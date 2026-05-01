import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { AuthMeResponse, AuthUser } from "./contracts.js";
import {
  authenticateAccessToken,
  getAccessTokenPrincipal,
  type AccessTokenPrincipal
} from "./access-token-store.js";
import { accessControlConfig } from "./runtime.js";

export interface RequestAuthState {
  user?: AccessTokenPrincipal;
  isAdmin: boolean;
}

export type AuthVariables = {
  auth: RequestAuthState;
};

type SessionKind = "access" | "admin";

interface SessionPayload {
  kind: SessionKind;
  subject: string;
  expiresAt: number;
}

const ACCESS_COOKIE_NAME = "gic_access_session";
const ADMIN_COOKIE_NAME = "gic_admin_session";

export function isAuthEnabled(): boolean {
  return accessControlConfig.enabled;
}

export function authConfigWarnings(): string[] {
  if (!isAuthEnabled()) {
    return [];
  }

  const warnings: string[] = [];
  if (!accessControlConfig.adminPassword) {
    warnings.push("APP_AUTH_ENABLED=true but APP_ADMIN_PASSWORD is empty; admin token management is disabled.");
  }
  if (accessControlConfig.sessionSecret.length < 32) {
    warnings.push("APP_AUTH_ENABLED=true but APP_SESSION_SECRET should be at least 32 characters.");
  }
  return warnings;
}

export function authMiddleware(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const auth = resolveAuthState(c);
    c.set("auth", auth);

    if (!isAuthEnabled()) {
      return next();
    }

    const path = new URL(c.req.url).pathname;
    if (isPublicApiPath(path)) {
      return next();
    }

    if (path.startsWith("/api/admin")) {
      if (!auth.isAdmin) {
        return c.json(errorResponse("admin_auth_required", "请先以管理员身份登录。"), 401);
      }
      return next();
    }

    if (path.startsWith("/api/") && !auth.user) {
      return c.json(errorResponse("auth_required", "请输入访问 token 后继续。"), 401);
    }

    return next();
  };
}

export function authMe(c: Context<{ Variables: AuthVariables }>): AuthMeResponse {
  const auth = c.get("auth");
  return {
    authEnabled: isAuthEnabled(),
    authenticated: Boolean(auth?.user),
    user: auth?.user ? toAuthUser(auth.user) : undefined
  };
}

export function adminMe(c: Context<{ Variables: AuthVariables }>) {
  const auth = c.get("auth");
  return {
    authEnabled: isAuthEnabled(),
    authenticated: Boolean(auth?.isAdmin)
  };
}

export function loginWithAccessToken(c: Context, token: string): AuthMeResponse | undefined {
  if (!isAuthEnabled()) {
    return {
      authEnabled: false,
      authenticated: true,
      user: {
        id: "local",
        label: "Local"
      }
    };
  }

  const principal = authenticateAccessToken(token);
  if (!principal) {
    return undefined;
  }

  setSessionCookie(c, ACCESS_COOKIE_NAME, {
    kind: "access",
    subject: principal.id,
    expiresAt: sessionExpiresAt()
  });

  return {
    authEnabled: true,
    authenticated: true,
    user: toAuthUser(principal)
  };
}

export function loginAsAdmin(c: Context, password: string): boolean {
  if (!isAuthEnabled() || !accessControlConfig.adminPassword) {
    return false;
  }
  if (!safeEqual(password, accessControlConfig.adminPassword)) {
    return false;
  }

  setSessionCookie(c, ADMIN_COOKIE_NAME, {
    kind: "admin",
    subject: "admin",
    expiresAt: sessionExpiresAt()
  });
  return true;
}

export function logoutAccess(c: Context): void {
  clearSessionCookie(c, ACCESS_COOKIE_NAME);
}

export function logoutAdmin(c: Context): void {
  clearSessionCookie(c, ADMIN_COOKIE_NAME);
}

export function currentAccessPrincipal(c: Context<{ Variables: AuthVariables }>): AccessTokenPrincipal | undefined {
  if (!isAuthEnabled()) {
    return undefined;
  }
  return c.get("auth")?.user;
}

function resolveAuthState(c: Context): RequestAuthState {
  if (!isAuthEnabled()) {
    return {
      isAdmin: true
    };
  }

  const accessSession = readSessionCookie(c, ACCESS_COOKIE_NAME);
  const user =
    accessSession?.kind === "access" && accessSession.subject ? getAccessTokenPrincipal(accessSession.subject) : undefined;
  const adminSession = readSessionCookie(c, ADMIN_COOKIE_NAME);

  return {
    user,
    isAdmin: adminSession?.kind === "admin" && adminSession.subject === "admin"
  };
}

function isPublicApiPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/auth/me" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    path === "/api/admin/login" ||
    path === "/api/admin/logout" ||
    path === "/api/admin/me"
  );
}

function readSessionCookie(c: Context, name: string): SessionPayload | undefined {
  const rawCookie = c.req.header("cookie");
  const cookieValue = parseCookie(rawCookie)[name];
  if (!cookieValue) {
    return undefined;
  }

  const payload = verifySignedValue(cookieValue);
  if (!payload || payload.expiresAt < Date.now()) {
    return undefined;
  }
  return payload;
}

function setSessionCookie(c: Context, name: string, payload: SessionPayload): void {
  const secure = new URL(c.req.url).protocol === "https:";
  const maxAge = Math.max(1, Math.floor((payload.expiresAt - Date.now()) / 1000));
  c.header(
    "Set-Cookie",
    `${name}=${signPayload(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
    {
      append: true
    }
  );
}

function clearSessionCookie(c: Context, name: string): void {
  c.header("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, {
    append: true
  });
}

function parseCookie(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const item of (cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (!rawName || rawValue.length === 0) {
      continue;
    }
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function signPayload(payload: SessionPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

function verifySignedValue(value: string): SessionPayload | undefined {
  const [encoded, actualSignature] = value.split(".", 2);
  if (!encoded || !actualSignature || !safeEqual(signature(encoded), actualSignature)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (
      (payload.kind !== "access" && payload.kind !== "admin") ||
      typeof payload.subject !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

function signature(value: string): string {
  const secret = accessControlConfig.sessionSecret || "gpt-image-canvas-development-session-secret";
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sessionExpiresAt(): number {
  return Date.now() + accessControlConfig.sessionDays * 24 * 60 * 60 * 1000;
}

function safeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}

function toAuthUser(principal: AccessTokenPrincipal): AuthUser {
  return {
    id: principal.id,
    label: principal.label
  };
}

function errorResponse(code: string, message: string) {
  return {
    error: {
      code,
      message
    }
  };
}

export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}
