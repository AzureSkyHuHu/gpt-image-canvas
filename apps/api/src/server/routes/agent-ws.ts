import { upgradeWebSocket } from "@hono/node-server";
import type { Hono } from "hono";
import { createAgentWebSocketEvents } from "../../domain/agent/websocket-session.js";
import { currentDataOwner } from "../http/access-control.js";

export function registerAgentWebSocketRoutes(app: Hono): void {
  app.get(
    "/api/agent/ws",
    upgradeWebSocket((c) => createAgentWebSocketEvents(currentDataOwner(c), c.req.query("connectionId"), c.req.query("runId")), {
      onError(error) {
        console.error("Agent WebSocket error.", error);
      }
    })
  );
}
