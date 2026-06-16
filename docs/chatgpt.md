# ChatGPT MCP 对接

## 适配策略

本项目采用“OAuth 优先”策略，原因是 ChatGPT 的 Connector 常见鉴权路径为 `No Auth` 或 `OAuth`，静态 Bearer 在可公开场景下有风险。

## MCP 认证与发现

服务需公开以下 endpoint（与 `/mcp` 同端口）：

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/authorize`
- `/oauth/approve`
- `/token`
- `/register`
- `/revoke`

## 连接步骤

1. ChatGPT 开发者模式下新增 app / connector
2. 填写服务器 URL：`https://gmb01.xyz/mcp`
3. 选择 OAuth
4. ChatGPT 自动注册 OAuth client 并打开授权页
5. 输入 `KB_MCP_OAUTH_PASSCODE`
6. 同意授权并返回
7. 测试工具清单与执行

## 当前 OAuth 能力

- Dynamic Client Registration：`POST /register`
- Authorization endpoint：`GET /authorize`
- Consent submit：`POST /oauth/approve`
- Token exchange：`POST /token`
- Revoke：`POST /revoke`
- PKCE：仅支持 `S256`
- Client auth：`none`
- Token store：内存存储，服务重启后失效

## ChatGPT 配置值

- MCP URL：`https://gmb01.xyz/mcp`
- Auth：`OAuth`
- Client ID/Secret：不需要手动填写，ChatGPT 会 DCR
- Owner passcode：使用环境变量 `KB_MCP_OAUTH_PASSCODE`

## 工具集建议

### 基础工具

- `list_tools`（服务标准）
- `read_file` / `write_file`
- `run_tests`
- `build_project`
- `create_preview`
- `create_share`
- `get_preview_url`

### 工具返回规范

所有工具建议返回统一结构：

```json
{
  "ok": true,
  "summary": "string",
  "jobId": "uuid",
  "previewUrl": "https://gmb01.xyz/outcome/xxx",
  "shareUrl": "https://gmb01.xyz/share/xxx/index.html",
  "artifacts": [
    "dist/index.js",
    "reports/report.html"
  ],
  "logs": "执行日志摘要"
}
```

## 安全建议

- 默认关闭高风险写工具，按需开启
- 长命令或危险命令需二次确认策略（应用层）
- 工具参数必须带 schema 校验
- 文件写入限定在工作区白名单路径

## 提示词中的工具约束

为降低模型误调工具的概率，在对话中可引导：

- 只使用某个工具名
- 必须按固定顺序执行（如先 `write_file` 再 `build_project`）
- 明确参数约束和返回判定条件
