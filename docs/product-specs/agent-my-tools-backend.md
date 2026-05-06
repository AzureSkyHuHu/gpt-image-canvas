# Agent my_tools Backend

## Goal

让普通 access-token 用户使用 Agent 时，Agent 的 LLM 对话/规划和确认后的图片生成/编辑都由 `my_tools` 后端接管，同时保留 `gpt-image-canvas` 本地的 WebSocket 会话、计划校验、DAG 执行、资产代理和 owner 隔离。

这项设计的核心不是把整个 Agent 迁移到 `my_tools`，而是把远端模型能力接入 `my_tools`：

- Agent LLM：`my_tools` 作为规划模型网关，返回模型文本或可选 thinking 文本。
- Agent 图片：`my_tools` 作为图片生成/编辑网关，返回 base64 图片结果。
- 本应用：继续负责 `GenerationPlan` 解析、校验、状态流转、执行、重试、取消和资产保存。

## Current Product Shape

Manual 图片生成已经通过 request-aware provider 选择：

```text
/api/images/generate|edit
  -> createRequestImageProvider({ owner, auth })
  -> runTextToImageGeneration / runReferenceImageGeneration
```

Agent 图片执行底层复用了同一套 generation/storage 函数，但 executor 仍可能默认走全局 provider：

```text
/api/agent/ws
  -> executeGenerationPlan
  -> createConfiguredImageProvider
  -> runTextToImageGeneration / runReferenceImageGeneration
```

现有代码里的 Agent LLM 规划目前使用本机全局 Agent LLM 配置：

```text
Agent WebSocket session
  -> getUsableAgentLlmConfig
  -> createGenerationPlan
  -> createDeepAgentsPlanner / ChatOpenAI-compatible model
```

这只是当前实现状态，不是目标行为。目标行为是：普通 access-token 用户使用 Agent 时，不读取、不依赖本机全局 Agent LLM 配置；Agent LLM 规划直接按服务端解析出的账号 owner 请求 `my_tools`。本机全局 Agent LLM 配置只保留给 auth disabled、admin 或 local 模式。

## Target Architecture

浏览器到 `gpt-image-canvas` 仍保持现有 WebSocket。`gpt-image-canvas` 到 `my_tools` 的 Agent LLM 第一版使用 SSE：`my_tools` 流式返回模型文本和 thinking 文本，`gpt-image-canvas` 将这些增量转发成现有 Agent WebSocket 事件，同时累积最终文本用于本地 `GenerationPlan` 解析和校验。

```text
Browser
  <-> /api/agent/ws
      gpt-image-canvas Agent WebSocket session
        - connectionId / runId
        - cancel / reconnect
        - assistant_delta / plan_created / job events / run_done

gpt-image-canvas
  -> createRequestAgentPlannerRunner({ owner, auth }, plannerOptions)
      access-token + AGENT_LLM_BACKEND=my_tools
        -> SSE my_tools Agent LLM API
      admin/local
        -> existing local Agent LLM config + DeepAgents runner

gpt-image-canvas
  -> createRequestImageProvider({ owner, auth })
      access-token + IMAGE_BACKEND=my_tools
        -> HTTP my_tools image generate/edit API
      access-token + IMAGE_BACKEND=access_token
        -> token-bound upstream provider
      admin/local
        -> existing env/local/Codex image provider chain
```

## Responsibility Boundaries

`gpt-image-canvas` owns:

- Browser-facing Agent WebSocket protocol.
- Request auth, owner identity, and same-origin protections.
- Agent run lifecycle: active run, cancellation, disconnect grace, pending event replay.
- Planning context assembly: user text, defaults, selected references, planner options, planning skill files.
- `GenerationPlan` parsing and validation: schema, caps, references, dependency DAG, selected-reference edit rules.
- Plan storage inside the WebSocket session.
- Plan execution, dependency scheduling, retry failed jobs, blocked jobs, and cancellation state.
- Asset writes, generation records, local cache, cloud metadata, and `/api/assets/:id` proxy routes.

`my_tools` owns:

- Agent LLM upstream access for access-token users when configured.
- Image model upstream access for access-token users when configured.
- Optional asset archive storage and origin fetch when `CLOUD_STORAGE_PROVIDER=my_tools`.

`my_tools` must not become the source of truth for browser session state, local plan validation, SQLite records, or frontend asset URLs in this phase.

## Backend Selection

Add an Agent LLM selection layer analogous to image provider selection:

```text
createRequestAgentPlannerRunner(context, plannerOptions)
```

`context` includes:

- `owner: DataOwner`
- `auth: RequestAuthState`
- request abort signal where needed

Recommended mode behavior:

```text
auth disabled:
  use existing local Agent LLM config

admin/local:
  use existing local Agent LLM config

access-token + AGENT_LLM_BACKEND=my_tools:
  use MyToolsAgentPlannerRunner with agentOwnerId = owner.id

access-token + AGENT_LLM_BACKEND=local:
  reject with a clear recoverable Agent error

access-token + AGENT_LLM_BACKEND unset:
  default to my_tools only when APP_AUTH_ENABLED=true and the current owner is a non-local access-token user; fail closed if my_tools config is missing
```

Auth disabled, admin, and local owners must continue to use the existing local Agent LLM configuration unless explicitly changed by a future design. They must not accidentally depend on `my_tools` just because `AGENT_LLM_BACKEND` is unset.

Image backend behavior stays aligned with the existing request-aware image provider strategy:

```text
access-token + IMAGE_BACKEND=my_tools:
  use MyToolsImageProvider(imageOwnerId = owner.id)

access-token + IMAGE_BACKEND=access_token:
  use the current access token upstream image credentials

access-token + IMAGE_BACKEND=local:
  reject with 403/provider error

admin/local:
  use existing configured provider chain
```

Agent executor must not silently fall back to `createConfiguredImageProvider` for access-token runs. It should receive either an explicit provider or enough request context to call `createRequestImageProvider`.

## my_tools Agent LLM SSE Contract

First version target:

```text
POST {MY_TOOLS_BASE_URL}/api/internal/gic/agent/plans/stream
Accept: text/event-stream
Content-Type: application/json
X-GIC-Agent-Key: <shared secret>
```

Configuration:

- `MY_TOOLS_BASE_URL` is the shared `my_tools` service base URL.
- `MY_TOOLS_AGENT_SHARED_SECRET` is the preferred secret for `X-GIC-Agent-Key`.
- If `MY_TOOLS_AGENT_SHARED_SECRET` is not set, the implementation may fall back to `MY_TOOLS_SHARED_SECRET` for compatibility.
- Missing `MY_TOOLS_BASE_URL` or missing both secrets is a recoverable Agent configuration error for access-token users.

Request body:

```json
{
  "agentOwnerId": "owner id from access token",
  "requestId": "optional browser request id",
  "threadId": "agent-plan-... attempt id",
  "messages": [
    {
      "role": "user",
      "content": "string or multimodal content"
    }
  ],
  "files": {
    "/skills/canvas-image-planning/SKILL.md": {
      "content": "planning skill content"
    }
  },
  "plannerOptions": {
    "thinking": {
      "type": "enabled"
    },
    "reasoningEffort": "high"
  },
  "supportsVision": true
}
```

Response stream:

```text
event: thinking_delta
data: {"delta":"display-safe planning status text"}

event: delta
data: {"delta":"model output text chunk"}

event: done
data: {"text":"complete model output text","thinkingText":"optional complete thinking text","model":"optional upstream model id"}

event: error
data: {"code":"upstream_failure","message":"safe user-facing error"}
```

`gpt-image-canvas` handles the stream as follows:

- `thinking_delta` maps to Agent WebSocket `assistant_thinking_delta`.
- `delta` maps to Agent WebSocket `assistant_delta`.
- `done.text` is treated exactly like the current model output. It is parsed, validated, retried with reflection when allowed, and used to replace temporary plan metadata.
- If `done.text` is omitted, the runner uses the accumulated `delta` chunks as the complete model output.
- `error` becomes a recoverable Agent error and ends the run as failed.
- Exactly one terminal event is allowed: `done` or `error`.
- Events received after a terminal event are ignored.
- A closed stream without `done` or `error` is treated as a stream interruption.
- User cancellation must abort the outbound SSE request from `gpt-image-canvas` to `my_tools`.
- `my_tools` should treat client disconnect as a best-effort cancellation signal for its own upstream LLM request.
- `my_tools` must only send display-safe status text in `thinking_delta`; it must not forward hidden chain-of-thought, raw provider reasoning, secrets, upstream headers, credential-bearing URLs, or vendor-internal error payloads.

If `my_tools` later needs a bidirectional protocol, only `MyToolsAgentPlannerRunner` should change; the browser WebSocket contract remains stable.

## my_tools Image Contract

Agent image execution should use the same `my_tools` image provider behavior as Manual:

```text
POST /api/internal/gic/images/generate
POST /api/internal/gic/images/edit
X-GIC-Image-Key: <shared secret>
```

Generate metadata includes:

- `imageOwnerId`
- `prompt`
- `size`
- `quality`
- `outputFormat`
- `count`

Edit metadata includes the same fields plus reference image uploads. First-phase `my_tools` edit support must accept the same Agent limit as local execution: up to 3 resolved reference images per job. The provider must never silently drop extra references. If `my_tools` rejects a valid 1-3 reference request, the job should fail with a clear provider error.

Response body:

```json
{
  "model": "optional model id",
  "size": "1024x1024",
  "images": [
    {
      "b64Json": "..."
    }
  ]
}
```

## Error Handling

Agent LLM errors from `my_tools` become recoverable Agent WebSocket errors:

- missing `my_tools` Agent config
- invalid `AGENT_LLM_BACKEND`
- SSE timeout or stream interruption
- upstream provider failure
- invalid response body
- empty model text
- user cancellation or server-side abort

The WebSocket session should send a stable `error` event and then `run_done` with `failed`. Secrets, raw headers, upstream keys, `.env` values, filesystem paths, and raw credential-bearing URLs must not be exposed.

Agent image provider errors should preserve existing plan execution behavior:

- provider selection failure blocks runnable jobs and marks the plan failed.
- per-job generation failure marks that job failed.
- downstream jobs are blocked when dependencies fail.
- cancellation leaves the plan inspectable.

## Security And Privacy

- Access-token users must not use local/global Agent LLM credentials unless explicitly allowed by a future design.
- Access-token users must not use local/global image provider credentials when `IMAGE_BACKEND=my_tools`.
- `agentOwnerId` and `imageOwnerId` must be derived from server-side request context, not from browser-provided payload.
- `X-GIC-Agent-Key`, `MY_TOOLS_AGENT_SHARED_SECRET`, `X-GIC-Image-Key`, access-token upstream keys, provider keys, Codex tokens, and storage secrets must never be logged or returned to the browser.
- Frontend asset URLs remain `/api/assets/:id`; do not expose internal `my_tools` archive ids or service URLs as canvas image sources.

## Acceptance Criteria

- For access-token users with `AGENT_LLM_BACKEND=my_tools`, Agent planning calls `my_tools` Agent LLM API instead of local Agent LLM config.
- `my_tools` Agent LLM responses stream through SSE and are forwarded to the browser as existing Agent WebSocket delta events.
- For admin/local users, existing Agent LLM configuration continues to work.
- For access-token users with `IMAGE_BACKEND=my_tools`, Agent plan execution uses `my_tools` image generate/edit APIs.
- Agent and Manual image generation share the same request-aware image provider rules.
- Invalid or missing `my_tools` Agent LLM config returns a recoverable Agent error without crashing the WebSocket.
- A valid `my_tools` LLM response is still parsed and validated locally as a strict `GenerationPlan` or Agent user question.
- Plan caps, selected reference rules, dependency rules, retry behavior, cancellation, and asset preview events remain unchanged.
- No SQLite schema change is required for the first phase.
- No frontend protocol change is required for the first phase.
- Existing Agent LLM "missing config" UI must not block ordinary access-token users when their Agent LLM backend is `my_tools`; the UI may still show local/admin configuration state for local users and administrators.

## Verification Requirements

Run toolchain verification in the dnmp `node` container:

```sh
pnpm typecheck
pnpm build
```

For implementation stories that touch visible Agent behavior, verify the running app in a browser through the project app container at:

```text
http://localhost:8787
```

Browser verification should cover:

- access-token user sends an Agent message and receives a plan through `my_tools` Agent LLM.
- user confirms the plan and image execution goes through `my_tools`.
- missing `my_tools` Agent config shows a recoverable Agent error.
- cancellation during planning or execution leaves the UI in an understandable state.
