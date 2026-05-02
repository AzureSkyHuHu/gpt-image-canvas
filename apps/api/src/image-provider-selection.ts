import { getCodexResponsesBaseURL, getValidCodexSession } from "./codex-auth.js";
import {
  createCodexImageProvider,
  getCodexImageProviderTimeoutMs
} from "./codex-image-provider.js";
import { selectImageProviderName } from "./codex-auth-utils.js";
import {
  ProviderError,
  createOpenAIImageProvider,
  getConfiguredImageModel,
  getOpenAIImageProviderConfig,
  getOpenAIImageProviderConfigFromOverride,
  type ImageProvider,
  type OpenAIImageProviderConfig
} from "./image-provider.js";

export function createAccessTokenImageProvider(config: {
  apiKey: string;
  baseURL?: string;
  model?: string;
}): ImageProvider {
  return createOpenAIImageProvider(getOpenAIImageProviderConfigFromOverride(config));
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
