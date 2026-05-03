import { randomUUID } from "node:crypto";
import { rm, readFile, writeFile } from "node:fs/promises";
import COS from "cos-nodejs-sdk-v5";

export interface AssetStorageAdapter<TPutInput, TLocation> {
  putObject(input: TPutInput): Promise<AssetStoragePutResult>;
  getObject(location: TLocation): Promise<Buffer>;
  deleteObject(location: TLocation): Promise<void>;
}

export interface AssetStoragePutResult {
  etag?: string;
  requestId?: string;
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
    formData.set(
      "file",
      new Blob([bufferToArrayBuffer(input.bytes)], { type: input.mimeType }),
      input.metadata.fileName
    );
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

    const data = await response.json() as { archiveId?: unknown; requestId?: unknown };
    if (typeof data.archiveId !== "string" || !data.archiveId.trim()) {
      throw new Error("my_tools asset upload returned no archiveId.");
    }

    return {
      archiveId: data.archiveId,
      requestId: typeof data.requestId === "string" ? data.requestId : undefined
    };
  }

  async getObject(location: MyToolsAssetLocation): Promise<Buffer> {
    const response = await fetch(
      `${this.baseUrl}/api/internal/gic/assets/${encodeURIComponent(location.archiveId)}`,
      {
        method: "GET",
        headers: this.authHeaders()
      }
    );

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "my_tools asset read failed."));
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject(location: MyToolsAssetLocation): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/internal/gic/assets/${encodeURIComponent(location.archiveId)}`,
      {
        method: "DELETE",
        headers: this.authHeaders()
      }
    );

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
      const data = await response.json() as { message?: unknown };
      if (typeof data.message === "string" && data.message.trim()) {
        return data.message.trim();
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
