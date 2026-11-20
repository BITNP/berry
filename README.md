# berry

网协 QQ 助手「树莓娘」及 Web 管理台。通过 `BITNP/message-gateway` 正向 WebSocket 事件流接收 OneBot 11 入站消息并经 HTTP 队列投递回复，集成小模型群聊分流、全局单上下文及子代理任务委派、Keycloak 实名身份解析、公会看板（Guild）内部接口协作及定时任务。

## 部署

复制 `.env.example` 为 `.env` 并填写配置后，使用 Docker Compose 启动：

```bash
cp .env.example .env
docker compose up -d --build
```

主要环境变量：

| 变量                                                                      | 说明                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `BERRY_PUBLIC_URL`                                                        | 对外访问地址，例如 `https://berry.example.com`                                                             |
| `BERRY_BOT_QQ`                                                            | 机器人 QQ 号                                                                                               |
| `BERRY_ALLOWED_GROUPS`                                                    | 可选群聊白名单（逗号分隔纯数字群号，留空不限制；首次启动写入 SQLite，后续可在管理台热修改）                |
| `BERRY_MAIN_*` / `BERRY_GATE_*`                                           | 主模型及门控小模型的初始配置（首次启动写入 SQLite，后续可在管理台调整）                                    |
| `BERRY_OIDC_ISSUER` / `BERRY_OIDC_CLIENT_ID` / `BERRY_OIDC_CLIENT_SECRET` | 管理台 Keycloak OIDC 登录配置（回调 `{BERRY_PUBLIC_URL}/api/auth/callback`，需 `permission-system-admin`） |
| `BERRY_KEYCLOAK_ADMIN_URL` / `BERRY_KEYCLOAK_CLIENT_*`                    | Keycloak Admin API，用于 QQ 号及成员身份双向查询                                                           |
| `BERRY_GUILD_API_URL` / `BERRY_GUILD_INTERNAL_TOKEN`                      | `guild-go` 内部服务接口（用于节点协作、SSE 事件流、到期提醒及周报）                                        |

端口默认绑定 `127.0.0.1:3220`，生产环境通过反向代理对外提供 HTTPS。运行数据（SQLite、媒体缓存、知识库 `knowledge/`、记事本 `notebooks/`）保存在 `data/` 目录。

## 本地开发

环境要求：Node.js 24+、pnpm 10+。

```bash
pnpm install
cp .env.example .env
pnpm check
pnpm test
pnpm build
node --env-file=.env src/main.ts
```

前后端分离调试（无本地 OIDC 时可临时对单次后端进程开启开发免登，切勿在生产或 `.env` 中长期开启）：

```bash
# 终端 1
BERRY_DEV_AUTH_BYPASS=true pnpm dev

# 终端 2
pnpm dev:web
```
