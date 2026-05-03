# my_tools 图片边界设计

状态：实施方向草稿
最后更新：2026-05-03

## 当前实现进度

已在 `my-tools-storage-design` 分支开始第一版落地：

- image 侧新增 `my_tools` cloud storage provider，启用方式是环境变量。
- 现有 COS UI 和 COS SQLite 配置继续保留，不做前端配置弹窗改造。
- `CLOUD_STORAGE_PROVIDER=my_tools` 时，生成图仍先写 `DATA_DIR/assets` 热缓存，再上传到 `my_tools`。
- `assets.cloud_provider` 保存 `my_tools`，`assets.cloud_object_key` 保存 `my_tools` 返回的 `archiveId`。
- 本地文件缺失时，`GET /api/assets/:id` 会按 `archiveId` 从 `my_tools` 回源并重新写入本地缓存。
- Gallery/资产删除时，会调用 `my_tools` 删除接口；失败仍按现有 COS 行为吞掉，不阻断 image 本地删除。
- 已新增 `IMAGE_BACKEND` 分流，默认 `access_token`，可显式设置 `my_tools` 让普通 access-token 用户把生成/编辑请求转发到 `my_tools`。

当 `IMAGE_BACKEND=my_tools` 时，普通 Laravel 用户生产路径中，`gpt-image-canvas` 不再使用真实 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 请求第三方。上游凭据由 `my_tools` 选择、审计和请求。

## 背景

`gpt-image-canvas` 现在是独立运行的图片应用。`/opt/project/my_tools` 是 Laravel 工具门户，负责主站账号、套餐、工具入口，以及上游图片凭据的选择。

当前 `my_tools` 的行为：

- `POST /tools/image/launch` 会为每个 Laravel 用户创建或复用一个稳定的 `gpt-image-canvas` access token。
- `my_tools` 通过 `GptImageCanvasClient` 调用 `gpt-image-canvas` 的管理员接口。
- `ImageUpstreamCredentialResolver` 会从 NewAPI 或静态配置里选择每个用户要使用的上游凭据。
- 选出的上游 key、base URL、model 会写入 image access token。
- 浏览器会被跳转到 `GIC_PUBLIC_URL/api/auth/login?token=...`。
- `my_tools` 不读取、不写入 image 应用的 SQLite 数据库。
- `gpt-image-canvas` 仍然负责画布状态、Gallery、生成的图片文件、历史记录和存储配置。

上游 `gpt-image-canvas` 已经开始把 provider 配置做进 image 应用内部。这和当前 fork 的公网部署模型有冲突，因为普通用户应该只能使用绑定在自己 access token 上的上游凭据生成图片。

## 目标

在保留当前 `my_tools` 控制面的同时，让以后合并上游更容易。

长期希望形成的状态：

- 上游的 provider、Codex、本地配置功能可以尽量少改地合并进来。
- 生产路径仍由 `my_tools` 控制，并且行为可预测。
- 普通 access-token 用户不能悄悄用到 image 应用里的全局凭据。
- 图片请求和图片保存都容易审计、归档和运维。
- 改动保持非破坏性，并且可以通过明确配置回退。

当前阶段结论：

- 默认 Provider 生成路径仍以 access-token 绑定 upstream 为主，不让普通用户走全局 provider-config。
- 已提供显式 `IMAGE_BACKEND=my_tools` 开关，让 `my_tools` 接管普通用户的生成/编辑请求。
- 图片存储路径已新增 `my_tools` cloud storage provider，仿照现有 COS。
- `my_tools` 做长期远端正本/归档层；第一阶段底层可以先用 Laravel 私有本地磁盘，后续再由 `my_tools` 自己接云。
- `gpt-image-canvas` 继续保留 SQLite 业务索引、本地热缓存、Gallery、画布和生成历史。
- 后续合并上游 provider-config 时，以“请求上下文选择 provider”和“普通用户权限边界”为核心不变量。

更新后的目标分成两个互相独立的边界：

```text
图片生成/编辑请求边界：IMAGE_BACKEND=access_token | my_tools | local
图片保存/回源边界：CLOUD_STORAGE_PROVIDER=cos | my_tools | 未启用
```

这两个开关不要混在一起。生成请求由谁发起，不等于图片正本保存在哪里。

## 推荐边界

把 `my_tools` 当作控制面，而不是让它接管 image 应用的全部数据状态。

`my_tools` 应该负责：

- Laravel 用户身份、套餐和工具访问权限。
- 上游凭据的创建和选择，包括 NewAPI/static provider 的选择。
- 通过管理员接口创建、更新、禁用和删除 image access token。
- 可选地记录工具启动日志，以及未来的使用量回调日志。

`gpt-image-canvas` 应该负责：

- 画布项目快照。
- Gallery 记录。
- 生成后的图片文件。
- 按 access token 隔离数据。
- 生成历史的删除、下载、复用等行为。
- 按 image access token 隔离的 COS/存储配置。

这样可以保持现有 Gallery 和项目行为稳定，也避免 Laravel 需要理解每个图片资产生命周期细节。

## Provider 选择规则

当 `APP_AUTH_ENABLED=true` 时：

- 普通 access-token 用户只能使用绑定在自己 access token 上的 upstream key、base URL 和 model。
- 普通用户不能使用 image 应用的全局 provider config、本地 provider config、`.env` OpenAI key 或 Codex fallback。
- 管理员用户可以使用 image 应用里的本地/管理员 provider 路径。

当 `APP_AUTH_ENABLED=false` 时：

- 应用可以按本地单用户模式运行。
- 上游 provider config 可以继续用于开发或私有本机使用。

这条规则应该作为以后合并上游时的核心不变量。未来上游 provider 功能可以合并，但不能削弱这条边界。

## 图片生成/编辑请求接管

`OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 在 `gpt-image-canvas` 里用于 OpenAI 兼容图片生成和图片编辑。当前普通 access-token 用户虽然不会走 image 应用全局 `.env`，但 image 应用仍会保存 access token 里的 upstream key/baseURL，并由 image 服务端直接请求第三方。

如果希望上游请求完全由 `my_tools` 接管，需要增加一个明确的后端开关，而不是悄悄改变默认行为。

示例环境变量：

```env
IMAGE_BACKEND=access_token
MY_TOOLS_IMAGE_BASE_URL=
MY_TOOLS_IMAGE_SHARED_SECRET=
```

后端模式：

- `access_token`：当前行为。access-token 用户使用 image access token 中保存的上游凭据生成。
- `my_tools`：image 应用把生成/编辑请求发给 `my_tools` 暴露的可信服务端接口，由 `my_tools` 选择上游凭据并请求第三方。
- `local`：仅管理员/本机使用的 image 应用 provider 配置，包括 env/local OpenAI/Codex。

推荐默认值是 `access_token`。只有当 `my_tools` 的生成接口配置好并验证通过之后，生产环境才显式设置 `IMAGE_BACKEND=my_tools`。

### IMAGE_BACKEND=my_tools 流程

image 应用里应该增加一个很薄的 `MyToolsImageProvider`，实现现有的 provider 接口。

生成请求流程：

```text
gpt-image-canvas 收到生成请求
  -> 解析当前已认证的 image principal
  -> MyToolsImageProvider POST /api/internal/gic/images/generate
  -> my_tools 校验共享密钥和 image access token 身份
  -> my_tools 通过 imageOwnerId 反查 Laravel 用户和 ToolAccess
  -> my_tools 选择 GIC_UPSTREAM_* / NewAPI / 后台配置
  -> my_tools 请求 OpenAI 兼容上游生成图片
  -> my_tools 返回图片 base64/bytes
  -> gpt-image-canvas 按现有逻辑保存本地热缓存、Gallery 和生成历史
```

编辑请求流程：

```text
gpt-image-canvas 收到编辑请求
  -> 读取 reference asset bytes
  -> MyToolsImageProvider POST /api/internal/gic/images/edit
  -> my_tools 校验共享密钥和 image access token 身份
  -> my_tools 反查 Laravel 用户并选择上游凭据
  -> my_tools 携带 reference image 调第三方 edit 接口
  -> my_tools 返回图片 base64/bytes
  -> gpt-image-canvas 继续保存结果资产和历史
```

第一版更建议 `my_tools` 返回 image provider 同形态的 JSON，也就是 `model`、`size` 和图片 `b64Json`。这样 image 侧的 `runTextToImageGeneration()` / `runReferenceImageGeneration()` 基本不用改变。

建议响应：

```json
{
  "model": "gpt-image-2",
  "size": "1024x1024",
  "images": [
    {
      "b64Json": "..."
    }
  ],
  "requestId": "..."
}
```

如果 `my_tools` 后续想直接保存上游返回图片，也可以在内部顺手归档，但第一版不建议让它返回“已经保存好的资产引用”替代 bytes。原因是 `gpt-image-canvas` 还需要自己维护 Gallery、画布引用、generation_outputs 和本地热缓存。

### 普通用户与管理员的凭据边界

当 `IMAGE_BACKEND=my_tools` 且当前请求是普通 access-token 用户：

- `gpt-image-canvas` 不读取、不使用 `OPENAI_API_KEY`。
- `gpt-image-canvas` 不读取、不使用 `OPENAI_BASE_URL`。
- `gpt-image-canvas` 不使用 Codex fallback。
- `gpt-image-canvas` 不使用上游 provider-config。
- `gpt-image-canvas` 只把经过认证的 `imageOwnerId`、请求参数和参考图片 bytes 发给 `my_tools`。

当当前请求是管理员或 `APP_AUTH_ENABLED=false`：

- 可以继续使用 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。
- 可以继续使用 Codex 或上游 provider-config。
- 这条路径用于本机开发、管理员测试和紧急 fallback，不是普通用户生产路径。

### my_tools 侧需要新增的生成接口

建议内部接口：

```text
POST /api/internal/gic/images/generate
POST /api/internal/gic/images/edit
POST /api/internal/gic/images/test
```

认证方式可以先复用存储接口的共享密钥，也可以独立：

```text
X-GIC-Image-Key: <shared-secret>
```

如果复用同一密钥，环境变量可以是：

```env
MY_TOOLS_IMAGE_SHARED_SECRET=复用 MY_TOOLS_STORAGE_SHARED_SECRET
GIC_IMAGE_SHARED_SECRET=复用 GIC_STORAGE_SHARED_SECRET
```

更稳的长期方案是 HMAC：

```text
X-GIC-Timestamp
X-GIC-Signature
```

请求 metadata 至少包含：

```json
{
  "imageOwnerId": "当前 access token subject id",
  "mode": "generate",
  "prompt": "...",
  "size": "1024x1024",
  "quality": "auto",
  "outputFormat": "png",
  "count": 1
}
```

编辑请求额外包含 reference image，第一版建议 multipart：

```text
file: reference image bytes
metadata: JSON 字符串
```

### 和存储接管的组合关系

推荐生产组合：

```env
IMAGE_BACKEND=my_tools
CLOUD_STORAGE_PROVIDER=my_tools
```

这表示：

- 生成/编辑请求由 `my_tools` 请求第三方。
- 生成后的图片正本由 `my_tools` 归档保存。
- `gpt-image-canvas` 仍负责 Gallery、画布、历史、本地热缓存和前端体验。

也允许阶段性组合：

```env
IMAGE_BACKEND=access_token
CLOUD_STORAGE_PROVIDER=my_tools
```

这就是当前已实现状态：image 自己请求第三方，但正本上传到 `my_tools`。

## my_tools 作为云端存储 Provider

更推荐的落点是：`my_tools` 不接管画布业务数据库，而是仿照现有 COS，成为 `gpt-image-canvas` 的一个 cloud storage provider。

当前 `gpt-image-canvas` 的本地图片文件保存在：

```text
DATA_DIR/assets/<assetId>.<ext>
```

也就是所有 owner 的本地文件都在同一个 `assets` 目录下。因为文件名是 UUID，冲突概率很低，但从运维、迁移、人工排查和按用户清理的角度看，这个结构不够友好。

COS 远端 key 当前已经按年月分层：

```text
<keyPrefix>/<year>/<month>/<assetId>.<ext>
```

`my_tools` 远端对象路径应该比 COS 更明确，至少按用户和日期分层。当前实现推荐对象 key：

```text
<rootPrefix>/image-canvas/users/<laravelUserId>/yyyy/mm/dd/<archiveId>/<fileName>
```

示例：

```text
gic-assets/image-canvas/users/123/2026/05/03/550e8400-e29b-41d4-a716-446655440000/asset.png
```

`archiveId` 放进真实对象路径，是为了避免同一个 `assetId/fileName` 重试上传时出现唯一 key 冲突。`gpt-image-canvas` 不需要理解这个路径，只保存 `archiveId`。

如果 `my_tools` 只能拿到 image access token owner，而暂时拿不到 Laravel 用户 ID，可以先拒绝保存并返回 404/422。当前设计不建议落到 unknown 用户目录，因为这会破坏后续按用户清理和审计。

推荐第一版存储语义：

- `my_tools` 是长期远端正本/归档层。
- `gpt-image-canvas` 的 `DATA_DIR/assets` 是热缓存。
- SQLite 的 `assets` 表仍保存 asset 索引、owner、文件名、尺寸、mime type 和 cloud object key。
- 本地文件被清理后，`gpt-image-canvas` 可以按 cloud object key 从 `my_tools` 拉回并重新缓存。

`my_tools` 需要提供与 COS 等价的最小能力：

```text
putObject    上传对象
getObject    读取对象
deleteObject 删除对象
testConfig   测试配置
```

第一版可以让 `storage provider` 二选一：

```text
cos | my_tools
```

暂时不做 COS 和 `my_tools` 同时上传。以后如果需要多目标备份，再把 `assets.cloud_*` 这组单值字段升级成独立的 `asset_cloud_copies` 表。

### my_tools 底层接云策略

`CLOUD_STORAGE_PROVIDER=my_tools` 只表示 image 应用把正本交给 `my_tools`。至于 `my_tools` 自己把文件存在本地磁盘、S3、COS 或其他云存储，是 `my_tools` 的内部实现。

阶段建议：

- 第一阶段：`my_tools` 使用 Laravel `local` 私有磁盘，先跑通上传、回源、删除和审计。
- 第二阶段：`my_tools` 把 `GIC_STORAGE_DISK` 切到 S3/COS/其他云盘，或新增自己的云存储 adapter。
- `gpt-image-canvas` 不感知 `my_tools` 后面到底是本地还是云。
- 不建议第一阶段使用 `public` disk，避免归档图片绕过权限控制被公开访问。

## image 侧需要怎么改

### 1. 抽象 cloud storage provider

现有代码虽然字段叫 `cloud_*`，但实现上基本写死了 COS：

- `getActiveCosStorageConfig`
- `CosAssetStorageAdapter`
- `CosAssetLocation`
- `toCosAssetLocation`
- `saveAssetToConfiguredCloud`
- `readCloudAsset`
- `deleteCloudAsset`

第一版不需要做很大的抽象框架，但要把关键入口改成 provider-aware：

```text
getActiveCloudStorageConfig(owner)
saveAssetToConfiguredCloud(owner, input)
readCloudAsset(owner, asset)
deleteCloudAsset(owner, asset)
```

内部根据 `storage_configs.provider` 分发：

```text
provider = cos       -> CosAssetStorageAdapter
provider = my_tools  -> MyToolsAssetStorageAdapter
```

### 2. 扩展 storage provider 类型

共享 contracts 从：

```text
CloudStorageProvider = "cos"
```

扩展成：

```text
CloudStorageProvider = "cos" | "my_tools"
```

第一版如果只用环境变量启用 `my_tools`，可以只扩展 provider 类型和后端解析，不急着把 `StorageConfigResponse` / `SaveStorageConfigRequest` 的 UI 配置视图做完整。这样能少碰前端，减少和上游 UI 改动冲突。

阶段 1 的环境变量：

```env
CLOUD_STORAGE_PROVIDER=my_tools
MY_TOOLS_STORAGE_BASE_URL=
MY_TOOLS_STORAGE_SHARED_SECRET=
```

`MY_TOOLS_STORAGE_BASE_URL` 指向 Laravel 站点根地址，例如 `http://piachi-tools.test.com`。image 服务端实际调用：

```text
POST   /api/internal/gic/assets
GET    /api/internal/gic/assets/{archiveId}
DELETE /api/internal/gic/assets/{archiveId}
POST   /api/internal/gic/storage/test
```

阶段 2 如果要让管理员在 UI 里配置，再给 `StorageConfigResponse` 和 `SaveStorageConfigRequest` 增加 `myTools` 配置视图。

UI 配置版的字段建议：

```text
baseUrl
sharedSecret
preserveSecret
```

如果 `my_tools` 和 image app 永远在同一个部署环境，也可以让 `baseUrl` 从环境变量读取，只在 UI 里显示只读状态。但为了可测试，第一版保留可配置 baseUrl 更灵活。

### 3. 新增 MyToolsAssetStorageAdapter

新增 adapter，行为和 COS adapter 对齐：

```text
putObject(input)    -> POST /api/internal/gic/assets
getObject(location) -> GET /api/internal/gic/assets/{archiveId}
deleteObject(...)   -> DELETE /api/internal/gic/assets/{archiveId}
testConfig()        -> POST /api/internal/gic/storage/test
```

上传时使用 `multipart/form-data`，包含：

```text
file
metadata
```

metadata 至少包含：

```json
{
  "imageOwnerId": "当前 DataOwner.id",
  "assetId": "asset uuid",
  "fileName": "asset uuid.png",
  "mimeType": "image/png",
  "width": 1024,
  "height": 1024,
  "createdAt": "2026-05-03T00:00:00.000Z"
}
```

如果保存时已经能拿到 generationId/outputId，可以一并传。第一版拿不到也可以不传，后续再补 webhook 或记录更新。

认证方式：

```text
X-GIC-Storage-Key: <shared secret>
```

后续可升级 HMAC。

注意：`my_tools` 远端真实对象路径可以按用户/日期分层，但返回给 image 侧的 `cloud_object_key` 建议是 URL-safe 的 `archiveId`，不要直接返回带 `/` 的文件路径。原因是 `GET /api/internal/gic/assets/{...}` 这类路径参数遇到斜杠会带来路由和编码问题。

推荐返回：

```json
{
  "archiveId": "uuid-or-ulid",
  "objectKey": "gic-assets/image-canvas/users/123/2026/05/03/<archiveId>/asset.png",
  "requestId": "..."
}
```

image 侧只把 `archiveId` 写进 `assets.cloud_object_key`；真实 `objectKey/storage_path` 由 `my_tools` 自己保存和管理。

### 4. cloud 字段复用方式

第一版继续复用 `assets.cloud_*` 这组字段，不新增表。

`my_tools` 上传成功后：

```text
cloud_provider = "my_tools"
cloud_bucket = null 或 "my_tools"
cloud_region = null
cloud_object_key = my_tools 返回的 archiveId
cloud_status = "uploaded"
cloud_uploaded_at = 当前时间
cloud_etag = my_tools 返回的 etag，可空
cloud_request_id = my_tools 返回的 requestId
```

上传失败后：

```text
cloud_provider = "my_tools"
cloud_status = "failed"
cloud_error = 脱敏后的错误摘要
```

读取时：

```text
本地文件存在 -> 直接读本地
本地不存在 + cloud_provider=my_tools + uploaded -> 从 my_tools 拉回
拉回成功 -> 重新写入 DATA_DIR/assets 本地热缓存
```

删除时：

```text
删除本地缓存
如果 cloud_provider=my_tools -> 调 my_tools deleteObject
删除失败不阻塞 image SQLite 删除，保持和 COS 当前行为一致
```

### 5. 本地文件目录先不大改

当前本地缓存路径是：

```text
DATA_DIR/assets/<assetId>.<ext>
```

第一版不要急着改成本地按用户/日期分层，避免影响已有数据和上游合并。

长期正本路径由 `my_tools` 按用户和日期分层：

```text
<rootPrefix>/image-canvas/users/<laravelUserId>/yyyy/mm/dd/<archiveId>/<fileName>
```

image 侧只保存 `cloud_object_key`，不需要理解 Laravel 用户目录结构。

### 6. UI 配置最小改动

现有云端配置 UI 是 COS 专用。第一版可以有两种做法：

方案 A：先只用环境变量启用 `my_tools`

```env
CLOUD_STORAGE_PROVIDER=my_tools
MY_TOOLS_STORAGE_BASE_URL=
MY_TOOLS_STORAGE_SHARED_SECRET=
```

UI 仍只配置 COS。`my_tools` 作为部署级配置，不给普通用户改。

方案 B：扩展现有云端配置弹窗，增加 provider 选择

```text
腾讯 COS
my_tools 归档
```

考虑到公网部署下不希望普通 access-token 用户改全局归档配置，推荐第一版用方案 A。等权限边界和管理员配置 UI 稳定后，再做方案 B。

### 7. 本地缓存清理

第一版不需要自动清理本地文件。只要实现“本地丢失可从 my_tools 恢复”，就已经证明 `my_tools` 可以做长期正本。

后续再加清理任务：

```text
删除 cloud_status=uploaded 且本地文件超过 N 天未访问的缓存
```

注意：清理任务只删 `DATA_DIR/assets` 本地文件，不删 SQLite，不删 `my_tools` 对象。

### 8. generationId 的时机

当前代码里 `generationId` 是在所有图片保存完成后由 `saveGenerationRecord()` 创建的，而 `saveProviderImage()` 上传 cloud 时还没有 generationId。

所以第一版上传到 `my_tools` 时不要强依赖 generationId。可以先传：

```text
imageOwnerId
assetId
fileName
mimeType
width
height
createdAt
```

后续如果 `my_tools` 需要按 generation 聚合，有两个选择：

- 在 image 侧调整流程，先创建 generationId，再保存 outputs。
- 生成记录落库后再补一个 webhook/updateArchiveMetadata，把 generationId/outputId 回写到 `my_tools`。

第一版推荐先不改生成记录时序，降低破坏性。

## 和上游 provider-config 合并的兼容策略

这个设计必须和后续上游合并一起考虑。上游现在新增了 provider-config 后端和前端配置弹窗，合并时容易碰到认证/provider/storage 三类文件。

### 核心不变量

合并上游时必须保留：

```text
APP_AUTH_ENABLED=true 且当前请求是普通 access-token 用户
  -> 只能使用 access token 绑定的 upstream key/baseURL/model
  -> 不能使用 env OpenAI
  -> 不能使用本地 provider-config
  -> 不能使用 Codex fallback
```

管理员或本机模式可以使用上游 provider-config。

### 建议的 provider 选择形态

保留 request-aware 入口：

```text
createRequestImageProvider(c, signal)
```

不要退回上游那种纯全局：

```text
createConfiguredImageProvider(signal)
```

如果合并上游需要保留 `createConfiguredImageProvider`，它只能作为 admin/local 的内部 helper，不能直接用于普通用户生成接口。

### provider-config API 权限

合并上游 `/api/provider-config` 时：

- `GET /api/provider-config` 在普通 access-token 用户下要么禁止，要么只返回受限只读视图。
- `PUT /api/provider-config` 必须只允许管理员或本机模式。
- 普通用户不允许保存本地 OpenAI key。
- 普通用户不允许调整全局 provider priority。

### storage provider 与 provider-config 分离

`my_tools` storage provider 是“图片保存位置”，不是“图片生成 provider”。

不要把这两个概念混在一个 provider-config 里：

```text
image provider: access-token upstream / env openai / local openai / codex
storage provider: local cache / cos / my_tools
```

上游 provider-config 可以合并，但不能影响 `cloud_provider=my_tools` 的保存和恢复逻辑。

### 高风险合并文件

每次合并上游 provider-config 或 storage 相关改动时重点看：

```text
apps/api/src/index.ts
apps/api/src/image-provider-selection.ts
apps/api/src/storage-config.ts
apps/api/src/image-generation.ts
apps/api/src/asset-storage.ts
apps/api/src/schema.ts
packages/shared/src/index.ts
apps/web/src/App.tsx
apps/web/src/ProviderConfigDialog.tsx
apps/web/src/styles.css
```

### 合并后的验证清单

合并上游后至少验证：

- 普通 access-token 用户生成时仍使用 token 绑定 upstream。
- 普通 access-token 用户不能使用 Codex fallback。
- 普通 access-token 用户不能保存全局 provider-config。
- 管理员/本机模式仍可使用上游 provider-config。
- `cloud_provider=my_tools` 上传成功。
- 删除本地 `DATA_DIR/assets/<file>` 后，图片能从 `my_tools` 拉回。
- Gallery 删除时，会调用 `my_tools` 删除对象。
- `cloud_object_key` 使用 `archiveId` 能正常 GET/DELETE，不受对象真实路径斜杠影响。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。

## 安全要求

- 不允许浏览器请求选择 `IMAGE_BACKEND`。
- 普通用户不能调用全局 provider-config 的保存/读取接口，除非这个接口响应已经明确做成普通用户可见的受限视图。
- 不记录 upstream API key、NewAPI token、Codex token、本地 provider key、SQLite secret 或共享密钥。
- 如果使用 `MY_TOOLS_IMAGE_BASE_URL`，服务端到服务端请求必须使用共享密钥或签名请求认证。
- `my_tools` 后端不可用时要有超时和清晰错误信息。
- 一旦请求选择了 `my_tools`，不能在失败后悄悄 fallback 到 OpenAI、Codex 或全局本地配置。

## 不做的事

- 不把 image 应用的 SQLite 数据库搬到 `/opt/project/my_tools`。
- 不让 Laravel 直接读取或修改 image 应用的 Gallery/project 表。
- 不替换现有 image access-token 登录流程。
- 不允许客户端 query 参数选择上游 provider。
- 本设计不加入计费或按图片扣额度逻辑。

## 待讨论问题

- `my_tools` 以后是否真的需要暴露一个直接生成图片的接口，还是当前 access-token upstream 绑定已经足够？
- 如果增加直接生成接口，第一版是否固定返回 provider 同形态 `b64Json`，而不是临时 URL 或资产引用？
- 生成后的使用量统计是否应该由 `gpt-image-canvas` 通过 webhook 推给 `my_tools`？
- 上游 provider-config 弹窗对非管理员用户应该完全隐藏，还是显示为只读状态？
- 生产环境是否应该长期固定 `IMAGE_BACKEND=access_token`，直到出现明确运维需求后再考虑 `IMAGE_BACKEND=my_tools`？
