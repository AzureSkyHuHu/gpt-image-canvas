import { getCodexResponsesBaseURL, getValidCodexSession } from "./codex-auth.js";
import type { CodexAccessSession } from "./codex-auth.js";
import {
  createCodexImageProvider,
  getCodexImageProviderTimeoutMs
} from "../../infrastructure/providers/codex-image-provider.js";
import {
  ProviderError,
  type EditImageProviderInput,
  createOpenAIImageProvider,
  getConfiguredImageModel,
  type ImageProviderInput,
  type OpenAIImageProviderConfig,
  type ImageProvider,
  type ProviderResult
} from "../../infrastructure/providers/image-provider.js";
import {
  getEnvironmentOpenAIImageProviderConfig,
  getLocalOpenAIImageProviderConfig,
  getProviderSourceOrder
} from "./provider-config.js";
import type { ProviderSourceId, RuntimeImageProvider } from "../contracts.js";
import type { DataOwner } from "../auth/data-owner.js";
import type { RequestAuthState } from "../../server/http/access-control.js";

export type ImageBackendMode = "access_token" | "my_tools" | "local";

export interface RequestImageProviderContext {
  owner: DataOwner;
  auth: RequestAuthState;
}

export interface ConfiguredImageProviderSelection {
  sourceId: ProviderSourceId;
  provider: RuntimeImageProvider;
  openAIConfig?: OpenAIImageProviderConfig;
  codexSession?: CodexAccessSession;
}

export async function createConfiguredImageProvider(signal?: AbortSignal): Promise<ImageProvider> {
  const selection = await selectConfiguredImageProviderSource(signal);

  if (selection?.openAIConfig) {
    return createOpenAIImageProvider(selection.openAIConfig);
  }

  if (selection?.provider === "codex" && selection.codexSession) {
    return createCodexImageProvider({
      baseURL: getCodexResponsesBaseURL(),
      model: getConfiguredImageModel(),
      timeoutMs: getCodexImageProviderTimeoutMs(),
      getSession: async (requestSignal?: AbortSignal) => selection.codexSession ?? getValidCodexSession(requestSignal)
    });
  }

  throw new ProviderError(
    "missing_provider",
    "服务器没有配置 OPENAI_API_KEY，也没有可用的 Codex 登录会话。请先登录 Codex 后重试。",
    401
  );
}

export async function createRequestImageProvider(
  context: RequestImageProviderContext,
  signal?: AbortSignal
): Promise<ImageProvider> {
  if (context.owner.isLocal || context.auth.isAdmin) {
    return createConfiguredImageProvider(signal);
  }

  const principal = context.auth.user;
  if (!principal) {
    throw new ProviderError("missing_provider", "当前请求缺少访问 token 上下文。", 401);
  }

  const backend = getConfiguredImageBackendMode();
  if (backend === "local") {
    throw new ProviderError("image_backend_forbidden", "当前访问 token 不能使用本机图像 provider。", 403);
  }

  if (backend === "my_tools") {
    const config = getMyToolsImageProviderConfig();
    if (!config) {
      throw new ProviderError("missing_provider", "my_tools 图像服务未配置。", 500);
    }
    return new MyToolsImageProvider({
      ...config,
      imageOwnerId: context.owner.id
    });
  }

  return createOpenAIImageProvider({
    apiKey: principal.upstreamApiKey,
    baseURL: principal.upstreamBaseURL,
    model: principal.upstreamModel || getConfiguredImageModel(),
    timeoutMs: getOpenAIImageProviderTimeoutMs()
  });
}

export function getConfiguredImageBackendMode(): ImageBackendMode {
  const value = process.env.IMAGE_BACKEND?.trim().toLowerCase();
  if (value === "my_tools" || value === "local") {
    return value;
  }
  return "access_token";
}

export async function selectConfiguredImageProviderSource(
  signal?: AbortSignal
): Promise<ConfiguredImageProviderSelection | undefined> {
  for (const sourceId of getProviderSourceOrder()) {
    if (sourceId === "env-openai") {
      const openAIConfig = getEnvironmentOpenAIImageProviderConfig();
      if (openAIConfig) {
        return {
          sourceId,
          provider: "openai",
          openAIConfig
        };
      }
      continue;
    }

    if (sourceId === "local-openai") {
      const openAIConfig = getLocalOpenAIImageProviderConfig();
      if (openAIConfig) {
        return {
          sourceId,
          provider: "openai",
          openAIConfig
        };
      }
      continue;
    }

    const codexSession = await getValidCodexSession(signal);
    if (codexSession) {
      return {
        sourceId,
        provider: "codex",
        codexSession
      };
    }
  }

  return undefined;
}

function getOpenAIImageProviderTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20 * 60 * 1000;
}

function getMyToolsImageProviderConfig(): { baseUrl: string; sharedSecret: string } | undefined {
  const baseUrl = process.env.MY_TOOLS_BASE_URL?.trim();
  const sharedSecret = process.env.MY_TOOLS_SHARED_SECRET?.trim();
  if (!baseUrl || !sharedSecret) {
    return undefined;
  }
  return { baseUrl, sharedSecret };
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
    const reference = dataUrlToBlob(input.referenceImages[0] ?? input.referenceImage);
    formData.set("file", reference.blob, reference.fileName);
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

  const images = data.images.map((item) =>
    typeof item === "object" &&
    item !== null &&
    "b64Json" in item &&
    typeof item.b64Json === "string" &&
    item.b64Json
      ? { b64Json: item.b64Json }
      : undefined
  );

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

function dataUrlToBlob(input: { dataUrl: string; fileName?: string } | undefined): { blob: Blob; fileName: string } {
  const match = input ? /^data:([^;,]+);base64,(.+)$/u.exec(input.dataUrl) : undefined;
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
    fileName: input?.fileName ?? `reference.${extension}`
  };
}
