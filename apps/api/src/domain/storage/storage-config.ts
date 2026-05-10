import { eq } from "drizzle-orm";
import type { CloudStorageProvider, SaveStorageConfigRequest, StorageConfigResponse, StorageTestResult } from "../contracts.js";
import { db } from "../../infrastructure/database.js";
import {
  CosAssetStorageAdapter,
  MyToolsAssetStorageAdapter,
  S3AssetStorageAdapter,
  normalizeKeyPrefix,
  storageErrorMessage,
  type CosStorageAdapterConfig,
  type MyToolsStorageAdapterConfig,
  type S3StorageAdapterConfig
} from "../../infrastructure/storage/asset-storage.js";
import { storageConfigs } from "../../infrastructure/schema.js";

const ACTIVE_STORAGE_CONFIG_ID = "active";
const DEFAULT_COS_BUCKET = process.env.COS_DEFAULT_BUCKET?.trim() || "source-1253253332";
const DEFAULT_COS_REGION = process.env.COS_DEFAULT_REGION?.trim() || "ap-nanjing";
const DEFAULT_COS_KEY_PREFIX = process.env.COS_DEFAULT_KEY_PREFIX?.trim() || "gpt-image-canvas/assets";
const DEFAULT_S3_REGION = process.env.S3_DEFAULT_REGION?.trim() || "auto";
const DEFAULT_S3_KEY_PREFIX = process.env.S3_DEFAULT_KEY_PREFIX?.trim() || "gpt-image-canvas/assets";
const MY_TOOLS_BASE_URL = process.env.MY_TOOLS_BASE_URL?.trim() || "";
const MY_TOOLS_STORAGE_SHARED_SECRET = process.env.MY_TOOLS_STORAGE_SHARED_SECRET?.trim() || "";

type StorageConfigRow = typeof storageConfigs.$inferSelect;

export function getStorageConfig(): StorageConfigResponse {
  return toStorageConfigResponse(getStorageConfigRow());
}

export function getActiveCloudStorageProvider(): "cos" | "my_tools" | "s3" | undefined {
  const configured = process.env.CLOUD_STORAGE_PROVIDER?.trim().toLowerCase();
  if (configured === "my_tools") {
    return getActiveMyToolsStorageConfig() ? "my_tools" : undefined;
  }
  if (configured === "s3") {
    return getActiveS3StorageConfig() ? "s3" : undefined;
  }
  if (configured === "cos") {
    return getActiveCosStorageConfig() ? "cos" : undefined;
  }

  const row = getStorageConfigRow();
  if (row?.enabled === 1 && row.provider === "my_tools") {
    return getActiveMyToolsStorageConfig() ? "my_tools" : undefined;
  }
  if (row?.enabled === 1 && row.provider === "s3") {
    return getActiveS3StorageConfig() ? "s3" : undefined;
  }
  return getActiveCosStorageConfig() ? "cos" : undefined;
}

export function getActiveCosStorageConfig(): CosStorageAdapterConfig | undefined {
  const row = getStorageConfigRow();
  if (!row || row.enabled !== 1 || row.provider !== "cos" || !row.secretId || !row.secretKey || !row.bucket || !row.region) {
    return undefined;
  }

  return {
    secretId: row.secretId,
    secretKey: row.secretKey,
    bucket: row.bucket,
    region: row.region,
    keyPrefix: normalizeKeyPrefix(row.keyPrefix ?? DEFAULT_COS_KEY_PREFIX)
  };
}

export function getActiveS3StorageConfig(): S3StorageAdapterConfig | undefined {
  const row = getStorageConfigRow();
  if (!row || row.enabled !== 1 || row.provider !== "s3" || !row.secretId || !row.secretKey || !row.bucket || !row.region) {
    return undefined;
  }

  return {
    accessKeyId: row.secretId,
    secretAccessKey: row.secretKey,
    bucket: row.bucket,
    endpoint: row.endpoint?.trim() || undefined,
    forcePathStyle: row.forcePathStyle === 1,
    region: row.region,
    keyPrefix: normalizeKeyPrefix(row.keyPrefix ?? DEFAULT_S3_KEY_PREFIX)
  };
}

export function getActiveMyToolsStorageConfig(): MyToolsStorageAdapterConfig | undefined {
  if (!MY_TOOLS_BASE_URL || !MY_TOOLS_STORAGE_SHARED_SECRET) {
    return undefined;
  }

  return {
    baseUrl: MY_TOOLS_BASE_URL,
    sharedSecret: MY_TOOLS_STORAGE_SHARED_SECRET
  };
}

export async function saveStorageConfig(input: SaveStorageConfigRequest): Promise<StorageConfigResponse> {
  const now = new Date().toISOString();
  const existing = getStorageConfigRow();

  if (!input.enabled) {
    upsertStorageConfig({
      ...disabledStorageRow(existing, now),
      enabled: 0,
      provider: existing?.provider ?? "cos",
      updatedAt: now
    });
    return getStorageConfig();
  }

  if (input.provider === "my_tools") {
    const config = getActiveMyToolsStorageConfig();
    if (!config) {
      throw new Error("MY_TOOLS_BASE_URL and MY_TOOLS_STORAGE_SHARED_SECRET are required.");
    }
    await new MyToolsAssetStorageAdapter(config).testConfig();

    upsertStorageConfig({
      ...disabledStorageRow(existing, now),
      enabled: 1,
      provider: "my_tools",
      updatedAt: now
    });
    return getStorageConfig();
  }

  if (input.provider === "s3") {
    const parsed = resolveS3ConfigForSave(input, existing);
    await new S3AssetStorageAdapter(parsed).testConfig();

    upsertStorageConfig({
      id: ACTIVE_STORAGE_CONFIG_ID,
      ownerTokenId: "local",
      provider: "s3",
      enabled: 1,
      secretId: parsed.accessKeyId,
      secretKey: parsed.secretAccessKey,
      bucket: parsed.bucket,
      region: parsed.region,
      keyPrefix: parsed.keyPrefix,
      endpoint: parsed.endpoint ?? null,
      forcePathStyle: parsed.forcePathStyle ? 1 : 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    return getStorageConfig();
  }

  const parsed = resolveCosConfigForSave(input, existing);
  await new CosAssetStorageAdapter(parsed).testConfig();

  upsertStorageConfig({
    id: ACTIVE_STORAGE_CONFIG_ID,
    ownerTokenId: "local",
    provider: "cos",
    enabled: 1,
    secretId: parsed.secretId,
    secretKey: parsed.secretKey,
    bucket: parsed.bucket,
    region: parsed.region,
    keyPrefix: parsed.keyPrefix,
    endpoint: null,
    forcePathStyle: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });

  return getStorageConfig();
}

export async function testStorageConfig(input: SaveStorageConfigRequest): Promise<StorageTestResult> {
  try {
    if (input.provider === "my_tools") {
      const config = getActiveMyToolsStorageConfig();
      if (!config) {
        throw new Error("MY_TOOLS_BASE_URL and MY_TOOLS_STORAGE_SHARED_SECRET are required.");
      }
      await new MyToolsAssetStorageAdapter(config).testConfig();
      return {
        ok: true,
        message: "my_tools storage is available."
      };
    }

    if (input.provider === "s3") {
      const parsed = resolveS3ConfigForSave(input, getStorageConfigRow());
      await new S3AssetStorageAdapter(parsed).testConfig();
      return {
        ok: true,
        message: "S3-compatible storage is available."
      };
    }

    const parsed = resolveCosConfigForSave(input, getStorageConfigRow());
    await new CosAssetStorageAdapter(parsed).testConfig();
    return {
      ok: true,
      message: "COS configuration is available."
    };
  } catch (error) {
    return {
      ok: false,
      message: storageErrorMessage(error)
    };
  }
}

function getStorageConfigRow(): StorageConfigRow | undefined {
  return db.select().from(storageConfigs).where(eq(storageConfigs.id, ACTIVE_STORAGE_CONFIG_ID)).get();
}

function upsertStorageConfig(row: StorageConfigRow): void {
  db.insert(storageConfigs)
    .values(row)
    .onConflictDoUpdate({
      target: storageConfigs.id,
      set: {
        provider: row.provider,
        enabled: row.enabled,
        secretId: row.secretId,
        secretKey: row.secretKey,
        bucket: row.bucket,
        region: row.region,
        keyPrefix: row.keyPrefix,
        endpoint: row.endpoint,
        forcePathStyle: row.forcePathStyle,
        updatedAt: row.updatedAt
      }
    })
    .run();
}

function disabledStorageRow(existing: StorageConfigRow | undefined, now: string): StorageConfigRow {
  return {
    id: ACTIVE_STORAGE_CONFIG_ID,
    ownerTokenId: "local",
    provider: existing?.provider ?? "cos",
    enabled: existing?.enabled ?? 0,
    secretId: existing?.secretId ?? null,
    secretKey: existing?.secretKey ?? null,
    bucket: existing?.bucket ?? DEFAULT_COS_BUCKET,
    region: existing?.region ?? DEFAULT_COS_REGION,
    keyPrefix: normalizeKeyPrefix(existing?.keyPrefix ?? DEFAULT_COS_KEY_PREFIX),
    endpoint: existing?.endpoint ?? null,
    forcePathStyle: existing?.forcePathStyle ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now
  };
}

function resolveCosConfigForSave(input: SaveStorageConfigRequest, existing: StorageConfigRow | undefined): CosStorageAdapterConfig {
  if (input.provider !== "cos") {
    throw new Error("COS configuration is required.");
  }

  const cos = input.cos;
  if (!cos) {
    throw new Error("COS config must be a JSON object.");
  }

  const secretId = requiredString(cos.secretId, "COS SecretId");
  const secretKey = cos.preserveSecret ? existing?.secretKey : cos.secretKey;
  const bucket = requiredString(cos.bucket, "COS bucket");
  const region = requiredString(cos.region, "COS region");

  if (!secretKey?.trim()) {
    throw new Error("COS SecretKey is required.");
  }

  return {
    secretId,
    secretKey: secretKey.trim(),
    bucket,
    region,
    keyPrefix: normalizeKeyPrefix(cos.keyPrefix)
  };
}

function resolveS3ConfigForSave(input: SaveStorageConfigRequest, existing: StorageConfigRow | undefined): S3StorageAdapterConfig {
  if (input.provider !== "s3") {
    throw new Error("S3-compatible config is required.");
  }

  const s3 = input.s3;
  if (!s3) {
    throw new Error("S3-compatible config must be a JSON object.");
  }

  const accessKeyId = requiredString(s3.accessKeyId, "S3 Access Key ID");
  const secretAccessKey = s3.preserveSecret ? existing?.secretKey : s3.secretAccessKey;
  const bucket = requiredString(s3.bucket, "S3 bucket");
  const region = requiredString(s3.region || DEFAULT_S3_REGION, "S3 region");

  if (!secretAccessKey?.trim()) {
    throw new Error("S3 Secret Access Key is required.");
  }

  return {
    accessKeyId,
    secretAccessKey: secretAccessKey.trim(),
    bucket,
    endpoint: s3.endpoint?.trim() || undefined,
    forcePathStyle: s3.forcePathStyle === true,
    region,
    keyPrefix: normalizeKeyPrefix(s3.keyPrefix || DEFAULT_S3_KEY_PREFIX)
  };
}

function requiredString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }

  return trimmed;
}

function toStorageConfigResponse(row: StorageConfigRow | undefined): StorageConfigResponse {
  const provider = storageProviderValue(row?.provider);
  return {
    enabled: row?.enabled === 1,
    provider,
    myToolsAvailable: Boolean(getActiveMyToolsStorageConfig()),
    cos: {
      secretId: provider === "cos" ? row?.secretId ?? "" : "",
      secretKey: {
        hasSecret: provider === "cos" && Boolean(row?.secretKey),
        value: provider === "cos" && row?.secretKey ? maskSecret(row.secretKey) : undefined
      },
      bucket: provider === "cos" ? row?.bucket ?? DEFAULT_COS_BUCKET : DEFAULT_COS_BUCKET,
      region: provider === "cos" ? row?.region ?? DEFAULT_COS_REGION : DEFAULT_COS_REGION,
      keyPrefix: normalizeKeyPrefix(provider === "cos" ? row?.keyPrefix ?? DEFAULT_COS_KEY_PREFIX : DEFAULT_COS_KEY_PREFIX)
    },
    s3: {
      accessKeyId: provider === "s3" ? row?.secretId ?? "" : "",
      secretAccessKey: {
        hasSecret: provider === "s3" && Boolean(row?.secretKey),
        value: provider === "s3" && row?.secretKey ? maskSecret(row.secretKey) : undefined
      },
      bucket: provider === "s3" ? row?.bucket ?? "" : "",
      endpoint: provider === "s3" ? row?.endpoint ?? "" : "",
      forcePathStyle: provider === "s3" ? row?.forcePathStyle === 1 : true,
      region: provider === "s3" ? row?.region ?? DEFAULT_S3_REGION : DEFAULT_S3_REGION,
      keyPrefix: normalizeKeyPrefix(provider === "s3" ? row?.keyPrefix ?? DEFAULT_S3_KEY_PREFIX : DEFAULT_S3_KEY_PREFIX)
    }
  };
}

function storageProviderValue(value: string | undefined): CloudStorageProvider {
  return value === "my_tools" || value === "s3" ? value : "cos";
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 4)}${"*".repeat(Math.min(8, Math.max(4, value.length - 8)))}${value.slice(-4)}`;
}
