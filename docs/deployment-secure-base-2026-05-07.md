# secure-base 主线部署说明

日期：2026-05-07
目标分支：`main`
目标提交：`4e19dd7`（`接入 my_tools Agent 后端`）
旧主线备份分支：`backup/origin-main-before-secure-base-20260507`

## 背景

本次发布将 `sync-upstream-secure-base` 作为新的 `origin/main`。旧 `origin/main` 已在远端保留为备份分支，便于发现生产问题时快速回滚。

当前主线以 `upstream/main` 的新代码结构为底座，同时保留本 fork 的 access-token 鉴权、租户隔离、`my_tools` 图片后端、`my_tools` Agent LLM 后端和可选资产归档能力。

## 上线前检查

在部署机器上确认当前代码已经拉到新的 `main`：

```sh
git fetch origin
git switch main
git reset --hard origin/main
git show --quiet --oneline HEAD
```

期望 HEAD 为：

```text
4e19dd7 接入 my_tools Agent 后端
```

真实 `.env` 存在时，只使用不会展开密钥的 Compose 配置检查：

```sh
docker compose config --quiet --no-env-resolution
```

不要运行普通 `docker compose config`，避免把 `.env` 中的密钥展开到终端或日志。

## 环境变量

基础运行：

- `PORT`：默认 `8787`。
- `HOST`：Docker Compose 内固定为 `0.0.0.0`，本地 `.env.example` 默认是 `127.0.0.1`。
- `DATA_DIR`：Docker Compose 内固定为 `/app/data`，宿主机挂载 `./data:/app/data`。
- `SQLITE_JOURNAL_MODE`：Docker Compose 默认 `DELETE`。
- `SQLITE_LOCKING_MODE`：Docker Compose 默认 `EXCLUSIVE`。

生产鉴权：

- `APP_AUTH_ENABLED=true`：启用 access-token 登录。
- `APP_SESSION_SECRET`：必须使用至少 32 字符的随机值。
- `APP_ADMIN_PASSWORD`：管理员登录密码。
- `APP_BOOTSTRAP_ACCESS_TOKEN`：首次启动可注入一个普通用户 access token。
- `APP_MAX_ASSETS_PER_TOKEN`：限制单个 access token 保存资产数量。

图片后端：

- `IMAGE_BACKEND=access_token`：普通用户使用 access token 绑定的 upstream 凭据。
- `IMAGE_BACKEND=my_tools`：普通用户图片生成/编辑转发到 `my_tools`。
- `IMAGE_BACKEND=local`：普通用户不可使用图片生成；管理员/本机模式仍可使用本地配置 provider。

Agent LLM 后端：

- `AGENT_LLM_BACKEND=local`：使用应用内 Agent LLM 配置。
- `AGENT_LLM_BACKEND=my_tools`：普通用户 Agent planning 转发到 `my_tools`；管理员/本机模式仍使用本地 Agent LLM。

`my_tools` 集成：

- `MY_TOOLS_BASE_URL`
- `MY_TOOLS_AGENT_SHARED_SECRET`
- `MY_TOOLS_IMAGE_SHARED_SECRET`
- `MY_TOOLS_STORAGE_SHARED_SECRET`

可选资产归档：

- `CLOUD_STORAGE_PROVIDER=my_tools`：新资产上传到 `my_tools`，本地文件作为热缓存。
- 留空时只使用本地 `DATA_DIR/assets`。

所有密钥只能来自 `.env` 或运行时环境。不要把真实密钥写入 Git、部署文档、终端日志或 issue 评论。

## 数据备份

部署前建议备份宿主机 `data/` 目录。该目录包含 SQLite 数据库、生成图片、本地 provider 配置、Agent LLM 配置、COS 配置和 Codex OAuth token 记录，属于敏感运行数据。

示例：

```sh
mkdir -p .codex-temp/backups
tar -czf .codex-temp/backups/gpt-image-canvas-data-$(date +%Y%m%d-%H%M%S).tar.gz data
```

`.codex-temp/` 和 `data/` 都不要提交。

## 部署步骤

构建并启动一体化应用容器：

```sh
docker compose up --build -d
```

确认容器状态：

```sh
docker ps --filter name=gpt_image_canvas_app
docker logs --tail=120 gpt_image_canvas_app
```

默认访问地址：

```text
http://localhost:8787
```

如果 `.env` 中设置了其他 `PORT`，以实际端口为准。

## 发布后验证

基础验证：

- 打开 `http://localhost:8787`。
- `APP_AUTH_ENABLED=true` 时，确认未登录用户进入登录页。
- 使用管理员或 bootstrap access token 登录后，应直接进入画布。
- 刷新页面后已有会话不应闪回登录页。

图片生成验证：

- `IMAGE_BACKEND=my_tools` 时，普通用户生成图片应由 `my_tools` 接管。
- `IMAGE_BACKEND=access_token` 时，普通用户生成图片应使用 access token 绑定的 upstream 凭据。
- 普通用户不能读取或修改全局 provider 配置。

Agent 验证：

- 普通用户执行 Agent plan 时，图片生成/编辑必须遵守与手动生成相同的 `IMAGE_BACKEND` 权限边界。
- `AGENT_LLM_BACKEND=my_tools` 时，普通用户 Agent planning 应转发到 `my_tools`。
- Agent WebSocket 断开重连后，不应跨 access token 恢复其他用户的 run。

资产验证：

- Gallery 只显示当前 owner 的资产。
- 资产预览、下载、删除都必须按 owner 隔离。
- `CLOUD_STORAGE_PROVIDER=my_tools` 时，新资产应上传归档；本地文件缺失时应可通过服务端资产入口回源。

## 工具链验证

仓库工具链验证使用 dnmp 中已有的 `node` 容器：

```sh
docker exec -w /www/python_project/gpt-image-canvas node pnpm typecheck
docker exec -w /www/python_project/gpt-image-canvas node pnpm build
```

本次主线替换前已执行上述两项检查并通过。`pnpm build` 仅出现 Vite chunk size 警告，不影响构建结果。

## 回滚

如果新主线发布后出现不可接受的问题，可先把旧主线备份分支恢复为 `main`：

```sh
git fetch origin
git push origin backup/origin-main-before-secure-base-20260507:main --force-with-lease
```

然后在部署机器拉回旧主线并重建：

```sh
git fetch origin
git switch main
git reset --hard origin/main
docker compose up --build -d
```

如果问题涉及数据迁移或运行时写入，优先结合部署前的 `data/` 备份一起恢复。不要在未确认数据兼容性的情况下反复切换新旧版本写同一份 SQLite 数据。

## 运维注意事项

- 不要公开暴露未加网络访问控制的本地应用。
- 不要提交 `.env`、`data/`、SQLite 数据库、生成图片、`.ralph/`、`.codex-temp/` 或构建产物。
- 日志中不应出现 OpenAI key、access token、Codex token、COS secret 或 `my_tools` shared secret。
- `my_tools` 图片后端、Agent LLM 后端和资产归档是三条独立链路，排障时分别检查对应的 shared secret、网络和错误响应。
- Docker Compose 依赖外部网络 `dnmp-infra`，如网络不存在，需要先启动 dnmp 基础环境。
