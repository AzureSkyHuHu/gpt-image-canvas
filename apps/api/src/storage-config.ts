import { and, eq } from "drizzle-orm";
import type { SaveStorageConfigRequest, StorageConfigResponse, StorageTestResult } from "./contracts.js";
import { db } from "./database.js";
import type { DataOwner } from "./data-owner.js";
import {
  CosAssetStorageAdapter,
  MyToolsAssetStorageAdapter,
  normalizeKeyPrefix,
  type CosStorageAdapterConfig,
  type MyToolsStorageAdapterConfig,
  storageErrorMessage
} from "./asset-storage.js";
import { storageConfigs } from "./schema.js";

const ACTIVE_STORAGE_CONFIG_ID = "active";
const DEFAULT_COS_BUCKET = process.env.COS_DEFAULT_BUCKET?.trim() || "source-1253253332";
const DEFAULT_COS_REGION = process.env.COS_DEFAULT_REGION?.trim() || "ap-nanjing";
const DEFAULT_COS_KEY_PREFIX = process.env.COS_DEFAULT_KEY_PREFIX?.trim() || "gpt-image-canvas/assets";
const ENV_CLOUD_STORAGE_PROVIDER = process.env.CLOUD_STORAGE_PROVIDER?.trim();
const MY_TOOLS_STORAGE_BASE_URL = process.env.MY_TOOLS_STORAGE_BASE_URL?.trim();
const MY_TOOLS_STORAGE_SHARED_SECRET = process.env.MY_TOOLS_STORAGE_SHARED_SECRET?.trim();

type StorageConfigRow = typeof storageConfigs.$inferSelect;

export function getStorageConfig(owner: DataOwner): StorageConfigResponse {
  return toStorageConfigResponse(getStorageConfigRow(owner));
}

export function getActiveCosStorageConfig(owner: DataOwner): CosStorageAdapterConfig | undefined {
  const row = getStorageConfigRow(owner);
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

export async function saveStorageConfig(owner: DataOwner, input: SaveStorageConfigRequest): Promise<StorageConfigResponse> {
  const now = new Date().toISOString();
  const existing = getStorageConfigRow(owner);

  if (!input.enabled) {
    upsertStorageConfig({
      id: storageConfigIdForOwner(owner),
      ownerTokenId: owner.id,
      provider: "cos",
      enabled: 0,
      secretId: existing?.secretId ?? null,
      secretKey: existing?.secretKey ?? null,
      bucket: existing?.bucket ?? DEFAULT_COS_BUCKET,
      region: existing?.region ?? DEFAULT_COS_REGION,
      keyPrefix: normalizeKeyPrefix(existing?.keyPrefix ?? DEFAULT_COS_KEY_PREFIX),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    return getStorageConfig(owner);
  }

  const parsed = resolveCosConfigForSave(input, existing);
  await new CosAssetStorageAdapter(parsed).testConfig();

  upsertStorageConfig({
    id: storageConfigIdForOwner(owner),
    ownerTokenId: owner.id,
    provider: "cos",
    enabled: 1,
    secretId: parsed.secretId,
    secretKey: parsed.secretKey,
    bucket: parsed.bucket,
    region: parsed.region,
    keyPrefix: parsed.keyPrefix,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });

  return getStorageConfig(owner);
}

export function getActiveMyToolsStorageConfig(_owner: DataOwner): MyToolsStorageAdapterConfig | undefined {
  if (ENV_CLOUD_STORAGE_PROVIDER !== "my_tools" || !MY_TOOLS_STORAGE_BASE_URL || !MY_TOOLS_STORAGE_SHARED_SECRET) {
    return undefined;
  }

  return {
    baseUrl: MY_TOOLS_STORAGE_BASE_URL,
    sharedSecret: MY_TOOLS_STORAGE_SHARED_SECRET
  };
}

export function getActiveCloudStorageProvider(owner: DataOwner): "cos" | "my_tools" | undefined {
  if (getActiveMyToolsStorageConfig(owner)) {
    return "my_tools";
  }

  if (getActiveCosStorageConfig(owner)) {
    return "cos";
  }

  return undefined;
}

export async function testStorageConfig(owner: DataOwner, input: SaveStorageConfigRequest): Promise<StorageTestResult> {
  try {
    if (input.provider === "my_tools") {
      const config = getActiveMyToolsStorageConfig(owner);
      if (!config) {
        throw new Error("my_tools storage is not configured by environment variables.");
      }

      await new MyToolsAssetStorageAdapter(config).testConfig();
      return {
        ok: true,
        message: "my_tools storage is available."
      };
    }

    const parsed = resolveCosConfigForSave(input, getStorageConfigRow(owner));
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

function getStorageConfigRow(owner: DataOwner): StorageConfigRow | undefined {
  return db
    .select()
    .from(storageConfigs)
    .where(and(eq(storageConfigs.id, storageConfigIdForOwner(owner)), eq(storageConfigs.ownerTokenId, owner.id)))
    .get();
}

function upsertStorageConfig(row: StorageConfigRow): void {
  db.insert(storageConfigs)
    .values(row)
    .onConflictDoUpdate({
      target: storageConfigs.id,
      set: {
        ownerTokenId: row.ownerTokenId,
        provider: row.provider,
        enabled: row.enabled,
        secretId: row.secretId,
        secretKey: row.secretKey,
        bucket: row.bucket,
        region: row.region,
        keyPrefix: row.keyPrefix,
        updatedAt: row.updatedAt
      }
    })
    .run();
}

function storageConfigIdForOwner(owner: DataOwner): string {
  return owner.isLocal ? ACTIVE_STORAGE_CONFIG_ID : `${ACTIVE_STORAGE_CONFIG_ID}:${owner.id}`;
}

function resolveCosConfigForSave(input: SaveStorageConfigRequest, existing: StorageConfigRow | undefined): CosStorageAdapterConfig {
  if (input.provider !== "cos") {
    throw new Error("Only Tencent COS storage is supported in this version.");
  }

  const cos = input.cos;
  if (!cos) {
    throw new Error("COS configuration is required.");
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

function requiredString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }

  return trimmed;
}

function toStorageConfigResponse(row: StorageConfigRow | undefined): StorageConfigResponse {
  return {
    enabled: row?.enabled === 1,
    provider: "cos",
    cos: {
      secretId: row?.secretId ?? "",
      secretKey: {
        hasSecret: Boolean(row?.secretKey),
        value: row?.secretKey ? maskSecret(row.secretKey) : undefined
      },
      bucket: row?.bucket ?? DEFAULT_COS_BUCKET,
      region: row?.region ?? DEFAULT_COS_REGION,
      keyPrefix: normalizeKeyPrefix(row?.keyPrefix ?? DEFAULT_COS_KEY_PREFIX)
    }
  };
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 4)}${"*".repeat(Math.min(8, Math.max(4, value.length - 8)))}${value.slice(-4)}`;
}
