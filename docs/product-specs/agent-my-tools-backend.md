# Agent 接入 my_tools 后端（gpt-image-canvas 侧）

## 目标

让普通 access-token 用户使用 Agent 时，Agent 的 LLM 规划和确认后的图片生成/编辑都可以通过 `my_tools` 后端执行，同时保留 `gpt-image-canvas` 对浏览器会话、计划校验、DAG 执行、资产保存和 owner 隔离的控制权。

这份文档只描述当前项目需要改动和保持不变的内容。`my_tools` 侧需要提供的内部 API、owner 反查、上游调用、密钥和验收要求记录在：

```text
/opt/project/my_tools/docs/gpt-image-canvas-agent-backend-design.md
```

## 当前产品形态

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

Agent LLM 规划目前使用本机全局 Agent LLM 配置：

```text
Agent WebSocket session
  -> getUsableAgentLlmConfig
  -> createGenerationPlan
  -> createDeepAgentsPlanner / ChatOpenAI-compatible model
```

目标行为是：普通 access-token 用户使用 Agent 时，不读取、不依赖本机全局 Agent LLM 配置；Agent LLM 规划直接按服务端解析出的账号 owner 请求 `my_tools`。本机全局 Agent LLM 配置只保留给 auth disabled、admin 或 local 模式。

## 范围

### gpt-image-canvas 负责

- Browser-facing Agent WebSocket 协议。
- 请求认证、owner 身份、同源保护和 access-token 用户隔离。
- Agent run 生命周期：active run、取消、断线宽限、pending event replay。
- Planning context 组装：用户输入、默认参数、选中 references、planner options、planning skill 文件。
- `GenerationPlan` 解析和校验：schema、caps、references、dependency DAG、selected-reference edit 规则。
- WebSocket session 内的计划存储。
- 计划执行、依赖调度、失败重试、blocked jobs 和取消状态。
- 资产写入、generation records、本地缓存、cloud metadata 和 `/api/assets/:id` 代理路由。
- 将 `my_tools` 的安全错误转换成稳定、可展示的 Agent 错误。

### gpt-image-canvas 不负责

- 不在本阶段迁移 Agent WebSocket 会话状态到 `my_tools`。
- 不让 `my_tools` 成为 `GenerationPlan` 校验、SQLite 记录或前端 asset URL 的事实来源。
- 不信任浏览器传入的 `agentOwnerId`、`imageOwnerId` 或任何上游凭据。
- 不把内部 `my_tools` archive id、服务 URL、credential-bearing URL 作为 canvas image source 暴露给前端。

## 目标架构

浏览器到 `gpt-image-canvas` 仍保持现有 WebSocket。`gpt-image-canvas` 到 `my_tools` 的 Agent LLM 第一版使用 SSE：`my_tools` 流式返回模型文本和 display-safe thinking/status 文本，`gpt-image-canvas` 将这些增量转发成现有 Agent WebSocket 事件，同时累积最终文本用于本地 `GenerationPlan` 解析和校验。

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
      admin/local/auth-disabled
        -> existing local Agent LLM config + DeepAgents runner

gpt-image-canvas
  -> createRequestImageProvider({ owner, auth })
      access-token + IMAGE_BACKEND=my_tools
        -> HTTP my_tools image generate/edit API
      access-token + IMAGE_BACKEND=access_token
        -> token-bound upstream provider
      admin/local/auth-disabled
        -> existing env/local/Codex image provider chain
```

## Agent LLM 后端选择

新增一个和图片 provider selection 类似的 Agent LLM runner 选择层：

```text
createRequestAgentPlannerRunner(context, plannerOptions)
```

`context` 至少包括：

- `owner: DataOwner`
- `auth: RequestAuthState`
- request abort signal

推荐模式行为：

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
  default to my_tools only when APP_AUTH_ENABLED=true and the current owner is a non-local access-token user;
  fail closed if my_tools config is missing
```

Auth disabled、admin 和 local owners 必须继续使用现有本地 Agent LLM 配置，除非未来设计明确改变。它们不能因为 `AGENT_LLM_BACKEND` 未设置而意外依赖 `my_tools`。

## Agent 图片后端选择

Agent executor 必须和 Manual 图片生成共用 request-aware image provider 规则：

```text
access-token + IMAGE_BACKEND=my_tools:
  use MyToolsImageProvider(imageOwnerId = owner.id)

access-token + IMAGE_BACKEND=access_token:
  use the current access-token upstream image credentials

access-token + IMAGE_BACKEND=local:
  reject with 403/provider error

admin/local/auth-disabled:
  use existing configured provider chain
```

Agent executor 不应在 access-token run 中静默回退到 `createConfiguredImageProvider`。它应该接收显式 provider，或接收足够的 request context 后调用 `createRequestImageProvider`。

## 依赖的 my_tools 契约

本项目只把 `my_tools` 当作服务端可信后端，不把它作为浏览器协议的一部分。当前项目需要依赖以下能力：

- Agent LLM SSE：`POST /api/internal/gic/agent/plans/stream`
- 图片生成：`POST /api/internal/gic/images/generate`
- 图片编辑：`POST /api/internal/gic/images/edit`
- 内部请求认证：Agent 使用 `X-GIC-Agent-Key`，图片使用 `X-GIC-Image-Key`
- owner 映射：`my_tools` 根据 `agentOwnerId` / `imageOwnerId` 反查 Laravel 用户和工具权限
- 安全错误：`my_tools` 返回不包含密钥、headers、文件路径和 credential-bearing URL 的 user-facing error

Agent、Image 和 Storage 内部调用都保持后端到后端的共享密钥 header 校验；三类内部能力使用三组独立密钥，密钥只从运行时环境读取，不写入日志、不返回浏览器。

第一阶段配置映射：

| gpt-image-canvas env | 请求头 | my_tools env | 说明 |
| --- | --- | --- | --- |
| `MY_TOOLS_BASE_URL` | n/a | n/a | `my_tools` 服务端 base URL，Agent/Image/Storage 共用。 |
| `MY_TOOLS_AGENT_SHARED_SECRET` | `X-GIC-Agent-Key` | `GIC_AGENT_SHARED_SECRET` | Agent LLM SSE 专用密钥。 |
| `MY_TOOLS_IMAGE_SHARED_SECRET` | `X-GIC-Image-Key` | `GIC_IMAGE_SHARED_SECRET` | 图片生成/编辑专用密钥。 |
| `MY_TOOLS_STORAGE_SHARED_SECRET` | `X-GIC-Storage-Key` | `GIC_STORAGE_SHARED_SECRET` | 资产上传、回源和删除专用密钥。 |

`MY_TOOLS_SHARED_SECRET` 和 `GIC_SHARED_SECRET` 不进入第一阶段设计；实现时不应把它们作为必要配置或 fallback。缺少当前能力对应的专用密钥时，该能力返回可恢复配置错误。

Agent LLM SSE 事件在当前项目内的处理规则：

```text
thinking_delta -> Agent WebSocket assistant_thinking_delta
delta          -> Agent WebSocket assistant_delta
done.text      -> current model output parsing/validation path
error          -> recoverable Agent error + failed run_done
```

当前 `my_tools` 第一版内部调用 OpenAI-compatible `/chat/completions` 使用非 streaming 请求，然后向 `gpt-image-canvas` 输出 SSE。`delta` 可能一次性携带完整模型文本，而不是上游 token 级增量。`gpt-image-canvas` 仍按 SSE 增量协议处理：累积 `delta`，在 `done` 后解析/校验 plan。

如果 `done.text` 为空，runner 使用累计的 `delta` 作为完整模型输出。Exactly one terminal event is allowed: `done` or `error`。终止事件后的增量忽略；stream 在没有终止事件时关闭，视为 stream interruption。

用户取消必须 abort outbound SSE/image request。`gpt-image-canvas` 只保证向 `my_tools` 传递取消信号；`my_tools` 对上游请求的取消是 best effort。

### SSE 错误形态

Agent runner 必须同时处理 HTTP JSON 错误和 SSE `error` event：

| 场景 | my_tools 返回 | gpt-image-canvas 处理 |
| --- | --- | --- |
| 缺失或错误共享密钥 | HTTP `401` JSON `{ "message": "Unauthorized." }` | 作为 recoverable Agent config/auth error，发送 `error` + failed `run_done`。 |
| `agentOwnerId` 找不到、用户禁用、工具禁用、ToolAccess 禁用或套餐不可用 | HTTP `403` JSON `{ "code": "tool_access_not_found" 或 "tool_access_disabled", "message": "Agent planning is not available for this user." }` | 作为 recoverable Agent permission error，发送 `error` + failed `run_done`。 |
| 请求体格式错误或缺少必填字段 | HTTP `422` JSON `{ "code": "invalid_request", "message": "Agent planning request is invalid.", "errors": {...} }` | 作为 recoverable Agent request error，发送 `error` + failed `run_done`。 |
| Agent LLM 上游未配置 | SSE `event: error`，`code=agent_backend_not_configured` | 结束当前 run，发送 `error` + failed `run_done`。 |
| Agent LLM 上游失败、超时或响应异常 | SSE `event: error`，`code=upstream_failure` / `upstream_timeout` / `invalid_upstream_response` | 结束当前 run，发送 `error` + failed `run_done`。 |
| stream 已建立后中断且没有 `done`/`error` | connection closes | 视为 stream interruption，发送 `error` + failed `run_done`。 |

认证、权限和请求体错误在进入 SSE 前用 HTTP JSON 返回；上游执行阶段错误用 SSE `error` event 返回。

Agent request body 兼容规则：

- `messages` 至少 1 条，支持 `system` / `user` / `assistant` / `tool` role；未知 role 由 `my_tools` 按 `user` 处理。
- `files` 可携带 planning skill 文本；`my_tools` 会作为 system context 拼入上游请求。
- `plannerOptions` 和 `supportsVision` 当前只用于入参校验和透传，不作为权限依据。

## 错误处理

Agent LLM 侧错误都转换成可恢复 Agent WebSocket 错误：

- missing `my_tools` Agent config
- invalid `AGENT_LLM_BACKEND`
- SSE timeout or stream interruption
- upstream provider failure
- invalid response body
- empty model text
- user cancellation or server-side abort

WebSocket session 应发送稳定 `error` event，再发送 `run_done` with `failed`。不得暴露 secrets、raw headers、upstream keys、`.env` values、filesystem paths 或 raw credential-bearing URLs。

Agent 图片 provider 错误保持现有 plan execution 行为：

- provider selection failure 会 block runnable jobs 并标记 plan failed。
- per-job generation failure 标记该 job failed。
- downstream jobs 在依赖失败后 blocked。
- cancellation 后计划仍可检查。
- 图片生成 `count` 允许 1-16，默认 1。
- 图片编辑必须使用 multipart `files[]` 发送 Agent resolved reference images，允许 1-3 张；旧单文件字段 `file` 仅用于兼容 Manual/历史调用。
- 如果 Agent edit job resolved reference images 超过 3 张，应在本地计划校验阶段先拒绝，避免调用 `my_tools` 后才失败。
- 图片接口不得使用 `X-GIC-Storage-Key` 作为 `X-GIC-Image-Key` 的 fallback。

## 安全与隐私

- Access-token 用户不得使用 local/global Agent LLM credentials，除非未来设计明确允许。
- Access-token 用户在 `IMAGE_BACKEND=my_tools` 时不得使用 local/global image provider credentials。
- `agentOwnerId` 和 `imageOwnerId` 必须来自服务端 request context，不能来自浏览器 payload。
- `MY_TOOLS_AGENT_SHARED_SECRET`、`MY_TOOLS_IMAGE_SHARED_SECRET`、`MY_TOOLS_STORAGE_SHARED_SECRET`、access-token upstream keys、provider keys、Codex tokens 和 storage secrets 不得写入日志或返回浏览器。
- 前端 asset URL 保持 `/api/assets/:id`。

## 验收标准

- access-token 用户在 `AGENT_LLM_BACKEND=my_tools` 时，Agent planning 调用 `my_tools` Agent LLM API，不读取本地 Agent LLM 配置。
- `my_tools` Agent LLM SSE 增量被转发为现有 Agent WebSocket delta/thinking delta 事件。
- admin/local/auth-disabled 用户继续使用现有本地 Agent LLM 配置。
- access-token 用户在 `IMAGE_BACKEND=my_tools` 时，Agent plan execution 使用 `my_tools` 图片生成/编辑接口。
- Agent 和 Manual 图片生成共用 request-aware image provider 规则。
- 缺失或无效 `my_tools` Agent LLM 配置返回可恢复 Agent 错误，不使 WebSocket crash。
- 有效 `my_tools` LLM 响应仍在本地解析并严格校验为 `GenerationPlan` 或 Agent user question。
- Agent edit 多参考图通过 multipart `files[]` 发送 1-3 张图；超过 3 张在本地计划校验阶段失败。
- Plan caps、selected reference 规则、dependency 规则、retry、cancellation 和 asset preview events 保持不变。
- 第一阶段不需要 SQLite schema change。
- 第一阶段不需要前端协议 change。
- 现有 Agent LLM "missing config" UI 不阻塞普通 access-token 用户；它可以继续为 local/admin 用户展示本地配置状态。

## 验证要求

工具链验证在 dnmp `node` 容器中执行：

```sh
docker exec node sh -lc 'cd /www/python_project/gpt-image-canvas && pnpm typecheck'
docker exec node sh -lc 'cd /www/python_project/gpt-image-canvas && pnpm build'
```

涉及可见 Agent 行为的实现 story，需要通过项目 app 容器验证：

```text
http://localhost:8787
```

浏览器验证覆盖：

- access-token 用户发送 Agent 消息，并通过 `my_tools` Agent LLM 收到计划。
- 用户确认计划后，图片执行走 `my_tools`。
- 缺失 `my_tools` Agent 配置时显示可恢复 Agent 错误。
- planning 或 execution 期间取消后，UI 状态可理解且计划/session 不损坏。
