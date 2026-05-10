import { randomUUID } from "node:crypto";
import { rm, readFile, writeFile } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import COS from "cos-nodejs-sdk-v5";

export interface AssetStorageAdapter<TPutInput, TLocation> {
  putObject(input: TPutInput): Promise<AssetStoragePutResult>;
  getObject(location: TLocation): Promise<Buffer>;
  deleteObject(location: TLocation): Promise<void>;
}

export interface AssetStoragePutResult {
  etag?: string;
  requestId?: string;
  publicUrl?: string;
  visibility?: "private" | "public";
  syncedAt?: string;
}

export interface LocalAssetPutInput {
  filePath: string;
  bytes: Buffer;
}

export interface LocalAssetLocation {
  filePath: string;
}

export interface CosStorageAdapterConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  keyPrefix: string;
}

export interface CosAssetPutInput {
  key: string;
  bytes: Buffer;
  mimeType: string;
}

export interface CosAssetLocation {
  bucket: string;
  region: string;
  key: string;
}

export interface S3StorageAdapterConfig {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint?: string;
  keyPrefix: string;
  forcePathStyle: boolean;
}

export interface S3AssetPutInput {
  key: string;
  bytes: Buffer;
  mimeType: string;
}

export interface S3AssetLocation {
  bucket: string;
  region: string;
  key: string;
}

export interface MyToolsStorageAdapterConfig {
  baseUrl: string;
  sharedSecret: string;
}

export interface MyToolsAssetPutInput {
  bytes: Buffer;
  mimeType: string;
  metadata: {
    imageOwnerId: string;
    assetId: string;
    fileName: string;
    mimeType: string;
    width: number;
    height: number;
    createdAt: string;
    generationId?: string;
    outputId?: string;
  };
}

export interface MyToolsAssetLocation {
  archiveId: string;
}

export interface MyToolsAssetStatus {
  archiveId: string;
  status: "uploaded" | "missing" | "deleted" | "failed";
  readable: boolean;
  visibility: "private" | "public";
  publicUrl?: string;
  syncedAt?: string;
  sizeBytes?: number;
  mimeType?: string;
  requestId?: string;
}

export interface MyToolsRefreshUrlInput extends MyToolsAssetLocation {
  ttlSeconds?: number;
  visibility?: "private" | "public";
}

export interface MyToolsRefreshUrlResult {
  publicUrl: string;
  visibility: "private" | "public";
  expiresAt?: string;
  requestId?: string;
}

export class LocalAssetStorageAdapter implements AssetStorageAdapter<LocalAssetPutInput, LocalAssetLocation> {
  async putObject(input: LocalAssetPutInput): Promise<AssetStoragePutResult> {
    await writeFile(input.filePath, input.bytes);
    return {};
  }

  async getObject(location: LocalAssetLocation): Promise<Buffer> {
    return readFile(location.filePath);
  }

  async deleteObject(location: LocalAssetLocation): Promise<void> {
    await rm(location.filePath, { force: true });
  }
}

export class CosAssetStorageAdapter implements AssetStorageAdapter<CosAssetPutInput, CosAssetLocation> {
  private readonly client: COS;

  constructor(private readonly config: CosStorageAdapterConfig) {
    this.client = new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
      Protocol: "https:"
    });
  }

  async putObject(input: CosAssetPutInput): Promise<AssetStoragePutResult> {
    const result = await this.client.putObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: input.key,
      Body: input.bytes,
      ContentLength: input.bytes.length,
      ContentType: input.mimeType
    });

    return {
      etag: result.ETag,
      requestId: result.RequestId
    };
  }

  async getObject(location: CosAssetLocation): Promise<Buffer> {
    const result = await this.client.getObject({
      Bucket: location.bucket,
      Region: location.region,
      Key: location.key
    });

    return Buffer.isBuffer(result.Body) ? result.Body : Buffer.from(result.Body);
  }

  async deleteObject(location: CosAssetLocation): Promise<void> {
    await this.client.deleteObject({
      Bucket: location.bucket,
      Region: location.region,
      Key: location.key
    });
  }

  async testConfig(): Promise<void> {
    const key = buildCosObjectKey(this.config.keyPrefix, `.storage-test-${randomUUID()}.txt`, new Date().toISOString());
    await this.putObject({
      key,
      bytes: Buffer.from("gpt-image-canvas storage test\n", "utf8"),
      mimeType: "text/plain; charset=utf-8"
    });
    await this.deleteObject({
      bucket: this.config.bucket,
      region: this.config.region,
      key
    });
  }
}

export class MyToolsAssetStorageAdapter implements AssetStorageAdapter<MyToolsAssetPutInput, MyToolsAssetLocation> {
  private readonly baseUrl: string;

  constructor(private readonly config: MyToolsStorageAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/u, "");
  }

  async putObject(input: MyToolsAssetPutInput): Promise<AssetStoragePutResult & { archiveId: string }> {
    const formData = new FormData();
    formData.set("file", new Blob([bufferToArrayBuffer(input.bytes)], { type: input.mimeType }), input.metadata.fileName);
    formData.set("metadata", JSON.stringify(input.metadata));

    const response = await fetch(`${this.baseUrl}/api/internal/gic/assets`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        Accept: "application/json"
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "my_tools asset upload failed."));
    }

    const data = (await response.json()) as {
      archiveId?: unknown;
      publicUrl?: unknown;
      requestId?: unknown;
      syncedAt?: unknown;
      visibility?: unknown;
    };
    if (typeof data.archiveId !== "string" || !data.archiveId.trim()) {
      throw new Error("my_tools asset upload returned no archiveId.");
    }

    return {
      archiveId: data.archiveId,
      publicUrl: safeHttpUrl(data.publicUrl),
      requestId: typeof data.requestId === "string" ? data.requestId : undefined,
      syncedAt: typeof data.syncedAt === "string" ? data.syncedAt : undefined,
      visibility: data.visibility === "public" ? "public" : data.visibility === "private" ? "private" : undefined
    };
  }

  async getStatus(location: MyToolsAssetLocation): Promise<MyToolsAssetStatus> {
    const response = await fetch(`${this.baseUrl}/api/internal/gic/assets/${encodeURIComponent(location.archiveId)}/status`, {
      method: "GET",
      headers: {
        ...this.authHeaders(),
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "my_tools asset status failed."));
    }

    return parseMyToolsAssetStatus(await response.json(), location.archiveId);
  }

  async refreshUrl(input: MyToolsRefreshUrlInput): Promise<MyToolsRefreshUrlResult> {
    const response = await fetch(`${this.baseUrl}/api/internal/gic/assets/${encodeURIComponent(input.archiveId)}/refresh-url`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ttlSeconds: input.ttlSeconds,
        visibility: input.visibility
      })
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "my_tools asset URL refresh failed."));
    }

    return parseMyToolsRefreshUrlResult(await response.json());
  }

  async getObject(location: MyToolsAssetLocation): Promise<Buffer> {
    const response = await fetch(`${this.baseUrl}/api/internal/gic/assets/${encodeURIComponent(location.archiveId)}`, {
      method: "GET",
      headers: this.authHeaders()
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "my_tools asset read failed."));
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject(location: MyToolsAssetLocation): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/internal/gic/assets/${encodeURIComponent(location.archiveId)}`, {
      method: "DELETE",
      headers: this.authHeaders()
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(await responseErrorMessage(response, "my_tools asset delete failed."));
    }
  }

  async testConfig(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/internal/gic/storage/test`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "my_tools storage test failed."));
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      "X-GIC-Storage-Key": this.config.sharedSecret
    };
  }
}

export class S3AssetStorageAdapter implements AssetStorageAdapter<S3AssetPutInput, S3AssetLocation> {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageAdapterConfig) {
    this.client = new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      },
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle,
      region: config.region
    });
  }

  async putObject(input: S3AssetPutInput): Promise<AssetStoragePutResult> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentLength: input.bytes.length,
        ContentType: input.mimeType
      })
    );

    return {
      etag: result.ETag,
      requestId: result.$metadata.requestId
    };
  }

  async getObject(location: S3AssetLocation): Promise<Buffer> {
    const result = await this.clientForLocation(location).send(
      new GetObjectCommand({
        Bucket: location.bucket,
        Key: location.key
      })
    );

    if (!result.Body) {
      return Buffer.alloc(0);
    }

    return Buffer.from(await result.Body.transformToByteArray());
  }

  async deleteObject(location: S3AssetLocation): Promise<void> {
    await this.clientForLocation(location).send(
      new DeleteObjectCommand({
        Bucket: location.bucket,
        Key: location.key
      })
    );
  }

  private clientForLocation(location: S3AssetLocation): S3Client {
    return location.region === this.config.region
      ? this.client
      : new S3Client({
          credentials: {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey
          },
          endpoint: this.config.endpoint || undefined,
          forcePathStyle: this.config.forcePathStyle,
          region: location.region
        });
  }

  async testConfig(): Promise<void> {
    const key = buildCosObjectKey(this.config.keyPrefix, `.storage-test-${randomUUID()}.txt`, new Date().toISOString());
    await this.putObject({
      key,
      bytes: Buffer.from("gpt-image-canvas storage test\n", "utf8"),
      mimeType: "text/plain; charset=utf-8"
    });
    await this.deleteObject({
      bucket: this.config.bucket,
      region: this.config.region,
      key
    });
  }
}

function parseMyToolsAssetStatus(input: unknown, fallbackArchiveId: string): MyToolsAssetStatus {
  if (!isRecord(input)) {
    throw new Error("my_tools asset status returned invalid data.");
  }

  const status = stringValue(input.status);
  if (status !== "uploaded" && status !== "missing" && status !== "deleted" && status !== "failed") {
    throw new Error("my_tools asset status returned invalid status.");
  }

  const visibility = stringValue(input.visibility) === "public" ? "public" : "private";
  return {
    archiveId: stringValue(input.archiveId) || fallbackArchiveId,
    status,
    readable: input.readable === true,
    visibility,
    publicUrl: safeHttpUrl(input.publicUrl),
    syncedAt: stringValue(input.syncedAt),
    sizeBytes: numberValue(input.sizeBytes),
    mimeType: stringValue(input.mimeType),
    requestId: stringValue(input.requestId)
  };
}

function parseMyToolsRefreshUrlResult(input: unknown): MyToolsRefreshUrlResult {
  if (!isRecord(input)) {
    throw new Error("my_tools URL refresh returned invalid data.");
  }

  const publicUrl = safeHttpUrl(input.publicUrl);
  if (!publicUrl) {
    throw new Error("my_tools URL refresh returned no publicUrl.");
  }

  return {
    publicUrl,
    visibility: stringValue(input.visibility) === "public" ? "public" : "private",
    expiresAt: stringValue(input.expiresAt),
    requestId: stringValue(input.requestId)
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : undefined;
}

function safeHttpUrl(input: unknown): string | undefined {
  const value = stringValue(input);
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function buildCosObjectKey(keyPrefix: string, fileName: string, createdAt: string): string {
  const date = new Date(createdAt);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = String(safeDate.getUTCFullYear()).padStart(4, "0");
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const normalizedPrefix = normalizeKeyPrefix(keyPrefix);
  return [normalizedPrefix, year, month, fileName].filter(Boolean).join("/");
}

export function normalizeKeyPrefix(value: string | undefined): string {
  const normalized = (value ?? "gpt-image-canvas/assets")
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\/{2,}/gu, "/");

  return normalized || "gpt-image-canvas/assets";
}

export function storageErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "Cloud storage request failed.";
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as { message?: unknown; error?: { message?: unknown } };
      if (typeof data.message === "string" && data.message.trim()) {
        return data.message.trim();
      }
      if (typeof data.error?.message === "string" && data.error.message.trim()) {
        return data.error.message.trim();
      }
    }

    const text = await response.text();
    if (text.trim()) {
      return text.trim().slice(0, 1200);
    }
  } catch {
    // Use fallback below.
  }

  return fallback;
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
