import type { Hono } from "hono";
import { getAgentLlmConfig, saveAgentLlmConfig } from "../../domain/agent/config.js";
import { currentDataOwner } from "../http/access-control.js";
import { errorResponse, errorToMessage } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { parseAgentLlmConfigPayload } from "../http/validation.js";

export function registerAgentConfigRoutes(app: Hono): void {
  app.get("/api/agent-config", (c) => {
    if (!currentDataOwner(c).isLocal) {
      return c.json(errorResponse("admin_auth_required", "普通访问 token 用户不能读取全局 Agent LLM 配置。"), 403);
    }
    return c.json(getAgentLlmConfig());
  });

  app.put("/api/agent-config", async (c) => {
    if (!currentDataOwner(c).isLocal) {
      return c.json(errorResponse("admin_auth_required", "普通访问 token 用户不能修改全局 Agent LLM 配置。"), 403);
    }
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseAgentLlmConfigPayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    try {
      return c.json(saveAgentLlmConfig(parsed.value));
    } catch (error) {
      return c.json(errorResponse("agent_config_error", errorToMessage(error)), 400);
    }
  });
}
