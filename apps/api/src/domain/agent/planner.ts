import { randomUUID } from "node:crypto";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import type { UsableAgentLlmConfig } from "./config.js";
import { createEmbeddedPlanningSkillsPrompt, createPlanningSkillFiles, createPlanningSystemPrompt } from "./planning-skill.js";
import {
  GENERATION_PLAN_SCHEMA_VERSION,
  IMAGE_QUALITIES,
  MAX_AGENT_SELECTED_REFERENCES,
  MAX_GENERATION_JOB_REFERENCES,
  MAX_GENERATION_PLAN_IMAGES,
  MAX_REFERENCE_IMAGES,
  OUTPUT_FORMATS,
  STYLE_PRESETS,
  validateSceneImageSize,
  type AgentPlannerOptions,
  type AgentReasoningEffort,
  type AgentSelectedCanvasReference,
  type AgentThinkingType,
  type GenerationDependencyEdge,
  type GenerationJob,
  type GenerationJobRole,
  type GenerationJobStatus,
  type GenerationPlan,
  type GenerationPlanDefaults,
  type GenerationPlanValidationCode,
  type GenerationPlanValidationIssue,
  type GenerationPlanValidationResult,
  type GenerationReference,
  type GenerationReferenceKind,
  type GenerationReferenceUsage,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type StylePresetId
} from "../contracts.js";

const DEFAULT_PLAN_SIZE: ImageSize = { width: 1024, height: 1024 };
const DEFAULT_PLAN_QUALITY: ImageQuality = "auto";
const DEFAULT_PLAN_OUTPUT_FORMAT: OutputFormat = "png";
const DEFAULT_PLAN_COUNT = 1;
const MAX_PLANNER_REFLECTION_ATTEMPTS = 1;
const PLANNER_REFLECTION_OUTPUT_PREVIEW_LIMIT = 6000;
const PLANNER_REFLECTION_ISSUE_LIMIT = 8;

const GENERATION_JOB_ROLES: readonly GenerationJobRole[] = [
  "final_image",
  "variation",
  "character_anchor",
  "style_anchor",
  "reference_anchor"
];
const GENERATION_JOB_STATUSES: readonly GenerationJobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled"
];
const GENERATION_REFERENCE_KINDS: readonly GenerationReferenceKind[] = ["selected_canvas_image", "generated_output"];
const GENERATION_REFERENCE_USAGES: readonly GenerationReferenceUsage[] = [
  "subject",
  "character",
  "style",
  "composition",
  "scene",
  "product",
  "other"
];

type PlannerMessageContent =
  | string
  | Array<
      | {
          type: "text";
          text: string;
        }
      | {
          type: "image_url";
          image_url: {
            url: string;
          };
        }
    >;

interface PlannerMessage {
  role: "user";
  content: PlannerMessageContent;
}

export interface GenerationPlanAgentRunner {
  streamsThinkingDeltas?: boolean;
  supportsVision?: boolean;
  invoke(
    input: {
      messages: PlannerMessage[];
      files?: Record<string, unknown>;
      plannerOptions?: AgentPlannerOptions;
      supportsVision?: boolean;
    },
    options?: {
      configurable?: {
        thread_id: string;
      };
      recursionLimit?: number;
      signal?: AbortSignal;
      onThinkingDelta?: (delta: string) => void;
    }
  ): Promise<unknown>;
}

export interface AgentPlannerInput {
  userText: string;
  defaults?: unknown;
  selectedReferences?: unknown;
  plannerOptions?: unknown;
  llmConfig?: UsableAgentLlmConfig;
  onAssistantDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  signal?: AbortSignal;
  now?: Date;
  runner?: GenerationPlanAgentRunner;
}

export type AgentPlannerResult =
  | {
      ok: true;
      plan: GenerationPlan;
    }
  | {
      ok: false;
      code: string;
      message: string;
      issues?: GenerationPlanValidationIssue[];
    };

type AgentPlannerFailure = Extract<AgentPlannerResult, { ok: false }>;
type GenerationPlanDefaultsParseResult =
  | AgentPlannerFailure
  | {
      ok: true;
      defaults: GenerationPlanDefaults;
    };
type SelectedReferencesParseResult =
  | AgentPlannerFailure
  | {
      ok: true;
      references: AgentSelectedCanvasReference[];
    };
type PlannerAttemptEvaluation =
  | {
      ok: true;
      plan: GenerationPlan;
    }
  | {
      ok: false;
      failure: AgentPlannerFailure;
      shouldReflect: boolean;
      previousOutput: string;
    };

export interface GenerationPlanValidationContext {
  defaults: GenerationPlanDefaults;
  selectedReferences?: AgentSelectedCanvasReference[];
  now?: Date;
  planId?: string;
}

export async function createGenerationPlan(input: AgentPlannerInput): Promise<AgentPlannerResult> {
  const userText = typeof input.userText === "string" ? input.userText.trim() : "";
  if (!userText) {
    return {
      ok: false,
      code: "invalid_agent_request",
      message: "Agent planning requires non-empty user text."
    };
  }

  const defaultsResult = parseGenerationPlanDefaults(input.defaults);
  if (!defaultsResult.ok) {
    return defaultsResult;
  }

  const selectedReferencesResult = parseSelectedCanvasReferences(input.selectedReferences);
  if (!selectedReferencesResult.ok) {
    return selectedReferencesResult;
  }

  const selectedReferences = selectedReferencesResult.references;
  const selectedReferenceRequestIssue = validateSelectedReferenceEditRequest(userText, selectedReferences);
  if (selectedReferenceRequestIssue) {
    return selectedReferenceRequestIssue;
  }

  const plannerOptions = normalizeAgentPlannerOptions(input.plannerOptions);
  if (!input.runner && !input.llmConfig) {
    return {
      ok: false,
      code: "missing_agent_config",
      message: "Configure an Agent LLM before using the Agent."
    };
  }

  const runner = input.runner ?? createDeepAgentsPlanner(input.llmConfig as UsableAgentLlmConfig, plannerOptions);
  const now = input.now ?? new Date();
  const planId = `plan-${randomUUID()}`;
  const message = buildPlannerUserMessage({
    userText,
    defaults: defaultsResult.defaults,
    selectedReferences,
    supportsVision: input.llmConfig?.supportsVision ?? runner.supportsVision ?? true
  });

  const planningSkillFiles = createPlanningSkillFiles(now);
  const invokePlannerAttempt = async (
    messages: PlannerMessage[],
    attemptIndex: number
  ): Promise<AgentPlannerFailure | { ok: true; agentResult: unknown }> => {
    emitAssistantDelta(input.onAssistantDelta, [
      attemptIndex === 0
        ? "我会先把你的需求整理成可执行的图像计划。"
        : "上一次规划没有通过校验，我会让 Agent 反思后重写一次。",
      " "
    ]);
    const runnerOptions: NonNullable<Parameters<GenerationPlanAgentRunner["invoke"]>[1]> = {
      configurable: {
        thread_id: `agent-plan-${planId}-attempt-${attemptIndex + 1}`
      },
      recursionLimit: 30,
      signal: input.signal
    };
    if (runner.streamsThinkingDeltas) {
      runnerOptions.onThinkingDelta = input.onThinkingDelta;
    }

    try {
      const agentResult = await runner.invoke(
        {
          messages,
          files: planningSkillFiles,
          plannerOptions,
          supportsVision: input.llmConfig?.supportsVision ?? runner.supportsVision ?? true
        },
        runnerOptions
      );
      if (input.signal?.aborted) {
        return agentRunCancelledResult();
      }

      const reasoningText = runner.streamsThinkingDeltas ? undefined : extractReasoningFromAgentResult(agentResult);
      if (reasoningText) {
        emitAssistantDelta(input.onThinkingDelta, [reasoningText]);
      }

      return {
        ok: true,
        agentResult
      };
    } catch (error) {
      if (input.signal?.aborted) {
        return agentRunCancelledResult();
      }

      return {
        ok: false,
        code: "agent_planner_failed",
        message: plannerRequestFailureMessage(error)
      };
    }
  };

  let plannerMessages: PlannerMessage[] = [message];
  let reflectionAttempt = 0;

  while (true) {
    const invocation = await invokePlannerAttempt(plannerMessages, reflectionAttempt);
    if (!invocation.ok) {
      return invocation;
    }

    const modelText = extractTextFromAgentResult(invocation.agentResult) ?? "";
    const evaluation = evaluatePlannerAttemptOutput({
      modelText,
      userText,
      defaults: defaultsResult.defaults,
      selectedReferences,
      now,
      planId
    });

    if (evaluation.ok) {
      emitAssistantDelta(input.onAssistantDelta, ["计划已生成，请在对话卡片中检查细节并确认执行。"]);
      return {
        ok: true,
        plan: evaluation.plan
      };
    }

    if (!evaluation.shouldReflect || reflectionAttempt >= MAX_PLANNER_REFLECTION_ATTEMPTS) {
      return evaluation.failure;
    }
    reflectionAttempt += 1;
    plannerMessages = [message, buildPlannerReflectionUserMessage(evaluation)];
  }
}

function evaluatePlannerAttemptOutput(input: {
  modelText: string;
  userText: string;
  defaults: GenerationPlanDefaults;
  selectedReferences: AgentSelectedCanvasReference[];
  now: Date;
  planId: string;
}): PlannerAttemptEvaluation {
  const previousOutput = input.modelText;
  if (!input.modelText) {
    return {
      ok: false,
      shouldReflect: true,
      previousOutput,
      failure: {
        ok: false,
        code: "invalid_plan_json",
        message: "Agent returned no GenerationPlan JSON."
      }
    };
  }

  const fallbackPlan = createSelectedReferenceEditFallbackPlan(input);
  const userQuestion = parsePlannerUserQuestionModelOutput(input.modelText);
  if (userQuestion) {
    return fallbackPlan
      ? {
          ok: true,
          plan: fallbackPlan
        }
      : {
          ok: false,
          shouldReflect: false,
          previousOutput,
          failure: userQuestion
        };
  }

  const validated = parseGenerationPlanModelOutput(input.modelText, {
    defaults: input.defaults,
    selectedReferences: input.selectedReferences,
    now: input.now,
    planId: input.planId
  });
  if (!validated.ok) {
    return {
      ok: false,
      shouldReflect: true,
      previousOutput,
      failure: {
        ok: false,
        code: validated.code,
        message: validated.message,
        issues: validated.issues
      }
    };
  }

  const selectedReferenceEditIssue = validateSelectedReferenceEditPlan(validated.plan, {
    userText: input.userText,
    selectedReferences: input.selectedReferences
  });
  if (selectedReferenceEditIssue) {
    return fallbackPlan
      ? {
          ok: true,
          plan: fallbackPlan
        }
      : {
          ok: false,
          shouldReflect: true,
          previousOutput,
          failure: selectedReferenceEditIssue
        };
  }

  return {
    ok: true,
    plan: validated.plan
  };
}

function agentRunCancelledResult(): AgentPlannerFailure {
  return {
    ok: false,
    code: "agent_run_cancelled",
    message: "Agent planning was cancelled."
  };
}

function emitAssistantDelta(onAssistantDelta: AgentPlannerInput["onAssistantDelta"], chunks: string[]): void {
  if (!onAssistantDelta) {
    return;
  }

  for (const chunk of chunks) {
    onAssistantDelta(chunk);
  }
}

export function createDeepAgentsPlanner(config: UsableAgentLlmConfig, plannerOptions?: AgentPlannerOptions): GenerationPlanAgentRunner {
  const isDeepSeek = isDeepSeekAgentConfig(config);
  const model = createAgentChatModel(config, isDeepSeek, plannerOptions);

  if (isDeepSeek) {
    return createDirectChatPlanner(model);
  }

  return createDeepAgent({
    model,
    skills: ["/skills/"],
    systemPrompt: createPlanningSystemPrompt(),
    tools: []
  }) as unknown as GenerationPlanAgentRunner;
}

function createAgentChatModel(
  config: UsableAgentLlmConfig,
  isDeepSeek = isDeepSeekAgentConfig(config),
  plannerOptions?: AgentPlannerOptions
): ChatOpenAI {
  const modelKwargs = agentModelKwargsForConfig(config, plannerOptions);
  return new ChatOpenAI({
    apiKey: config.apiKey,
    configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    maxRetries: 1,
    model: config.model,
    modelKwargs,
    streaming: isDeepSeek,
    streamUsage: false,
    temperature: isDeepSeek ? undefined : 0,
    timeout: config.timeoutMs
  });
}

export function createDirectChatPlanner(model: ChatOpenAI): GenerationPlanAgentRunner {
  return {
    streamsThinkingDeltas: true,
    async invoke(input, options) {
      const stream = await model.stream(
        [
          {
            role: "system",
            content: createDirectPlanningSystemPrompt()
          },
          ...input.messages
        ] as never,
        {
          signal: options?.signal
        } as never
      );
      const contentChunks: string[] = [];
      const reasoningSeen = new Set<string>();

      for await (const chunk of stream as AsyncIterable<unknown>) {
        throwIfAborted(options?.signal);
        for (const reasoningDelta of extractReasoningDeltasFromStreamChunk(chunk, reasoningSeen)) {
          options?.onThinkingDelta?.(reasoningDelta);
        }
        throwIfAborted(options?.signal);

        const content = extractContentDeltaFromStreamChunk(chunk);
        if (content !== undefined) {
          contentChunks.push(content);
        }
        throwIfAborted(options?.signal);
      }

      throwIfAborted(options?.signal);

      return {
        messages: [
          {
            content: contentChunks.join("")
          }
        ]
      };
    }
  };
}

export function createMyToolsAgentPlannerRunner(config: {
  baseUrl: string;
  sharedSecret: string;
  agentOwnerId: string;
}): GenerationPlanAgentRunner {
  const baseUrl = config.baseUrl.replace(/\/+$/u, "");
  return {
    streamsThinkingDeltas: true,
    supportsVision: true,
    async invoke(input, options) {
      const response = await fetch(`${baseUrl}/api/internal/gic/agent/plans/stream`, {
        method: "POST",
        headers: {
          Accept: "text/event-stream, application/json",
          "Content-Type": "application/json",
          "X-GIC-Agent-Key": config.sharedSecret
        },
        body: JSON.stringify({
          agentOwnerId: config.agentOwnerId,
          messages: [
            {
              role: "system",
              content: createDirectPlanningSystemPrompt()
            },
            ...input.messages
          ],
          files: normalizeMyToolsPlanningFiles(input.files),
          plannerOptions: input.plannerOptions,
          supportsVision: input.supportsVision,
          threadId: options?.configurable?.thread_id,
          recursionLimit: options?.recursionLimit
        }),
        signal: options?.signal
      });

      if (!response.ok) {
        throw new Error(await myToolsAgentResponseErrorMessage(response));
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.toLowerCase().includes("application/json")) {
        const data = (await response.json()) as unknown;
        const text = myToolsAgentResponseText(data);
        if (!text) {
          throw new Error("my_tools Agent planner returned no plan text.");
        }
        return { messages: [{ content: text }] };
      }

      const streamState: MyToolsAgentSseState = {
        contentChunks: []
      };
      const body = response.body;
      if (!body) {
        throw new Error("my_tools Agent planner returned an empty stream.");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        throwIfAborted(options?.signal);
        buffer += decoder.decode(chunk, { stream: true });
        buffer = drainMyToolsAgentSseBuffer(buffer, streamState, options?.onThinkingDelta);
      }
      buffer += decoder.decode();
      drainMyToolsAgentSseBuffer(`${buffer}\n\n`, streamState, options?.onThinkingDelta);
      throwIfAborted(options?.signal);

      const content = streamState.doneText ?? streamState.contentChunks.join("");
      return {
        messages: [
          {
            content
          }
        ]
      };
    }
  };
}

function normalizeMyToolsPlanningFiles(files: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!files) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const [path, file] of Object.entries(files)) {
    if (!isRecord(file)) {
      normalized[path] = file;
      continue;
    }

    normalized[path] = {
      ...file,
      content: planningFileContentToText(file.content)
    };
  }

  return normalized;
}

function planningFileContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((line) => (typeof line === "string" ? line : "")).join("\n");
  }

  return "";
}

async function myToolsAgentResponseErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: unknown; error?: { message?: unknown } };
    if (typeof data.message === "string" && data.message.trim()) {
      return data.message.trim();
    }
    if (typeof data.error?.message === "string" && data.error.message.trim()) {
      return data.error.message.trim();
    }
  } catch {
    // Use fallback below.
  }

  return "my_tools Agent planner request failed.";
}

function myToolsAgentResponseText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return nonEmptyString(data);
  }
  if (!isRecord(data)) {
    return undefined;
  }
  return contentToText(data.text) ?? contentToText(data.delta) ?? contentToText(data.output) ?? extractTextFromAgentResult(data);
}

interface MyToolsAgentSseState {
  contentChunks: string[];
  doneText?: string;
}

function drainMyToolsAgentSseBuffer(
  buffer: string,
  state: MyToolsAgentSseState,
  onThinkingDelta: ((delta: string) => void) | undefined
): string {
  let nextBuffer = buffer;
  while (true) {
    const boundary = nextBuffer.search(/\r?\n\r?\n/u);
    if (boundary < 0) {
      return nextBuffer;
    }

    const rawEvent = nextBuffer.slice(0, boundary);
    nextBuffer = nextBuffer.slice(nextBuffer[boundary] === "\r" ? boundary + 4 : boundary + 2);
    handleMyToolsAgentSseEvent(rawEvent, state, onThinkingDelta);
  }
}

function handleMyToolsAgentSseEvent(
  rawEvent: string,
  state: MyToolsAgentSseState,
  onThinkingDelta: ((delta: string) => void) | undefined
): void {
  const lines = rawEvent.split(/\r?\n/u);
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return;
  }

  const rawData = dataLines.join("\n");
  if (rawData === "[DONE]") {
    return;
  }

  let parsed: unknown = rawData;
  try {
    parsed = JSON.parse(rawData) as unknown;
  } catch {
    // Plain string deltas are allowed.
  }

  const delta = myToolsAgentEventText(parsed);
  if (eventType === "thinking_delta") {
    if (delta) {
      onThinkingDelta?.(delta);
    }
    return;
  }

  if (eventType === "delta") {
    if (delta) {
      state.contentChunks.push(delta);
    }
    return;
  }

  if (eventType === "done") {
    if (delta) {
      state.doneText = delta;
    }
    return;
  }

  if (eventType === "error") {
    throw new Error(delta || "my_tools Agent planner stream failed.");
  }
}

function myToolsAgentEventText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (!isRecord(data)) {
    return undefined;
  }
  return streamingContentToText(data.delta) ?? streamingContentToText(data.text) ?? streamingContentToText(data.message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Agent planning was cancelled.");
  }
}

function extractContentDeltaFromStreamChunk(chunk: unknown): string | undefined {
  if (typeof chunk === "string") {
    return chunk.length > 0 ? chunk : undefined;
  }

  if (!isRecord(chunk)) {
    return undefined;
  }

  return streamingContentToText(chunk.content) ?? streamingContentToText(chunk.text);
}

function extractReasoningDeltasFromStreamChunk(chunk: unknown, seen: Set<string>): string[] {
  const deltas: string[] = [];
  collectStreamingReasoningText(chunk, deltas, seen);
  return deltas;
}

function createDirectPlanningSystemPrompt(): string {
  return [
    createPlanningSystemPrompt(),
    "The full built-in planning skills are embedded below for this single chat completion request.",
    createEmbeddedPlanningSkillsPrompt()
  ].join("\n\n");
}

export function agentModelKwargsForConfig(
  config: Pick<UsableAgentLlmConfig, "baseUrl" | "model">,
  plannerOptions?: AgentPlannerOptions
): Record<string, unknown> {
  if (!isDeepSeekAgentConfig(config)) {
    return {};
  }

  const thinkingType = plannerOptions?.thinking?.type ?? "enabled";
  if (thinkingType === "disabled") {
    return {
      extra_body: {
        thinking: {
          type: "disabled"
        }
      }
    };
  }

  return {
    extra_body: {
      thinking: {
        type: "enabled"
      }
    },
    reasoning_effort: plannerOptions?.reasoningEffort ?? "high"
  };
}

function normalizeAgentPlannerOptions(input: unknown): AgentPlannerOptions | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const thinkingType = parseAgentThinkingType(input.thinking);
  const reasoningEffort = parseAgentReasoningEffort(input.reasoningEffort);
  if (!thinkingType && !reasoningEffort) {
    return undefined;
  }

  return {
    thinking: thinkingType
      ? {
          type: thinkingType
        }
      : undefined,
    reasoningEffort
  };
}

function parseAgentThinkingType(input: unknown): AgentThinkingType | undefined {
  if (isRecord(input) && typeof input.type === "string") {
    return input.type === "enabled" || input.type === "disabled" ? input.type : undefined;
  }

  return undefined;
}

function parseAgentReasoningEffort(input: unknown): AgentReasoningEffort | undefined {
  return input === "high" || input === "max" ? input : undefined;
}

function isDeepSeekAgentConfig(config: Pick<UsableAgentLlmConfig, "baseUrl" | "model">): boolean {
  const model = config.model.trim().toLowerCase();
  const baseUrl = config.baseUrl?.trim().toLowerCase() ?? "";
  return model.startsWith("deepseek-") || baseUrl.includes("deepseek.");
}

export function parseGenerationPlanDefaults(input: unknown): GenerationPlanDefaultsParseResult {
  if (input === undefined || input === null) {
    return {
      ok: true,
      defaults: {
        size: DEFAULT_PLAN_SIZE,
        quality: DEFAULT_PLAN_QUALITY,
        outputFormat: DEFAULT_PLAN_OUTPUT_FORMAT,
        count: DEFAULT_PLAN_COUNT
      }
    };
  }

  if (!isRecord(input)) {
    return {
      ok: false,
      code: "invalid_plan_defaults",
      message: "Agent defaults must be a JSON object."
    };
  }

  const size = parseOptionalImageSize(input.size) ?? DEFAULT_PLAN_SIZE;
  const sizeValidation = validateSceneImageSize({ size });
  if (!sizeValidation.ok) {
    return {
      ok: false,
      code: "invalid_plan_defaults",
      message: sizeValidation.message
    };
  }

  const quality = parseQuality(input.quality) ?? DEFAULT_PLAN_QUALITY;
  const outputFormat = parseOutputFormat(input.outputFormat) ?? DEFAULT_PLAN_OUTPUT_FORMAT;
  const count = parseGenerationCount(input.count) ?? DEFAULT_PLAN_COUNT;
  const stylePresetId = parseStylePresetId(input.stylePresetId);

  return {
    ok: true,
    defaults: {
      size: sizeValidation.size,
      quality,
      outputFormat,
      count,
      stylePresetId
    }
  };
}

export function parseSelectedCanvasReferences(
  input: unknown
): SelectedReferencesParseResult {
  if (input === undefined || input === null) {
    return {
      ok: true,
      references: []
    };
  }

  if (!Array.isArray(input)) {
    return {
      ok: false,
      code: "invalid_selected_references",
      message: "Selected canvas references must be an array."
    };
  }

  if (input.length > MAX_AGENT_SELECTED_REFERENCES) {
    return {
      ok: false,
      code: "too_many_selected_references",
      message: `Select at most ${MAX_AGENT_SELECTED_REFERENCES} canvas references for Agent planning.`
    };
  }

  const references: AgentSelectedCanvasReference[] = [];
  for (const [index, rawReference] of input.entries()) {
    if (!isRecord(rawReference)) {
      return {
        ok: false,
        code: "invalid_selected_references",
        message: `Selected reference at index ${index} must be an object.`
      };
    }

    const id = stringValue(rawReference.id);
    const assetId = stringValue(rawReference.assetId);
    if (!id || !assetId) {
      return {
        ok: false,
        code: "invalid_selected_references",
        message: `Selected reference at index ${index} must include id and assetId.`
      };
    }

    references.push({
      id,
      assetId,
      label: stringValue(rawReference.label),
      width: positiveIntegerValue(rawReference.width),
      height: positiveIntegerValue(rawReference.height),
      mimeType: stringValue(rawReference.mimeType),
      dataUrl: stringValue(rawReference.dataUrl)
    });
  }

  return {
    ok: true,
    references
  };
}

export function buildPlannerUserMessage(input: {
  userText: string;
  defaults: GenerationPlanDefaults;
  selectedReferences: AgentSelectedCanvasReference[];
  supportsVision: boolean;
}): PlannerMessage {
  const referenceSummaries = input.selectedReferences.map((reference, index) =>
    formatReferenceSummary(reference, index, input.supportsVision)
  );
  const text = [
    `User request:\n${input.userText.trim()}`,
    `Current Agent defaults:\n${JSON.stringify(input.defaults)}`,
    `supportsVision: ${input.supportsVision ? "true" : "false"}`,
    'Allowed quality values: "auto", "low", "medium", "high". Allowed outputFormat values: "png", "jpeg", "webp". Omit job quality/outputFormat when using defaults.',
    referenceSummaries.length > 0
      ? `Selected canvas references, capped at ${MAX_AGENT_SELECTED_REFERENCES}:\n${referenceSummaries.join("\n")}`
      : "Selected canvas references: none",
    referenceSummaries.length > 0
      ? 'When a job uses a selected_canvas_image reference, set assetId to one of the listed handles such as "ref1", the listed id, or the listed assetId.'
      : "Do not create selected_canvas_image references because no canvas references are selected.",
    referenceSummaries.length > 0 && hasSelectedReferenceEditIntent(input.userText, input.selectedReferences.length)
      ? "Selected-image edit mode: the user is asking to work on the selected/original image(s). Preserve those images as the source. Create edit jobs with selected_canvas_image references; for each/every selected image, create one final_image job per ref with count 1 and exactly one selected_canvas_image reference. Prompts must say to edit the original directly and must forbid blank poster templates, generic geometric backgrounds, or unrelated replacement images."
      : "",
    referenceSummaries.length === 0 && hasSelectedReferenceEditIntent(input.userText, 0)
      ? 'The request appears to depend on original/selected canvas images, but none are selected. Return an AgentUserQuestion with code "missing_selected_canvas_reference".'
      : "",
    input.supportsVision
      ? "Vision mode: image data may be attached below when dataUrl is available."
      : "No-vision mode: selected images are reference handles only. Do not claim visual inspection or describe unseen image contents.",
    "Return only the strict JSON object described by the planning skill."
  ].filter(Boolean).join("\n\n");

  const imageBlocks = input.supportsVision
    ? input.selectedReferences
        .filter((reference) => typeof reference.dataUrl === "string" && reference.dataUrl.trim().length > 0)
        .map((reference) => ({
          type: "image_url" as const,
          image_url: {
            url: reference.dataUrl as string
          }
        }))
    : [];

  if (imageBlocks.length === 0) {
    return {
      role: "user",
      content: text
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text
      },
      ...imageBlocks
    ]
  };
}

function buildPlannerReflectionUserMessage(input: {
  failure: AgentPlannerFailure;
  previousOutput: string;
}): PlannerMessage {
  const issues = input.failure.issues
    ?.slice(0, PLANNER_REFLECTION_ISSUE_LIMIT)
    .map((feedbackIssue, index) => {
      const path = feedbackIssue.path ? ` path=${JSON.stringify(feedbackIssue.path)}` : "";
      return `${index + 1}. code=${feedbackIssue.code}${path}: ${feedbackIssue.message}`;
    });
  const issueSummary = issues && issues.length > 0 ? `Evaluator feedback:\n${issues.join("\n")}` : "";
  const previousOutput = input.previousOutput.trim()
    ? truncate(input.previousOutput.trim(), PLANNER_REFLECTION_OUTPUT_PREVIEW_LIMIT)
    : "(empty output)";
  const text = [
    "Self-reflection retry request.",
    "Your previous response was not accepted by the app evaluator.",
    `Evaluator code: ${input.failure.code}`,
    `Evaluator message: ${input.failure.message}`,
    issueSummary,
    "Review the original user request, the current Agent defaults, selected references, and your previous output.",
    "Think privately about what needs to change, then revise your previous response into a corrected complete response.",
    "Do not merely patch the named error; re-check the whole plan, including image count limits, references, dependencies, user intent, and output shape.",
    "Return exactly one JSON object. The first non-whitespace character must be { and the last non-whitespace character must be }.",
    'Do not include markdown, code fences, commentary, labels such as "Here is the plan", or trailing text.',
    "If the safe response is an AgentUserQuestion, return it as that single JSON object.",
    `Previous response for reflection:\n${previousOutput}`
  ].filter(Boolean).join("\n\n");

  return {
    role: "user",
    content: text
  };
}

export function parseGenerationPlanModelOutput(
  outputText: string,
  context: GenerationPlanValidationContext
): GenerationPlanValidationResult {
  const parsed = parseStrictJsonObject(outputText);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "invalid_plan_json",
      message: parsed.message,
      issues: [
        {
          code: "invalid_plan_json",
          message: parsed.message
        }
      ]
    };
  }

  return validateGenerationPlan(parsed.value, context);
}

function parsePlannerUserQuestionModelOutput(outputText: string): AgentPlannerFailure | undefined {
  const parsed = parseStrictJsonObject(outputText);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return undefined;
  }

  const kind = normalizedOptionToken(parsed.value.kind ?? parsed.value.type);
  if (kind !== "agentuserquestion" && kind !== "userquestion" && kind !== "requiresuserinput") {
    return undefined;
  }

  const rawCode = stringValue(parsed.value.code);
  const code =
    rawCode === "missing_selected_canvas_reference" || rawCode === "agent_requires_user_input"
      ? rawCode
      : "agent_requires_user_input";
  const message =
    stringValue(parsed.value.message ?? parsed.value.question ?? parsed.value.prompt) ??
    defaultAgentUserInputMessage(code);

  return {
    ok: false,
    code,
    message
  };
}

function createSelectedReferenceEditFallbackPlan(input: {
  userText: string;
  defaults: GenerationPlanDefaults;
  selectedReferences: AgentSelectedCanvasReference[];
  now: Date;
  planId: string;
}): GenerationPlan | undefined {
  const intent = selectedReferenceEditIntent(input.userText, input.selectedReferences.length);
  if (!intent.requiresSelectedImageEdit || input.selectedReferences.length === 0) {
    return undefined;
  }

  const timestamp = input.now.toISOString();
  const references = input.selectedReferences.slice(0, MAX_AGENT_SELECTED_REFERENCES);
  if (intent.allowsCombinedReferences && intent.requiresSingleCombinedOutput && references.length > MAX_REFERENCE_IMAGES) {
    return undefined;
  }

  const jobs: GenerationJob[] = intent.allowsCombinedReferences
    ? [
        {
          id: "edit_selected_combined",
          role: "final_image",
          prompt: selectedReferenceFallbackPrompt(input.userText, "Edit the selected canvas images together"),
          count: 1,
          references: references.map((reference) => selectedReferenceForFallbackJob(reference)),
          status: "queued",
          outputs: [],
          visible: true
        }
      ]
    : references.map((reference, index) => ({
        id: `edit_selected_${index + 1}`,
        role: "final_image",
        prompt: selectedReferenceFallbackPrompt(
          input.userText,
          `Edit selected canvas image ref${index + 1} directly`
        ),
        count: 1,
        references: [selectedReferenceForFallbackJob(reference)],
        status: "queued",
        outputs: [],
        visible: true
      }));

  return {
    schemaVersion: GENERATION_PLAN_SCHEMA_VERSION,
    id: input.planId,
    title: references.length > 1 ? "Edit selected images" : "Edit selected image",
    status: "awaiting_confirmation",
    defaults: input.defaults,
    jobs,
    edges: [],
    createdBy: "agent",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function validateSelectedReferenceEditRequest(
  userText: string,
  selectedReferences: AgentSelectedCanvasReference[]
): AgentPlannerFailure | undefined {
  const intent = selectedReferenceEditIntent(userText, selectedReferences.length);
  if (
    !intent.requiresSelectedImageEdit ||
    !intent.allowsCombinedReferences ||
    !intent.requiresSingleCombinedOutput ||
    selectedReferences.length <= MAX_REFERENCE_IMAGES
  ) {
    return undefined;
  }

  return {
    ok: false,
    code: "agent_requires_user_input",
    message: `This request asks to combine ${selectedReferences.length} selected images into one output, but each edit job supports at most ${MAX_REFERENCE_IMAGES} reference images. Select ${MAX_REFERENCE_IMAGES} or fewer images, or ask the Agent to split them into multiple outputs.`
  };
}

function selectedReferenceForFallbackJob(reference: AgentSelectedCanvasReference): GenerationReference {
  return {
    kind: "selected_canvas_image",
    usage: "scene",
    assetId: reference.assetId,
    label: reference.label
  };
}

function selectedReferenceFallbackPrompt(userText: string, action: string): string {
  return [
    `${action} according to the user request: ${userText}`,
    "Preserve the original image content, composition, perspective, and main subjects.",
    "Add only the requested text/design treatment on top.",
    "Do not create a blank poster template, generic geometric background, or unrelated replacement image."
  ].join(" ");
}

function validateSelectedReferenceEditPlan(
  plan: GenerationPlan,
  input: {
    userText: string;
    selectedReferences: AgentSelectedCanvasReference[];
  }
): AgentPlannerFailure | undefined {
  const intent = selectedReferenceEditIntent(input.userText, input.selectedReferences.length);
  if (!intent.requiresSelectedImageEdit) {
    return undefined;
  }

  if (input.selectedReferences.length === 0) {
    return {
      ok: false,
      code: "missing_selected_canvas_reference",
      message: defaultAgentUserInputMessage("missing_selected_canvas_reference")
    };
  }

  const finalSelectedReferenceAssetIds = selectedReferenceAssetIdsForFinalJobs(plan);
  if (finalSelectedReferenceAssetIds.size === 0) {
    return {
      ok: false,
      code: "agent_requires_user_input",
      message: defaultAgentUserInputMessage("agent_requires_user_input")
    };
  }

  if (!intent.requiresEverySelectedReference || intent.allowsCombinedReferences) {
    return undefined;
  }

  const missingReferences = input.selectedReferences.filter(
    (reference) => !finalSelectedReferenceAssetIds.has(reference.assetId)
  );
  if (missingReferences.length === 0) {
    return undefined;
  }

  return {
    ok: false,
    code: "agent_requires_user_input",
    message: `Agent needs a plan that covers every selected image. Missing: ${missingReferences
      .map((reference, index) => reference.label ?? reference.assetId ?? `ref${index + 1}`)
      .join(", ")}.`
  };
}

function selectedReferenceAssetIdsForFinalJobs(plan: GenerationPlan): Set<string> {
  const assetIds = new Set<string>();
  for (const job of plan.jobs) {
    if (job.role !== "final_image") {
      continue;
    }
    for (const reference of job.references) {
      if (reference.kind === "selected_canvas_image" && reference.assetId) {
        assetIds.add(reference.assetId);
      }
    }
  }

  return assetIds;
}

function selectedReferenceEditIntent(
  userText: string,
  selectedReferenceCount: number
): {
  requiresSelectedImageEdit: boolean;
  requiresEverySelectedReference: boolean;
  allowsCombinedReferences: boolean;
  requiresSingleCombinedOutput: boolean;
} {
  const text = normalizeIntentText(userText);
  const hasSelectedContext =
    selectedReferenceCount > 0 ||
    /原图|原始图|原本|选中|当前图|这张图|这些图|图片上|图上|画面上|每张图|每一张|所有图|全部图|selected image|selected images|original image|source image|current image|each image|every image|all selected/u.test(text);
  const hasEditAction =
    /编辑|修改|调整|改成|改为|优化|润色|重绘|修图|保留|基于|基础上|加字|加上字|加文字|配字|配上字|配文字|配上文字|配文|文案|标题|字幕|字标|字体|排版|贴字|一致|统一|edit|modify|retouch|polish|redesign|based on|from the original|add text|text overlay|caption|title|typography|copy|font|consistent|unify/u.test(text);
  const requiresEverySelectedReference =
    /每张|每一张|每个|每一个|所有选中|全部选中|所有图|全部图|each image|every image|all selected|all images|for each/u.test(text);
  const allowsCombinedReferences =
    /组合|合成|拼贴|拼成|融合|放在一起|对比|一张海报|combine|merge|collage|montage|together|one poster|single poster|comparison/u.test(text);
  const requiresSingleCombinedOutput =
    /合成一张|拼成一张|做成一张|一张图|一张海报|one image|single image|one poster|single poster/u.test(text);

  return {
    requiresSelectedImageEdit: hasSelectedContext && (hasEditAction || allowsCombinedReferences),
    requiresEverySelectedReference,
    allowsCombinedReferences,
    requiresSingleCombinedOutput
  };
}

function hasSelectedReferenceEditIntent(userText: string, selectedReferenceCount = 0): boolean {
  return selectedReferenceEditIntent(userText, selectedReferenceCount).requiresSelectedImageEdit;
}

function normalizeIntentText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function defaultAgentUserInputMessage(code: "missing_selected_canvas_reference" | "agent_requires_user_input"): string {
  return code === "missing_selected_canvas_reference"
    ? "Please select the original canvas image(s) to edit, then send the Agent request again."
    : "Please confirm whether the Agent should edit the selected original image(s) directly or generate a new design image.";
}

export function validateGenerationPlan(
  input: unknown,
  context: GenerationPlanValidationContext
): GenerationPlanValidationResult {
  const issues: GenerationPlanValidationIssue[] = [];
  const now = (context.now ?? new Date()).toISOString();

  if (!isRecord(input)) {
    return invalidPlan("invalid_plan_schema", "GenerationPlan must be a JSON object.");
  }

  if (input.schemaVersion !== GENERATION_PLAN_SCHEMA_VERSION) {
    issues.push(issue("invalid_plan_schema", `schemaVersion must be ${GENERATION_PLAN_SCHEMA_VERSION}.`, "schemaVersion"));
  }

  const title = stringValue(input.title);
  if (!title) {
    issues.push(issue("invalid_plan_schema", "Plan title is required.", "title"));
  }

  if (input.status !== "awaiting_confirmation") {
    issues.push(
      issue(
        "invalid_plan_schema",
        'Plan status must be "awaiting_confirmation" before user confirmation.',
        "status"
      )
    );
  }

  if (input.createdBy !== "agent") {
    issues.push(issue("invalid_plan_schema", 'createdBy must be "agent".', "createdBy"));
  }

  const defaults = parsePlanDefaultsFromPlan(input.defaults, context.defaults, issues);
  const jobs = parsePlanJobs(input.jobs, defaults, context, issues);
  const edges = parsePlanEdges(input.edges, issues);

  if (issues.length === 0) {
    validatePlanGraph(jobs, edges, context.selectedReferences ?? [], issues);
  }

  if (issues.length > 0) {
    return invalidPlan(issues[0]?.code ?? "invalid_plan_schema", issues[0]?.message ?? "Invalid GenerationPlan.", issues);
  }

  const plan: GenerationPlan = {
    schemaVersion: GENERATION_PLAN_SCHEMA_VERSION,
    id: context.planId ?? stringValue(input.id) ?? `plan-${randomUUID()}`,
    title: title ?? "Untitled plan",
    status: "awaiting_confirmation",
    defaults,
    jobs,
    edges,
    createdBy: "agent",
    createdAt: isoStringValue(input.createdAt) ?? now,
    updatedAt: now
  };

  return {
    ok: true,
    plan
  };
}

export function extractTextFromAgentResult(result: unknown): string | undefined {
  if (typeof result === "string") {
    return nonEmptyString(result);
  }

  if (!isRecord(result)) {
    return undefined;
  }

  const directOutput = contentToText(result.output) ?? contentToText(result.structuredResponse);
  if (directOutput) {
    return directOutput;
  }

  if (Array.isArray(result.messages)) {
    for (let index = result.messages.length - 1; index >= 0; index -= 1) {
      const message = result.messages[index];
      if (!isRecord(message)) {
        continue;
      }
      const text = contentToText(message.content);
      if (text) {
        return text;
      }
    }
  }

  return undefined;
}

export function extractReasoningFromAgentResult(result: unknown): string | undefined {
  const chunks: string[] = [];
  const seen = new Set<string>();

  collectReasoningText(result, chunks, seen);
  if (isRecord(result) && Array.isArray(result.messages)) {
    for (const message of result.messages) {
      collectReasoningText(message, chunks, seen);
    }
  }

  return nonEmptyString(chunks.join("\n\n"));
}

function collectReasoningText(value: unknown, chunks: string[], seen: Set<string>): void {
  if (!isRecord(value)) {
    return;
  }

  for (const candidate of reasoningCandidates(value)) {
    const text = reasoningContentToText(candidate);
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    chunks.push(text);
  }
}

function collectStreamingReasoningText(value: unknown, chunks: string[], seen: Set<string>): void {
  if (!isRecord(value)) {
    return;
  }

  for (const candidate of reasoningCandidates(value)) {
    const text = reasoningContentToStreamingText(candidate);
    if (text === undefined || text.trim().length === 0 || seen.has(text)) {
      continue;
    }

    seen.add(text);
    chunks.push(text);
  }
}

function reasoningCandidates(value: Record<string, unknown>): unknown[] {
  return [
    value.reasoning_content,
    value.reasoning,
    isRecord(value.additional_kwargs) ? value.additional_kwargs.reasoning_content : undefined,
    isRecord(value.additional_kwargs) ? value.additional_kwargs.reasoning : undefined,
    isRecord(value.response_metadata) ? value.response_metadata.reasoning_content : undefined,
    isRecord(value.response_metadata) ? value.response_metadata.reasoning : undefined
  ];
}

function reasoningContentToText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => reasoningContentToText(item) ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    return nonEmptyString(text);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const direct = contentToText(value.text) ?? contentToText(value.content) ?? contentToText(value.summary);
  if (direct) {
    return direct;
  }

  return Array.isArray(value.summary) ? reasoningContentToText(value.summary) : undefined;
}

function reasoningContentToStreamingText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => reasoningContentToStreamingText(item) ?? "")
      .filter((item) => item.length > 0)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const direct =
    streamingContentToText(value.text) ?? streamingContentToText(value.content) ?? streamingContentToText(value.summary);
  if (direct !== undefined) {
    return direct;
  }

  return Array.isArray(value.summary) ? reasoningContentToStreamingText(value.summary) : undefined;
}

function parsePlanDefaultsFromPlan(
  input: unknown,
  fallback: GenerationPlanDefaults,
  issues: GenerationPlanValidationIssue[]
): GenerationPlanDefaults {
  if (input === undefined || input === null) {
    return fallback;
  }

  if (!isRecord(input)) {
    issues.push(issue("invalid_plan_defaults", "Plan defaults must be an object.", "defaults"));
    return fallback;
  }

  const size = parseOptionalImageSize(input.size) ?? fallback.size;
  const sizeValidation = validateSceneImageSize({ size });
  if (!sizeValidation.ok) {
    issues.push(issue("invalid_plan_defaults", sizeValidation.message, "defaults.size"));
  }

  const quality = parseQuality(input.quality);

  const outputFormat = parseOutputFormat(input.outputFormat);

  const count = parseGenerationCount(input.count);
  if (input.count !== undefined && !count) {
    issues.push(
      issue("invalid_plan_defaults", `Plan default count must be an integer from 1 to ${MAX_GENERATION_PLAN_IMAGES}.`, "defaults.count")
    );
  }

  const stylePresetId = parseStylePresetId(input.stylePresetId);
  if (input.stylePresetId !== undefined && !stylePresetId) {
    issues.push(issue("invalid_plan_defaults", "Plan default stylePresetId is unsupported.", "defaults.stylePresetId"));
  }

  return {
    size: sizeValidation.ok ? sizeValidation.size : fallback.size,
    quality: quality ?? fallback.quality,
    outputFormat: outputFormat ?? fallback.outputFormat,
    count: count ?? fallback.count,
    stylePresetId: stylePresetId ?? fallback.stylePresetId
  };
}

function parsePlanJobs(
  input: unknown,
  defaults: GenerationPlanDefaults,
  context: GenerationPlanValidationContext,
  issues: GenerationPlanValidationIssue[]
): GenerationJob[] {
  if (!Array.isArray(input) || input.length === 0) {
    issues.push(issue("invalid_plan_job", "GenerationPlan must include at least one job.", "jobs"));
    return [];
  }

  const jobs: GenerationJob[] = [];
  const seenJobIds = new Set<string>();
  for (const [index, rawJob] of input.entries()) {
    const path = `jobs.${index}`;
    if (!isRecord(rawJob)) {
      issues.push(issue("invalid_plan_job", "GenerationJob must be an object.", path));
      continue;
    }

    const id = stringValue(rawJob.id);
    if (!id) {
      issues.push(issue("invalid_plan_job", "GenerationJob id is required.", `${path}.id`));
      continue;
    }
    if (seenJobIds.has(id)) {
      issues.push(issue("invalid_plan_job", `Duplicate GenerationJob id "${id}".`, `${path}.id`));
      continue;
    }
    seenJobIds.add(id);

    const role = parseJobRole(rawJob.role);
    if (!role) {
      issues.push(issue("invalid_plan_job", "GenerationJob role is unsupported.", `${path}.role`));
    }

    const prompt = stringValue(rawJob.prompt);
    if (!prompt) {
      issues.push(issue("invalid_plan_job", "GenerationJob prompt is required.", `${path}.prompt`));
    }

    const count = parseGenerationCount(rawJob.count ?? defaults.count);
    if (!count) {
      issues.push(
        issue("invalid_plan_job", `GenerationJob count must be an integer from 1 to ${MAX_GENERATION_PLAN_IMAGES}.`, `${path}.count`)
      );
    }

    const status = rawJob.status === undefined ? "queued" : parseJobStatus(rawJob.status);
    if (!status || status !== "queued") {
      issues.push(issue("invalid_plan_job", 'GenerationJob status must be "queued" before execution.', `${path}.status`));
    }

    const size = isOmittedOptionalValue(rawJob.size) ? undefined : parseOptionalImageSize(rawJob.size);
    const resolvedSize = size ?? defaults.size;
    const sizeValidation = validateSceneImageSize({ size: resolvedSize });
    if (size && !sizeValidation.ok) {
      issues.push(issue("invalid_plan_job", sizeValidation.message, `${path}.size`));
    }

    const quality = rawJob.quality === undefined ? undefined : parseQuality(rawJob.quality);

    const outputFormat = rawJob.outputFormat === undefined ? undefined : parseOutputFormat(rawJob.outputFormat);

    const references = parseJobReferences(rawJob.references, `${path}.references`, context.selectedReferences ?? [], issues);
    const visible = rawJob.visible === undefined ? true : rawJob.visible === true;
    if (rawJob.visible !== undefined && typeof rawJob.visible !== "boolean") {
      issues.push(issue("invalid_plan_job", "GenerationJob visible must be boolean.", `${path}.visible`));
    }
    if (role && role.endsWith("_anchor") && !visible) {
      issues.push(issue("invalid_plan_job", "Generated anchor jobs must be visible.", `${path}.visible`));
    }

    if (rawJob.outputs !== undefined && (!Array.isArray(rawJob.outputs) || rawJob.outputs.length > 0)) {
      issues.push(issue("invalid_plan_job", "GenerationJob outputs must be empty before execution.", `${path}.outputs`));
    }

    jobs.push({
      id,
      role: role ?? "final_image",
      prompt: prompt ?? "",
      count: count ?? 1,
      size: sizeValidation.ok && size ? sizeValidation.size : undefined,
      quality,
      outputFormat,
      references,
      status: "queued",
      outputs: [],
      visible,
      error: stringValue(rawJob.error)
    });
  }

  const totalImageCount = jobs.reduce((total, job) => total + job.count, 0);
  if (totalImageCount > MAX_GENERATION_PLAN_IMAGES) {
    issues.push(
      issue(
        "generation_plan_limit_exceeded",
        `GenerationPlan requests ${totalImageCount} images; the cap is ${MAX_GENERATION_PLAN_IMAGES}.`,
        "jobs"
      )
    );
  }

  for (const [index, job] of jobs.entries()) {
    if (job.references.length > MAX_GENERATION_JOB_REFERENCES) {
      issues.push(
        issue(
          "generation_job_reference_limit_exceeded",
          `GenerationJob "${job.id}" uses ${job.references.length} references; the cap is ${MAX_GENERATION_JOB_REFERENCES}.`,
          `jobs.${index}.references`
        )
      );
    }
  }

  for (const [index, job] of jobs.entries()) {
    if (job.role === "character_anchor" && job.count !== 1) {
      issues.push(
        issue("invalid_dependency_source_count", "Character anchor jobs must generate exactly one visible image.", `jobs.${index}.count`)
      );
    }
  }

  return jobs;
}

function parseJobReferences(
  input: unknown,
  path: string,
  selectedReferences: AgentSelectedCanvasReference[],
  issues: GenerationPlanValidationIssue[]
): GenerationReference[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input)) {
    issues.push(issue("invalid_plan_reference", "GenerationJob references must be an array.", path));
    return [];
  }

  const references: GenerationReference[] = [];
  for (const [index, rawReference] of input.entries()) {
    const referencePath = `${path}.${index}`;
    if (!isRecord(rawReference)) {
      issues.push(issue("invalid_plan_reference", "GenerationReference must be an object.", referencePath));
      continue;
    }

    const normalizedSelectedReference = normalizeSelectedCanvasReference(rawReference, selectedReferences);
    const kind =
      parseReferenceKind(rawReference.kind ?? rawReference.type) ??
      inferReferenceKind(rawReference, normalizedSelectedReference);
    if (!kind) {
      issues.push(issue("invalid_plan_reference", "GenerationReference kind is unsupported.", `${referencePath}.kind`));
    }

    const usage = parseReferenceUsage(rawReference.usage) ?? "other";
    if (rawReference.usage !== undefined && !parseReferenceUsage(rawReference.usage)) {
      issues.push(issue("invalid_plan_reference", "GenerationReference usage is unsupported.", `${referencePath}.usage`));
    }

    const referenceKind = kind ?? "selected_canvas_image";
    const selectedReference = referenceKind === "selected_canvas_image" ? normalizedSelectedReference : undefined;
    if (referenceKind === "selected_canvas_image" && selectedReferences.length === 0 && !selectedReference) {
      continue;
    }

    references.push({
      kind: referenceKind,
      usage,
      assetId: selectedReference?.assetId ?? stringValue(rawReference.assetId ?? rawReference.id),
      jobId: stringValue(rawReference.jobId ?? rawReference.sourceJobId ?? rawReference.fromJobId),
      outputId: stringValue(rawReference.outputId),
      label: stringValue(rawReference.label) ?? selectedReference?.label
    });
  }

  return references;
}

function inferReferenceKind(
  rawReference: Record<string, unknown>,
  normalizedSelectedReference: AgentSelectedCanvasReference | undefined
): GenerationReferenceKind | undefined {
  if (
    stringValue(rawReference.jobId ?? rawReference.sourceJobId ?? rawReference.fromJobId) ||
    stringValue(rawReference.outputId)
  ) {
    return "generated_output";
  }

  if (normalizedSelectedReference || selectedReferenceAliasCandidates(rawReference).length > 0) {
    return "selected_canvas_image";
  }

  return undefined;
}

function normalizeSelectedCanvasReference(
  rawReference: Record<string, unknown>,
  selectedReferences: AgentSelectedCanvasReference[]
): AgentSelectedCanvasReference | undefined {
  if (selectedReferences.length === 0) {
    return undefined;
  }

  const aliases = createSelectedReferenceAliasMap(selectedReferences);
  for (const candidate of selectedReferenceAliasCandidates(rawReference)) {
    const aliasKey = normalizeReferenceAliasKey(candidate);
    const selectedReference = aliases.get(aliasKey);
    if (selectedReference) {
      return selectedReference;
    }
    if (isGenericSelectedReferenceAlias(aliasKey)) {
      return selectedReferences[0];
    }
  }

  return selectedReferences[0];
}

function createSelectedReferenceAliasMap(
  selectedReferences: AgentSelectedCanvasReference[]
): Map<string, AgentSelectedCanvasReference> {
  const aliases = new Map<string, AgentSelectedCanvasReference>();
  selectedReferences.forEach((reference, index) => {
    const position = index + 1;
    addSelectedReferenceAlias(aliases, reference, reference.id);
    addSelectedReferenceAlias(aliases, reference, reference.assetId);
    addSelectedReferenceAlias(aliases, reference, reference.label);
    addSelectedReferenceAlias(aliases, reference, `${position}`);
    addSelectedReferenceAlias(aliases, reference, `ref${position}`);
    addSelectedReferenceAlias(aliases, reference, `ref-${position}`);
    addSelectedReferenceAlias(aliases, reference, `ref_${position}`);
    addSelectedReferenceAlias(aliases, reference, `reference-${position}`);
    addSelectedReferenceAlias(aliases, reference, `reference_${position}`);
    addSelectedReferenceAlias(aliases, reference, `selected-${position}`);
    addSelectedReferenceAlias(aliases, reference, `selected_${position}`);
    addSelectedReferenceAlias(aliases, reference, `canvas-image-${position}`);
    addSelectedReferenceAlias(aliases, reference, `canvas_image_${position}`);
    addSelectedReferenceAlias(aliases, reference, `selected-canvas-image-${position}`);
    addSelectedReferenceAlias(aliases, reference, `selected_canvas_image_${position}`);
  });

  if (selectedReferences.length === 1) {
    const [reference] = selectedReferences;
    addSelectedReferenceAlias(aliases, reference, "ref");
    addSelectedReferenceAlias(aliases, reference, "reference");
    addSelectedReferenceAlias(aliases, reference, "selected");
    addSelectedReferenceAlias(aliases, reference, "selected image");
    addSelectedReferenceAlias(aliases, reference, "selected_image");
    addSelectedReferenceAlias(aliases, reference, "selected canvas image");
    addSelectedReferenceAlias(aliases, reference, "selected_canvas_image");
    addSelectedReferenceAlias(aliases, reference, "canvas reference");
    addSelectedReferenceAlias(aliases, reference, "canvas_reference");
  }

  return aliases;
}

function addSelectedReferenceAlias(
  aliases: Map<string, AgentSelectedCanvasReference>,
  reference: AgentSelectedCanvasReference,
  value: string | undefined
): void {
  const key = normalizeReferenceAliasKey(value);
  if (key && !aliases.has(key)) {
    aliases.set(key, reference);
  }
}

function selectedReferenceAliasCandidates(rawReference: Record<string, unknown>): string[] {
  const candidates = [
    stringValue(rawReference.assetId),
    stringValue(rawReference.id),
    stringValue(rawReference.referenceId),
    stringValue(rawReference.referenceAssetId),
    stringValue(rawReference.selectedReferenceId),
    stringValue(rawReference.selectedReferenceHandle),
    stringValue(rawReference.referenceHandle),
    stringValue(rawReference.handle),
    stringValue(rawReference.label),
    stringValue(rawReference.name)
  ];

  const index = positiveIntegerValue(rawReference.index ?? rawReference.position);
  if (index) {
    candidates.push(`${index}`);
    candidates.push(`ref${index}`);
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function normalizeReferenceAliasKey(value: string | undefined): string {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function isGenericSelectedReferenceAlias(value: string): boolean {
  return (
    value === "ref" ||
    value === "reference" ||
    value === "selected" ||
    value === "selected image" ||
    value === "selected_image" ||
    value === "selected canvas image" ||
    value === "selected_canvas_image" ||
    value === "canvas reference" ||
    value === "canvas_reference"
  );
}

function parsePlanEdges(input: unknown, issues: GenerationPlanValidationIssue[]): GenerationDependencyEdge[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input)) {
    issues.push(issue("invalid_plan_edge", "GenerationPlan edges must be an array.", "edges"));
    return [];
  }

  const edges: GenerationDependencyEdge[] = [];
  const seenEdges = new Set<string>();
  for (const [index, rawEdge] of input.entries()) {
    const path = `edges.${index}`;
    if (!isRecord(rawEdge)) {
      issues.push(issue("invalid_plan_edge", "GenerationDependencyEdge must be an object.", path));
      continue;
    }

    const fromJobId = stringValue(rawEdge.fromJobId ?? rawEdge.from ?? rawEdge.sourceJobId ?? rawEdge.source);
    const toJobId = stringValue(rawEdge.toJobId ?? rawEdge.to ?? rawEdge.targetJobId ?? rawEdge.target);
    if (!fromJobId || !toJobId) {
      issues.push(issue("invalid_plan_edge", "Dependency edge requires fromJobId and toJobId.", path));
      continue;
    }
    if (fromJobId === toJobId) {
      issues.push(issue("generation_dependency_cycle", "Dependency edge cannot point to the same job.", path));
      continue;
    }

    const edgeKey = `${fromJobId}->${toJobId}`;
    if (seenEdges.has(edgeKey)) {
      continue;
    }
    seenEdges.add(edgeKey);
    edges.push({ fromJobId, toJobId });
  }

  return edges;
}

function validatePlanGraph(
  jobs: GenerationJob[],
  edges: GenerationDependencyEdge[],
  selectedReferences: AgentSelectedCanvasReference[],
  issues: GenerationPlanValidationIssue[]
): void {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const selectedReferenceKeys = new Set<string>();
  for (const reference of selectedReferences) {
    selectedReferenceKeys.add(reference.id);
    selectedReferenceKeys.add(reference.assetId);
  }

  const downstreamSourceJobIds = new Set<string>();
  for (const [index, edge] of edges.entries()) {
    if (!jobsById.has(edge.fromJobId)) {
      issues.push(
        issue("unknown_generation_job_reference", `Dependency source job "${edge.fromJobId}" does not exist.`, `edges.${index}.fromJobId`)
      );
    }
    if (!jobsById.has(edge.toJobId)) {
      issues.push(
        issue("unknown_generation_job_reference", `Dependency target job "${edge.toJobId}" does not exist.`, `edges.${index}.toJobId`)
      );
    }
    downstreamSourceJobIds.add(edge.fromJobId);
  }

  for (const [jobIndex, job] of jobs.entries()) {
    for (const [referenceIndex, reference] of job.references.entries()) {
      const path = `jobs.${jobIndex}.references.${referenceIndex}`;
      if (reference.kind === "selected_canvas_image") {
        const selectedKey = reference.assetId;
        if (!selectedKey || !selectedReferenceKeys.has(selectedKey)) {
          issues.push(
            issue(
              "unknown_generation_job_reference",
              "selected_canvas_image reference must use one of the selected canvas reference handles.",
              path
            )
          );
        }
        continue;
      }

      const sourceJobId = reference.jobId;
      if (!sourceJobId || !jobsById.has(sourceJobId)) {
        issues.push(
          issue("unknown_generation_job_reference", "generated_output reference must point to a known source job.", path)
        );
        continue;
      }

      downstreamSourceJobIds.add(sourceJobId);
      if (!edges.some((edge) => edge.fromJobId === sourceJobId && edge.toJobId === job.id)) {
        issues.push(
          issue(
            "invalid_plan_edge",
            "generated_output references must include a matching dependency edge.",
            path
          )
        );
      }
    }
  }

  for (const sourceJobId of downstreamSourceJobIds) {
    const sourceJob = jobsById.get(sourceJobId);
    if (sourceJob && sourceJob.count !== 1) {
      issues.push(
        issue(
          "invalid_dependency_source_count",
          `Dependency source job "${sourceJobId}" must have count exactly 1.`,
          `jobs.${jobs.indexOf(sourceJob)}.count`
        )
      );
    }
  }

  if (hasDependencyCycle(jobs, edges)) {
    issues.push(issue("generation_dependency_cycle", "GenerationPlan dependencies must not contain a cycle.", "edges"));
  }
}

function hasDependencyCycle(jobs: GenerationJob[], edges: GenerationDependencyEdge[]): boolean {
  const graph = new Map<string, string[]>();
  for (const job of jobs) {
    graph.set(job.id, []);
  }
  for (const edge of edges) {
    graph.get(edge.fromJobId)?.push(edge.toJobId);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (jobId: string): boolean => {
    if (visiting.has(jobId)) {
      return true;
    }
    if (visited.has(jobId)) {
      return false;
    }
    visiting.add(jobId);
    for (const downstreamJobId of graph.get(jobId) ?? []) {
      if (visit(downstreamJobId)) {
        return true;
      }
    }
    visiting.delete(jobId);
    visited.add(jobId);
    return false;
  };

  return jobs.some((job) => visit(job.id));
}

function formatReferenceSummary(
  reference: AgentSelectedCanvasReference,
  index: number,
  supportsVision: boolean
): string {
  const size = reference.width && reference.height ? `${reference.width}x${reference.height}` : "unknown-size";
  const label = reference.label ? ` label="${truncate(reference.label, 120)}"` : "";
  const mimeType = reference.mimeType ? ` mimeType="${truncate(reference.mimeType, 80)}"` : "";
  const vision = supportsVision && reference.dataUrl ? "visionAttachment=provided" : "visionAttachment=not_provided";

  return `- ref${index + 1}: id="${reference.id}" assetId="${reference.assetId}" size=${size}${label}${mimeType} ${vision}`;
}

function parseStrictJsonObject(input: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return {
      ok: false,
      message: "Agent output must be a single JSON object with no markdown or extra text."
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(trimmed) as unknown
    };
  } catch {
    return {
      ok: false,
      message: "Agent output was not valid JSON."
    };
  }
}

function invalidPlan(
  code: GenerationPlanValidationCode,
  message: string,
  issues?: GenerationPlanValidationIssue[]
): GenerationPlanValidationResult {
  return {
    ok: false,
    code,
    message,
    issues: issues ?? [issue(code, message)]
  };
}

function plannerRequestFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? sanitizePlannerErrorText(error.message) : "";
  return detail ? `Agent planner request failed: ${detail}` : "Agent planner request failed.";
}

function sanitizePlannerErrorText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._~+/=-]+/gu, "sk-[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 360);
}

function issue(
  code: GenerationPlanValidationCode,
  message: string,
  path?: string
): GenerationPlanValidationIssue {
  return {
    code,
    message,
    path
  };
}

function parseOptionalImageSize(value: unknown): ImageSize | undefined {
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)\s*[xX×*]\s*(\d+)$/u);
    if (!match) {
      return undefined;
    }

    const width = positiveIntegerValue(match[1]);
    const height = positiveIntegerValue(match[2]);
    return width && height ? { width, height } : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const width = positiveIntegerValue(value.width);
  const height = positiveIntegerValue(value.height);
  return width && height ? { width, height } : undefined;
}

function isOmittedOptionalValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function parseQuality(value: unknown): ImageQuality | undefined {
  const normalized = normalizedOptionToken(value);
  if (!normalized) {
    return undefined;
  }

  const qualityAliases: Record<string, ImageQuality> = {
    automatic: "auto",
    default: "auto",
    standard: "medium",
    normal: "medium",
    balanced: "medium",
    draft: "low",
    fast: "low",
    quick: "low",
    hd: "high",
    highquality: "high",
    best: "high",
    premium: "high"
  };
  const quality = qualityAliases[normalized] ?? normalized;
  return IMAGE_QUALITIES.includes(quality as ImageQuality) ? (quality as ImageQuality) : undefined;
}

function parseOutputFormat(value: unknown): OutputFormat | undefined {
  const normalized = normalizedOptionToken(value);
  if (!normalized) {
    return undefined;
  }

  const outputFormatAliases: Record<string, OutputFormat> = {
    jpg: "jpeg",
    imagejpeg: "jpeg",
    imagejpg: "jpeg",
    imagepng: "png",
    imagewebp: "webp"
  };
  const outputFormat = outputFormatAliases[normalized] ?? normalized;
  return OUTPUT_FORMATS.includes(outputFormat as OutputFormat) ? (outputFormat as OutputFormat) : undefined;
}

function parseGenerationCount(value: unknown): number | undefined {
  const count = positiveIntegerValue(value);
  return count && count <= MAX_GENERATION_PLAN_IMAGES ? count : undefined;
}

function normalizedOptionToken(value: unknown): string | undefined {
  if (isRecord(value)) {
    return normalizedOptionToken(value.value ?? value.id ?? value.name ?? value.label);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "");
  return normalized || undefined;
}

function parseStylePresetId(value: unknown): StylePresetId | undefined {
  return typeof value === "string" && STYLE_PRESETS.some((preset) => preset.id === value)
    ? (value as StylePresetId)
    : undefined;
}

function parseJobRole(value: unknown): GenerationJobRole | undefined {
  return typeof value === "string" && GENERATION_JOB_ROLES.includes(value as GenerationJobRole)
    ? (value as GenerationJobRole)
    : undefined;
}

function parseJobStatus(value: unknown): GenerationJobStatus | undefined {
  return typeof value === "string" && GENERATION_JOB_STATUSES.includes(value as GenerationJobStatus)
    ? (value as GenerationJobStatus)
    : undefined;
}

function parseReferenceKind(value: unknown): GenerationReferenceKind | undefined {
  const normalized = normalizedOptionToken(value);
  if (!normalized) {
    return undefined;
  }

  const kindAliases: Record<string, GenerationReferenceKind> = {
    selectedcanvasimage: "selected_canvas_image",
    selectedcanvasreference: "selected_canvas_image",
    selectedimage: "selected_canvas_image",
    selectedimagereference: "selected_canvas_image",
    canvasimage: "selected_canvas_image",
    canvasimagereference: "selected_canvas_image",
    canvasreference: "selected_canvas_image",
    referenceimage: "selected_canvas_image",
    generatedoutput: "generated_output",
    generatedimage: "generated_output",
    generatedimagereference: "generated_output",
    joboutput: "generated_output",
    sourcejoboutput: "generated_output",
    sourceoutput: "generated_output",
    upstreamoutput: "generated_output"
  };

  const kind = kindAliases[normalized] ?? normalized;
  return GENERATION_REFERENCE_KINDS.includes(kind as GenerationReferenceKind) ? (kind as GenerationReferenceKind) : undefined;
}

function parseReferenceUsage(value: unknown): GenerationReferenceUsage | undefined {
  return typeof value === "string" && GENERATION_REFERENCE_USAGES.includes(value as GenerationReferenceUsage)
    ? (value as GenerationReferenceUsage)
    : undefined;
}

function contentToText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item) && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .join("\n")
      .trim();
    return nonEmptyString(text);
  }

  return undefined;
}

function streamingContentToText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }

  if (Array.isArray(value)) {
    let text = "";
    for (const item of value) {
      if (typeof item === "string") {
        text += item;
      } else if (isRecord(item) && typeof item.text === "string") {
        text += item.text;
      }
    }

    return text.length > 0 ? text : undefined;
  }

  return undefined;
}

function nonEmptyString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoStringValue(value: unknown): string | undefined {
  const string = stringValue(value);
  if (!string) {
    return undefined;
  }

  const timestamp = Date.parse(string);
  return Number.isFinite(timestamp) ? string : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }

  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
