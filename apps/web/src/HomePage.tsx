import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  FileText,
  ImageIcon,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  Terminal,
  X
} from "lucide-react";
import type { AuthStatusResponse } from "@gpt-image-canvas/shared";
import productPreviewUrl from "../../../docs/assets/app-preview.png";

interface HomePageProps {
  authError: string;
  authStatus: AuthStatusResponse | null;
  isAuthLoading: boolean;
  isCodexStarting: boolean;
  onOpenApiSetup: () => void;
  onOpenGallery: () => void;
  onStartCodexLogin: () => void;
}

interface ApiSetupDialogProps {
  onClose: () => void;
}

export function HomePage({
  authError,
  authStatus,
  isAuthLoading,
  isCodexStarting,
  onOpenApiSetup,
  onOpenGallery,
  onStartCodexLogin
}: HomePageProps) {
  const providerLabel =
    authStatus?.provider === "openai" ? "OpenAI API 已接入" : authStatus?.provider === "codex" ? "Codex 会话已可用" : "等待接入生成服务";

  return (
    <main className="home-page app-view" data-testid="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__visual" aria-hidden="true">
          <img className="home-preview-image" src={productPreviewUrl} alt="" />
        </div>

        <div className="home-hero__copy">
          <p className="home-kicker">
            <Sparkles className="size-4" aria-hidden="true" />
            专业 AI 画布
          </p>
          <h1 id="home-title">专业 AI 画布</h1>
          <p className="home-deck">把提示词、参考图、生成历史和视觉比较收束到一张本地画布里。</p>

          <div className="home-actions" aria-label="进入方式">
            <button
              className="home-action home-action--primary"
              data-testid="home-codex-login"
              disabled={isAuthLoading || isCodexStarting}
              type="button"
              onClick={onStartCodexLogin}
            >
              {isCodexStarting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
              Codex 登录
            </button>
            <button className="home-action home-action--secondary" data-testid="home-api-setup" type="button" onClick={onOpenApiSetup}>
              <Terminal className="size-4" aria-hidden="true" />
              接入 API
            </button>
          </div>

          <div className="home-provider-state" data-provider={authStatus?.provider ?? "loading"} data-testid="home-provider-state">
            <span className="home-provider-state__icon">
              {isAuthLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : authStatus?.provider === "none" || !authStatus ? (
                <KeyRound className="size-4" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-4" aria-hidden="true" />
              )}
            </span>
            <span>{isAuthLoading ? "正在检查本地凭据" : providerLabel}</span>
          </div>

          {authError ? (
            <p className="home-auth-error" role="alert">
              {authError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="home-afterfold" aria-label="创作入口">
        <div className="home-afterfold__item">
          <span>
            <CheckCircle2 className="size-4" aria-hidden="true" />
          </span>
          <p>API Key 只在服务端环境读取，浏览器不会保存或回显密钥。</p>
        </div>
        <button className="home-gallery-link" data-testid="home-gallery-link" type="button" onClick={onOpenGallery}>
          <ImageIcon className="size-4" aria-hidden="true" />
          打开 Gallery
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
}

export function ApiSetupDialog({ onClose }: ApiSetupDialogProps) {
  return (
    <div className="api-setup-backdrop" data-testid="api-setup-dialog" role="presentation" onClick={onClose}>
      <div
        aria-labelledby="api-setup-title"
        aria-modal="true"
        className="api-setup-dialog"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="api-setup-dialog__header">
          <div>
            <p>Environment Setup</p>
            <h2 id="api-setup-title">接入 API</h2>
          </div>
          <button aria-label="关闭 API 接入说明" className="api-setup-dialog__close" type="button" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="api-setup-dialog__body">
          <section className="api-setup-step">
            <span className="api-setup-step__icon">
              <FileText className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h3>1. 在项目根目录创建或编辑 .env</h3>
              <pre>{`OPENAI_API_KEY=<your-api-key>
OPENAI_BASE_URL=<optional-compatible-base-url>`}</pre>
            </div>
          </section>

          <section className="api-setup-step">
            <span className="api-setup-step__icon">
              <Terminal className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h3>2. 重启本地服务</h3>
              <p>保存环境变量后重新运行 <code>pnpm dev</code>，服务端会在启动时读取配置。</p>
            </div>
          </section>

          <section className="api-setup-step">
            <span className="api-setup-step__icon">
              <BookOpen className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h3>3. 回到浏览器</h3>
              <p>刷新首页后，已配置的 API 会优先于 Codex 会话并直接进入画布。</p>
            </div>
          </section>

          <p className="api-setup-dialog__notice">
            这个窗口只提供说明，不包含表单，不会向浏览器写入、保存或回显任何 API Key。
          </p>
        </div>

        <footer className="api-setup-dialog__footer">
          <a className="secondary-action h-10" href="https://platform.openai.com/api-keys" rel="noreferrer" target="_blank">
            <ExternalLink className="size-4" aria-hidden="true" />
            API Keys
          </a>
          <button className="primary-action h-10" data-testid="api-setup-close" type="button" onClick={onClose}>
            我知道了
          </button>
        </footer>
      </div>
    </div>
  );
}
