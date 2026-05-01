# Docker 部署文档

本文档记录当前项目在小服务器上的 Docker Compose 部署方式。默认配置适合放到已有反向代理网络后面使用，例如同一台机器上的 Nginx、Caddy、Traefik 或 DNMP 网络。

## 部署前准备

服务器需要：

- Docker Engine 和 Docker Compose。
- 一个可写的项目目录。
- 一个 `.env` 文件保存运行时配置和密钥。
- 如果要接入已有反向代理，需要一个外部 Docker 网络，默认名为 `dnmp-infra`。

首次部署：

```sh
cp .env.example .env
mkdir -p data
```

如果默认外部网络不存在，可以创建：

```sh
docker network create dnmp-infra
```

已经有自己的反向代理网络时，在 `.env` 中覆盖：

```env
APP_DOCKER_NETWORK=your-proxy-network
```

## 必填配置

公网部署前建议至少设置：

```env
PORT=8787
APP_AUTH_ENABLED=true
APP_ADMIN_PASSWORD=replace-with-a-long-admin-password
APP_SESSION_SECRET=replace-with-at-least-32-random-characters
OPENAI_API_KEY=replace-with-upstream-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_MODEL=gpt-image-2
```

说明：

- `APP_AUTH_ENABLED=true` 会要求访问 token 登录，避免公网裸奔。
- `APP_ADMIN_PASSWORD` 用于登录管理员面板，创建和管理朋友访问 token。
- `APP_SESSION_SECRET` 用于签名登录 Cookie，开启鉴权时至少 32 个字符。
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` 是未开启鉴权时的默认上游；开启鉴权后，图片生成优先使用当前访问 token 映射的上游 key、URL 和模型。
- `.env.example` 默认已经设置 `APP_AUTH_ENABLED=true`。如果只是本地单人开发，可以临时改成 `false`，但公网部署不要关闭。

可以生成本地随机值：

```sh
openssl rand -base64 32
```

## 启动和更新

验证 Compose 配置时不要打印展开后的 `.env`：

```sh
docker compose config --quiet
```

构建并启动：

```sh
docker compose up -d --build
```

查看状态：

```sh
docker compose ps
docker compose logs -f app
```

更新代码后重新构建：

```sh
git pull
docker compose up -d --build
```

当前 Compose 会固定容器名，默认是 `gpt_image_canvas_app`。如果同一台机器要部署多份，在 `.env` 中设置：

```env
APP_CONTAINER_NAME=gpt_image_canvas_app_2
PORT=8788
```

## 反向代理

容器默认监听内部 `8787`，并通过 `${PORT:-8787}` 映射到宿主机。反向代理可以转发到：

```text
http://gpt_image_canvas_app:8787
```

如果你的反向代理不在同一个 Docker 网络，也可以转发到宿主机：

```text
http://127.0.0.1:8787
```

仓库提供了一份 Nginx 示例配置：

```text
deploy/nginx/gpt-image-canvas.conf
```

复制到 Nginx 的 `conf.d` 或站点配置目录后，把 `image.example.com` 替换成自己的域名。配置里默认把请求转发到同 Docker 网络里的 `gpt_image_canvas_app:8787`。

图片编辑和画布保存可能包含较大的 base64 数据，反向代理需要允许较大的请求体；上例设置为 `120m`。

## 访问 token

浏览器打开站点后，如果未登录会出现访问 token 输入框。管理员可以在登录页展开管理员面板，用 `.env` 中的 `APP_ADMIN_PASSWORD` 登录，然后创建访问 token。

每个访问 token 可以绑定自己的：

- 上游 API key。
- 上游 Base URL。
- 上游图像模型。
- 启用/停用状态。

也可以用接口管理，详见 [API 文档](api.md)。

如果 `.env` 中连续写了多组 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`，可以用脚本创建或更新测试映射：

```sh
node scripts/seed-test-access-tokens.mjs
```

脚本需要服务已经运行，并且会通过管理员接口写入 token 映射。

## 数据和备份

运行时数据保存在宿主机：

```text
./data
```

里面包含 SQLite 数据库和生成图片。备份时停止容器再复制目录：

```sh
docker compose stop app
cp -a data "data-backup-$(date +%Y%m%d-%H%M%S)"
docker compose up -d
```

不要提交：

- `.env`
- `data/`
- 生成图片
- SQLite 数据库
- Docker 展开的配置输出

## Compose 说明

当前 `docker-compose.yml` 做了这些部署向配置：

- `container_name` 默认固定为 `gpt_image_canvas_app`，便于反向代理引用。
- `APP_CONTAINER_NAME` 可以覆盖容器名；如果改了容器名，Nginx upstream 里的容器名也要同步修改。
- `restart: always`，宿主机重启或容器异常退出后自动拉起。
- `extra_hosts: host.docker.internal:host-gateway`，容器内可访问宿主机服务。
- `./data:/app/data` 持久化运行时数据。
- 外部网络默认使用 `dnmp-infra`，可通过 `APP_DOCKER_NETWORK` 覆盖。
- Docker 中默认设置 `SQLITE_JOURNAL_MODE=DELETE` 和 `SQLITE_LOCKING_MODE=EXCLUSIVE`，减少绑定挂载目录上的 SQLite 共享内存问题。

如果不需要外部网络，可以把 `networks` 相关配置改成 Compose 默认网络；公网反代部署一般建议保留外部网络。

## 常见问题

`docker compose config --quiet --no-env-resolution` 不支持：

有些 Docker Compose 版本没有 `--no-env-resolution`。可以只运行：

```sh
docker compose config --quiet
```

注意不要把普通 `docker compose config` 的完整输出发到公开场合，因为它可能展开 `.env` 里的密钥。

容器启动后访问不到：

- 检查 `docker compose ps` 里端口是否映射到预期 `PORT`。
- 检查反向代理是否和容器在同一个 Docker 网络。
- 检查服务器防火墙是否开放了反向代理端口。

开启鉴权后启动失败：

- `APP_SESSION_SECRET` 必须至少 32 个字符。
- `APP_ADMIN_PASSWORD` 为空时管理员接口不可用，无法在 UI 创建访问 token。

生成失败：

- 检查当前登录 token 的上游 API key、Base URL 和模型。
- 管理员面板里确认 token 没有被停用。
- 查看 `docker compose logs -f app`，但不要把包含密钥的日志公开。
