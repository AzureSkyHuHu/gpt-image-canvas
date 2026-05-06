import type { Hono } from "hono";
import type { AgentLlmConfigView } from "../../domain/contracts.js";
import { DEFAULT_AGENT_LLM_TIMEOUT_MS, getAgentLlmConfig, saveAgentLlmConfig } from "../../domain/agent/config.js";
import { currentDataOwner } from "../http/access-control.js";
import { errorResponse, errorToMessage } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { parseAgentLlmConfigPayload } from "../http/validation.js";

export function registerAgentConfigRoutes(app: Hono): void {
  app.get("/api/agent-config", (c) => {
    const owner = currentDataOwner(c);
    if (!owner.isLocal) {
      const myToolsConfig = getMyToolsAgentConfigView();
      if (myToolsConfig) {
        return c.json(myToolsConfig);
      }
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

function getMyToolsAgentConfigView(): AgentLlmConfigView | undefined {
  if (process.env.AGENT_LLM_BACKEND?.trim().toLowerCase() !== "my_tools") {
    return undefined;
  }

  const baseUrl = process.env.MY_TOOLS_BASE_URL?.trim();
  const sharedSecret = process.env.MY_TOOLS_AGENT_SHARED_SECRET?.trim();
  return {
    configured: Boolean(baseUrl && sharedSecret),
    apiKey: {
      hasSecret: Boolean(sharedSecret)
    },
    baseUrl: "",
    model: "my_tools Agent",
    timeoutMs: DEFAULT_AGENT_LLM_TIMEOUT_MS,
    supportsVision: true,
    createdAt: "",
    updatedAt: ""
  };
}
