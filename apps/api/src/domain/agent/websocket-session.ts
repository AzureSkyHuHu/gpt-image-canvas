import { randomUUID } from "node:crypto";
import type { WSEvents, WSContext, WSMessageReceive } from "hono/ws";
import type {
  AgentClientMessage,
  AgentClientMessageType,
  AgentErrorEvent,
  AgentServerEvent,
  GenerationPlan
} from "../contracts.js";
import type { DataOwner } from "../auth/data-owner.js";
import { getUsableAgentLlmConfig } from "./config.js";
import {
  executeGenerationPlan,
  isExecutableGenerationPlan,
  type StoredAgentGenerationPlan
} from "./executor.js";
import { createGenerationPlan } from "./planner.js";

const OPEN_READY_STATE = 1;
const AGENT_SOCKET_SERVER_HEARTBEAT_INTERVAL_MS = 10_000;
const AGENT_ACTIVE_DISCONNECT_GRACE_MS = 2 * 60 * 60 * 1000;
const AGENT_IDLE_DISCONNECT_GRACE_MS = 5 * 60 * 1000;
const AGENT_PENDING_EVENT_LIMIT = 500;
const CLIENT_MESSAGE_TYPES: readonly AgentClientMessageType[] = [
  "user_message",
  "revise_plan",
  "execute_plan",
  "cancel_run",
  "retry_failed",
  "ping"
];
const AGENT_WORK_MESSAGE_TYPES = new Set<AgentClientMessageType>([
  "user_message",
  "revise_plan",
  "execute_plan",
  "retry_failed"
]);

interface ActiveAgentRun {
  id: string;
  controller: AbortController;
  cancelled: boolean;
}

interface AgentSocketSession {
  connectionId: string;
  owner: DataOwner;
  ws?: WSContext;
  activeRun?: ActiveAgentRun;
  plans: Map<string, StoredAgentGenerationPlan>;
  pendingEvents: AgentServerEvent[];
  keepAliveTimer?: ReturnType<typeof setInterval>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

interface ParsedMessage {
  ok: true;
  value: AgentClientMessage;
}

interface MessageParseError {
  ok: false;
  code: string;
  message: string;
}

const sessions = new Map<string, AgentSocketSession>();

export function createAgentWebSocketEvents(owner: DataOwner, connectionId?: string, runId?: string): WSEvents {
  const { resumeFailedRunId, session } = resolveAgentSocketSession(owner, connectionId, runId);

  return {
    onOpen(_event, ws) {
      attachAgentSocket(session, ws);
      sendDirectEvent(ws, {
        type: "connected",
        connectionId: session.connectionId,
        timestamp: new Date().toISOString()
      });
      if (resumeFailedRunId) {
        sendSessionError(session, {
          code: "agent_session_expired",
          message: "Agent session expired before the browser could reconnect. Start a new Agent run.",
          runId: resumeFailedRunId,
          recoverable: true
        });
        sendSessionEvent(session, {
          type: "run_done",
          runId: resumeFailedRunId,
          status: "failed",
          timestamp: new Date().toISOString()
        });
      }
      flushPendingSessionEvents(session);
    },
    onMessage(event, ws) {
      handleAgentMessage(event.data, ws, session);
    },
    onClose(_event, ws) {
      detachAgentSocket(session, ws, "socket_disconnected");
    },
    onError(_event, ws) {
      detachAgentSocket(session, ws, "socket_error");
    }
  };
}

export function closeAllAgentSessions(reason = "server_shutdown"): void {
  for (const session of sessions.values()) {
    cancelActiveRun(session, reason);
    disposeAgentSession(session);
  }
  sessions.clear();
}

function createAgentSocketSession(owner: DataOwner): AgentSocketSession {
  return {
    connectionId: randomUUID(),
    owner,
    plans: new Map(),
    pendingEvents: []
  };
}

function resolveAgentSocketSession(
  owner: DataOwner,
  requestedConnectionId?: string,
  requestedRunId?: string
): { session: AgentSocketSession; resumeFailedRunId?: string } {
  const connectionId = requestedConnectionId?.trim();
  const runId = requestedRunId?.trim();
  if (connectionId) {
    const existingSession = sessions.get(connectionId);
    if (existingSession && existingSession.owner.id === owner.id) {
      return { session: existingSession };
    }
  }

  if (runId) {
    const activeRunSession = [...sessions.values()].find(
      (session) => session.activeRun?.id === runId && session.owner.id === owner.id
    );
    if (activeRunSession) {
      return { session: activeRunSession };
    }
  }

  const session = createAgentSocketSession(owner);
  return {
    session,
    resumeFailedRunId: connectionId && runId ? runId : undefined
  };
}

function attachAgentSocket(session: AgentSocketSession, ws: WSContext): void {
  clearSessionDisconnectTimer(session);
  if (session.ws && session.ws !== ws) {
    closeAgentSocket(session.ws, 1012, "agent_session_replaced");
  }

  session.ws = ws;
  sessions.set(session.connectionId, session);
  startSessionKeepAlive(session);
}

function detachAgentSocket(session: AgentSocketSession, ws: WSContext, reason: string): void {
  if (session.ws !== ws) {
    return;
  }

  session.ws = undefined;
  stopSessionKeepAlive(session);
  scheduleDisconnectedSessionCleanup(session, reason);
}

function scheduleDisconnectedSessionCleanup(session: AgentSocketSession, reason = "socket_disconnected"): void {
  if (session.ws) {
    clearSessionDisconnectTimer(session);
    return;
  }

  clearSessionDisconnectTimer(session);
  const timeoutMs = session.activeRun ? AGENT_ACTIVE_DISCONNECT_GRACE_MS : AGENT_IDLE_DISCONNECT_GRACE_MS;
  session.disconnectTimer = setTimeout(() => {
    if (session.ws) {
      return;
    }

    if (session.activeRun) {
      cancelActiveRun(session, reason);
    }
    disposeAgentSession(session);
  }, timeoutMs);
}

function clearSessionDisconnectTimer(session: AgentSocketSession): void {
  if (session.disconnectTimer) {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = undefined;
  }
}

function startSessionKeepAlive(session: AgentSocketSession): void {
  stopSessionKeepAlive(session);
  session.keepAliveTimer = setInterval(() => {
    const ws = session.ws;
    if (!ws) {
      return;
    }

    const heartbeat: AgentServerEvent = {
      type: "pong",
      requestId: `agent-server-heartbeat-${session.connectionId}-${Date.now()}`,
      runId: session.activeRun?.id,
      timestamp: new Date().toISOString()
    };
    if (!sendDirectEvent(ws, heartbeat)) {
      detachAgentSocket(session, ws, "socket_send_failed");
    }
  }, AGENT_SOCKET_SERVER_HEARTBEAT_INTERVAL_MS);
}

function stopSessionKeepAlive(session: AgentSocketSession): void {
  if (session.keepAliveTimer) {
    clearInterval(session.keepAliveTimer);
    session.keepAliveTimer = undefined;
  }
}

function disposeAgentSession(session: AgentSocketSession): void {
  clearSessionDisconnectTimer(session);
  stopSessionKeepAlive(session);
  session.pendingEvents = [];
  session.ws = undefined;
  sessions.delete(session.connectionId);
}

function closeAgentSocket(ws: WSContext, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // The socket may already be closed by the underlying adapter.
  }
}

function flushPendingSessionEvents(session: AgentSocketSession): void {
  const ws = session.ws;
  if (!ws || session.pendingEvents.length === 0) {
    return;
  }

  const events = session.pendingEvents;
  session.pendingEvents = [];
  for (let index = 0; index < events.length; index += 1) {
    if (!sendDirectEvent(ws, events[index])) {
      session.pendingEvents = events.slice(index);
      detachAgentSocket(session, ws, "socket_flush_failed");
      return;
    }
  }
}

function handleAgentMessage(data: WSMessageReceive, _ws: WSContext, session: AgentSocketSession): void {
  const parsed = parseAgentClientMessage(data);
  if (!parsed.ok) {
    sendSessionError(session, {
      code: parsed.code,
      message: parsed.message,
      recoverable: true
    });
    return;
  }

  const message = parsed.value;
  if (message.type === "ping") {
    sendSessionEvent(session, {
      type: "pong",
      requestId: message.requestId,
      runId: message.runId,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (message.type === "cancel_run") {
    const cancelled = cancelActiveRun(session, "client_cancelled", message.runId);
    sendSessionEvent(session, {
      type: "run_cancelled",
      requestId: message.requestId,
      runId: cancelled.runId,
      reason: cancelled.reason,
      alreadyCancelled: cancelled.alreadyCancelled,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (AGENT_WORK_MESSAGE_TYPES.has(message.type)) {
    handleAgentWorkMessage(message, session);
    return;
  }

  sendSessionError(session, {
    code: "unsupported_agent_message",
    message: "Unsupported Agent WebSocket message.",
    requestId: message.requestId,
    runId: message.runId,
    recoverable: true
  });
}

function handleAgentWorkMessage(message: AgentClientMessage, session: AgentSocketSession): void {
  const llmConfig = getUsableAgentLlmConfig();
  if (!llmConfig) {
    sendSessionError(session, {
      code: "missing_agent_config",
      message: "Configure an Agent LLM before using the Agent.",
      requestId: message.requestId,
      runId: message.runId,
      recoverable: true
    });
    return;
  }

  if (message.type === "user_message") {
    if (session.activeRun) {
      sendSessionError(session, {
        code: "agent_run_in_progress",
        message: "An Agent run is already in progress for this connection.",
        requestId: message.requestId,
        runId: session.activeRun.id,
        recoverable: true
      });
      return;
    }

    const runId = message.runId ?? randomUUID();
    const activeRun: ActiveAgentRun = {
      id: runId,
      controller: new AbortController(),
      cancelled: false
    };
    session.activeRun = activeRun;
    void handleAgentPlanMessage(message, session, activeRun, llmConfig);
    return;
  }

  if (message.type === "execute_plan" || message.type === "retry_failed") {
    if (session.activeRun) {
      sendSessionError(session, {
        code: "agent_run_in_progress",
        message: "An Agent run is already in progress for this connection.",
        requestId: message.requestId,
        runId: session.activeRun.id,
        recoverable: true
      });
      return;
    }

    const storedPlan = resolveStoredPlanForExecution(session, message);
    if (!storedPlan) {
      sendSessionError(session, {
        code: "unknown_agent_plan",
        message: "The requested Agent plan is not available. Regenerate the plan or execute it from the canvas node payload.",
        requestId: message.requestId,
        runId: message.runId,
        recoverable: true
      });
      return;
    }

    const runId = message.runId ?? randomUUID();
    const activeRun: ActiveAgentRun = {
      id: runId,
      controller: new AbortController(),
      cancelled: false
    };
    session.activeRun = activeRun;
    void handleAgentPlanExecutionMessage(message, session, activeRun, storedPlan);
    return;
  }

  sendSessionError(session, {
    code: "agent_work_unavailable",
    message: "This Agent action is not available in this build yet.",
    requestId: message.requestId,
    runId: message.runId,
    recoverable: true
  });
}

async function handleAgentPlanMessage(
  message: Extract<AgentClientMessage, { type: "user_message" }>,
  session: AgentSocketSession,
  activeRun: ActiveAgentRun,
  llmConfig: NonNullable<ReturnType<typeof getUsableAgentLlmConfig>>
): Promise<void> {
  let result: Awaited<ReturnType<typeof createGenerationPlan>>;
  try {
    result = await createGenerationPlan({
      userText: message.text,
      defaults: message.defaults,
      selectedReferences: message.selectedReferences,
      plannerOptions: message.plannerOptions,
      llmConfig,
      onAssistantDelta: (delta) => {
        if (session.activeRun?.id !== activeRun.id || activeRun.cancelled) {
          return;
        }

        sendSessionEvent(session, {
          type: "assistant_delta",
          requestId: message.requestId,
          runId: activeRun.id,
          delta,
          timestamp: new Date().toISOString()
        });
      },
      onThinkingDelta: (delta) => {
        if (session.activeRun?.id !== activeRun.id || activeRun.cancelled) {
          return;
        }

        sendSessionEvent(session, {
          type: "assistant_thinking_delta",
          requestId: message.requestId,
          runId: activeRun.id,
          delta,
          timestamp: new Date().toISOString()
        });
      },
      signal: activeRun.controller.signal
    });
  } catch {
    result = {
      ok: false,
      code: "agent_planner_failed",
      message: "Agent planner request failed."
    };
  }

  if (session.activeRun?.id !== activeRun.id || activeRun.cancelled) {
    return;
  }

  session.activeRun = undefined;
  scheduleDisconnectedSessionCleanup(session);

  if (!result.ok) {
    sendSessionError(session, {
      code: result.code,
      message: result.message,
      requestId: message.requestId,
      runId: activeRun.id,
      recoverable: true
    });
    sendSessionEvent(session, {
      type: "run_done",
      requestId: message.requestId,
      runId: activeRun.id,
      status: "failed",
      timestamp: new Date().toISOString()
    });
    return;
  }

  session.plans.set(result.plan.id, {
    plan: result.plan,
    selectedReferences: message.selectedReferences ?? []
  });

  sendSessionEvent(session, {
    type: "plan_created",
    requestId: message.requestId,
    runId: activeRun.id,
    plan: result.plan,
    timestamp: new Date().toISOString()
  });
  sendSessionEvent(session, {
    type: "run_done",
    requestId: message.requestId,
    runId: activeRun.id,
    status: "succeeded",
    timestamp: new Date().toISOString()
  });
}

async function handleAgentPlanExecutionMessage(
  message: Extract<AgentClientMessage, { type: "execute_plan" | "retry_failed" }>,
  session: AgentSocketSession,
  activeRun: ActiveAgentRun,
  storedPlan: StoredAgentGenerationPlan
): Promise<void> {
  let result: Awaited<ReturnType<typeof executeGenerationPlan>>;
  try {
    result = await executeGenerationPlan({
      ...storedPlan,
      mode: message.type === "execute_plan" ? "execute" : "retry_failed",
      owner: session.owner,
      requestId: message.requestId,
      runId: activeRun.id,
      signal: activeRun.controller.signal,
      isRunActive: () => session.activeRun?.id === activeRun.id && !activeRun.cancelled,
      sendEvent: (event) => sendSessionEvent(session, event)
    });
  } catch (error) {
    if (activeRun.controller.signal.aborted || activeRun.cancelled || session.activeRun?.id !== activeRun.id) {
      return;
    }

    const messageText = error instanceof Error && error.message ? error.message : "Agent plan execution failed.";
    sendSessionError(session, {
      code: "agent_execution_failed",
      message: messageText,
      requestId: message.requestId,
      runId: activeRun.id,
      recoverable: true
    });
    sendSessionEvent(session, {
      type: "run_done",
      requestId: message.requestId,
      runId: activeRun.id,
      status: "failed",
      timestamp: new Date().toISOString()
    });
    session.activeRun = undefined;
    scheduleDisconnectedSessionCleanup(session);
    return;
  }

  if (session.activeRun?.id !== activeRun.id || activeRun.cancelled) {
    return;
  }

  session.activeRun = undefined;
  scheduleDisconnectedSessionCleanup(session);
  session.plans.set(result.plan.id, {
    plan: result.plan,
    selectedReferences: storedPlan.selectedReferences
  });
  sendSessionEvent(session, {
    type: "run_done",
    requestId: message.requestId,
    runId: activeRun.id,
    status: result.status,
    timestamp: new Date().toISOString()
  });
}

function resolveStoredPlanForExecution(
  session: AgentSocketSession,
  message: Extract<AgentClientMessage, { type: "execute_plan" | "retry_failed" }>
): StoredAgentGenerationPlan | undefined {
  const messagePlan = isExecutableGenerationPlan(message.plan) && message.plan.id === message.planId ? message.plan : undefined;
  const storedPlan = session.plans.get(message.planId);
  const selectedReferences =
    message.selectedReferences ?? storedPlan?.selectedReferences ?? (messagePlan ? selectedReferencesFromPlan(messagePlan) : undefined);

  if (!messagePlan) {
    return storedPlan
      ? {
          ...storedPlan,
          selectedReferences: selectedReferences ?? storedPlan.selectedReferences
        }
      : undefined;
  }

  return {
    plan: messagePlan,
    selectedReferences: selectedReferences ?? selectedReferencesFromPlan(messagePlan)
  };
}

function selectedReferencesFromPlan(plan: GenerationPlan): StoredAgentGenerationPlan["selectedReferences"] {
  const selectedReferences = new Map<string, StoredAgentGenerationPlan["selectedReferences"][number]>();
  for (const job of plan.jobs) {
    for (const reference of job.references) {
      if (reference.kind !== "selected_canvas_image" || !reference.assetId) {
        continue;
      }
      selectedReferences.set(reference.assetId, {
        id: reference.assetId,
        assetId: reference.assetId,
        label: reference.label
      });
    }
  }

  return [...selectedReferences.values()];
}

function cancelActiveRun(
  session: AgentSocketSession,
  reason: string,
  requestedRunId?: string
): { runId?: string; alreadyCancelled: boolean; reason: string } {
  const activeRun = session.activeRun;
  if (!activeRun || (requestedRunId && requestedRunId !== activeRun.id)) {
    return {
      runId: requestedRunId ?? activeRun?.id,
      alreadyCancelled: true,
      reason
    };
  }

  const alreadyCancelled = activeRun.cancelled;
  if (!activeRun.cancelled) {
    activeRun.cancelled = true;
    activeRun.controller.abort(reason);
  }
  session.activeRun = undefined;

  return {
    runId: activeRun.id,
    alreadyCancelled,
    reason
  };
}

function parseAgentClientMessage(data: WSMessageReceive): ParsedMessage | MessageParseError {
  if (typeof data !== "string") {
    return {
      ok: false,
      code: "invalid_agent_message",
      message: "Agent WebSocket messages must be JSON text."
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "Agent WebSocket message must be valid JSON."
    };
  }

  if (!isRecord(value) || typeof value.type !== "string" || !isAgentClientMessageType(value.type)) {
    return {
      ok: false,
      code: "invalid_agent_message",
      message: `Agent WebSocket message type must be one of: ${CLIENT_MESSAGE_TYPES.join(", ")}.`
    };
  }

  if (value.requestId !== undefined && typeof value.requestId !== "string") {
    return {
      ok: false,
      code: "invalid_agent_message",
      message: "Agent WebSocket requestId must be a string when provided."
    };
  }

  if (value.runId !== undefined && typeof value.runId !== "string") {
    return {
      ok: false,
      code: "invalid_agent_message",
      message: "Agent WebSocket runId must be a string when provided."
    };
  }

  return {
    ok: true,
    value: value as unknown as AgentClientMessage
  };
}

function sendSessionError(
  session: AgentSocketSession,
  input: Omit<AgentErrorEvent, "type" | "timestamp">
): void {
  sendSessionEvent(session, {
    type: "error",
    timestamp: new Date().toISOString(),
    ...input
  });
}

function sendSessionEvent(session: AgentSocketSession, event: AgentServerEvent): void {
  const ws = session.ws;
  if (ws) {
    if (sendDirectEvent(ws, event)) {
      return;
    }
    detachAgentSocket(session, ws, "socket_send_failed");
  }

  session.pendingEvents.push(event);
  if (session.pendingEvents.length > AGENT_PENDING_EVENT_LIMIT) {
    session.pendingEvents.splice(0, session.pendingEvents.length - AGENT_PENDING_EVENT_LIMIT);
  }
}

function sendDirectEvent(ws: WSContext, event: AgentServerEvent): boolean {
  if (ws.readyState !== OPEN_READY_STATE) {
    return false;
  }

  try {
    ws.send(JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
}

function isAgentClientMessageType(value: string): value is AgentClientMessageType {
  return (CLIENT_MESSAGE_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
