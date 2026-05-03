# 从 origin/main 部署到 my_tools 托管上游版本

更新时间：2026-05-03

## 对比基线

本文档按当前分支相对远程主支生成：

```text
base: origin/main c71b220 fix: route existing sessions straight to canvas
target: my-tools-storage-design
```

当前分支新增了两类能力：

- 图片生成/编辑请求可以由 `my_tools` 托管。
- 生成图片可以可选归档到 `my_tools` 云端存储。

同时修复了 Docker 内访问 `piachi-tools.test.com` 的容器域名解析问题。

## 主要差异

### 1. 图片生成后端分流

新增环境变量：

```env
IMAGE_BACKEND=access_token
MY_TOOLS_IMAGE_BASE_URL=http://piachi-tools.test.com
MY_TOOLS_IMAGE_SHARED_SECRET=
```

模式说明：

```text
access_token  普通 access-token 用户使用 token 中绑定的 upstream key/baseURL/model。
my_tools      普通 access-token 用户把生成/编辑请求转发给 my_tools。
local         只允许管理员/本机模式使用本应用的本地 provider。
```

生产接入 `my_tools` 时建议：

```env
IMAGE_BACKEND=my_tools
MY_TOOLS_IMAGE_BASE_URL=http://piachi-tools.test.com
MY_TOOLS_IMAGE_SHARED_SECRET=<与 my_tools 的 GIC_IMAGE_SHARED_SECRET 相同>
```

当 `IMAGE_BACKEND=my_tools` 时，普通用户路径不会使用 access token 里的真实 upstream key。`my_tools` 可以只给 image access token 传占位 key，例如：

```text
managed-by-my-tools
```

### 2. my_tools 归档存储

新增环境变量：

```env
CLOUD_STORAGE_PROVIDER=
MY_TOOLS_STORAGE_BASE_URL=http://piachi-tools.test.com
MY_TOOLS_STORAGE_SHARED_SECRET=
```

启用方式：

```env
CLOUD_STORAGE_PROVIDER=my_tools
MY_TOOLS_STORAGE_BASE_URL=http://piachi-tools.test.com
MY_TOOLS_STORAGE_SHARED_SECRET=<与 my_tools 的 GIC_STORAGE_SHARED_SECRET 相同>
```

行为：

- 图片仍先写入本地 `DATA_DIR/assets`，作为热缓存。
- 上传成功后，`assets.cloud_provider` 保存 `my_tools`。
- `assets.cloud_object_key` 保存 `my_tools` 返回的 `archiveId`。
- 本地文件缺失时，会从 `my_tools` 回源。
- 删除 Gallery/资产时，会尝试删除 `my_tools` 归档；失败不阻断本地删除。

### 3. Docker 域名解析

`docker-compose.yml` 新增：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
  - "piachi-tools.test.com:host-gateway"
```

原因：image 容器里 Node 需要访问 `MY_TOOLS_IMAGE_BASE_URL`。如果容器无法解析 `piachi-tools.test.com`，生成会秒失败，前端显示：

```text
fetch failed
```

容器内错误通常是：

```text
ENOTFOUND getaddrinfo ENOTFOUND piachi-tools.test.com
```

如果部署环境使用其他 `my_tools` 域名，需要把 `piachi-tools.test.com` 替换成实际域名，或者把 `MY_TOOLS_IMAGE_BASE_URL` 改成 Docker 网络内可解析的服务名。

## 部署步骤

### 1. 拉取代码

```sh
git fetch origin
git checkout main
git pull --ff-only origin main
```

如果当前机器是从功能分支部署，可以先合并后再部署：

```sh
git merge --ff-only my-tools-storage-design
```

### 2. 更新 `.env`

最小配置示例：

```env
APP_AUTH_ENABLED=true
IMAGE_BACKEND=my_tools
MY_TOOLS_IMAGE_BASE_URL=http://piachi-tools.test.com
MY_TOOLS_IMAGE_SHARED_SECRET=<shared-secret>
```

如果同时启用 `my_tools` 归档存储：

```env
CLOUD_STORAGE_PROVIDER=my_tools
MY_TOOLS_STORAGE_BASE_URL=http://piachi-tools.test.com
MY_TOOLS_STORAGE_SHARED_SECRET=<shared-secret>
```

如果只测试图片生成托管，不启用归档存储，保持：

```env
CLOUD_STORAGE_PROVIDER=
```

### 3. 验证 Compose 配置

不要使用会展开并打印 `.env` 的完整配置输出。

推荐：

```sh
docker compose config --quiet
```

有些 Docker Compose 版本不支持：

```sh
docker compose config --quiet --no-env-resolution
```

遇到 `unknown flag: --no-env-resolution` 时，使用 `docker compose config --quiet` 即可。

### 4. 重新构建并启动

必须重新构建镜像，不能只重启旧容器：

```sh
docker compose up -d --build
```

如果只改了 `extra_hosts`，需要重新创建容器让 `/etc/hosts` 生效：

```sh
docker compose up -d --force-recreate
```

### 5. 验证容器内代码版本

确认容器内 API dist 已包含 `my_tools` provider：

```sh
docker exec gpt_image_canvas_app sh -lc \
  'grep -R "createMyToolsImageProvider\|MY_TOOLS_IMAGE_BASE_URL\|IMAGE_BACKEND" -n /app/apps/api/dist | head -50'
```

应能看到：

```text
/app/apps/api/dist/image-provider-selection.js
/app/apps/api/dist/index.js
```

### 6. 验证容器到 my_tools 连通性

```sh
docker exec gpt_image_canvas_app sh -lc 'getent hosts piachi-tools.test.com'
```

应返回宿主机网关 IP。

再测试 `my_tools` 内部 image backend：

```sh
docker exec gpt_image_canvas_app sh -lc \
  'node -e "fetch(process.env.MY_TOOLS_IMAGE_BASE_URL + \"/api/internal/gic/images/test\", { method: \"POST\", headers: { \"X-GIC-Image-Key\": process.env.MY_TOOLS_IMAGE_SHARED_SECRET || process.env.MY_TOOLS_STORAGE_SHARED_SECRET || \"\" } }).then(async r => { console.log(r.status); console.log(await r.text()) }).catch(e => { console.error(e); process.exit(1) })"'
```

成功结果：

```text
200
{"ok":true,"message":"my_tools image backend is available."}
```

## 生成链路验证

从 `my_tools` 进入图片工具后，点击生成。

应该在 `my_tools` Nginx access log 看到：

```text
POST /api/internal/gic/images/generate
```

编辑图片时应该看到：

```text
POST /api/internal/gic/images/edit
```

常用日志：

```sh
tail -f /opt/dnmp_other/logs/nginx/nginx.piachi-tools.access.log
docker logs -f gpt_image_canvas_app
docker exec php82 sh -lc 'cd /www/my_tools && tail -f storage/logs/laravel.log'
```

如果 `my_tools` 后台策略是 `global`，请求进入 Laravel 后应由 `ImageUpstreamCredentialResolver` 解析出全局凭据。是否走全局只能在 `/api/internal/gic/images/generate` 进入 `my_tools` 之后判断；如果 Nginx 看不到该请求，优先排查 image 容器 DNS、网络和 shared secret。

## 常见故障

### 前端提示 fetch failed

通常是 image 容器无法访问 `MY_TOOLS_IMAGE_BASE_URL`。

检查：

```sh
docker exec gpt_image_canvas_app sh -lc 'getent hosts piachi-tools.test.com'
```

如果没有解析结果，修改 `docker-compose.yml` 的 `extra_hosts` 后重建容器：

```sh
docker compose up -d --force-recreate
```

### Nginx 没有 generate/edit 请求

说明请求没有到达 `my_tools`。排查顺序：

1. image 容器内是否有新代码。
2. `IMAGE_BACKEND` 是否为 `my_tools`。
3. `MY_TOOLS_IMAGE_BASE_URL` 是否容器内可解析。
4. `/api/internal/gic/images/test` 是否返回 200。
5. 当前浏览器是否通过普通 access token 登录，而不是管理员/本机路径。

### 请求进入 my_tools 后报上游错误

这时才排查 `my_tools` 策略：

- `global`：检查 `image_global_api_key`、`image_global_base_url`、`image_global_model`。
- `personal + newapi`：检查 NewAPI 面板配置。
- `personal + manual`：检查用户级 `tool_access_upstream_credentials`。
- `personal + supapi`：第一版预留，未实现时会返回清晰错误。

## 回滚

如果需要回滚到远程主支：

```sh
git checkout main
git reset --hard origin/main
docker compose up -d --build
```

回滚前请确认 `data/` 已备份。不要删除 `data/`，其中包含 SQLite 数据库和生成图片。

如果只想临时停用 `my_tools` 图片生成代理，可以改回：

```env
IMAGE_BACKEND=access_token
```

然后重启容器：

```sh
docker compose up -d --force-recreate
```
