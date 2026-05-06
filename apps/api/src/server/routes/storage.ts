import type { Hono } from "hono";
import { getStorageConfig, saveStorageConfig, testStorageConfig } from "../../domain/storage/storage-config.js";
import { currentDataOwner } from "../http/access-control.js";
import { errorResponse, errorToMessage } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { parseStorageConfigPayload } from "../http/validation.js";

export function registerStorageRoutes(app: Hono): void {
  app.get("/api/storage/config", (c) => {
    if (!currentDataOwner(c).isLocal) {
      return c.json(errorResponse("admin_auth_required", "普通访问 token 用户不能读取全局存储配置。"), 403);
    }
    return c.json(getStorageConfig());
  });

  app.put("/api/storage/config", async (c) => {
    if (!currentDataOwner(c).isLocal) {
      return c.json(errorResponse("admin_auth_required", "普通访问 token 用户不能修改全局存储配置。"), 403);
    }
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseStorageConfigPayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    try {
      return c.json(await saveStorageConfig(parsed.value));
    } catch (error) {
      return c.json(errorResponse("storage_config_error", errorToMessage(error)), 400);
    }
  });

  app.post("/api/storage/config/test", async (c) => {
    if (!currentDataOwner(c).isLocal) {
      return c.json(errorResponse("admin_auth_required", "普通访问 token 用户不能测试全局存储配置。"), 403);
    }
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseStorageConfigPayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    return c.json(await testStorageConfig(parsed.value));
  });
}
