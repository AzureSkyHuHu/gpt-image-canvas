# my_tools 托管上游兼容计划

更新时间：2026-05-03

## 结论

`gpt-image-canvas` 当前第一版已经可以兼容 `my_tools` 接管普通用户图片生成/编辑请求。

当生产环境配置为：

```env
IMAGE_BACKEND=my_tools
MY_TOOLS_IMAGE_BASE_URL=...
MY_TOOLS_IMAGE_SHARED_SECRET=...
```

普通 access-token 用户生成/编辑图片时，`gpt-image-canvas` 不再使用 access token 中保存的真实 upstream key/baseURL/model，而是把请求转发给 `my_tools`：

```text
access-token 用户生成/编辑
  -> createRequestImageProvider()
  -> MyToolsImageProvider
  -> my_tools /api/internal/gic/images/*
  -> my_tools 解析真实上游并请求第三方
```

因此，本项目短期不需要为了 `my_tools` 新的图片上游策略做大改。真正需要修改的是 `my_tools`：它不应该再把真实上游 key 当成创建/更新 image access token 的前置条件。

## 当前兼容方式

`gpt-image-canvas` 的 admin access-token 接口当前仍要求创建 token 时提供 `upstreamApiKey`，数据库字段也是必填：

```text
access_tokens.upstream_api_key not null
CreateAccessTokenRequest.upstreamApiKey required
```

在 `IMAGE_BACKEND=my_tools` 模式下，这个字段不会参与普通用户生成/编辑请求，但仍是历史 schema 的必填字段。

推荐短期兼容方式：

```text
my_tools 创建 image access token 时传入 inert placeholder upstream key
例如：managed-by-my-tools
```

这个 placeholder 只用于满足 image 侧旧 schema，不代表真实上游凭据，也不应该被普通用户路径使用。

## 本项目需要保持的不变量

### 普通用户

当 `APP_AUTH_ENABLED=true` 且当前请求是普通 access-token 用户：

- `IMAGE_BACKEND=my_tools` 时必须走 `MyToolsImageProvider`。
- 不读取、不使用 access token 中的 upstream key/baseURL/model 发起第三方请求。
- 不使用 `OPENAI_API_KEY`。
- 不使用 `OPENAI_BASE_URL`。
- 不使用 Codex fallback。
- `imageOwnerId` 使用当前 image access token id，也就是 `currentAccessPrincipal(c).id`。

### 管理员/本机模式

当当前请求是管理员，或 `APP_AUTH_ENABLED=false`：

- 可以继续走本地 provider。
- 可以使用 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。
- 可以使用 Codex fallback。

### access-token 后台接口

短期继续保留现有 admin token schema，避免迁移风险：

- `upstreamApiKey` 仍必填。
- `upstreamApiKeyPreview` 仍显示 placeholder 的 mask。
- `upstreamBaseURL` / `upstreamModel` 可留空。

## 可选后续修改

如果希望语义更干净，可以在后续版本把 access token schema 改成支持“managed upstream”：

```text
upstream_mode=access_token | managed
upstream_api_key nullable
upstream_api_key_preview nullable
```

对应改动：

- `access_tokens.upstream_api_key` 改为 nullable。
- `CreateAccessTokenRequest.upstreamApiKey` 在 managed 模式下可空。
- admin token 列表显示“由 my_tools 管理”。
- `createRequestImageProvider()` 在 `IMAGE_BACKEND=access_token` 时才要求 principal 有真实 upstream key。
- bootstrap token 仍要求真实 upstream key，除非显式配置 managed bootstrap。

这不是第一版必需项。短期使用 placeholder 更稳，因为它不需要改 SQLite schema，也不会影响已有 access token。

## 验证建议

本项目侧验证重点：

1. `IMAGE_BACKEND=my_tools` 时，access token 里只有 placeholder key 也能生成。
2. `IMAGE_BACKEND=access_token` 时，placeholder key 不能误当真实 key 使用。
3. `IMAGE_BACKEND=local` 时，普通 access-token 用户返回 403。
4. `MY_TOOLS_IMAGE_BASE_URL` 或 shared secret 缺失时返回清晰配置错误。
5. admin/local 模式不受 `my_tools` 后端开关影响。

## 与 my_tools 的接口契约

`gpt-image-canvas` 调用 `my_tools` 的请求：

```text
POST /api/internal/gic/images/generate
POST /api/internal/gic/images/edit
Header: X-GIC-Image-Key
```

生成 JSON metadata 至少包含：

```json
{
  "imageOwnerId": "image access token id",
  "prompt": "...",
  "size": "1024x1024",
  "quality": "auto",
  "outputFormat": "png",
  "count": 1
}
```

编辑请求使用 multipart：

```text
file: reference image
metadata: JSON string
```

期望响应：

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

错误响应建议：

```json
{
  "message": "用户上游凭据未配置。"
}
```

`gpt-image-canvas` 会把非 2xx 响应转成 provider error，并展示 `message`。
