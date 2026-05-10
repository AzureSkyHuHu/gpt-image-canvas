import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { AssetCloudActionResponse, AssetCloudStatusResponse } from "../contracts.js";
import type { DataOwner } from "../auth/data-owner.js";
import { db } from "../../infrastructure/database.js";
import { assets, generationOutputs } from "../../infrastructure/schema.js";
import { LocalAssetStorageAdapter, MyToolsAssetStorageAdapter, storageErrorMessage } from "../../infrastructure/storage/asset-storage.js";
import { getActiveMyToolsStorageConfig } from "../storage/storage-config.js";
import { getStoredAssetFile } from "../generation/image-generation.js";

const localAssetStorage = new LocalAssetStorageAdapter();

type AssetRow = typeof assets.$inferSelect;

export async function readAssetCloudStatus(owner: DataOwner, assetId: string): Promise<AssetCloudStatusResponse | undefined> {
  const asset = findOwnedAsset(owner, assetId);
  if (!asset) {
    return undefined;
  }

  if (asset.cloudStatus === "failed") {
    return fromStoredAsset(asset, "failed", false);
  }

  if (!asset.cloudProvider || !asset.cloudObjectKey) {
    return fromStoredAsset(asset, "missing", false);
  }

  if (asset.cloudProvider !== "my_tools") {
    const status = storedAssetCloudStatus(asset);
    return fromStoredAsset(asset, status, status === "uploaded");
  }

  const config = getActiveMyToolsStorageConfig();
  if (!config) {
    return {
      ...fromStoredAsset(asset, "uploaded", false),
      lastError: "my_tools storage is not configured."
    };
  }

  try {
    const status = await new MyToolsAssetStorageAdapter(config).getStatus({ archiveId: asset.cloudObjectKey });
    const cloud = {
      assetId: asset.id,
      provider: "my_tools" as const,
      status: status.status,
      readable: status.readable,
      visibility: status.visibility,
      publicUrl: status.publicUrl,
      syncedAt: status.syncedAt ?? asset.cloudSyncedAt ?? asset.cloudUploadedAt ?? undefined,
      sizeBytes: status.sizeBytes,
      mimeType: status.mimeType,
      requestId: status.requestId ?? asset.cloudRequestId ?? undefined,
      lastError: asset.cloudError ?? undefined
    };
    updateCloudSnapshot(asset.id, cloud);
    return cloud;
  } catch (error) {
    const status = storedAssetCloudStatus(asset);
    return {
      ...fromStoredAsset(asset, status, status === "uploaded"),
      lastError: storageErrorMessage(error)
    };
  }
}

export async function resyncAssetToMyTools(owner: DataOwner, assetId: string): Promise<AssetCloudActionResponse | undefined> {
  const asset = findOwnedAsset(owner, assetId);
  if (!asset) {
    return undefined;
  }

  const file = getStoredAssetFile(owner, assetId);
  if (!file) {
    return undefined;
  }

  const config = getActiveMyToolsStorageConfig();
  if (!config) {
    throw new Error("my_tools storage is not configured.");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(file.filePath);
  } catch {
    throw new Error("Local asset file is not readable.");
  }

  const output = findFirstOutputForAsset(owner, assetId);
  const result = await new MyToolsAssetStorageAdapter(config).putObject({
    bytes,
    mimeType: asset.mimeType,
    metadata: {
      imageOwnerId: owner.id,
      assetId: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt,
      generationId: output?.generationId,
      outputId: output?.id
    }
  });

  const syncedAt = result.syncedAt ?? new Date().toISOString();
  const cloud: AssetCloudStatusResponse = {
    assetId: asset.id,
    provider: "my_tools",
    status: "uploaded",
    readable: true,
    visibility: result.visibility ?? "private",
    publicUrl: result.publicUrl,
    syncedAt,
    mimeType: asset.mimeType,
    requestId: result.requestId
  };

  db.update(assets)
    .set({
      cloudProvider: "my_tools",
      cloudBucket: null,
      cloudRegion: null,
      cloudObjectKey: result.archiveId,
      cloudStatus: "uploaded",
      cloudError: null,
      cloudUploadedAt: syncedAt,
      cloudRequestId: result.requestId ?? null,
      cloudVisibility: cloud.visibility,
      cloudPublicUrl: cloud.publicUrl ?? null,
      cloudSyncedAt: syncedAt
    })
    .where(and(eq(assets.id, asset.id), eq(assets.ownerTokenId, owner.id)))
    .run();

  return {
    cloud,
    message: "Asset resynced to my_tools."
  };
}

export async function restoreAssetFromMyTools(owner: DataOwner, assetId: string): Promise<AssetCloudActionResponse | undefined> {
  const asset = findOwnedAsset(owner, assetId);
  if (!asset) {
    return undefined;
  }
  if (asset.cloudProvider !== "my_tools" || asset.cloudStatus !== "uploaded" || !asset.cloudObjectKey) {
    throw new Error("This asset has no readable my_tools archive.");
  }

  const file = getStoredAssetFile(owner, assetId);
  if (!file) {
    return undefined;
  }

  const config = getActiveMyToolsStorageConfig();
  if (!config) {
    throw new Error("my_tools storage is not configured.");
  }

  const adapter = new MyToolsAssetStorageAdapter(config);
  const bytes = await adapter.getObject({ archiveId: asset.cloudObjectKey });
  await localAssetStorage.putObject({ filePath: file.filePath, bytes });
  const syncedAt = new Date().toISOString();

  const cloud: AssetCloudStatusResponse = {
    assetId: asset.id,
    provider: "my_tools",
    status: "uploaded",
    readable: true,
    visibility: asset.cloudVisibility === "public" ? "public" : "private",
    publicUrl: safeHttpUrl(asset.cloudPublicUrl),
    syncedAt,
    mimeType: asset.mimeType,
    requestId: asset.cloudRequestId ?? undefined
  };
  updateCloudSnapshot(asset.id, cloud);

  return {
    cloud,
    message: "Asset restored from my_tools."
  };
}

export async function refreshAssetCloudUrl(owner: DataOwner, assetId: string): Promise<AssetCloudActionResponse | undefined> {
  const asset = findOwnedAsset(owner, assetId);
  if (!asset) {
    return undefined;
  }
  if (asset.cloudProvider !== "my_tools" || asset.cloudStatus !== "uploaded" || !asset.cloudObjectKey) {
    throw new Error("This asset has no my_tools archive URL to refresh.");
  }

  const config = getActiveMyToolsStorageConfig();
  if (!config) {
    throw new Error("my_tools storage is not configured.");
  }

  const refreshed = await new MyToolsAssetStorageAdapter(config).refreshUrl({
    archiveId: asset.cloudObjectKey,
    visibility: "public"
  });
  const syncedAt = new Date().toISOString();
  const cloud: AssetCloudStatusResponse = {
    assetId: asset.id,
    provider: "my_tools",
    status: "uploaded",
    readable: true,
    visibility: refreshed.visibility,
    publicUrl: refreshed.publicUrl,
    syncedAt,
    mimeType: asset.mimeType,
    requestId: refreshed.requestId ?? asset.cloudRequestId ?? undefined
  };
  updateCloudSnapshot(asset.id, cloud);

  return {
    cloud,
    message: "Cloud URL refreshed."
  };
}

function findOwnedAsset(owner: DataOwner, assetId: string): AssetRow | undefined {
  return db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.ownerTokenId, owner.id))).get();
}

function findFirstOutputForAsset(owner: DataOwner, assetId: string): (typeof generationOutputs.$inferSelect) | undefined {
  return db
    .select()
    .from(generationOutputs)
    .where(and(eq(generationOutputs.assetId, assetId), eq(generationOutputs.ownerTokenId, owner.id)))
    .get();
}

function fromStoredAsset(asset: AssetRow, status: AssetCloudStatusResponse["status"], readable: boolean): AssetCloudStatusResponse {
  return {
    assetId: asset.id,
    provider: validCloudProvider(asset.cloudProvider),
    status,
    readable,
    visibility: asset.cloudVisibility === "public" ? "public" : "private",
    publicUrl: safeHttpUrl(asset.cloudPublicUrl),
    syncedAt: asset.cloudSyncedAt ?? asset.cloudUploadedAt ?? undefined,
    mimeType: asset.mimeType,
    requestId: asset.cloudRequestId ?? undefined,
    lastError: asset.cloudError ?? undefined
  };
}

function updateCloudSnapshot(assetId: string, cloud: AssetCloudStatusResponse): void {
  db.update(assets)
    .set({
      cloudStatus: cloud.status,
      cloudError: cloud.status === "failed" ? cloud.lastError ?? "Cloud asset is not readable." : null,
      cloudRequestId: cloud.requestId ?? null,
      cloudVisibility: cloud.visibility,
      cloudPublicUrl: cloud.visibility === "public" ? cloud.publicUrl ?? null : null,
      cloudSyncedAt: cloud.syncedAt ?? null
    })
    .where(eq(assets.id, assetId))
    .run();
}

function validCloudProvider(value: string | null): AssetCloudStatusResponse["provider"] {
  return value === "my_tools" || value === "cos" || value === "s3" ? value : undefined;
}

function storedAssetCloudStatus(asset: AssetRow): AssetCloudStatusResponse["status"] {
  return asset.cloudStatus === "uploaded" || asset.cloudStatus === "failed" || asset.cloudStatus === "missing" || asset.cloudStatus === "deleted"
    ? asset.cloudStatus
    : "missing";
}

function safeHttpUrl(input: string | null | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
