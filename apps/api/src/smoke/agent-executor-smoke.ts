import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSelectedCanvasReference, AgentServerEvent, GenerationPlan } from "../domain/contracts.js";
import type { DataOwner } from "../domain/auth/data-owner.js";
import type { EditImageProviderInput, ImageProvider, ImageProviderInput, ProviderResult } from "../infrastructure/providers/image-provider.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = resolve(repoRoot, ".codex-temp", `agent-executor-smoke-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = dataDir;
process.env.SQLITE_JOURNAL_MODE = "DELETE";
process.env.SQLITE_LOCKING_MODE = "EXCLUSIVE";

mkdirSync(dataDir, { recursive: true });

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const smokeOwner: DataOwner = {
  id: "local",
  label: "Smoke local",
  isLocal: true
};

async function main(): Promise<void> {
  try {
    const [{ executeGenerationPlan, isExecutableGenerationPlan }, { closeDatabase }] = await Promise.all([
      import("../domain/agent/executor.js"),
      import("../infrastructure/database.js")
    ]);

    try {
      const successProvider = new FakeImageProvider();
      const events: AgentServerEvent[] = [];
      const success = await executeGenerationPlan({
	        plan: planFixture(),
	        owner: smokeOwner,
	        selectedReferences: [],
        mode: "execute",
        provider: successProvider,
        requestId: "smoke-execute",
        runId: "run-smoke",
        signal: new AbortController().signal,
        isRunActive: () => true,
        sendEvent: (event) => events.push(event)
      });

      expect(success.status === "succeeded", "DAG execution succeeds");
      expect(success.plan.jobs.every((job) => job.status === "succeeded"), "all jobs are marked succeeded");
      expect(successProvider.generateCalls === 1, "anchor job uses text-to-image generation");
      expect(successProvider.editCalls === 1, "downstream generated reference uses edit generation");
      expect(events.filter((event) => event.type === "asset_preview").length === 2, "each generated asset emits a preview");

      const selectedAssetId = success.plan.jobs[0]?.outputs[0]?.asset?.id;
      expect(selectedAssetId, "successful fixture creates a stored asset for selected reference checks");
      const selectedProvider = new FakeImageProvider();
      const selectedReference = {
        id: "selected-1",
        assetId: `asset:${selectedAssetId}`,
        label: "Selected fixture"
      } satisfies AgentSelectedCanvasReference;
      const selectedReferencePlan = selectedReferencePlanFixture(`asset:${selectedAssetId}`);
      const selectedReferenceRun = await executeGenerationPlan({
	        plan: selectedReferencePlan,
	        owner: smokeOwner,
	        selectedReferences: [selectedReference],
        mode: "execute",
        provider: selectedProvider,
        requestId: "smoke-selected-reference",
        runId: "run-selected-reference",
        signal: new AbortController().signal,
        isRunActive: () => true,
        sendEvent: () => undefined
      });
      expect(selectedReferenceRun.status === "succeeded", "selected references with tldraw asset: prefix resolve to stored assets");
      expect(selectedProvider.editCalls === 1, "selected reference run uses edit generation");

      const localSelectedProvider = new FakeImageProvider();
      const localSelectedReference = {
        id: "selected-local-1",
        assetId: "local-only-reference",
        label: "Local canvas image",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${tinyPngBase64}`
      } satisfies AgentSelectedCanvasReference;
      const localSelectedReferenceRun = await executeGenerationPlan({
	        plan: selectedReferencePlanFixture("local-only-reference"),
	        owner: smokeOwner,
	        selectedReferences: [localSelectedReference],
        mode: "execute",
        provider: localSelectedProvider,
        requestId: "smoke-local-selected-reference",
        runId: "run-local-selected-reference",
        signal: new AbortController().signal,
        isRunActive: () => true,
        sendEvent: () => undefined
      });
      expect(localSelectedReferenceRun.status === "succeeded", "selected references with local-only asset ids are persisted before edit generation");
      expect(localSelectedProvider.editCalls === 1, "local-only selected reference run still uses edit generation");

      const multiSelectedProvider = new FakeImageProvider();
      const multiSelectedRun = await executeGenerationPlan({
	        plan: multiSelectedReferencePlanFixture(),
	        owner: smokeOwner,
	        selectedReferences: [
          localSelectedReference,
          {
            id: "selected-local-2",
            assetId: "local-only-reference-2",
            label: "Second local canvas image",
            mimeType: "image/png",
            dataUrl: `data:image/png;base64,${tinyPngBase64}`
          }
        ],
        mode: "execute",
        provider: multiSelectedProvider,
        requestId: "smoke-multi-selected-reference",
        runId: "run-multi-selected-reference",
        signal: new AbortController().signal,
        isRunActive: () => true,
        sendEvent: () => undefined
      });
      expect(multiSelectedRun.status === "succeeded", "multiple independent selected-reference jobs succeed");
      expect(multiSelectedProvider.generateCalls === 0, "multiple selected-reference jobs do not call text generation");
      expect(multiSelectedProvider.editCalls === 2, "multiple selected-reference jobs each use edit generation");

      const arbitraryCountProvider = new FakeImageProvider();
      const arbitraryCountPlan = arbitraryCountPlanFixture();
      expect(isExecutableGenerationPlan(arbitraryCountPlan), "single agent job can request an arbitrary count up to the plan cap");
      const arbitraryCountRun = await executeGenerationPlan({
	        plan: arbitraryCountPlan,
	        owner: smokeOwner,
	        selectedReferences: [],
        mode: "execute",
        provider: arbitraryCountProvider,
        requestId: "smoke-arbitrary-count",
        runId: "run-arbitrary-count",
        signal: new AbortController().signal,
        isRunActive: () => true,
        sendEvent: () => undefined
      });
      expect(arbitraryCountRun.status === "succeeded", "arbitrary-count agent job succeeds");
      expect(arbitraryCountProvider.generateCalls === 9, "arbitrary-count agent job is fanned out by the generation runner");
      expect(arbitraryCountRun.plan.jobs[0]?.outputs.length === 9, "arbitrary-count agent job preserves all outputs on one job");

      const retryProvider = new FakeImageProvider();
      const retryPlan = clonePlan(success.plan);
      const finalJob = retryPlan.jobs.find((job) => job.id === "final_scene");
      expect(finalJob, "retry fixture includes final job");
      finalJob.status = "failed";
      finalJob.outputs = [];
      finalJob.error = "retry me";
      retryPlan.status = "partial";

      const retry = await executeGenerationPlan({
	        plan: retryPlan,
	        owner: smokeOwner,
	        selectedReferences: [],
        mode: "retry_failed",
        provider: retryProvider,
        requestId: "smoke-retry",
        runId: "run-retry",
        signal: new AbortController().signal,
        isRunActive: () => true,
        sendEvent: () => undefined
      });
      expect(retry.status === "succeeded", "retry_failed recovers failed downstream job");
      expect(retryProvider.generateCalls === 0, "retry keeps succeeded upstream anchor");
      expect(retryProvider.editCalls === 1, "retry reruns failed downstream job");

      const failedProvider = new FakeImageProvider({ failGenerate: true });
      const blocked = await executeGenerationPlan({
	        plan: planFixture("plan-blocked"),
	        owner: smokeOwner,
	        selectedReferences: [],
        mode: "execute",
        provider: failedProvider,
        requestId: "smoke-blocked",
        runId: "run-blocked",
        signal: new AbortController().signal,
        isRunActive: () => true,
        sendEvent: () => undefined
      });
      expect(blocked.status === "failed", "failed upstream plan reports failed");
      expect(blocked.plan.jobs.find((job) => job.id === "final_scene")?.status === "blocked", "downstream job is blocked");
    } finally {
      closeDatabase();
    }

    console.log("agent executor smoke checks passed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

class FakeImageProvider implements ImageProvider {
  generateCalls = 0;
  editCalls = 0;

  constructor(private readonly options: { failGenerate?: boolean } = {}) {}

  async generate(input: ImageProviderInput): Promise<ProviderResult> {
    this.generateCalls += 1;
    if (this.options.failGenerate) {
      throw new Error("fake text generation failed");
    }

    return providerResult(input.sizeApiValue);
  }

  async edit(input: EditImageProviderInput): Promise<ProviderResult> {
    this.editCalls += 1;
    expect(input.referenceImages.length > 0, "edit generation receives references");
    return providerResult(input.sizeApiValue);
  }
}

function providerResult(size: string): ProviderResult {
  return {
    model: "fake-image-model",
    size,
    images: [
      {
        b64Json: tinyPngBase64
      }
    ]
  };
}

function planFixture(id = "plan-smoke"): GenerationPlan {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    title: "Agent executor smoke plan",
    status: "awaiting_confirmation",
    defaults: {
      size: {
        width: 1024,
        height: 1024
      },
      quality: "auto",
      outputFormat: "png",
      count: 1
    },
    jobs: [
      {
        id: "character_anchor",
        role: "character_anchor",
        prompt: "Create one reusable character anchor.",
        count: 1,
        references: [],
        status: "queued",
        outputs: [],
        visible: true
      },
      {
        id: "final_scene",
        role: "final_image",
        prompt: "Create one final scene with the generated character.",
        count: 1,
        references: [
          {
            kind: "generated_output",
            usage: "character",
            jobId: "character_anchor"
          }
        ],
        status: "queued",
        outputs: [],
        visible: true
      }
    ],
    edges: [
      {
        fromJobId: "character_anchor",
        toJobId: "final_scene"
      }
    ],
    createdBy: "agent",
    createdAt: now,
    updatedAt: now
  };
}

function selectedReferencePlanFixture(assetId: string): GenerationPlan {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "plan-selected-reference-smoke",
    title: "Selected reference smoke plan",
    status: "awaiting_confirmation",
    defaults: {
      size: {
        width: 1024,
        height: 1024
      },
      quality: "auto",
      outputFormat: "png",
      count: 1
    },
    jobs: [
      {
        id: "final_from_selected",
        role: "final_image",
        prompt: "Create one final image from the selected canvas reference.",
        count: 1,
        references: [
          {
            kind: "selected_canvas_image",
            usage: "style",
            assetId
          }
        ],
        status: "queued",
        outputs: [],
        visible: true
      }
    ],
    edges: [],
    createdBy: "agent",
    createdAt: now,
    updatedAt: now
  };
}

function multiSelectedReferencePlanFixture(): GenerationPlan {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "plan-multi-selected-reference-smoke",
    title: "Multiple selected reference smoke plan",
    status: "awaiting_confirmation",
    defaults: {
      size: {
        width: 1024,
        height: 1024
      },
      quality: "auto",
      outputFormat: "png",
      count: 1
    },
    jobs: [
      {
        id: "caption_selected_1",
        role: "final_image",
        prompt: "Edit selected canvas image one directly and add title typography.",
        count: 1,
        references: [
          {
            kind: "selected_canvas_image",
            usage: "scene",
            assetId: "local-only-reference"
          }
        ],
        status: "queued",
        outputs: [],
        visible: true
      },
      {
        id: "caption_selected_2",
        role: "final_image",
        prompt: "Edit selected canvas image two directly and add title typography.",
        count: 1,
        references: [
          {
            kind: "selected_canvas_image",
            usage: "scene",
            assetId: "local-only-reference-2"
          }
        ],
        status: "queued",
        outputs: [],
        visible: true
      }
    ],
    edges: [],
    createdBy: "agent",
    createdAt: now,
    updatedAt: now
  };
}

function arbitraryCountPlanFixture(): GenerationPlan {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "plan-arbitrary-count-smoke",
    title: "Arbitrary count smoke plan",
    status: "awaiting_confirmation",
    defaults: {
      size: {
        width: 1024,
        height: 1024
      },
      quality: "auto",
      outputFormat: "png",
      count: 1
    },
    jobs: [
      {
        id: "travel_vlog_batch",
        role: "final_image",
        prompt: "Create nine realistic travel vlog stills.",
        count: 9,
        references: [],
        status: "queued",
        outputs: [],
        visible: true
      }
    ],
    edges: [],
    createdBy: "agent",
    createdAt: now,
    updatedAt: now
  };
}

function clonePlan(plan: GenerationPlan): GenerationPlan {
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
        asset: output.asset ? { ...output.asset, cloud: output.asset.cloud ? { ...output.asset.cloud } : undefined } : undefined
      }))
    })),
    edges: plan.edges.map((edge) => ({ ...edge }))
  };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
