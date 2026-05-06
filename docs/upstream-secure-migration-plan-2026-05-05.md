# 上游安全合并迁移计划

日期：2026-05-05
分支：`sync-upstream-secure-base`
底座：`upstream/main`

## 结论

代码以**上游**为底座，但安全、权限、租户隔离和 `my_tools` 行为以当前 fork 为准。

具体含义：

- 代码结构跟随上游的新架构：`domain/`、`infrastructure/`、`server/routes/`、`apps/web/src/features/`。
- 生产环境里已认证普通用户的运行时行为跟随当前 fork。
- 当前 fork 的 access-token 租户隔离、provider 边界、`my_tools` 图片后端、`my_tools` 存储后端、登录流程和部署假设必须保留。

这不是一次简单的“接受上游”合并，而是把当前 fork 的业务与安全行为迁移到上游的新架构里。

资产存储第一阶段采用**方案 A**：

```text
my_tools 负责远端正本/归档
gpt-image-canvas 保留 /api/assets/:id 统一代理入口
本地文件只作为可清理热缓存
```

第一阶段不做浏览器直连 `my_tools` 图片 URL，也不要求 `my_tools` 返回可直接嵌入画布的公开图片地址。

## 重要说明

当前 fork 的大部分功能逻辑都要保留，但不能说“没有冲突”。

冲突真实存在，原因是上游移动并拆分了当前 fork 改过的同一批文件：

- API 路由从 `apps/api/src/index.ts` 拆出。
- Provider 选择逻辑移动到 `apps/api/src/domain/providers/`。
- 存储和生成逻辑移动到 `domain/` 和 `infrastructure/`。
- 共享契约从一个大的 `packages/shared/src/index.ts` 拆成多个小文件。
- Web 从大的 `App.tsx` 和 `styles.css` 拆成 feature 模块和多个 CSS 文件。

所以目标是：**产品逻辑尽量不变，代码落点和接入方式按上游新结构重构。**

## 必须保留的当前 fork 行为

### 登录与租户隔离

- `APP_AUTH_ENABLED=true` 时启用 access-token 用户会话。
- access-token 用户按 `ownerTokenId` 或等价 owner 字段隔离。
- 项目、资产、生成记录、生成输出、存储配置、Gallery 读取、资产读取、下载、删除、重跑都必须按 owner 隔离。
- 管理员会话和 access-token 用户会话保持分离。
- 非安全 API 方法继续保留 same-origin 校验。
- 登录、登出、状态查询等公开 auth 路由继续可用。
- 已有会话应直接进入画布，避免 auth gate 闪屏。

### Provider 权限边界

当 `APP_AUTH_ENABLED=true` 且当前请求来自普通 access-token 用户时：

- 不能使用 `.env` 里的 OpenAI 凭据。
- 不能使用上游的应用内 local provider 配置。
- 不能使用 Codex fallback。
- 不能使用上游全局 provider 优先级选出来的任何 provider。
- 只能使用当前 fork 策略允许的“按请求主体选择 provider”。

允许的生产模式：

- `IMAGE_BACKEND=my_tools`：生成/编辑请求转发给 `my_tools`。
- `IMAGE_BACKEND=access_token`：使用当前 access token 绑定的 upstream 凭据。
- `IMAGE_BACKEND=local`：普通 access-token 用户返回 403。

管理员或本机单用户模式可以使用上游 provider 链：

- 环境变量 OpenAI-compatible provider
- 应用内 local OpenAI-compatible provider
- Codex fallback

### my_tools 图片后端

保留 `MyToolsImageProvider` 行为：

- `POST /api/internal/gic/images/generate`
- `POST /api/internal/gic/images/edit`
- `X-GIC-Image-Key`
- 发送 `imageOwnerId`
- 发送 prompt、size、quality、outputFormat、count
- 编辑请求发送参考图
- 接收 `model`、`size`、`images[].b64Json` 形态的响应
- 将 `my_tools` 的错误 JSON 转成前端可见的 provider error

当 `IMAGE_BACKEND=my_tools` 时，普通用户路径中 `gpt-image-canvas` 不得读取或使用 access token 中的真实 upstream key。

Agent 和 Manual 必须走同一套 provider 权限规则。普通 access-token 用户执行 Agent plan 时，图片生成/编辑请求也必须转发给 `my_tools` 接管，不能因为 Agent executor 在后端运行就绕过 `IMAGE_BACKEND=my_tools`。

### my_tools 资产存储

保留图片生成后端和资产存储后端的分离：

- 生成图仍然先写入本地 `DATA_DIR/assets` 作为热缓存。
- `CLOUD_STORAGE_PROVIDER=my_tools` 时，新资产上传到 `my_tools`。
- 将 `my_tools` 返回的 `archiveId` 保存到资产 cloud object 字段。
- 本地文件缺失时，从 `my_tools` 回源并重新填充本地缓存。
- Gallery/资产删除时调用 `my_tools` 删除；远端清理失败时不阻断本地删除。
- COS 存储能力继续保留。

本地图片文件不再视为长期正本，而是视为可清理热缓存：

- `my_tools` 或 COS 中已成功上传的对象是远端正本。
- `/api/assets/:id`、`/api/assets/:id/preview`、`/api/assets/:id/download` 继续作为前端唯一资产入口。
- 本地文件存在时优先读本地，降低延迟和远端请求量。
- 本地文件不存在时，根据 SQLite 中的 cloud metadata 从 `my_tools` 或 COS 回源，并可重新写入本地热缓存。
- 可以加入 TTL/容量清理，但只能清理已有远端正本的本地文件。
- 没有远端正本的本地文件不能被自动清理，否则会造成真实资产丢失。

第一轮不建议完全取消本地资产入口。当前缩略图、下载、参考图生成、Agent 下游引用都需要服务端拿到图片 bytes；即使 `my_tools` 返回 URL，`gpt-image-canvas` 仍需要能按 `archiveId` 回源 bytes。

因此第一阶段只实现方案 A，不做前端直连 `my_tools` URL 的方案 B。

### 部署和文档

保留生产部署相关配置和文档：

- access-token 管理员/bootstrap 行为
- `my_tools` 托管 upstream 兼容说明
- Docker、DNS 和部署说明
- 密钥处理规则
- 不记录 `.env`、access-token upstream key、provider key、Codex token、COS secret 或 `my_tools` shared secret

## 应吸收的上游能力

以下上游能力应尽量保留，除非它们破坏当前 fork 的安全边界：

- 应用内 provider 配置，仅供管理员/本机模式使用
- provider 优先级 UI，仅供管理员/本机模式使用
- 多参考图生成，并遵守上游数量限制
- i18n 结构
- Agent LLM 配置
- Agent WebSocket
- Agent 规划
- 画布上的 Agent plan node
- Agent DAG 执行和失败重试
- 上游的 Web feature 模块结构
- 上游拆分后的 CSS 结构
- 上游 smoke scripts
- Node 24 运行时文件和 package 约束

重要规则：**Agent 执行不能绕过当前 fork 的 provider 权限边界。** Agent 生成图片任务必须调用和手动生成相同的 request-aware provider 选择逻辑；当普通用户处于 `IMAGE_BACKEND=my_tools` 时，Agent 的 generate/edit 请求也必须交给 `my_tools`。

## 目标架构

### 统一请求上下文

第一轮迁移必须先建立统一 request context，而不是只在 provider 层打补丁。

统一上下文至少包含：

- auth 是否启用
- 当前 access-token principal
- 当前 owner id
- 当前请求是否管理员
- 当前请求是否本机/单用户模式
- request signal

所有用户数据入口都必须携带这个上下文：

- provider 选择
- project 读写
- Gallery 查询和删除
- asset 读取、预览、下载、删除
- reference asset 读取
- generation record 保存
- storage config 读写
- Agent WebSocket session 和 Agent executor

不能出现“HTTP 路由有 owner，但 domain 函数内部又按裸 asset id/project id 读取”的路径。

### 按请求主体选择 provider

将上游“只按全局配置选择 provider”的逻辑改造成“按请求主体选择 provider”。

上游当前入口：

```text
apps/api/src/domain/providers/image-provider-selection.ts
createConfiguredImageProvider(signal)
```

目标形态：

```text
createRequestImageProvider(context, signal)
```

`context` 至少包含：

- auth 是否启用
- 当前 access principal
- 当前 owner id
- 是否管理员
- 请求 abort signal

策略：

```text
未启用 auth:
  使用上游 configured provider 链

管理员:
  使用上游 configured provider 链

access-token 用户 + IMAGE_BACKEND=my_tools:
  使用 MyToolsImageProvider(imageOwnerId = access token id)

access-token 用户 + IMAGE_BACKEND=access_token:
  使用当前 token upstream 字段创建 OpenAI provider

access-token 用户 + IMAGE_BACKEND=local:
  返回 403

access-token 用户 + IMAGE_BACKEND 配置无效:
  返回清晰的 provider 配置错误
```

### 路由

把当前 fork 的 auth 和 owner 检查迁移进上游路由结构：

- `apps/api/src/server/app.ts`：尽早安装 auth middleware。
- `apps/api/src/server/routes/auth.ts`：合并 Codex auth 路由与 access-token 登录/登出/me 路由，但不要混淆两种会话含义。
- `apps/api/src/server/routes/images.ts`：调用 request-aware provider 选择逻辑。
- `apps/api/src/server/routes/assets.ts`：资产读取、下载、删除必须 owner-scoped，并支持 `my_tools` 回源。
- `apps/api/src/server/routes/gallery.ts`：Gallery 按 owner 隔离。
- `apps/api/src/server/routes/project.ts`：项目快照按 owner 隔离。
- `apps/api/src/server/routes/storage.ts`：第一轮普通用户不开放存储配置 UI；管理员/本机可管理全局 COS/`my_tools` 配置。若后续恢复 per-owner 存储配置，必须单独按 owner 隔离。
- `apps/api/src/server/routes/provider-config.ts`：只允许管理员/本机模式访问，普通 access-token 用户不能读取或修改全局 provider。
- `apps/api/src/server/routes/agent-config.ts`：只允许管理员/本机模式访问，除非后续明确设计普通用户自带 Agent LLM 配置。
- `apps/api/src/server/routes/agent-ws.ts`：WebSocket 建连、恢复和执行必须绑定 owner，不能只靠 `connectionId/runId` 恢复跨用户 session。
- 新增或保留 access token 管理员路由。

资产路由保持稳定，不把前端改成直接访问 `my_tools` URL：

- 前端继续使用 `/api/assets/:id`、`/api/assets/:id/preview` 和 `/api/assets/:id/download`。
- API 层负责权限校验、owner scope、热缓存读取、远端回源和响应缓存头。
- 这样可以避免把 `my_tools` archive id、内部 URL 或共享鉴权细节暴露给浏览器。

### 数据模型

以上游 schema 为起点，重新引入当前 fork 字段：

- `projects.ownerTokenId`
- `assets.ownerTokenId`
- COS 和 `my_tools` 所需 cloud 字段
- `storageConfigs.ownerTokenId`，仅在后续启用 per-owner 存储配置时使用；第一轮可保持管理员/本机全局配置并禁止普通用户访问配置路由。
- `accessTokens`
- `generationRecords.ownerTokenId`
- `generationOutputs.ownerTokenId`
- 上游多参考图所需的 reference ownership 校验

任何读取或修改用户数据的查询都必须带 owner scope，除非该路由明确是管理员专用。

需要特别处理：

- 上游默认项目不能继续是全局唯一的 `default` 项目；应按 owner 建立默认项目，或让项目主键包含 owner 维度。
- owner 字段需要配套索引，例如 `ownerTokenId + createdAt`、`ownerTokenId + id`。
- `cloud_object_key` 在 `cloud_provider=my_tools` 时保存 `archiveId`，不是 COS object key；代码和文档必须显式约定，避免语义混淆。
- 远端上传失败状态 `cloud_status=failed` 不能被视为可清理远端正本。

### Shared contracts

不要把当前 fork 的所有类型重新堆回 `packages/shared/src/index.ts`。

跟随上游拆分方式：

- auth/access-token contract 放到新的或已有的聚焦文件里
- generation 相关增量放到 `generation.ts`
- storage 相关增量放到 `storage.ts`
- provider config 只放管理员/本机 provider 概念
- 最后从 `index.ts` 统一 export

### Web

将当前 fork 的 UI 行为迁移到上游 feature 结构：

- 已有会话直达画布的逻辑放到新的 app routing/home/canvas 边界里。
- Auth gate 应保护 canvas 访问，但不能破坏上游 Manual/Agent tab。
- 管理员/token 管理 UI 与普通用户画布流程保持分离。
- 样式迁移到上游拆分后的 CSS 文件中，不要整块塞回 `styles.css`。

## 迁移阶段

### 阶段 1：安全基础

- 保持分支基于 `upstream/main`。
- 加入 auth runtime config 和 middleware。
- 加入 access-token schema 和 store。
- 加入管理员/access-token 路由。
- 增加 login、logout、管理员校验、无效 token、禁用 token、same-origin 拒绝的测试或 smoke checks。
- 将全局配置路由先保护起来：provider config、storage config、Agent LLM config 默认只允许管理员/本机模式访问。
- 明确普通 access-token 用户不能读写全局密钥配置。
- 为后续 `my_tools` HMAC 准备 shared secret 读取和签名工具，但第一轮可继续兼容 `X-GIC-Image-Key` / `X-GIC-Storage-Key` 静态密钥。

验收标准：

- 启用 auth 不破坏上游本机模式。
- 本阶段还没有完成用户数据隔离，不能单独部署。
- 非公开 API 默认都能拿到统一 request context。

### 阶段 2：用户数据隔离

- 加入 owner 字段和迁移。
- 隔离 project、assets、generation records、outputs、Gallery、storage config、reference assets。
- 第一轮如不开放普通用户存储配置 UI，则 `storage config` 只需禁止普通用户访问；不要为了迁移过早引入 per-owner 存储 UI。
- 上游多参考图生成必须校验每个 reference asset 的 owner。
- 资产回源不能获取其他用户的 cloud object。
- Manual reference asset id 和 Agent selected/generated reference asset id 都必须用 owner-aware 读取函数。
- 默认项目按 owner 隔离，不能让所有用户共享上游 `default` 项目。

验收标准：

- 两个 access-token 用户不能查看、加载、下载、重跑、引用或删除彼此的数据。
- 用户不能把其他 owner 的 asset id 当作参考图传给 Manual 或 Agent。

### 阶段 3：Provider 权限边界

- 加入 `IMAGE_BACKEND` runtime config。
- 迁移 `MyToolsImageProvider`。
- 加入 access-token upstream provider 模式。
- 将路由里的 `createConfiguredImageProvider()` 替换为 request-aware provider 选择逻辑。
- 确保手动生成和参考图生成都使用 request-aware selector。

验收标准：

- 普通 access-token 用户不能使用 env/local/Codex provider。
- `IMAGE_BACKEND=my_tools` 时，access token 里只有 placeholder upstream 凭据也能工作。
- `IMAGE_BACKEND=access_token` 时，placeholder 或无效 token upstream 凭据会清晰失败。

### 阶段 4：my_tools 存储

本阶段只实施方案 A：`my_tools` 作为远端正本，`gpt-image-canvas` 继续作为资产代理和权限层。

- 迁移 `MyToolsAssetStorageAdapter`。
- 加入 `CLOUD_STORAGE_PROVIDER=my_tools` 配置。
- 保留本地热缓存优先。
- 本地资产文件缺失时从 `my_tools` 回源。
- 资产删除时删除远端 `my_tools` archive，远端清理失败时像 COS 一样吞掉错误。
- 将本地资产文件定位为热缓存，而不是长期正本。
- 加入本地缓存策略配置，例如：

```env
LOCAL_ASSET_CACHE_MODE=hot_cache
LOCAL_ASSET_CACHE_TTL_DAYS=30
LOCAL_ASSET_CACHE_CLEANUP_ENABLED=true
```

- 第一版清理策略只删除已成功上传远端正本的本地文件。
- 清理 SQLite metadata、generation records、canvas snapshot 不属于缓存清理范围。

验收标准：

- 新生成资产能上传到 `my_tools`。
- 本地缺失资产能从 `my_tools` 恢复。
- `my_tools` 清理失败时，本地删除仍可靠。
- 自动清理不会删除没有远端正本的资产文件。
- 本地文件被清理后，Gallery、画布展示、下载、参考图生成和 Agent 下游引用仍能通过回源工作。

### 阶段 5：Agent 纳入当前 fork 权限策略

- 审计 Agent executor 的图片生成路径。
- 确保 Agent 执行能拿到请求 auth context。
- 确保 Agent job 调用 request-aware provider 选择逻辑。
- 明确移除 Agent executor 对 `createConfiguredImageProvider()` 这类全局 provider selector 的用户请求调用。
- `IMAGE_BACKEND=my_tools` 时，Agent 的 generate/edit 请求必须由 `MyToolsImageProvider` 发给 `my_tools`。
- 确保 Agent 选中的 reference 都按 owner 校验。
- 确保 Agent plan node 存进项目快照时不会泄露跨用户数据。
- Agent WebSocket session 必须绑定 owner；恢复 session 时必须校验当前 owner 与原 session owner 一致。
- Agent LLM config 第一轮作为管理员/本机全局配置，不向普通 access-token 用户开放配置读写；如果普通用户可使用 Agent，必须明确它使用的是受控的服务端 Agent LLM，不暴露密钥。
- 区分 Agent 规划和图片生成：Agent 规划可以使用服务端受控的 Agent LLM；Agent 执行图片生成必须走 `my_tools` / request-aware image provider。

验收标准：

- `IMAGE_BACKEND=my_tools` 时，普通用户的 Agent 生图也走 `my_tools`。
- Agent 不能让普通用户用到 env/local/Codex provider。
- Agent 下游 job 引用上游生成图片时，若本地热缓存已清理，必须能从 `my_tools` 回源 reference bytes。
- 不同 owner 不能通过 `connectionId/runId` 恢复彼此的 Agent session。

### 阶段 6：Web 和文档

- 将 auth gate 和已有会话直达逻辑迁移到上游 feature layout。
- 保持上游 Manual/Agent UI 可用。
- 保留部署、DNS、`my_tools` 相关文档。
- 更新 `.env.example`，加入 auth、image backend、storage backend 配置，但不暴露密钥。

验收标准：

- 普通用户登录流程可用。
- 管理员/本机 provider 流程可用。
- 文档清楚说明权限边界。

## 验证门槛

迁移完成前必须运行：

- `pnpm typecheck`
- `pnpm build`
- auth smoke checks
- provider selection smoke checks
- owner isolation smoke checks
- `my_tools` image backend smoke checks
- `my_tools` storage read-through smoke checks
- local asset cache cleanup smoke checks
- 上游 Agent smoke scripts
- `pnpm dev` 后做浏览器验证

浏览器验证场景：

- 未登录生产用户
- 有效 access-token 用户
- 过期/禁用/无效 token
- 管理员/本机用户
- `IMAGE_BACKEND=my_tools` 下的 Manual 生成
- 1、2、3 张参考图生成
- `IMAGE_BACKEND=my_tools` 下的 Agent plan 创建和执行
- 清理本地热缓存后再次打开 Gallery、画布、下载资产、执行 Agent 下游引用
- Gallery 隔离
- 资产下载/删除隔离

## 第一轮迁移不做的事

- 不重新设计 `my_tools` API。
- 不把 access-token upstream 凭据改成 nullable，除非后续明确批准 schema 清理。
- 不向普通 access-token 用户暴露 provider config。
- 不改变上游当前 Agent 对话不持久化的行为。
- 不把 `gpt-image-canvas` 改成 `my_tools` 的纯无状态前端。
- 不在第一轮完全取消 `/api/assets/:id` 资产代理入口。
- 不在第一轮要求浏览器直接访问 `my_tools` 图片 URL。
- 不在第一轮引入 `my_tools`/CDN 签名 URL 直连画布或 Gallery。
- 不在第一轮开放普通用户自定义 provider、storage 或 Agent LLM 配置。

## 主要风险

### Provider 绕过

风险：上游 Agent 或图片路由直接调用全局 provider selector。

缓解：用户请求不能直接访问全局 selector；全局 selector 只作为管理员/本机 helper。

### 全局配置路由泄露

风险：普通 access-token 用户读取或修改 provider config、storage config、Agent LLM config，间接使用或覆盖管理员全局密钥。

缓解：这些路由默认只允许管理员/本机模式访问；普通用户需要配置能力时必须另行设计 per-owner 配置。

### 跨用户引用资产

风险：上游多参考图生成接受其他 owner 的 asset id。

缓解：读取图片 bytes 或保存生成记录前，按当前 owner 校验每个 reference asset id。

### 存储回源泄露

风险：通过 asset id 或 archive id 读取其他用户对象。

缓解：使用 cloud metadata 前，必须同时按 asset id 和 owner 解析资产行。

### Agent 上下文泄露

风险：Agent plan 或选中 reference 包含其他用户画布数据。

缓解：选中 reference 只能来自当前用户画布快照和当前 owner 的资产行。

### Agent WebSocket 跨用户恢复

风险：WebSocket 使用 `connectionId/runId` 恢复 session 时没有绑定 owner，导致另一个用户恢复或影响别人的 Agent run。

缓解：session 创建时记录 owner id；恢复、取消、执行、重试都必须校验当前 owner 一致。

### 默认项目共享

风险：继续使用上游全局 `default` 项目会让多个 access-token 用户读写同一画布。

缓解：默认项目必须按 owner 隔离，或者项目主键包含 owner 维度。

### 孤儿资产增长

风险：Gallery 删除只删除输出记录，不清理 asset 行、本地文件或远端 archive，长期会造成孤儿资产。

缓解：定义删除边界；用户删除生成输出时至少应记录可清理资产，远端删除失败不阻断本地逻辑但要保留错误和后续清理机会。

## 推荐实施顺序

第一轮实现应尽量窄：

1. Auth runtime config 和 middleware。
2. Access token store/schema。
3. 管理员和 access-token auth 路由。
4. 最小化 Web auth gate 适配。
5. 只验证 auth 的测试。

之后再分步迁移数据隔离和 provider 选择。这样最重要的安全边界更容易 review。
