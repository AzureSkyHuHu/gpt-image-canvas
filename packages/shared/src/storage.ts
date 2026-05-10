import type { CloudStorageProvider } from "./image.js";
import type { MaskedSecret } from "./provider-config.js";

export interface CosStorageConfigView {
  secretId: string;
  secretKey: MaskedSecret;
  bucket: string;
  region: string;
  keyPrefix: string;
}

export interface S3StorageConfigView {
  accessKeyId: string;
  secretAccessKey: MaskedSecret;
  bucket: string;
  region: string;
  endpoint: string;
  keyPrefix: string;
  forcePathStyle: boolean;
}

export interface StorageConfigResponse {
  enabled: boolean;
  provider: CloudStorageProvider;
  cos: CosStorageConfigView;
  s3: S3StorageConfigView;
  myToolsAvailable?: boolean;
}

export interface SaveCosStorageConfig {
  secretId: string;
  secretKey?: string;
  preserveSecret?: boolean;
  bucket: string;
  region: string;
  keyPrefix: string;
}

export interface SaveS3StorageConfig {
  accessKeyId: string;
  secretAccessKey?: string;
  preserveSecret?: boolean;
  bucket: string;
  region: string;
  endpoint: string;
  keyPrefix: string;
  forcePathStyle?: boolean;
}

export interface SaveStorageConfigRequest {
  enabled: boolean;
  provider: CloudStorageProvider;
  cos?: SaveCosStorageConfig;
  s3?: SaveS3StorageConfig;
}

export interface StorageTestResult {
  ok: boolean;
  message: string;
}
