# API 文档

本文档描述 `gpt-image-canvas` 当前后端接口。默认服务地址按 `.env` 的 `PORT` 决定，Docker 当前通常是：

```text
http://localhost:8787
```

## 认证

当 `APP_AUTH_ENABLED=true` 时，除公开登录接口外，`/api/*` 都需要先用访问 token 登录。登录成功后服务端写入 HttpOnly Cookie，后续请求带 cookie 即可。

### 访问 token 登录

如果要给朋友一个“点开即登录”的地址，使用 GET 跳转登录：

```http
GET /api/auth/login?token=<access-token>&redirect=/
```

示例：

```text
http://localhost:8787/api/auth/login?token=<access-token>&redirect=/
```

行为：

- token 有效：写入访问 Cookie，然后 `302` 跳转到 `redirect`。
- token 无效或停用：跳转到 `redirect?auth_error=invalid_token`。
- `redirect` 只允许站内路径，例如 `/`、`/gallery`，不允许外部 URL。

如果要用脚本登录或手动调 API，也可以使用 POST：

```http
POST /api/auth/login
Content-Type: application/json
```

请求：

```json
{
  "token": "<access-token>"
}
```

示例：

```bash
curl -c .codex-temp/access.cookies \
  -H 'Content-Type: application/json' \
  -d '{"token":"<access-token>"}' \
  http://localhost:8787/api/auth/login
```

响应：

```json
{
  "authEnabled": true,
  "authenticated": true,
  "user": {
    "id": "token-row-id",
    "label": "Test access - freeapi"
  }
}
```

### 当前登录状态

```http
GET /api/auth/me
```

```bash
curl -b .codex-temp/access.cookies http://localhost:8787/api/auth/me
```

### 退出访问 token

```http
POST /api/auth/logout
```

```bash
curl -b .codex-temp/access.cookies -X POST http://localhost:8787/api/auth/logout
```

## 当前测试 Token

这三个 token 由 `scripts/seed-test-access-tokens.mjs` 创建或更新。每个访问 token 映射自己的上游 API key 和 Base URL。

```text
Test access - otokapi -> https://otokapi.com/v1
Test access - freeapi -> https://freeapi.dgbmc.top/v1
Test access - new -> http://new.xem8k5.top:3000/v1
```

重新同步 `.env` 里的三组 `OPENAI_API_KEY + OPENAI_BASE_URL`：

```bash
node scripts/seed-test-access-tokens.mjs
```

脚本首次创建 token 时会在输出里返回完整 access token；已有同名 token 时只更新上游配置，并只显示 token preview。

## 图像生成

### 文生图

```http
POST /api/images/generate
Content-Type: application/json
Cookie: gic_access_session=...
```

请求：

```json
{
  "prompt": "一张 80 年代老照片风格的山间湖泊，胶片颗粒，柔和阳光",
  "presetId": "photoreal",
  "sizePresetId": "square-1k",
  "size": {
    "width": 1024,
    "height": 1024
  },
  "quality": "auto",
  "outputFormat": "png",
  "count": 1
}
```

示例：

```bash
curl -b .codex-temp/access.cookies \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt":"一张 80 年代老照片风格的山间湖泊，胶片颗粒，柔和阳光",
    "presetId":"photoreal",
    "sizePresetId":"square-1k",
    "size":{"width":1024,"height":1024},
    "quality":"auto",
    "outputFormat":"png",
    "count":1
  }' \
  http://localhost:8787/api/images/generate
```

响应核心结构：

```json
{
  "record": {
    "id": "generation-id",
    "mode": "generate",
    "prompt": "原始提示词",
    "effectivePrompt": "合成风格后的提示词",
    "presetId": "photoreal",
    "size": { "width": 1024, "height": 1024 },
    "quality": "auto",
    "outputFormat": "png",
    "count": 1,
    "status": "succeeded",
    "createdAt": "2026-05-01T00:00:00.000Z",
    "outputs": [
      {
        "id": "output-id",
        "status": "succeeded",
        "asset": {
          "id": "asset-id",
          "url": "/api/assets/asset-id",
          "fileName": "asset-id.png",
          "mimeType": "image/png",
          "width": 1024,
          "height": 1024
        }
      }
    ]
  }
}
```

### 参考图生成

```http
POST /api/images/edit
Content-Type: application/json
```

请求在文生图字段基础上增加：

```json
{
  "referenceImage": {
    "dataUrl": "data:image/png;base64,...",
    "fileName": "reference.png"
  },
  "referenceAssetId": "optional-existing-asset-id"
}
```

`referenceAssetId` 可选；如果传入，必须是当前 token owner 下存在的本地资产。

## 生成参数

### 风格 presetId

```text
none
photoreal
product
illustration
poster
avatar
```

### 尺寸

尺寸必须满足：

```text
最小边 >= 512
最大边 <= 3840
宽高必须是 16 的倍数
长短边比例 <= 3:1
总像素范围：655,360 到 8,294,400
```

常用 `sizePresetId`：

```text
square-1k        1024x1024
poster-portrait 1024x1536
poster-landscape 1536x1024
story-9-16       1088x1920
video-16-9       1920x1088
wide-2k          2560x1440
portrait-2k      1440x2560
square-2k        2048x2048
wide-4k          3840x2160
custom           自定义
```

### 其它枚举

```text
quality: auto | low | medium | high
outputFormat: png | jpeg | webp
count: 1 | 2 | 4
```

## 项目与历史

### 读取项目

```http
GET /api/project
```

返回：

```json
{
  "id": "default-or-owner-default",
  "name": "Default Project",
  "snapshot": {},
  "history": [],
  "updatedAt": "2026-05-01T00:00:00.000Z"
}
```

### 保存项目

```http
PUT /api/project
Content-Type: application/json
```

请求：

```json
{
  "name": "Default Project",
  "snapshot": {}
}
```

### 删除生成历史

```http
DELETE /api/generations/:generationId
```

行为：

- 删除这条历史记录。
- 级联删除该历史下的 output 记录。
- 尝试删除该历史输出图片的本地文件、COS 对象和预览缓存。
- 如果图片仍被其它记录引用，会保留资源。
- 不会删除该历史使用的参考图，除非参考图本身也是该历史的输出并且没有其它引用。

示例：

```bash
curl -b .codex-temp/access.cookies \
  -X DELETE \
  http://localhost:8787/api/generations/generation-id
```

## Gallery

### 列表

```http
GET /api/gallery
```

返回：

```json
{
  "items": [
    {
      "outputId": "output-id",
      "generationId": "generation-id",
      "mode": "generate",
      "prompt": "原始提示词",
      "effectivePrompt": "合成提示词",
      "presetId": "photoreal",
      "size": { "width": 1024, "height": 1024 },
      "quality": "auto",
      "outputFormat": "png",
      "createdAt": "2026-05-01T00:00:00.000Z",
      "asset": {
        "id": "asset-id",
        "url": "/api/assets/asset-id",
        "fileName": "asset-id.png",
        "mimeType": "image/png",
        "width": 1024,
        "height": 1024
      }
    }
  ]
}
```

### 删除 Gallery 输出

```http
DELETE /api/gallery/:outputId?deleteAsset=true
```

参数：

```text
deleteAsset=false 默认，只移除 Gallery/output 记录。
deleteAsset=true  同时尝试删除本地图片文件、COS 对象和预览缓存。
```

示例：

```bash
curl -b .codex-temp/access.cookies \
  -X DELETE \
  'http://localhost:8787/api/gallery/output-id?deleteAsset=true'
```

## 资产文件

### 原图内联读取

```http
GET /api/assets/:id
```

返回图片二进制，`Content-Type` 为资源 MIME。

### 原图下载

```http
GET /api/assets/:id/download
```

返回图片二进制，并使用 attachment 下载头。

### 预览图

```http
GET /api/assets/:id/preview?width=512
```

`width` 支持服务端预设宽度，当前前端使用：

```text
256
512
1024
2048
```

## 配置

### 获取生成配置

```http
GET /api/config
```

返回当前 token 对应的模型、尺寸、风格、质量、格式、数量枚举。

### COS 配置

读取：

```http
GET /api/storage/config
```

保存：

```http
PUT /api/storage/config
Content-Type: application/json
```

测试：

```http
POST /api/storage/config/test
Content-Type: application/json
```

保存请求示例：

```json
{
  "enabled": true,
  "provider": "cos",
  "cos": {
    "secretId": "AKID...",
    "secretKey": "secret",
    "bucket": "source-1253253332",
    "region": "ap-nanjing",
    "keyPrefix": "gpt-image-canvas/assets"
  }
}
```

如果只想保存其它字段并保留已有 SecretKey：

```json
{
  "enabled": true,
  "provider": "cos",
  "cos": {
    "secretId": "AKID...",
    "preserveSecret": true,
    "bucket": "source-1253253332",
    "region": "ap-nanjing",
    "keyPrefix": "gpt-image-canvas/assets"
  }
}
```

## 管理员接口

管理员接口需要管理员登录 cookie。

### 管理员登录

```http
POST /api/admin/login
Content-Type: application/json
```

```bash
curl -c .codex-temp/admin.cookies \
  -H 'Content-Type: application/json' \
  -d '{"password":"你的 APP_ADMIN_PASSWORD"}' \
  http://localhost:8787/api/admin/login
```

### 管理员状态

```http
GET /api/admin/me
```

### 退出管理员

```http
POST /api/admin/logout
```

### 列出访问 token

```http
GET /api/admin/tokens
```

### 创建访问 token

```http
POST /api/admin/tokens
Content-Type: application/json
```

请求：

```json
{
  "label": "Friend A",
  "accessToken": "gic_friend_a_xxxxxxxxxxxx",
  "upstreamApiKey": "sk-...",
  "upstreamBaseURL": "https://freeapi.dgbmc.top/v1",
  "upstreamModel": "gpt-image-2",
  "enabled": true
}
```

`accessToken` 可省略；省略时后端自动生成一次性返回。

### 更新访问 token

```http
PATCH /api/admin/tokens/:id
Content-Type: application/json
```

请求字段均可选：

```json
{
  "label": "Friend A",
  "accessToken": "gic_friend_a_new",
  "upstreamApiKey": "sk-...",
  "upstreamBaseURL": "https://otokapi.com/v1",
  "upstreamModel": "gpt-image-2",
  "enabled": true
}
```

设置为 `null` 可清空可选字段：

```json
{
  "upstreamBaseURL": null,
  "upstreamModel": null
}
```

### 删除访问 token

```http
DELETE /api/admin/tokens/:id
```

## 错误格式

所有 JSON 错误统一返回：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "错误说明"
  }
}
```

常见状态码：

```text
400 请求参数错误
401 未登录、token 无效或管理员未登录
403 来源校验失败
404 资源不存在
409 token 重复
500 服务端异常
502 上游图像接口失败
```

## 注意事项

- 图片生成实际使用的上游配置来自当前访问 token 的映射：`upstreamApiKey + upstreamBaseURL + upstreamModel`。
- 未开启 `APP_AUTH_ENABLED` 时才直接使用 `.env` 的 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。
- 生成图片始终先写本地 `data/assets`，COS 开启后会额外上传。
- 不要把 `.env`、`data/`、SQLite 数据库或生成图片提交到 Git。
