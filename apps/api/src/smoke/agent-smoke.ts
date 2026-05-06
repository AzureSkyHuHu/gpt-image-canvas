import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import WebSocket, { type RawData } from "ws";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = resolve(repoRoot, ".codex-temp", `agent-smoke-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = dataDir;
process.env.SQLITE_JOURNAL_MODE = "DELETE";
process.env.SQLITE_LOCKING_MODE = "EXCLUSIVE";
process.env.APP_AUTH_ENABLED = "false";

mkdirSync(dataDir, { recursive: true });

async function main(): Promise<void> {
  try {
    const [{ app, agentWebSocketServer }, { closeDatabase }, { closeAllAgentSessions }] = await Promise.all([
      import("../index.js"),
      import("../infrastructure/database.js"),
      import("../domain/agent/websocket-session.js")
    ]);

    let server: ReturnType<typeof serve> | undefined;
    const port = await new Promise<number>((resolvePort) => {
      server = serve(
        {
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: 0,
          websocket: { server: agentWebSocketServer }
        },
        (info) => {
          resolvePort(info.port);
        }
      );
    });

    try {
      await smokeAgentWebSocket(port);
      await smokeAgentConfig(app);
    } finally {
      closeAllAgentSessions("agent_smoke_shutdown");
      agentWebSocketServer.close();
      await new Promise<void>((resolveClose) => {
        server?.close(() => resolveClose());
      });
      closeDatabase();
    }

    console.log("agent smoke checks passed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function smokeAgentWebSocket(port: number): Promise<void> {
  const probe = await openWebSocketProbe(`ws://127.0.0.1:${port}/api/agent/ws`);
  try {
    const connected = await probe.next();
    expectEventType(connected, "connected");
    expect(typeof connected.connectionId === "string" && connected.connectionId.length > 0, "connected includes connectionId");
    const connectionId = String(connected.connectionId);

    probe.socket.send(JSON.stringify({ type: "ping", requestId: "ping-1" }));
    const pong = await probe.next();
    expectEventType(pong, "pong");
    expect(pong.requestId === "ping-1", "pong preserves requestId");

    probe.socket.send("{\"type\":");
    const jsonError = await probe.next();
    expectEventType(jsonError, "error");
    expect(jsonError.code === "invalid_json", "malformed WebSocket JSON returns invalid_json");

    probe.socket.send(JSON.stringify({ type: "ping", requestId: "ping-2" }));
    const pongAfterError = await probe.next();
    expectEventType(pongAfterError, "pong");
    expect(pongAfterError.requestId === "ping-2", "socket remains open after malformed JSON");

    probe.socket.send(JSON.stringify({ type: "user_message", requestId: "work-1", text: "make an image" }));
    const missingConfig = await probe.next();
    expectEventType(missingConfig, "error");
    expect(missingConfig.code === "missing_agent_config", "missing config returns user-facing error");

    probe.socket.send(JSON.stringify({ type: "cancel_run", requestId: "cancel-1", runId: "run-a" }));
    const firstCancel = await probe.next();
    expectEventType(firstCancel, "run_cancelled");
    expect(firstCancel.runId === "run-a", "cancel event includes requested runId");
    expect(firstCancel.alreadyCancelled === true, "cancel with no active run is idempotent");

    probe.socket.send(JSON.stringify({ type: "cancel_run", requestId: "cancel-2", runId: "run-a" }));
    const secondCancel = await probe.next();
    expectEventType(secondCancel, "run_cancelled");
    expect(secondCancel.alreadyCancelled === true, "repeated cancel remains idempotent");

    const resumedProbe = await openWebSocketProbe(
      `ws://127.0.0.1:${port}/api/agent/ws?connectionId=${encodeURIComponent(connectionId)}`
    );
    try {
      const resumedConnected = await resumedProbe.next();
      expectEventType(resumedConnected, "connected");
      expect(resumedConnected.connectionId === connectionId, "reconnect resumes the same Agent session");

      resumedProbe.socket.send(JSON.stringify({ type: "ping", requestId: "ping-resumed" }));
      const resumedPong = await resumedProbe.next();
      expectEventType(resumedPong, "pong");
      expect(resumedPong.requestId === "ping-resumed", "resumed socket remains interactive");
    } finally {
      resumedProbe.close();
    }
  } finally {
    probe.close();
  }
}

interface RequestApp {
  request(input: string | Request, init?: RequestInit): Response | Promise<Response>;
}

interface SecretView {
  hasSecret: boolean;
  value?: string;
}

async function smokeAgentConfig(app: RequestApp): Promise<void> {
  const initial = await requestJson(app, "/api/agent-config");
  expect(initial.response.status === 200, "initial config GET returns 200");
  expectEventShape(initial.body, "initial config body");
  expect(initial.body.configured === false, "initial config is not usable");
  expect(expectSecretView(initial.body.apiKey, "initial config API key").hasSecret === false, "initial config has no API key");
  expect(initial.body.supportsVision === false, "initial supportsVision defaults to false");

  const missingKey = await requestJson(app, "/api/agent-config", {
    method: "PUT",
    body: {
      baseUrl: "",
      model: "gpt-4.1-mini",
      timeoutMs: 12000,
      supportsVision: false
    }
  });
  expect(missingKey.response.status === 400, "saving without an API key is rejected");

  const invalidTimeout = await requestJson(app, "/api/agent-config", {
    method: "PUT",
    body: {
      apiKey: "sk-test-agent-secret",
      baseUrl: "",
      model: "gpt-4.1-mini",
      timeoutMs: 0,
      supportsVision: false
    }
  });
  expect(invalidTimeout.response.status === 400, "non-positive timeout is rejected");

  const saved = await requestJson(app, "/api/agent-config", {
    method: "PUT",
    body: {
      apiKey: "  sk-test-agent-secret  ",
      baseUrl: "  https://agent.example.test/v1  ",
      model: "  gpt-4.1-mini  ",
      timeoutMs: 12345,
      supportsVision: true
    }
  });
  expect(saved.response.status === 200, "valid config save returns 200");
  expectEventShape(saved.body, "saved config body");
  expect(saved.body.configured === true, "saved config is usable");
  expect(saved.body.baseUrl === "https://agent.example.test/v1", "base URL is trimmed");
  expect(saved.body.model === "gpt-4.1-mini", "model is trimmed");
  expect(saved.body.timeoutMs === 12345, "timeout is persisted");
  expect(saved.body.supportsVision === true, "supportsVision is persisted");
  const savedSecret = expectSecretView(saved.body.apiKey, "saved config API key");
  expect(savedSecret.hasSecret === true, "saved key is masked");
  expect(!JSON.stringify(saved.body).includes("sk-test-agent-secret"), "saved readback does not expose API key");

  const preserved = await requestJson(app, "/api/agent-config", {
    method: "PUT",
    body: {
      apiKey: "",
      preserveApiKey: true,
      baseUrl: "  https://agent-2.example.test/v1  ",
      model: "  gpt-4.1  ",
      timeoutMs: 23456,
      supportsVision: false
    }
  });
  expect(preserved.response.status === 200, "preserved API key save returns 200");
  expectEventShape(preserved.body, "preserved config body");
  const preservedSecret = expectSecretView(preserved.body.apiKey, "preserved config API key");
  expect(preservedSecret.hasSecret === true, "preserved config keeps API key");
  expect(preservedSecret.value === savedSecret.value, "preserved config keeps same masked key");
  expect(preserved.body.baseUrl === "https://agent-2.example.test/v1", "preserved save updates base URL");
  expect(preserved.body.model === "gpt-4.1", "preserved save updates model");
  expect(preserved.body.supportsVision === false, "preserved save updates supportsVision");
}

async function requestJson(
  app: RequestApp,
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await app.request(path, {
    method: options?.method ?? "GET",
    headers: options?.body === undefined ? undefined : { "content-type": "application/json" },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = (await response.json()) as unknown;
  expect(isRecord(body), `${path} response body is an object`);
  return { response, body };
}

async function openWebSocketProbe(url: string): Promise<WebSocketProbe> {
  const socket = new WebSocket(url);
  const probe = new WebSocketProbe(socket);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", rejectOpen);
  });
  return probe;
}

class WebSocketProbe {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: Array<(value: Record<string, unknown>) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data: import("ws").RawData) => {
      const parsed = JSON.parse(rawDataToString(data)) as unknown;
      expect(isRecord(parsed), "WebSocket event is an object");
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      this.queue.push(parsed);
    });
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise((resolveNext, rejectNext) => {
      let waiter: (value: Record<string, unknown>) => void;
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        rejectNext(new Error("Timed out waiting for WebSocket event."));
      }, 2000);
      waiter = (value: Record<string, unknown>): void => {
        clearTimeout(timeout);
        resolveNext(value);
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function expectEventShape(value: Record<string, unknown>, label: string): void {
  expect(isRecord(value.apiKey), `${label} includes apiKey`);
  expect(typeof value.baseUrl === "string", `${label} includes baseUrl`);
  expect(typeof value.model === "string", `${label} includes model`);
  expect(typeof value.timeoutMs === "number", `${label} includes timeoutMs`);
  expect(typeof value.supportsVision === "boolean", `${label} includes supportsVision`);
}

function expectSecretView(value: unknown, label: string): SecretView {
  expect(isRecord(value), `${label} is an object`);
  expect(typeof value.hasSecret === "boolean", `${label} includes hasSecret`);
  if (value.value !== undefined) {
    expect(typeof value.value === "string", `${label} value is a string`);
  }

  return value as unknown as SecretView;
}

function expectEventType(value: Record<string, unknown>, type: string): void {
  expect(value.type === type, `expected ${type} event`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

await main();
