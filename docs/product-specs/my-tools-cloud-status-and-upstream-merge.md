# my_tools 云端状态 API 与上游功能合并设计

## 目标与结论

`my_tools` 在本项目中定义为正式云端 provider，而不是附属的 tools bridge。`gpt-image-canvas` 继续保持本地优先：SQLite、生成记录、Gallery、画布快照和 `/api/assets/:id` 资产代理仍是浏览器侧事实入口；`my_tools` 负责云端归档、回源恢复、可选发布链接和后续跨设备资产恢复。

本设计合并三条线：

- 当前 fork 已打通的 access-token、owner 隔离、`my_tools` Image/Agent/Storage 和 secure-base 部署能力必须保留。
- 上游 v0.3.0 的异步生成、Gallery ZIP 导出、R2/S3 存储、loading/Gallery 优化可以吸收，但不能破坏本地权限边界。
- `my_tools` 需要补齐或明确云端状态 API，让云端能力从“静默双写备份”变成可查询、可恢复、可展示的产品能力。

第一版不让浏览器直连 `my_tools` 图片 bytes，也不把 `archiveId`、内部服务 URL、共享密钥或 credential-bearing URL 暴露给前端。浏览器继续访问 `gpt-image-canvas` 的资产路由，由 API 层负责权限校验、本地热缓存、云端回源和状态转换。

## 当前接手优先级

后续接手时，主线优先围绕 `my_tools` 做真实联调，而不是继续打磨 S3/R2：

1. 先在 `my_tools` 侧实现并联调 `status`、`refresh-url` 和上传响应中的 `publicUrl`、`visibility`、`syncedAt` 字段。
2. 再对齐 GIC 与 `my_tools` 的错误语义，尤其是 `missing`、`deleted`、`failed`、`unsupported`、`forbidden`，确保 Gallery 展示和恢复动作能给出稳定反馈。
3. 然后用真实 `my_tools` 服务验证 Gallery 云端状态、重新同步、恢复本地缓存和复制云端链接。
4. S3/R2 只作为同步上游和第三方兜底能力保留，优先级最低；除非后续出现明确用户需求或上游继续强依赖，否则不投入真实桶联调和体验 polish。

## 必须保留

- `APP_AUTH_ENABLED=true` 时启用 access-token 会话和管理员会话。
- 项目、资产、generation records、outputs、Gallery、参考图和 Agent session 都必须按 owner 隔离。
- 普通 access-token 用户不能读取或使用 env/local/Codex provider，也不能读写全局 provider、storage 或 Agent LLM 配置。
- Manual 和 Agent 图片生成都必须走 request-aware provider 选择；`IMAGE_BACKEND=my_tools` 时转发给 `my_tools`，`IMAGE_BACKEND=access_token` 时使用当前 token 绑定的 upstream 凭据，`IMAGE_BACKEND=local` 时普通用户失败关闭。
- `AGENT_LLM_BACKEND=my_tools` 时，普通 access-token 用户的 Agent planning 通过 `my_tools` SSE；admin/local/auth-disabled 保持本地 Agent LLM 配置。
- `CLOUD_STORAGE_PROVIDER=my_tools` 时，新资产先写入本地热缓存，再上传到 `my_tools`；本地缺失时从 `my_tools` 回源并回填本地。
- secure-base、dnmp node 容器、Docker 网络、`.env` 密钥读取和不提交运行数据的规则保持不变。

## 上游功能吸收边界

上游功能作为手工吸收来源，不直接合并覆盖当前 fork：

- 异步生成任务可以吸收为“先创建 running record，后台完成，前端轮询/取消”，但 task 必须保存或传入当前 request context，并继续使用 `createRequestImageProvider`。
- Gallery ZIP 导出可以吸收，但导出查询必须 owner-scoped，只能导出当前 owner 可见的 outputs。
- R2/S3-compatible 存储可以吸收，但定位是上游兼容兜底；`CloudStorageProvider` 目标应是 `my_tools | cos | s3`，不能把 `my_tools` 从 shared contract 中移除。
- 上游 S3 的 `endpoint` 和 `forcePathStyle` 持久化思路可用于增强云端回源稳定性；`my_tools` 的 `archiveId` 仍保存在 cloud object 字段，并在文档中明确其语义不是对象存储 key。
- 上游 loading、Gallery 和 Agent 稳定性优化可以吸收，但不得删除 AuthGate、access-token 管理、owner 字段、same-origin 校验或 `my_tools` 配置。

## my_tools 云端状态 API 契约

所有 storage 接口由 `gpt-image-canvas` 服务端调用 `my_tools` 服务端，使用 `X-GIC-Storage-Key`。响应不得包含密钥、内部文件系统路径、原始 headers、上游凭据或 credential-bearing URL。

### 已有或需确认接口

`POST /api/internal/gic/assets`

- 用途：上传生成资产到 `my_tools` 云端归档。
- 请求：multipart `file` 和 JSON `metadata`。
- `metadata` 至少包含：`imageOwnerId`、`assetId`、`fileName`、`mimeType`、`width`、`height`、`createdAt`，可包含 `generationId`、`outputId`。
- 响应：`archiveId` 必填，`requestId` 可选。
- 新增建议字段：`publicUrl`、`visibility`、`syncedAt`。

`GET /api/internal/gic/assets/:archiveId`

- 用途：本地热缓存缺失时回源读取原图 bytes。
- 响应：原始图片 bytes 和正确 `Content-Type`。
- 失败：不存在、无权限或已删除时返回稳定 JSON 错误，不暴露内部路径。

`DELETE /api/internal/gic/assets/:archiveId`

- 用途：删除或标记删除远端归档。
- 语义：删除失败不阻断 `gpt-image-canvas` 本地删除流程，但错误应可记录用于后续清理。
- `404` 可视为远端已不存在。

`POST /api/internal/gic/storage/test`

- 用途：验证 `MY_TOOLS_BASE_URL` 和 `MY_TOOLS_STORAGE_SHARED_SECRET` 可用。
- 响应：成功返回可展示 message；失败返回稳定错误码和 message。

### 新增建议接口

`GET /api/internal/gic/assets/:archiveId/status`

- 用途：查询云端归档状态，用于 Gallery 状态展示、重新同步判断和本地缺失恢复提示。
- 响应字段：
  - `archiveId`
  - `status`: `uploaded | missing | deleted | failed`
  - `readable`: boolean
  - `visibility`: `private | public`
  - `publicUrl`: 可选；仅当链接安全且可展示时返回
  - `syncedAt`: 可选 ISO 时间
  - `sizeBytes`: 可选
  - `mimeType`: 可选
  - `requestId`: 可选
- 安全：如果 owner 无权访问该 archive，应返回 403 风格稳定错误，而不是泄漏对象是否存在。

`POST /api/internal/gic/assets/:archiveId/refresh-url`

- 用途：生成或刷新云端可展示链接。
- 请求：可选 `ttlSeconds`、`visibility`。
- 响应字段：`publicUrl`、`visibility`、`expiresAt` 可选、`requestId` 可选。
- 约束：如果 `my_tools` 当前不支持公开链接，可返回 `unsupported`，`gpt-image-canvas` 应继续只展示代理资产入口。

## gpt-image-canvas 侧接口设计

浏览器侧资产入口保持稳定：

- `GET /api/assets/:id`
- `GET /api/assets/:id/preview`
- `GET /api/assets/:id/download`
- `GET /api/assets/:id/metadata`

后续实现可新增云端状态路由：

- `GET /api/assets/:id/cloud`：查询当前资产的云端状态。必须按 owner 读取 asset row，再根据 `cloud_provider` 决定是否调用 `my_tools` status API。
- `POST /api/assets/:id/cloud/resync`：重新上传本地资产到 `my_tools`。仅当本地文件可读且当前 owner 有权限时执行。
- `POST /api/assets/:id/cloud/restore`：从 `my_tools` 回源并重建本地热缓存。仅当资产有成功云端正本或 status 确认为 readable 时执行。

Gallery 后续展示：

- 已同步：`cloud_status=uploaded` 且云端 status readable。
- 同步失败：`cloud_status=failed`，展示安全错误摘要。
- 本地缺失可恢复：本地文件不存在但云端 readable。
- 可复制云端链接：`publicUrl` 存在且 visibility 为 public。
- 未同步：没有 cloud metadata 或 provider 未启用。

第一版不要求把 `publicUrl` 作为画布 image source。即使云端能公开访问，画布、下载、参考图生成和 Agent 下游引用仍默认走 `/api/assets/:id`，避免绕过 owner 权限。

## Agent 协作说明

后续实现允许 AI 在认为有必要时使用子 agent 能力进行并行分析、实现或验证。允许的典型拆分：

- explorer：独立审查上游 v0.3.0 变更、冲突文件、owner-scope 风险或现有 my_tools 调用点。
- worker：在明确互不冲突的文件范围内实现某个子模块，例如 storage adapter、Gallery UI、async generation task 或 smoke checks。
- verifier：在主实现进行时并行运行 typecheck/build/smoke 或浏览器验证，并报告命令和结果。

使用子 agent 时必须遵守：

- 主 agent 负责最终整合、冲突处理和安全边界审查。
- 每个 worker 必须有明确文件/模块所有权，并知道不是独占代码库，不能回滚用户或其他 agent 的改动。
- 子 agent 不得自行改变本设计的安全边界：不能移除 access-token、owner 隔离、AuthGate、`my_tools` provider 或 secure-base 部署假设。
- 子 agent 可以提出问题或风险，但最终取舍由主 agent 按本文档和用户最新指示执行。

## 实施阶段

### 阶段 1：设计与契约确认

- 保存本文档。
- 与 `my_tools` 侧确认 status、refresh-url、publicUrl、visibility 字段是否支持。
- 明确第一版是否只做内部状态查询，还是同时在 Gallery 显示复制云端链接。

### 阶段 2：存储状态模型

- 扩展 shared contract，让 cloud provider 目标为 `my_tools | cos | s3`。
- 在资产 metadata 中表达云端可读状态、同步时间、公开链接和错误摘要。
- 如需新增 SQLite 字段，更新 schema 和 `docs/generated/db-schema.md`。

### 阶段 3：API 与回源能力

- 增加 owner-scoped cloud status、resync、restore 路由。
- `my_tools` status API 缺失时，降级使用已有 `cloud_status` 和回源尝试结果。
- 确保本地缺失时仍能从 `my_tools` 回源并回填热缓存。

### 阶段 4：Gallery 可见化

- Gallery 显示云端状态。
- 支持重新同步、恢复本地缓存和复制安全云端链接。
- 保持 Gallery locate、download、rerun、delete 行为不退化。

### 阶段 5：上游功能手工吸收

- 先吸收异步生成任务，但必须 request-aware。
- 再吸收 Gallery ZIP 导出，但必须 owner-scoped。
- 最后吸收 R2/S3，作为 `my_tools | cos | s3` provider 架构中的第三方兜底实现；当前不作为主线联调目标。

## 验收标准

- 文档不包含真实密钥、真实 `.env` 值、内部机器私有路径或 credential-bearing URL。
- `my_tools` 被描述为正式云端 provider，且没有被上游 `cos | s3` 设计覆盖。
- 所有新增 browser-facing API 都要求 owner scope。
- 文档明确允许子 agent 协作，并要求主 agent 最终整合和保护本地改动。
- 后续实现完成后优先通过本项目 app 镜像/容器验证，避免 dnmp `node` 源码挂载在宿主工作区生成 `node_modules`：

```sh
docker compose build app
docker compose up -d --build app
```

- 涉及 UI 时，优先验证项目 app 容器暴露的 `http://localhost:8787`。如需在已构建容器内检查运行时命令，使用 `docker exec gpt_image_canvas_app sh -lc 'cd /app && ...'`。

## 非目标

- 不在本设计文档落地业务代码。
- 不直接合并 `upstream/main`。
- 不提交 git commit。
- 不让浏览器绕过 `gpt-image-canvas` 直接读取私有 `my_tools` 图片 bytes。
- 不向普通 access-token 用户开放全局 provider、storage 或 Agent LLM 配置。
- 不把本地没有远端正本的资产当作可自动清理缓存。
