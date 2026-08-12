# 快速设置

本页包含项目的“从 0 到可运行”的最小步骤。

## 前置条件

1. Node.js 运行环境
2. 可访问的域名 `gmb01.xyz`
3. Cloudflare 账号及 tunnel 管理权限
4. ChatGPT 账号满足开发者模式使用要求（视你的账号层级而定）

## 本地服务启动

1. 克隆仓库并进入项目目录
2. 安装依赖：`npm install`
3. 配置环境变量（见下）
4. 开发模式启动：`npm run dev`
5. 生产构建：`npm run build && npm start`

## Docker 启动

如果希望用容器管理服务：

```bash
cp .env.docker.example .env.docker
npm run docker:up
curl -sS http://127.0.0.1:6859/health
```

常用管理命令：

- `npm run docker:logs`
- `npm run docker:down`
- `npm run docker:build`

完整说明见 [Docker 部署](./docker.md)。

## 必要配置示例

```bash
export PORT=6859
export KB_MCP_OAUTH_ENABLED=1
export KB_MCP_OAUTH_ISSUER=https://gmb01.xyz
export KB_MCP_OAUTH_PASSCODE=<强随机口令>
export KB_MCP_HTTP_KEY=<高熵静态密钥，可选>
export ADMIN_SESSION_SECRET=<随机字符串>
export MCP_DEV_TOKEN=<本地验证用-token>
export PUBLIC_BASE_URL=https://gmb01.xyz
export CONTENT_BASE_URL=https://content.gmb01.xyz
export WORKSPACE_ROOT=/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT
export SHARE_ROOT=/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT/.shares
export TOOL_STATE_PATH=/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT/.state/tool-state.json
export COMMAND_TIMEOUT_MS=30000
export CONVERSATION_FILE_MAX_BYTES=100MiB
export FILE_TRANSFER_TIMEOUT_MS=300000
export MCP_RATE_LIMIT_MAX_REQUESTS=100
export MCP_RATE_LIMIT_WINDOW_MS=60000
export JOB_WORKER_CONCURRENCY=5
export JOB_BROWSER_CONCURRENCY=2
export JOB_BUILD_CONCURRENCY=2
export JOB_AUDIO_CONCURRENCY=1
export JOB_MAX_CONCURRENT_PER_USER=2
export JOB_LEASE_MS=30000
export JOB_HEARTBEAT_MS=2000
```

> 建议使用 `http.env` 或你的密钥管理系统，不要把敏感值写进 git。

## 验证步骤

1. 启动服务后先本地连通：
   - `curl -sS http://127.0.0.1:6859/health`
2. 验证 MCP 入口：
   - `curl -i -X POST http://127.0.0.1:6859/mcp -H "content-type: application/json" -H "authorization: Bearer $MCP_DEV_TOKEN" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'`
3. 验证 OAuth 发现：
   - `curl -sS http://127.0.0.1:6859/.well-known/oauth-protected-resource/mcp`
   - `curl -sS http://127.0.0.1:6859/.well-known/oauth-authorization-server`

## ChatGPT 接入（简版）

1. 开启 ChatGPT 开发者模式并创建 App（远程 MCP）
2. 填入 MCP URL：`https://gmb01.xyz/mcp`
3. 选择 OAuth（DCR 自动注册）
4. 完成授权后验证可调用工具

当前实现说明：

- 已提供 OAuth discovery、DCR、authorization code、PKCE、access token、refresh token 与 revoke。
- OAuth 状态当前存在内存中，服务重启后 ChatGPT 需要重新授权。
- `MCP_DEV_TOKEN` 仍可用于本地 curl 调试；ChatGPT 连接应使用 OAuth。
- `/mcp` 对每个已认证用户/客户端执行内存限流，默认每 60 秒 100 次；超限返回 `429` 和 `Retry-After`。

## 结果链接

约定返回：

- `ok`：是否成功
- `jobId`：任务 ID
- `previewUrl`：如 `https://gmb01.xyz/outcome/<jobId>`
- `shareUrl`：如 `https://gmb01.xyz/share/<id>/index.html`
- `summary`：执行摘要
