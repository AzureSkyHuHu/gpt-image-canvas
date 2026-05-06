import type { Hono } from "hono";
import { getProviderConfig, saveProviderConfig } from "../../domain/providers/provider-config.js";
import { currentDataOwner } from "../http/access-control.js";
import { errorResponse, errorToMessage } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { parseProviderConfigPayload } from "../http/validation.js";

export function registerProviderConfigRoutes(app: Hono): void {
  app.get("/api/provider-config", (c) => {
    if (!currentDataOwner(c).isLocal) {
      return c.json(errorResponse("admin_auth_required", "普通访问 token 用户不能读取全局 provider 配置。"), 403);
    }
    return c.json(getProviderConfig());
  });

  app.put("/api/provider-config", async (c) => {
    if (!currentDataOwner(c).isLocal) {
      return c.json(errorResponse("admin_auth_required", "普通访问 token 用户不能修改全局 provider 配置。"), 403);
    }
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseProviderConfigPayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    try {
      return c.json(saveProviderConfig(parsed.value));
    } catch (error) {
      return c.json(errorResponse("provider_config_error", errorToMessage(error)), 400);
    }
  });
}
