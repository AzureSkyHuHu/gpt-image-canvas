import type { Context, Hono } from "hono";
import { getAuthStatus, logoutCodex, pollCodexDeviceLogin, startCodexDeviceLogin } from "../../domain/providers/codex-auth.js";
import {
  AccessTokenStoreError,
  createAccessToken,
  deleteAccessToken,
  ensureBootstrapAccessToken,
  listAccessTokens,
  updateAccessToken
} from "../../domain/auth/access-token-store.js";
import type { CreateAccessTokenRequest, UpdateAccessTokenRequest } from "../../domain/contracts.js";
import { accessControlConfig } from "../../infrastructure/runtime.js";
import {
  adminMe,
  authMe,
  isAuthEnabled,
  loginAsAdmin,
  loginWithAccessToken,
  logoutAccess,
  logoutAdmin
} from "../http/access-control.js";
import { ProviderError } from "../../infrastructure/providers/image-provider.js";
import { errorResponse, errorToMessage, providerErrorJson } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { parseCodexPollPayload } from "../http/validation.js";

export function registerAuthRoutes(app: Hono): void {
  ensureBootstrapAccessToken({
    accessToken: accessControlConfig.bootstrapAccessToken,
    label: accessControlConfig.bootstrapAccessLabel,
    upstreamApiKey: accessControlConfig.bootstrapUpstreamApiKey,
    upstreamBaseURL: accessControlConfig.bootstrapUpstreamBaseURL,
    upstreamModel: accessControlConfig.bootstrapUpstreamModel
  });

  app.get("/api/auth/me", (c) => c.json(authMe(c)));

  app.get("/api/auth/login", (c) => {
    const token = c.req.query("token")?.trim();
    const redirectTo = safeRedirectPath(c.req.query("redirect")) ?? "/";
    if (!token) {
      return c.redirect(`${redirectTo}${redirectTo.includes("?") ? "&" : "?"}auth_error=missing_token`, 302);
    }

    try {
      const result = loginWithAccessToken(c, token);
      if (!result) {
        return c.redirect(`${redirectTo}${redirectTo.includes("?") ? "&" : "?"}auth_error=invalid_token`, 302);
      }
      return c.redirect(redirectTo, 302);
    } catch {
      return c.redirect(`${redirectTo}${redirectTo.includes("?") ? "&" : "?"}auth_error=invalid_token`, 302);
    }
  });

  app.post("/api/auth/login", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }
    if (!isRecord(payload.value) || typeof payload.value.token !== "string") {
      return c.json(errorResponse("invalid_auth_token", "请输入访问 token。"), 400);
    }

    try {
      const result = loginWithAccessToken(c, payload.value.token);
      if (!result) {
        return c.json(errorResponse("invalid_auth_token", "访问 token 无效或已停用。"), 401);
      }
      return c.json(result);
    } catch (error) {
      return c.json(errorResponse("invalid_auth_token", errorToMessage(error)), 400);
    }
  });

  app.post("/api/auth/logout", (c) => {
    logoutAccess(c);
    return c.json({ ok: true });
  });

  app.get("/api/admin/me", (c) => c.json(adminMe(c)));

  app.post("/api/admin/login", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }
    if (!isRecord(payload.value) || typeof payload.value.password !== "string") {
      return c.json(errorResponse("invalid_admin_password", "请输入管理员密码。"), 400);
    }

    if (!loginAsAdmin(c, payload.value.password)) {
      return c.json(errorResponse("invalid_admin_password", "管理员密码无效。"), 401);
    }

    return c.json(adminMe(c));
  });

  app.post("/api/admin/logout", (c) => {
    logoutAdmin(c);
    return c.json({ ok: true });
  });

  app.get("/api/admin/tokens", (c) =>
    c.json({
      items: listAccessTokens()
    })
  );

  app.post("/api/admin/tokens", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }
    if (!isRecord(payload.value)) {
      return c.json(errorResponse("invalid_access_token", "Token payload must be a JSON object."), 400);
    }

    try {
      return c.json(createAccessToken(parseCreateAccessTokenPayload(payload.value)), 201);
    } catch (error) {
      return accessTokenStoreErrorJson(c, error);
    }
  });

  app.patch("/api/admin/tokens/:id", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }
    if (!isRecord(payload.value)) {
      return c.json(errorResponse("invalid_access_token", "Token payload must be a JSON object."), 400);
    }

    try {
      return c.json(updateAccessToken(c.req.param("id"), parseUpdateAccessTokenPayload(payload.value)));
    } catch (error) {
      return accessTokenStoreErrorJson(c, error);
    }
  });

  app.delete("/api/admin/tokens/:id", (c) => {
    if (!deleteAccessToken(c.req.param("id"))) {
      return c.json(errorResponse("not_found", "找不到这个访问 token。"), 404);
    }

    return c.json({
      ok: true
    });
  });

  app.get("/api/auth/status", (c) => c.json(getAuthStatus()));

  app.post("/api/auth/codex/device/start", async (c) => {
    try {
      return c.json(await startCodexDeviceLogin(c.req.raw.signal));
    } catch (error) {
      if (error instanceof ProviderError) {
        return providerErrorJson(c, error);
      }

      throw error;
    }
  });

  app.post("/api/auth/codex/device/poll", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseCodexPollPayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    try {
      return c.json(await pollCodexDeviceLogin(parsed.value, c.req.raw.signal));
    } catch (error) {
      if (error instanceof ProviderError) {
        return providerErrorJson(c, error);
      }

      throw error;
    }
  });

  app.post("/api/auth/codex/logout", (c) => c.json(logoutCodex()));
}

function accessTokenStoreErrorJson(c: Context, error: unknown) {
  if (error instanceof AccessTokenStoreError) {
    return c.json(errorResponse(error.code, error.message), error.status as 400 | 401 | 404 | 409);
  }
  return c.json(errorResponse("access_token_error", errorToMessage(error)), 400);
}

function parseCreateAccessTokenPayload(value: Record<string, unknown>): CreateAccessTokenRequest {
  return {
    label: typeof value.label === "string" ? value.label : "",
    accessToken: typeof value.accessToken === "string" ? value.accessToken : undefined,
    upstreamApiKey: typeof value.upstreamApiKey === "string" ? value.upstreamApiKey : "",
    upstreamBaseURL: typeof value.upstreamBaseURL === "string" ? value.upstreamBaseURL : undefined,
    upstreamModel: typeof value.upstreamModel === "string" ? value.upstreamModel : undefined,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined
  };
}

function parseUpdateAccessTokenPayload(value: Record<string, unknown>): UpdateAccessTokenRequest {
  return {
    label: typeof value.label === "string" ? value.label : undefined,
    accessToken: typeof value.accessToken === "string" ? value.accessToken : undefined,
    upstreamApiKey: typeof value.upstreamApiKey === "string" ? value.upstreamApiKey : undefined,
    upstreamBaseURL:
      typeof value.upstreamBaseURL === "string" || value.upstreamBaseURL === null ? value.upstreamBaseURL : undefined,
    upstreamModel: typeof value.upstreamModel === "string" || value.upstreamModel === null ? value.upstreamModel : undefined,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined
  };
}

function safeRedirectPath(value: string | undefined): string | undefined {
  if (!value?.startsWith("/")) {
    return undefined;
  }
  if (value.startsWith("//")) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
