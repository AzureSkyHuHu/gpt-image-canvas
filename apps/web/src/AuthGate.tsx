import { ChevronDown, Copy, Eye, EyeOff, Loader2, LogOut, Plus, Shield, Trash2 } from "lucide-react";
import { type CSSProperties, type FormEvent, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccessTokenView,
  AdminMeResponse,
  AuthMeResponse,
  CreateAccessTokenResponse
} from "@gpt-image-canvas/shared";

interface AuthGateProps {
  children: ReactNode;
}

type AuthStatus = "loading" | "ready" | "locked";
type AdminStatus = "unknown" | "authenticated" | "guest";
type SessionMenuPlacement = "above" | "below";
type SessionMenuAlign = "start" | "end";

interface SessionBarPosition {
  left: number;
  bottom: number;
}

interface SessionBarDragState {
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startBottom: number;
  width: number;
  height: number;
  dragging: boolean;
}

interface TokenFormState {
  label: string;
  accessToken: string;
  upstreamApiKey: string;
  upstreamBaseURL: string;
  upstreamModel: string;
  enabled: boolean;
}

const defaultTokenForm: TokenFormState = {
  label: "",
  accessToken: "",
  upstreamApiKey: "",
  upstreamBaseURL: "",
  upstreamModel: "gpt-image-2",
  enabled: true
};

const SESSION_BAR_POSITION_KEY = "gic-session-bar-position";
const SESSION_BAR_MARGIN = 8;
const SESSION_BAR_DRAG_THRESHOLD = 4;

export function AuthGate({ children }: AuthGateProps) {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [authEnabled, setAuthEnabled] = useState(false);
  const [userLabel, setUserLabel] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [adminStatus, setAdminStatus] = useState<AdminStatus>("unknown");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [tokens, setTokens] = useState<AccessTokenView[]>([]);
  const [tokenForm, setTokenForm] = useState<TokenFormState>(defaultTokenForm);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState("");
  const [createdToken, setCreatedToken] = useState("");
  const [editingId, setEditingId] = useState<string | undefined>();
  const [showAdmin, setShowAdmin] = useState(false);
  const [showCreatedToken, setShowCreatedToken] = useState(false);
  const [showSessionBar, setShowSessionBar] = useState(false);
  const [sessionBarPosition, setSessionBarPosition] = useState<SessionBarPosition | undefined>(() => readSessionBarPosition());
  const sessionBarRef = useRef<HTMLDivElement | null>(null);
  const sessionBarDragRef = useRef<SessionBarDragState | undefined>();
  const suppressSessionToggleRef = useRef(false);

  useEffect(() => {
    void refreshAuth();
    void refreshAdmin();
  }, []);

  const isEditing = Boolean(editingId);
  const sortedTokens = useMemo(
    () => [...tokens].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [tokens]
  );
  const sessionMenuPlacement = getSessionMenuPlacement(sessionBarPosition);
  const sessionMenuAlign = getSessionMenuAlign(sessionBarPosition);
  const sessionBarStyle: CSSProperties | undefined = sessionBarPosition
    ? {
        left: `${sessionBarPosition.left}px`,
        bottom: `${sessionBarPosition.bottom}px`
      }
    : undefined;

  async function refreshAuth(): Promise<void> {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin"
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const body = (await response.json()) as AuthMeResponse;
      setAuthEnabled(body.authEnabled);
      setUserLabel(body.user?.label ?? "");
      setAuthStatus(!body.authEnabled || body.authenticated ? "ready" : "locked");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "认证状态读取失败。");
      setAuthStatus("locked");
    }
  }

  async function refreshAdmin(): Promise<void> {
    try {
      const response = await fetch("/api/admin/me", {
        credentials: "same-origin"
      });
      if (!response.ok) {
        setAdminStatus("guest");
        return;
      }
      const body = (await response.json()) as AdminMeResponse;
      setAdminStatus(body.authenticated ? "authenticated" : "guest");
      if (body.authenticated) {
        await refreshTokens();
      }
    } catch {
      setAdminStatus("guest");
    }
  }

  async function refreshTokens(): Promise<void> {
    const response = await fetch("/api/admin/tokens", {
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    const body = (await response.json()) as { items: AccessTokenView[] };
    setTokens(body.items);
  }

  async function submitAccessToken(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          token: tokenInput.trim()
        })
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      await refreshAuth();
      setTokenInput("");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "访问 token 登录失败。");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logoutAccess(): Promise<void> {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin"
    });
    setAuthStatus(authEnabled ? "locked" : "ready");
    setUserLabel("");
  }

  async function submitAdminLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAdminBusy(true);
    setAdminError("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          password: adminPassword
        })
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      setAdminPassword("");
      setAdminStatus("authenticated");
      await refreshTokens();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "管理员登录失败。");
    } finally {
      setAdminBusy(false);
    }
  }

  async function logoutAdmin(): Promise<void> {
    await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "same-origin"
    });
    setAdminStatus("guest");
    setTokens([]);
    resetTokenForm();
  }

  async function submitTokenForm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTokenBusy(true);
    setTokenError("");
    setCreatedToken("");
    try {
      const payload = {
        label: tokenForm.label.trim(),
        accessToken: tokenForm.accessToken.trim() || undefined,
        upstreamApiKey: tokenForm.upstreamApiKey.trim() || undefined,
        upstreamBaseURL: tokenForm.upstreamBaseURL.trim() || undefined,
        upstreamModel: tokenForm.upstreamModel.trim() || undefined,
        enabled: tokenForm.enabled
      };
      const response = await fetch(editingId ? `/api/admin/tokens/${encodeURIComponent(editingId)}` : "/api/admin/tokens", {
        method: editingId ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      if (editingId) {
        const item = (await response.json()) as AccessTokenView;
        setTokens((items) => items.map((existing) => (existing.id === item.id ? item : existing)));
      } else {
        const body = (await response.json()) as CreateAccessTokenResponse;
        setTokens((items) => [body.item, ...items]);
        setCreatedToken(body.accessToken);
        setShowCreatedToken(false);
      }
      resetTokenForm();
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "Token 保存失败。");
    } finally {
      setTokenBusy(false);
    }
  }

  async function deleteToken(id: string): Promise<void> {
    setTokenError("");
    const response = await fetch(`/api/admin/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    if (!response.ok) {
      setTokenError(await readErrorMessage(response));
      return;
    }
    setTokens((items) => items.filter((item) => item.id !== id));
    if (editingId === id) {
      resetTokenForm();
    }
  }

  function editToken(item: AccessTokenView): void {
    setEditingId(item.id);
    setCreatedToken("");
    setTokenError("");
    setTokenForm({
      label: item.label,
      accessToken: "",
      upstreamApiKey: "",
      upstreamBaseURL: item.upstreamBaseURL ?? "",
      upstreamModel: item.upstreamModel ?? "gpt-image-2",
      enabled: item.enabled
    });
  }

  function resetTokenForm(): void {
    setEditingId(undefined);
    setTokenForm(defaultTokenForm);
  }

  function updateTokenForm<K extends keyof TokenFormState>(key: K, value: TokenFormState[K]): void {
    setTokenForm((current) => ({
      ...current,
      [key]: value
    }));
  }

  function updateSessionBarPosition(position: SessionBarPosition): void {
    setSessionBarPosition(position);
    saveSessionBarPosition(position);
  }

  function startSessionBarDrag(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) {
      return;
    }

    const bar = sessionBarRef.current;
    if (!bar) {
      return;
    }

    const rect = bar.getBoundingClientRect();
    sessionBarDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startBottom: window.innerHeight - rect.bottom,
      width: rect.width,
      height: rect.height,
      dragging: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSessionBarDrag(event: PointerEvent<HTMLButtonElement>): void {
    const drag = sessionBarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.dragging && Math.hypot(deltaX, deltaY) < SESSION_BAR_DRAG_THRESHOLD) {
      return;
    }

    drag.dragging = true;
    event.preventDefault();
    updateSessionBarPosition(
      clampSessionBarPosition({
        left: drag.startLeft + deltaX,
        bottom: drag.startBottom - deltaY
      }, drag.width, drag.height)
    );
  }

  function endSessionBarDrag(event: PointerEvent<HTMLButtonElement>): void {
    const drag = sessionBarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (drag.dragging) {
      suppressSessionToggleRef.current = true;
      window.setTimeout(() => {
        suppressSessionToggleRef.current = false;
      }, 0);
    }

    sessionBarDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  if (authStatus === "loading") {
    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <Loader2 className="auth-panel__spinner" aria-hidden="true" />
          <p>正在检查访问权限</p>
        </div>
      </div>
    );
  }

  if (!authEnabled || authStatus === "ready") {
    return (
      <>
        {authEnabled ? (
          <div
            className="auth-session-bar"
            data-expanded={showSessionBar}
            data-menu-placement={sessionMenuPlacement}
            data-menu-align={sessionMenuAlign}
            ref={sessionBarRef}
            style={sessionBarStyle}
          >
            <button
              type="button"
              className="auth-session-bar__toggle"
              onClick={(event) => {
                if (suppressSessionToggleRef.current) {
                  event.preventDefault();
                  return;
                }
                setShowSessionBar((value) => !value);
              }}
              onPointerDown={startSessionBarDrag}
              onPointerMove={moveSessionBarDrag}
              onPointerUp={endSessionBarDrag}
              onPointerCancel={endSessionBarDrag}
              aria-expanded={showSessionBar}
              aria-label={showSessionBar ? "收起访问状态" : "展开访问状态"}
              title={showSessionBar ? "收起访问状态" : "展开访问状态"}
            >
              <Shield size={16} aria-hidden="true" />
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {showSessionBar ? (
              <div className="auth-session-bar__menu">
                <span>{userLabel ? `当前访问：${userLabel}` : "已授权访问"}</span>
                <button type="button" onClick={() => void logoutAccess()}>
                  <LogOut size={15} aria-hidden="true" />
                  退出
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {children}
      </>
    );
  }

  return (
    <div className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-panel__icon" aria-hidden="true">
          <Shield size={22} />
        </div>
        <div>
          <p className="auth-panel__eyebrow">gpt-image-canvas</p>
          <h1 id="auth-title">请输入访问 token</h1>
          <p className="auth-panel__copy">授权后会进入画布，后续图片和资源请求会自动带上登录状态。</p>
        </div>

        <form className="auth-form" onSubmit={(event) => void submitAccessToken(event)}>
          <label>
            <span>访问 token</span>
            <input
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="输入朋友访问 token"
            />
          </label>
          {loginError ? <p className="auth-form__error">{loginError}</p> : null}
          <button type="submit" disabled={loginBusy || !tokenInput.trim()}>
            {loginBusy ? <Loader2 size={16} className="auth-button-spinner" aria-hidden="true" /> : null}
            进入画布
          </button>
        </form>

        <button type="button" className="auth-admin-toggle" onClick={() => setShowAdmin((value) => !value)}>
          {showAdmin ? "收起管理员面板" : "管理员管理 token"}
        </button>

        {showAdmin ? (
          <div className="auth-admin-panel">
            {adminStatus !== "authenticated" ? (
              <form className="auth-form" onSubmit={(event) => void submitAdminLogin(event)}>
                <label>
                  <span>管理员密码</span>
                  <input
                    type="password"
                    value={adminPassword}
                    onChange={(event) => setAdminPassword(event.target.value)}
                    autoComplete="current-password"
                    placeholder="来自 .env 的 APP_ADMIN_PASSWORD"
                  />
                </label>
                {adminError ? <p className="auth-form__error">{adminError}</p> : null}
                <button type="submit" disabled={adminBusy || !adminPassword.trim()}>
                  {adminBusy ? <Loader2 size={16} className="auth-button-spinner" aria-hidden="true" /> : null}
                  登录管理员
                </button>
              </form>
            ) : (
              <div className="auth-admin-workspace">
                <div className="auth-admin-heading">
                  <div>
                    <h2>访问 token 映射</h2>
                    <p>真实上游 key 只在后端保存，列表里只显示掩码。</p>
                  </div>
                  <button type="button" onClick={() => void logoutAdmin()}>
                    <LogOut size={15} />
                    退出管理员
                  </button>
                </div>

                {createdToken ? (
                  <div className="auth-created-token">
                    <div>
                      <strong>新 token 只显示一次</strong>
                      <code>{showCreatedToken ? createdToken : maskValue(createdToken)}</code>
                    </div>
                    <button type="button" onClick={() => setShowCreatedToken((value) => !value)} aria-label="显示或隐藏新 token">
                      {showCreatedToken ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button type="button" onClick={() => void navigator.clipboard.writeText(createdToken)} aria-label="复制新 token">
                      <Copy size={16} />
                    </button>
                  </div>
                ) : null}

                <form className="auth-token-form" onSubmit={(event) => void submitTokenForm(event)}>
                  <label>
                    <span>名称</span>
                    <input value={tokenForm.label} onChange={(event) => updateTokenForm("label", event.target.value)} placeholder="Alice" />
                  </label>
                  <label>
                    <span>{isEditing ? "替换访问 token" : "访问 token"}</span>
                    <input
                      value={tokenForm.accessToken}
                      onChange={(event) => updateTokenForm("accessToken", event.target.value)}
                      placeholder={isEditing ? "留空则不替换" : "留空自动生成"}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    <span>{isEditing ? "替换上游 key" : "上游 API key"}</span>
                    <input
                      value={tokenForm.upstreamApiKey}
                      onChange={(event) => updateTokenForm("upstreamApiKey", event.target.value)}
                      placeholder={isEditing ? "留空则不替换" : "sk-..."}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    <span>上游 Base URL</span>
                    <input
                      value={tokenForm.upstreamBaseURL}
                      onChange={(event) => updateTokenForm("upstreamBaseURL", event.target.value)}
                      placeholder="https://freeapi.dgbmc.top/v1"
                    />
                  </label>
                  <label>
                    <span>模型</span>
                    <input
                      value={tokenForm.upstreamModel}
                      onChange={(event) => updateTokenForm("upstreamModel", event.target.value)}
                      placeholder="gpt-image-2"
                    />
                  </label>
                  <label className="auth-check">
                    <input
                      type="checkbox"
                      checked={tokenForm.enabled}
                      onChange={(event) => updateTokenForm("enabled", event.target.checked)}
                    />
                    <span>启用</span>
                  </label>
                  {tokenError ? <p className="auth-form__error auth-token-form__wide">{tokenError}</p> : null}
                  <div className="auth-token-form__actions">
                    {isEditing ? (
                      <button type="button" onClick={resetTokenForm}>
                        取消编辑
                      </button>
                    ) : null}
                    <button type="submit" disabled={tokenBusy || !tokenForm.label.trim() || (!isEditing && !tokenForm.upstreamApiKey.trim())}>
                      {tokenBusy ? <Loader2 size={16} className="auth-button-spinner" aria-hidden="true" /> : <Plus size={16} />}
                      {isEditing ? "保存修改" : "新增 token"}
                    </button>
                  </div>
                </form>

                <div className="auth-token-list">
                  {sortedTokens.length === 0 ? (
                    <p className="auth-token-list__empty">还没有访问 token。</p>
                  ) : (
                    sortedTokens.map((item) => (
                      <article className="auth-token-item" key={item.id}>
                        <div>
                          <div className="auth-token-item__title">
                            <strong>{item.label}</strong>
                            <span data-enabled={item.enabled}>{item.enabled ? "启用" : "停用"}</span>
                          </div>
                          <dl>
                            <div>
                              <dt>访问</dt>
                              <dd>{item.tokenPreview}</dd>
                            </div>
                            <div>
                              <dt>上游</dt>
                              <dd>{item.upstreamApiKeyPreview}</dd>
                            </div>
                            <div>
                              <dt>Base</dt>
                              <dd>{item.upstreamBaseURL || "默认"}</dd>
                            </div>
                            <div>
                              <dt>模型</dt>
                              <dd>{item.upstreamModel || "默认"}</dd>
                            </div>
                          </dl>
                        </div>
                        <div className="auth-token-item__actions">
                          <button type="button" onClick={() => editToken(item)}>
                            编辑
                          </button>
                          <button type="button" onClick={() => void deleteToken(item.id)} aria-label={`删除 ${item.label}`}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message || "请求失败，请重试。";
  } catch {
    return "请求失败，请重试。";
  }
}

function maskValue(value: string): string {
  if (value.length <= 10) {
    return `${value.slice(0, 2)}...${value.slice(-2)}`;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function readSessionBarPosition(): SessionBarPosition | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(SESSION_BAR_POSITION_KEY);
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as Partial<SessionBarPosition>;
    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.bottom)) {
      return undefined;
    }

    return clampSessionBarPosition({
      left: Number(parsed.left),
      bottom: Number(parsed.bottom)
    });
  } catch {
    return undefined;
  }
}

function saveSessionBarPosition(position: SessionBarPosition): void {
  try {
    window.localStorage.setItem(SESSION_BAR_POSITION_KEY, JSON.stringify(position));
  } catch {
    // Ignore storage failures; dragging should still work for the current page.
  }
}

function clampSessionBarPosition(position: SessionBarPosition, width = 48, height = 48): SessionBarPosition {
  if (typeof window === "undefined") {
    return position;
  }

  return {
    left: clampNumber(position.left, SESSION_BAR_MARGIN, Math.max(SESSION_BAR_MARGIN, window.innerWidth - width - SESSION_BAR_MARGIN)),
    bottom: clampNumber(position.bottom, SESSION_BAR_MARGIN, Math.max(SESSION_BAR_MARGIN, window.innerHeight - height - SESSION_BAR_MARGIN))
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getSessionMenuPlacement(position: SessionBarPosition | undefined): SessionMenuPlacement {
  if (typeof window === "undefined" || !position) {
    return "above";
  }

  const buttonBottom = window.innerHeight - position.bottom;
  return buttonBottom < window.innerHeight / 2 ? "below" : "above";
}

function getSessionMenuAlign(position: SessionBarPosition | undefined): SessionMenuAlign {
  if (typeof window === "undefined" || !position) {
    return "start";
  }

  return position.left > window.innerWidth / 2 ? "end" : "start";
}
