# ChatGPT MCP 对接

## 适配策略

本项目采用“OAuth 优先”策略，原因是 ChatGPT 的 Connector 常见鉴权路径为 `No Auth` 或 `OAuth`，静态 Bearer 在可公开场景下有风险。

## ChatGPT File → Project Asset

ChatGPT 对话附件和 `image_gen` 输出与 Code-MCP server filesystem 不在同一环境；例如 ChatGPT 侧的 `/mnt/data/...` 不能直接传给 `import_project_asset_from_local_file`。现在应使用 `promote_conversation_file_to_project`：

```text
用户上传 / image_gen
  → ChatGPT connector file reference
  → promote_conversation_file_to_project({ projectId, file, relativePath })
  → assets/hero.png
```

工具声明了 ChatGPT Apps SDK 的 `_meta["openai/fileParams"]: ["file"]`。ChatGPT 会把顶层 `file` 字段作为文件引用传入，形状为 `download_url`、`file_id`、可选 `mime_type`/`file_name`；这与 [OpenAI Apps SDK 文件输入参考](https://developers.openai.com/plugins/reference#define-file-inputs) 的契约一致。模型不需要读取原始 bytes，也不需要 Base64。Code-MCP 只接受 connector 提供的受控 HTTPS 下载引用，不接受 `/mnt/data`、`file:///` 或模型自造的本地路径。

Promotion 是 lossless transfer，不是 image optimization：源文件流会在 server 端边传边 hash，写入同目录临时文件，完成后才原子替换；返回 `sourceSha256`、`destinationSha256`、`byteExact`、`qualityPreserved`、`transformed` 以及图片尺寸/格式。默认不 resize、recompress、PNG/JPEG → WebP、crop 或改变 alpha。需要生产压缩时，另行调用显式的 `optimize_project_assets` 工作流。

来源路由：

- 对话附件 / `image_gen` / connector file reference：`promote_conversation_file_to_project`
- 已在 Code-MCP server 上的文件：`import_project_asset_from_local_file`
- 安全的可达 HTTPS URL：`import_project_asset_from_url`
- 旧 Base64/raw compatibility：`write_project_asset`

相关环境变量：`CONVERSATION_FILE_MAX_BYTES`（默认 `100MiB`）和 `FILE_TRANSFER_TIMEOUT_MS`（默认 5 分钟）。普通图片/文档资产上限为 `100MiB`，PPTX 为 `25MiB`、ZIP 为 `50MiB`；这些限制只会拒绝超限文件，不会自动缩放或重编码。旧 `express.json({ limit: "40mb" })` 只约束传统 JSON/Base64 请求；native file reference 不把大文件放入 JSON。SVG 仍按既有安全规则拒绝脚本、外部资源和事件处理器，不会静默清洗后冒充 byte-exact。

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
