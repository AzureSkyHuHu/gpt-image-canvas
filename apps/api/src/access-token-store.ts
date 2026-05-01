import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  AccessTokenView,
  CreateAccessTokenRequest,
  CreateAccessTokenResponse,
  UpdateAccessTokenRequest
} from "./contracts.js";
import { db } from "./database.js";
import { accessTokens } from "./schema.js";

export interface AccessTokenPrincipal {
  id: string;
  label: string;
  upstreamApiKey: string;
  upstreamBaseURL?: string;
  upstreamModel?: string;
}

export type AccessTokenStoreErrorCode =
  | "duplicate_token"
  | "invalid_access_token"
  | "invalid_label"
  | "invalid_upstream_api_key"
  | "not_found";

export class AccessTokenStoreError extends Error {
  constructor(
    readonly code: AccessTokenStoreErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const MIN_ACCESS_TOKEN_LENGTH = 12;

export function listAccessTokens(): AccessTokenView[] {
  return db
    .select()
    .from(accessTokens)
    .all()
    .map(toAccessTokenView)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function ensureBootstrapAccessToken(input: {
  accessToken: string;
  label: string;
  upstreamApiKey: string;
  upstreamBaseURL?: string;
  upstreamModel?: string;
}): void {
  const accessToken = normalizeOptional(input.accessToken);
  if (!accessToken) {
    return;
  }

  const normalized = normalizeTokenInput(accessToken);
  const tokenHash = hashAccessToken(normalized);
  const existing = db.select().from(accessTokens).where(eq(accessTokens.tokenHash, tokenHash)).get();
  if (existing) {
    return;
  }

  if (!normalizeOptional(input.upstreamApiKey)) {
    console.warn("APP_BOOTSTRAP_ACCESS_TOKEN is set but no upstream API key is configured; bootstrap token was skipped.");
    return;
  }

  createAccessToken({
    label: input.label,
    accessToken: normalized,
    upstreamApiKey: input.upstreamApiKey,
    upstreamBaseURL: input.upstreamBaseURL,
    upstreamModel: input.upstreamModel,
    enabled: true
  });
  console.warn(`Created bootstrap access token mapping for ${input.label}.`);
}

export function createAccessToken(input: CreateAccessTokenRequest): CreateAccessTokenResponse {
  const createdAt = new Date().toISOString();
  const accessToken = normalizeOptional(input.accessToken) ?? generateAccessToken();
  const normalized = normalizeTokenInput(accessToken);
  const upstreamApiKey = requiredTrimmed(input.upstreamApiKey, "invalid_upstream_api_key", "请提供上游 API key。");
  const label = requiredTrimmed(input.label, "invalid_label", "请提供 token 名称。");

  const row = {
    id: randomUUID(),
    label,
    tokenHash: hashAccessToken(normalized),
    tokenPreview: maskSecret(normalized),
    upstreamApiKey,
    upstreamApiKeyPreview: maskSecret(upstreamApiKey),
    upstreamBaseURL: normalizeOptional(input.upstreamBaseURL) ?? null,
    upstreamModel: normalizeOptional(input.upstreamModel) ?? null,
    enabled: input.enabled === false ? 0 : 1,
    createdAt,
    updatedAt: createdAt
  };

  try {
    db.insert(accessTokens).values(row).run();
  } catch (error) {
    if (isSqliteUniqueError(error)) {
      throw new AccessTokenStoreError("duplicate_token", "访问 token 已存在，请换一个。", 409);
    }
    throw error;
  }

  return {
    item: toAccessTokenView(row),
    accessToken: normalized
  };
}

export function updateAccessToken(id: string, input: UpdateAccessTokenRequest): AccessTokenView {
  const existing = db.select().from(accessTokens).where(eq(accessTokens.id, id)).get();
  if (!existing) {
    throw new AccessTokenStoreError("not_found", "找不到这个访问 token。", 404);
  }

  const values: Partial<typeof accessTokens.$inferInsert> = {
    updatedAt: new Date().toISOString()
  };

  if (input.label !== undefined) {
    values.label = requiredTrimmed(input.label, "invalid_label", "请提供 token 名称。");
  }

  if (input.accessToken !== undefined) {
    const normalized = normalizeTokenInput(input.accessToken);
    values.tokenHash = hashAccessToken(normalized);
    values.tokenPreview = maskSecret(normalized);
  }

  if (input.upstreamApiKey !== undefined) {
    const upstreamApiKey = requiredTrimmed(input.upstreamApiKey, "invalid_upstream_api_key", "请提供上游 API key。");
    values.upstreamApiKey = upstreamApiKey;
    values.upstreamApiKeyPreview = maskSecret(upstreamApiKey);
  }

  if (input.upstreamBaseURL !== undefined) {
    values.upstreamBaseURL = normalizeOptional(input.upstreamBaseURL) ?? null;
  }

  if (input.upstreamModel !== undefined) {
    values.upstreamModel = normalizeOptional(input.upstreamModel) ?? null;
  }

  if (input.enabled !== undefined) {
    values.enabled = input.enabled ? 1 : 0;
  }

  try {
    db.update(accessTokens).set(values).where(eq(accessTokens.id, id)).run();
  } catch (error) {
    if (isSqliteUniqueError(error)) {
      throw new AccessTokenStoreError("duplicate_token", "访问 token 已存在，请换一个。", 409);
    }
    throw error;
  }

  const updated = db.select().from(accessTokens).where(eq(accessTokens.id, id)).get();
  if (!updated) {
    throw new AccessTokenStoreError("not_found", "找不到这个访问 token。", 404);
  }
  return toAccessTokenView(updated);
}

export function deleteAccessToken(id: string): boolean {
  const result = db.delete(accessTokens).where(eq(accessTokens.id, id)).run();
  return result.changes > 0;
}

export function authenticateAccessToken(token: string): AccessTokenPrincipal | undefined {
  const normalized = normalizeTokenInput(token);
  const tokenHash = hashAccessToken(normalized);
  const row = db.select().from(accessTokens).where(eq(accessTokens.tokenHash, tokenHash)).get();
  if (!row || row.enabled !== 1 || !safeEqual(row.tokenHash, tokenHash)) {
    return undefined;
  }

  return {
    id: row.id,
    label: row.label,
    upstreamApiKey: row.upstreamApiKey,
    upstreamBaseURL: normalizeOptional(row.upstreamBaseURL ?? undefined),
    upstreamModel: normalizeOptional(row.upstreamModel ?? undefined)
  };
}

export function getAccessTokenPrincipal(id: string): AccessTokenPrincipal | undefined {
  const row = db.select().from(accessTokens).where(eq(accessTokens.id, id)).get();
  if (!row || row.enabled !== 1) {
    return undefined;
  }

  return {
    id: row.id,
    label: row.label,
    upstreamApiKey: row.upstreamApiKey,
    upstreamBaseURL: normalizeOptional(row.upstreamBaseURL ?? undefined),
    upstreamModel: normalizeOptional(row.upstreamModel ?? undefined)
  };
}

export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function toAccessTokenView(row: typeof accessTokens.$inferSelect): AccessTokenView {
  return {
    id: row.id,
    label: row.label,
    tokenPreview: row.tokenPreview,
    upstreamApiKeyPreview: row.upstreamApiKeyPreview,
    upstreamBaseURL: row.upstreamBaseURL ?? undefined,
    upstreamModel: row.upstreamModel ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function generateAccessToken(): string {
  return `gic_${randomBytes(24).toString("base64url")}`;
}

function normalizeTokenInput(token: string): string {
  const normalized = requiredTrimmed(token, "invalid_access_token", "请输入有效的访问 token。");
  if (normalized.length < MIN_ACCESS_TOKEN_LENGTH) {
    throw new AccessTokenStoreError("invalid_access_token", `访问 token 至少需要 ${MIN_ACCESS_TOKEN_LENGTH} 个字符。`, 400);
  }
  return normalized;
}

function requiredTrimmed<TCode extends AccessTokenStoreErrorCode>(value: string, code: TCode, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AccessTokenStoreError(code, message, 400);
  }
  return value.trim();
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hashAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}

function isSqliteUniqueError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
