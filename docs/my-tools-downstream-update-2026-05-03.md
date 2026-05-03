# my_tools 下游变更通知：NewAPI 多分组上游与自动降级

状态：给 `gpt-image-canvas` 侧的对接备忘
日期：2026-05-03

## 一句话

`/opt/project/my_tools` 已经可以作为 `gpt-image-canvas` 的图片生成/编辑下游后端：image 侧只负责登录态、画布、Gallery、历史和本地资产缓存；真实 OpenAI 兼容上游请求由 `my_tools` 选择 NewAPI 分组 token 后发出。

## my_tools 已实现的能力

Laravel 侧已经落地：

- `POST /api/internal/gic/images/generate`
- `POST /api/internal/gic/images/edit`
- `POST /api/internal/gic/images/test`
- 根据 `imageOwnerId` 反查 `tool_accesses.external_subject_id`
- 为同一个 Laravel 用户/ToolAccess 创建和补齐 NewAPI 多分组 token
- 分组包括 `vip`、`plus`、`default`
- 当前运行选择策略是 `vip -> default`
- `plus` 已建模和补齐，但默认不参与 fallback 链
- 当上游返回 `503` 且错误包含 `无可用账号，请稍后重试` 时，当前分组会熔断 1 小时
- `vip` 熔断后会自动切到 `default` 重试一次
- 旧 image access token 不删除重建，Gallery/历史 owner 保持不变

对应 Laravel 提交：

```text
ce48cc0 Add NewAPI multi-group upstream fallback
ea49c80 Harden NewAPI fallback during credential sync
```

## image 侧应如何使用

生产推荐：

```env
IMAGE_BACKEND=my_tools
MY_TOOLS_IMAGE_BASE_URL=http://piachi-tools.test.com
MY_TOOLS_IMAGE_SHARED_SECRET=<same-secret-as-my_tools>
```

如果本地 Docker 内网互通，`MY_TOOLS_IMAGE_BASE_URL` 可以使用容器内地址；如果 image 容器只能经 Nginx 访问，则使用 Laravel 站点地址。

image 侧普通 access-token 用户在 `IMAGE_BACKEND=my_tools` 时：

- 不使用 `OPENAI_API_KEY`
- 不使用 `OPENAI_BASE_URL`
- 不使用 image 应用全局 provider config
- 不使用 Codex fallback
- 只把已认证用户的 `imageOwnerId`、请求参数和参考图片 bytes 发给 `my_tools`

管理员/本机开发模式可以继续保留原来的 local/env/provider 路径。

## 内部接口约定

### 认证

请求头：

```text
X-GIC-Image-Key: <shared-secret>
```

Laravel 当前也兼容 `X-GIC-Storage-Key`，但 image 生成/编辑请求建议使用 `X-GIC-Image-Key`。

### 生成

```text
POST /api/internal/gic/images/generate
Content-Type: application/json
```

请求：

```json
{
  "imageOwnerId": "gpt-image-canvas access token subject/id",
  "prompt": "a small cabin",
  "size": "1024x1024",
  "quality": "auto",
  "outputFormat": "png",
  "count": 1
}
```

响应：

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

### 编辑

```text
POST /api/internal/gic/images/edit
Content-Type: multipart/form-data
```

字段：

```text
file      reference image，支持 png/jpeg/webp
metadata  JSON 字符串
```

`metadata` 示例：

```json
{
  "imageOwnerId": "gpt-image-canvas access token subject/id",
  "prompt": "turn it into a watercolor poster",
  "size": "1024x1024",
  "quality": "auto",
  "outputFormat": "png",
  "count": 1
}
```

响应与生成接口一致。

## 错误和降级行为

image 侧不需要知道 `vip/default` 具体选择结果。它只需要按普通上游错误处理即可。

Laravel 侧行为：

```text
使用 vip 请求 NewAPI
  -> 成功：返回 b64Json
  -> 503 + 无可用账号，请稍后重试：
       vip 熔断 1 小时
       改用 default 重试一次
  -> default 成功：返回 b64Json
  -> default 也失败：返回错误
  -> 其他错误：不自动降级，返回错误
```

Laravel 返回错误时通常是：

```json
{
  "message": "错误信息"
}
```

HTTP status 通常是 `502`。image 侧可以把 `message` 显示给用户或按现有 generation error 流程记录。

## imageOwnerId 要求

`imageOwnerId` 必须是 image 当前登录 access token 的 owner/subject/id，也就是 Laravel 保存到：

```text
tool_accesses.external_subject_id
```

不要传 Laravel user id。
不要让浏览器自己传任意 owner id。
image API 服务端应从当前认证上下文里取 owner id，再转发给 `my_tools`。

## 与 my_tools 云存储的关系

这是两条独立边界：

```text
IMAGE_BACKEND=my_tools           生成/编辑请求由 my_tools 发给上游
CLOUD_STORAGE_PROVIDER=my_tools  生成后的图片正本归档到 my_tools
```

推荐生产组合：

```env
IMAGE_BACKEND=my_tools
CLOUD_STORAGE_PROVIDER=my_tools
```

但二者可以单独启用。生成请求走 `my_tools` 不代表 image 可以跳过 Gallery、本地缓存或历史记录。

## my_tools 后台和维护

Laravel 侧新增了：

- `tool_access_upstream_credentials` 表
- Filament 上游凭据管理入口
- `php artisan gic:sync-upstream-credentials`

补齐旧用户凭据的命令应在 Laravel/PHP 容器里运行：

```bash
docker exec php82 sh -lc 'cd /www/my_tools && php artisan gic:sync-upstream-credentials'
```

image 侧不需要读取这张表，也不要读取 Laravel 数据库。

## 对 image 侧实现的最低要求

如果 image 侧已经有 `IMAGE_BACKEND=my_tools`，请核对：

- 生成接口使用 JSON POST 到 `/api/internal/gic/images/generate`
- 编辑接口使用 multipart POST 到 `/api/internal/gic/images/edit`
- 请求头带 `X-GIC-Image-Key`
- `imageOwnerId` 来自当前 access token 认证上下文
- 响应里的 `images[].b64Json` 继续走现有资产保存/Gallery/历史流程
- 普通 access-token 用户不再使用 image 本地 OpenAI provider

这样 image 侧保持薄转发，NewAPI 分组、熔断、fallback、旧用户兼容都由 `my_tools` 负责。
