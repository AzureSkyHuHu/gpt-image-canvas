import {
  composePrompt,
  MAX_GENERATION_JOB_REFERENCES,
  MAX_GENERATION_PLAN_IMAGES,
  sizeToApiValue,
  type AgentSelectedCanvasReference,
  type AgentServerEvent,
  type GeneratedAsset,
  type GenerationJob,
  type GenerationOutput,
  type GenerationPlan,
  type GenerationRecord,
  type GenerationReference,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type ReferenceImageInput
} from "../contracts.js";
import type { DataOwner } from "../auth/data-owner.js";
import { readStoredAsset, runReferenceImageGeneration, runTextToImageGeneration } from "../generation/image-generation.js";
import type { ImageProvider, ImageProviderInput } from "../../infrastructure/providers/image-provider.js";

export const AGENT_EXECUTION_TOOL_ALLOWLIST = ["generate_canvas_image_job"] as const;

export interface StoredAgentGenerationPlan {
  plan: GenerationPlan;
  selectedReferences: AgentSelectedCanvasReference[];
}

export type AgentPlanExecutionMode = "execute" | "retry_failed";

export interface AgentPlanExecutionInput extends StoredAgentGenerationPlan {
  mode: AgentPlanExecutionMode;
  owner: DataOwner;
  provider: ImageProvider;
  requestId?: string;
  runId: string;
  signal: AbortSignal;
  sendEvent: (event: AgentServerEvent) => void;
  isRunActive: () => boolean;
}

export interface AgentPlanExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  plan: GenerationPlan;
}

interface ResolvedJobReferences {
  referenceImages: ReferenceImageInput[];
  referenceAssetIds: string[];
}

export function isExecutableGenerationPlan(value: unknown): value is GenerationPlan {
  if (!isRecord(value)) {
    return false;
  }

  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  const edges = Array.isArray(value.edges) ? value.edges : [];

  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isPlanStatus(value.status) &&
    isRecord(value.defaults) &&
    isImageSize(value.defaults.size) &&
    isQuality(value.defaults.quality) &&
    isOutputFormat(value.defaults.outputFormat) &&
    Array.isArray(value.jobs) &&
    jobs.every(isExecutableGenerationJob) &&
    Array.isArray(value.edges) &&
    edges.every(isDependencyEdge) &&
    executionPlanWithinBounds(jobs as GenerationJob[], edges as Array<{ fromJobId: string; toJobId: string }>) &&
    value.createdBy === "agent" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export async function executeGenerationPlan(input: AgentPlanExecutionInput): Promise<AgentPlanExecutionResult> {
  const plan = preparePlanForExecution(input.plan, input.mode);
  emitPlanUpdated(input, plan);

  let provider: ImageProvider;
  try {
    throwIfAborted(input.signal);
    provider = input.provider;
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      markPlanCancelled(plan);
      emitPlanUpdated(input, plan);
      return { status: "cancelled", plan };
    }

    markRunnableJobsBlocked(plan, errorToMessage(error));
    plan.status = "failed";
    plan.updatedAt = new Date().toISOString();
    emitPlanUpdated(input, plan);
    return { status: "failed", plan };
  }

  const selectedReferencesByKey = createSelectedReferenceMap(input.selectedReferences);

  while (input.isRunActive()) {
    if (input.signal.aborted) {
      markPlanCancelled(plan);
      emitPlanUpdated(input, plan);
      return { status: "cancelled", plan };
    }

    const runnableJobs = plan.jobs.filter((job) => job.status === "queued" && dependenciesSucceeded(plan, job.id));
    if (runnableJobs.length === 0) {
      const queuedJobs = plan.jobs.filter((job) => job.status === "queued");
      if (queuedJobs.length === 0) {
        break;
      }

      for (const job of queuedJobs) {
        if (dependencyFailed(plan, job.id)) {
          const reason = "Blocked because an upstream Agent job failed or was cancelled.";
          job.status = "blocked";
          job.error = reason;
          job.outputs = [];
          emitJobBlocked(input, plan, job.id, reason);
        }
      }

      plan.updatedAt = new Date().toISOString();
      emitPlanUpdated(input, plan);
      break;
    }

    await Promise.all(
      runnableJobs.map((job) =>
        executeGenerationJob({
          ...input,
          plan,
          job,
          provider,
          selectedReferencesByKey
        })
      )
    );
  }

  if (!input.isRunActive() || input.signal.aborted) {
    markPlanCancelled(plan);
    emitPlanUpdated(input, plan);
    return { status: "cancelled", plan };
  }

  plan.status = resolvePlanStatus(plan);
  plan.updatedAt = new Date().toISOString();
  emitPlanUpdated(input, plan);

  return {
    status: plan.status === "succeeded" ? "succeeded" : "failed",
    plan
  };
}

function preparePlanForExecution(plan: GenerationPlan, mode: AgentPlanExecutionMode): GenerationPlan {
  const now = new Date().toISOString();
  const nextPlan = cloneGenerationPlan(plan);
  nextPlan.status = "running";
  nextPlan.updatedAt = now;
  nextPlan.jobs = nextPlan.jobs.map((job) => {
    const shouldKeepSuccessfulJob =
      mode === "retry_failed" && job.status === "succeeded" && job.outputs.some((output) => output.status === "succeeded" && output.asset);

    if (shouldKeepSuccessfulJob) {
      return job;
    }

    return {
      ...job,
      status: "queued",
      outputs: [],
      error: undefined
    };
  });
  return nextPlan;
}

async function executeGenerationJob(input: AgentPlanExecutionInput & {
  plan: GenerationPlan;
  job: GenerationJob;
  provider: ImageProvider;
  selectedReferencesByKey: Map<string, AgentSelectedCanvasReference>;
}): Promise<void> {
  if (!input.isRunActive() || input.signal.aborted || input.job.status !== "queued") {
    return;
  }

  input.job.status = "running";
  input.job.error = undefined;
  input.job.outputs = [];
  input.plan.updatedAt = new Date().toISOString();
  emitJobStarted(input, input.plan, input.job.id);
  emitPlanUpdated(input, input.plan);

  try {
    throwIfAborted(input.signal);
    const references = await resolveJobReferences(input.owner, input.plan, input.job, input.selectedReferencesByKey);
    throwIfAborted(input.signal);

    const request = createJobImageProviderInput(input.plan, input.job);
    const response =
      references.referenceImages.length > 0
        ? await runReferenceImageGeneration(
            input.owner,
            {
              ...request,
              referenceImages: references.referenceImages,
              referenceAssetIds: references.referenceAssetIds,
              referenceAssetId: references.referenceAssetIds[0]
            },
            input.provider,
            input.signal
          )
        : await runTextToImageGeneration(input.owner, request, input.provider, input.signal);
    throwIfAborted(input.signal);

    input.job.outputs = response.record.outputs;
    const successfulOutputs = response.record.outputs.filter((output) => output.status === "succeeded" && output.asset);
    const failedOutputs = response.record.outputs.filter((output) => output.status === "failed");
    input.job.status = successfulOutputs.length > 0 && failedOutputs.length === 0 ? "succeeded" : "failed";
    input.job.error =
      input.job.status === "failed"
        ? response.record.error ?? failedOutputs[0]?.error ?? "Agent image generation failed."
        : undefined;
    input.plan.updatedAt = new Date().toISOString();

    for (const output of successfulOutputs) {
      if (output.asset) {
        emitAssetPreview(input, input.plan, input.job.id, output.id, output.asset);
      }
    }

    if (input.job.status === "succeeded") {
      emitJobCompleted(input, input.plan, input.job.id, input.job.outputs, response.record);
    } else {
      emitJobFailed(input, input.plan, input.job.id, input.job.error ?? "Agent image generation failed.");
    }
    emitPlanUpdated(input, input.plan);
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      input.job.status = "cancelled";
      input.job.error = "Agent run was cancelled.";
      input.plan.updatedAt = new Date().toISOString();
      emitPlanUpdated(input, input.plan);
      return;
    }

    input.job.status = "failed";
    input.job.outputs = [];
    input.job.error = errorToMessage(error);
    input.plan.updatedAt = new Date().toISOString();
    emitJobFailed(input, input.plan, input.job.id, input.job.error);
    emitPlanUpdated(input, input.plan);
  }
}

function createJobImageProviderInput(plan: GenerationPlan, job: GenerationJob): ImageProviderInput {
  const size = job.size ?? plan.defaults.size;
  const quality = job.quality ?? plan.defaults.quality;
  const outputFormat = job.outputFormat ?? plan.defaults.outputFormat;
  const presetId = plan.defaults.stylePresetId ?? "none";

  return {
    originalPrompt: job.prompt,
    presetId,
    prompt: composePrompt(job.prompt, presetId),
    size,
    sizeApiValue: sizeToApiValue(size),
    quality,
    outputFormat,
    count: job.count
  };
}

async function resolveJobReferences(
  owner: DataOwner,
  plan: GenerationPlan,
  job: GenerationJob,
  selectedReferencesByKey: Map<string, AgentSelectedCanvasReference>
): Promise<ResolvedJobReferences> {
  const referenceImages: ReferenceImageInput[] = [];
  const referenceAssetIds: string[] = [];

  for (const reference of job.references.slice(0, 3)) {
    const resolved = await resolveGenerationReference(owner, plan, reference, selectedReferencesByKey);
    referenceImages.push(resolved.referenceImage);
    if (resolved.assetId) {
      referenceAssetIds.push(resolved.assetId);
    }
  }

  return {
    referenceImages,
    referenceAssetIds
  };
}

async function resolveGenerationReference(
  owner: DataOwner,
  plan: GenerationPlan,
  reference: GenerationReference,
  selectedReferencesByKey: Map<string, AgentSelectedCanvasReference>
): Promise<{ referenceImage: ReferenceImageInput; assetId?: string }> {
  if (reference.kind === "selected_canvas_image") {
    const selected = selectedReferenceFor(reference, selectedReferencesByKey);
    if (selected?.dataUrl) {
      return {
        referenceImage: {
          dataUrl: selected.dataUrl,
          fileName: fileNameForReference(selected.label ?? selected.assetId, selected.mimeType)
        },
        assetId: selected.assetId
      };
    }

    const assetId = selected?.assetId ?? reference.assetId;
    if (assetId) {
      const stored = await storedAssetReference(owner, assetId);
      if (stored) {
        return stored;
      }
    }

    throw new Error(`Selected reference "${reference.assetId ?? reference.label ?? "unknown"}" is not available to the Agent executor.`);
  }

  const sourceJob = reference.jobId ? plan.jobs.find((job) => job.id === reference.jobId) : undefined;
  const sourceOutput = sourceJob
    ? sourceJob.outputs.find((output) =>
        reference.outputId ? output.id === reference.outputId || output.asset?.id === reference.outputId : output.status === "succeeded" && output.asset
      )
    : undefined;
  const assetId = sourceOutput?.asset?.id;
  if (!assetId) {
    throw new Error(`Generated reference "${reference.jobId ?? "unknown"}" has no available output.`);
  }

  const stored = await storedAssetReference(owner, assetId);
  if (!stored) {
    throw new Error(`Generated reference asset "${assetId}" is not available.`);
  }

  return stored;
}

async function storedAssetReference(
  owner: DataOwner,
  assetId: string
): Promise<{ referenceImage: ReferenceImageInput; assetId: string } | undefined> {
  for (const candidateAssetId of storedAssetIdCandidates(assetId)) {
    const stored = await readStoredAsset(owner, candidateAssetId);
    if (!stored) {
      continue;
    }

    return {
      referenceImage: {
        dataUrl: `data:${stored.file.mimeType};base64,${stored.bytes.toString("base64")}`,
        fileName: stored.file.fileName
      },
      assetId: stored.file.id
    };
  }

  return undefined;
}

function selectedReferenceFor(
  reference: GenerationReference,
  selectedReferencesByKey: Map<string, AgentSelectedCanvasReference>
): AgentSelectedCanvasReference | undefined {
  const keys = [...selectedReferenceLookupKeys(reference.assetId), ...selectedReferenceLookupKeys(reference.label)];
  for (const key of keys) {
    const selected = selectedReferencesByKey.get(key);
    if (selected) {
      return selected;
    }
  }

  return undefined;
}

function createSelectedReferenceMap(references: AgentSelectedCanvasReference[]): Map<string, AgentSelectedCanvasReference> {
  const map = new Map<string, AgentSelectedCanvasReference>();
  references.forEach((reference, index) => {
    addSelectedReferenceMapEntries(map, reference, reference.id);
    addSelectedReferenceMapEntries(map, reference, reference.assetId);
    addSelectedReferenceMapEntries(map, reference, reference.label);
    addSelectedReferenceMapEntries(map, reference, `${index + 1}`);
    addSelectedReferenceMapEntries(map, reference, `ref${index + 1}`);
    addSelectedReferenceMapEntries(map, reference, `selected-${index + 1}`);
  });

  return map;
}

function addSelectedReferenceMapEntries(
  map: Map<string, AgentSelectedCanvasReference>,
  reference: AgentSelectedCanvasReference,
  value: string | undefined
): void {
  for (const key of selectedReferenceLookupKeys(value)) {
    if (!map.has(key)) {
      map.set(key, reference);
    }
  }
}

function selectedReferenceLookupKeys(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [...storedAssetIdCandidates(value), value.trim()].filter((key, index, keys) => key && keys.indexOf(key) === index);
}

function storedAssetIdCandidates(assetId: string): string[] {
  const trimmed = assetId.trim();
  const candidates = [trimmed];
  const tldrawAssetMatch = /^asset:(.+)$/u.exec(trimmed);
  if (tldrawAssetMatch?.[1]) {
    candidates.push(tldrawAssetMatch[1]);
  }

  return candidates.filter((candidate, index) => candidate && candidates.indexOf(candidate) === index);
}

function dependenciesSucceeded(plan: GenerationPlan, jobId: string): boolean {
  return plan.edges
    .filter((edge) => edge.toJobId === jobId)
    .every((edge) => plan.jobs.find((job) => job.id === edge.fromJobId)?.status === "succeeded");
}

function dependencyFailed(plan: GenerationPlan, jobId: string): boolean {
  return plan.edges
    .filter((edge) => edge.toJobId === jobId)
    .some((edge) => {
      const status = plan.jobs.find((job) => job.id === edge.fromJobId)?.status;
      return status === "failed" || status === "blocked" || status === "cancelled";
    });
}

function markRunnableJobsBlocked(plan: GenerationPlan, reason: string): void {
  for (const job of plan.jobs) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "blocked";
      job.error = reason;
      job.outputs = [];
    }
  }
}

function markPlanCancelled(plan: GenerationPlan): void {
  plan.status = "cancelled";
  plan.updatedAt = new Date().toISOString();
  plan.jobs = plan.jobs.map((job) =>
    job.status === "queued" || job.status === "running"
      ? {
          ...job,
          status: "cancelled",
          error: job.error ?? "Agent run was cancelled."
        }
      : job
  );
}

function resolvePlanStatus(plan: GenerationPlan): GenerationPlan["status"] {
  const statuses = plan.jobs.map((job) => job.status);
  if (statuses.every((status) => status === "succeeded")) {
    return "succeeded";
  }
  if (statuses.some((status) => status === "succeeded")) {
    return "partial";
  }
  if (statuses.some((status) => status === "cancelled")) {
    return "cancelled";
  }
  return "failed";
}

function emitPlanUpdated(input: AgentPlanExecutionInput, plan: GenerationPlan): void {
  if (!input.isRunActive()) {
    return;
  }

  input.sendEvent({
    type: "plan_updated",
    requestId: input.requestId,
    runId: input.runId,
    plan: cloneGenerationPlan(plan),
    timestamp: new Date().toISOString()
  });
}

function emitJobStarted(input: AgentPlanExecutionInput, plan: GenerationPlan, jobId: string): void {
  input.sendEvent({
    type: "job_started",
    requestId: input.requestId,
    runId: input.runId,
    planId: plan.id,
    jobId,
    timestamp: new Date().toISOString()
  });
}

function emitJobCompleted(
  input: AgentPlanExecutionInput,
  plan: GenerationPlan,
  jobId: string,
  outputs: GenerationOutput[],
  record: GenerationRecord
): void {
  input.sendEvent({
    type: "job_completed",
    requestId: input.requestId,
    runId: input.runId,
    planId: plan.id,
    jobId,
    outputs,
    record,
    timestamp: new Date().toISOString()
  });
}

function emitJobFailed(input: AgentPlanExecutionInput, plan: GenerationPlan, jobId: string, error: string): void {
  input.sendEvent({
    type: "job_failed",
    requestId: input.requestId,
    runId: input.runId,
    planId: plan.id,
    jobId,
    error,
    timestamp: new Date().toISOString()
  });
}

function emitJobBlocked(input: AgentPlanExecutionInput, plan: GenerationPlan, jobId: string, reason: string): void {
  input.sendEvent({
    type: "job_blocked",
    requestId: input.requestId,
    runId: input.runId,
    planId: plan.id,
    jobId,
    reason,
    timestamp: new Date().toISOString()
  });
}

function emitAssetPreview(
  input: AgentPlanExecutionInput,
  plan: GenerationPlan,
  jobId: string,
  outputId: string,
  asset: GeneratedAsset
): void {
  input.sendEvent({
    type: "asset_preview",
    requestId: input.requestId,
    runId: input.runId,
    planId: plan.id,
    jobId,
    outputId,
    assetId: asset.id,
    url: asset.url,
    asset,
    timestamp: new Date().toISOString()
  });
}

function cloneGenerationPlan(plan: GenerationPlan): GenerationPlan {
  return {
    ...plan,
    defaults: {
      ...plan.defaults,
      size: { ...plan.defaults.size }
    },
    jobs: plan.jobs.map((job) => ({
      ...job,
      size: job.size ? { ...job.size } : undefined,
      references: job.references.map((reference) => ({ ...reference })),
      outputs: job.outputs.map((output) => ({
        ...output,
        asset: output.asset ? cloneGeneratedAsset(output.asset) : undefined
      }))
    })),
    edges: plan.edges.map((edge) => ({ ...edge }))
  };
}

function cloneGeneratedAsset(asset: GeneratedAsset): GeneratedAsset {
  return {
    ...asset,
    cloud: asset.cloud ? { ...asset.cloud } : undefined
  };
}

function fileNameForReference(label: string | undefined, mimeType: string | undefined): string | undefined {
  if (!label) {
    return undefined;
  }

  if (/\.(png|jpe?g|webp)$/iu.test(label)) {
    return label;
  }

  if (!mimeType) {
    return label;
  }

  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "png";
  return `${label}.${extension}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Agent run was cancelled.", "AbortError");
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || (error instanceof DOMException && error.name === "AbortError"));
}

function errorToMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Agent image generation failed.";
}

function isExecutableGenerationJob(value: unknown): value is GenerationJob {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.prompt === "string" &&
    isExecutableGenerationCount(value.count) &&
    isJobRole(value.role) &&
    isJobStatus(value.status) &&
    (value.size === undefined || isImageSize(value.size)) &&
    (value.quality === undefined || isQuality(value.quality)) &&
    (value.outputFormat === undefined || isOutputFormat(value.outputFormat)) &&
    Array.isArray(value.references) &&
    value.references.every(isGenerationReference) &&
    Array.isArray(value.outputs) &&
    typeof value.visible === "boolean" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isExecutableGenerationCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_GENERATION_PLAN_IMAGES;
}

function executionPlanWithinBounds(jobs: GenerationJob[], edges: Array<{ fromJobId: string; toJobId: string }>): boolean {
  const totalOutputCount = jobs.reduce((total, job) => total + job.count, 0);
  if (totalOutputCount > MAX_GENERATION_PLAN_IMAGES) {
    return false;
  }

  if (jobs.some((job) => job.references.length > MAX_GENERATION_JOB_REFERENCES)) {
    return false;
  }

  const sourceJobIds = new Set(edges.map((edge) => edge.fromJobId));
  for (const job of jobs) {
    for (const reference of job.references) {
      if (reference.kind === "generated_output" && reference.jobId) {
        sourceJobIds.add(reference.jobId);
      }
    }
  }

  return jobs.every((job) => !sourceJobIds.has(job.id) || job.count === 1);
}

function isGenerationReference(value: unknown): value is GenerationReference {
  if (!isRecord(value) || !isReferenceUsage(value.usage)) {
    return false;
  }

  if (value.kind === "selected_canvas_image") {
    return value.assetId === undefined || typeof value.assetId === "string";
  }

  if (value.kind === "generated_output") {
    return typeof value.jobId === "string" && (value.outputId === undefined || typeof value.outputId === "string");
  }

  return false;
}

function isDependencyEdge(value: unknown): boolean {
  return isRecord(value) && typeof value.fromJobId === "string" && typeof value.toJobId === "string";
}

function isImageSize(value: unknown): value is ImageSize {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    typeof value.height === "number" &&
    Number.isFinite(value.height)
  );
}

function isPlanStatus(value: unknown): value is GenerationPlan["status"] {
  return isOneOf(value, ["awaiting_confirmation", "confirmed", "running", "succeeded", "partial", "failed", "cancelled"]);
}

function isJobStatus(value: unknown): value is GenerationJob["status"] {
  return isOneOf(value, ["queued", "running", "succeeded", "failed", "blocked", "cancelled"]);
}

function isJobRole(value: unknown): value is GenerationJob["role"] {
  return isOneOf(value, ["final_image", "variation", "character_anchor", "style_anchor", "reference_anchor"]);
}

function isQuality(value: unknown): value is ImageQuality {
  return isOneOf(value, ["auto", "low", "medium", "high"]);
}

function isOutputFormat(value: unknown): value is OutputFormat {
  return isOneOf(value, ["png", "jpeg", "webp"]);
}

function isReferenceUsage(value: unknown): value is GenerationReference["usage"] {
  return isOneOf(value, ["subject", "character", "style", "composition", "scene", "product", "other"]);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
