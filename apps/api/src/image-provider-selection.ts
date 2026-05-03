import { getCodexResponsesBaseURL, getValidCodexSession } from "./codex-auth.js";
import {
  createCodexImageProvider,
  getCodexImageProviderTimeoutMs
} from "./codex-image-provider.js";
import { selectImageProviderName } from "./codex-auth-utils.js";
import {
  ProviderError,
  type EditImageProviderInput,
  createOpenAIImageProvider,
  getConfiguredImageModel,
  getOpenAIImageProviderConfig,
  getOpenAIImageProviderConfigFromOverride,
  type ImageProviderInput,
  type ImageProvider,
  type OpenAIImageProviderConfig,
  type ProviderResult
} from "./image-provider.js";

export type ImageBackendMode = "access_token" | "my_tools" | "local";

export function createAccessTokenImageProvider(config: {
  apiKey: string;
  baseURL?: string;
  model?: string;
}): ImageProvider {
  return createOpenAIImageProvider(getOpenAIImageProviderConfigFromOverride(config));
}

export function getConfiguredImageBackendMode(): ImageBackendMode {
  const value = process.env.IMAGE_BACKEND?.trim().toLowerCase();

  if (value === "my_tools" || value === "local") {
    return value;
  }

  return "access_token";
}

export function createMyToolsImageProvider(config: {
  baseUrl: string;
  sharedSecret: string;
  imageOwnerId: string;
}): ImageProvider {
  return new MyToolsImageProvider(config);
}

export async function createLocalImageProvider(signal?: AbortSignal): Promise<ImageProvider> {
  const openAIProviderName = selectImageProviderName({
    openaiApiKey: process.env.OPENAI_API_KEY,
    codexSessionAvailable: false
  });

  if (openAIProviderName === "openai") {
    const openAIConfig = getOpenAIImageProviderConfig();
    if (!openAIConfig.ok) {
      throw openAIConfig.error;
    }

    return createOpenAIImageProvider(openAIConfig.config);
  }

  const providerName = selectImageProviderName({
    openaiApiKey: undefined,
    codexSessionAvailable: Boolean(await getValidCodexSession(signal))
  });

  if (providerName === "codex") {
    return createCodexImageProvider({
      baseURL: getCodexResponsesBaseURL(),
      model: getConfiguredImageModel(),
      timeoutMs: getCodexImageProviderTimeoutMs(),
      getSession: getValidCodexSession
    });
  }

  throw new ProviderError(
    "missing_provider",
    "服务器没有配置 OPENAI_API_KEY，也没有可用的 Codex 登录会话。请先登录 Codex 后重试。",
    401
  );
}

export function resolveLocalOpenAIImageProviderConfig():
  | {
      ok: true;
      config: OpenAIImageProviderConfig;
    }
  | {
      ok: false;
      error: ProviderError;
} {
  return getOpenAIImageProviderConfig();
}

class MyToolsImageProvider implements ImageProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: { baseUrl: string; sharedSecret: string; imageOwnerId: string }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/u, "");
  }

  async generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    const response = await fetch(`${this.baseUrl}/api/internal/gic/images/generate`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-GIC-Image-Key": this.config.sharedSecret
      },
      body: JSON.stringify({
        imageOwnerId: this.config.imageOwnerId,
        prompt: input.prompt,
        size: input.sizeApiValue,
        quality: input.quality,
        outputFormat: input.outputFormat,
        count: input.count
      }),
      signal
    });

    return normalizeMyToolsProviderResponse(response, input.sizeApiValue);
  }

  async edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    const formData = new FormData();
    const reference = dataUrlToBlob(input.referenceImage.dataUrl);
    formData.set("file", reference.blob, input.referenceImage.fileName ?? reference.fileName);
    formData.set(
      "metadata",
      JSON.stringify({
        imageOwnerId: this.config.imageOwnerId,
        prompt: input.prompt,
        size: input.sizeApiValue,
        quality: input.quality,
        outputFormat: input.outputFormat,
        count: input.count
      })
    );

    const response = await fetch(`${this.baseUrl}/api/internal/gic/images/edit`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-GIC-Image-Key": this.config.sharedSecret
      },
      body: formData,
      signal
    });

    return normalizeMyToolsProviderResponse(response, input.sizeApiValue);
  }
}

async function normalizeMyToolsProviderResponse(response: Response, fallbackSize: string): Promise<ProviderResult> {
  if (!response.ok) {
    throw new ProviderError("upstream_failure", await responseErrorMessage(response), response.status || 502);
  }

  const data = (await response.json()) as {
    model?: unknown;
    size?: unknown;
    images?: unknown;
  };

  if (!Array.isArray(data.images) || data.images.length === 0) {
    throw new ProviderError("unsupported_provider_behavior", "my_tools 没有返回图像结果。", 502);
  }

  const images = data.images.map((item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      "b64Json" in item &&
      typeof item.b64Json === "string" &&
      item.b64Json
    ) {
      return {
        b64Json: item.b64Json
      };
    }

    return undefined;
  });

  if (images.some((image) => !image)) {
    throw new ProviderError("unsupported_provider_behavior", "my_tools 没有返回 base64 图像数据。", 502);
  }

  return {
    model: typeof data.model === "string" && data.model ? data.model : getConfiguredImageModel(),
    size: typeof data.size === "string" && data.size ? data.size : fallbackSize,
    images: images as Array<{ b64Json: string }>
  };
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: unknown; error?: { message?: unknown } };
    if (typeof data.message === "string" && data.message.trim()) {
      return data.message.trim();
    }
    if (typeof data.error?.message === "string" && data.error.message.trim()) {
      return data.error.message.trim();
    }
  } catch {
    // Use fallback below.
  }

  return "my_tools 图像服务请求失败。";
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; fileName: string } {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new ProviderError("unsupported_provider_behavior", "参考图片格式无效。", 400);
  }

  const mimeType = match[1];
  const extension = mimeType === "image/jpeg" || mimeType === "image/jpg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  const bytes = Buffer.from(match[2], "base64");

  return {
    blob: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
      type: mimeType
    }),
    fileName: `reference.${extension}`
  };
}
