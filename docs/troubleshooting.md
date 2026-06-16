# 故障排查

## 1) ChatGPT 连接失败

### 症状：无法完成 OAuth

- 检查 `.well-known` endpoint 可访问
- 检查 redirect URI 与服务地址一致
- 检查 `KB_MCP_OAUTH_PASSCODE` 有效
- 检查 ChatGPT 是否选择 `OAuth` 而不是 `No Auth`
- 检查服务是否重启过；当前 token/client/code 状态是内存存储，重启后需重新连接

### 症状：提示 MCP 不兼容

- 检查 MCP 接口返回 `initialize` 与 `tools/list`
- 检查 transport（Streamable HTTP 或 SSE）是否与客户端一致
- 检查 tool schema JSON 严格有效

## 2) 403 但服务本身健康

- 若有 Ray ID / 拒绝页，多数是 Cloudflare 边缘规则
- 排查：Zone Dashboard → Security → Events（按 Ray ID）
- 处理原则：对 `gmb01.xyz` 做 host 级豁免，优先避免把 MCP 域名套进严格 bot/geo 限制

## 3) 任务结果链接不可访问

- 检查 cloudflared ingress 和路由
- 检查 `/outcome/{jobId}` 是否过期清理
- 检查服务端端口与进程状态

## 4) 工具执行慢/超时

- 检查命令超时限制
- 检查并发执行上限
- 检查工作目录 I/O、依赖下载或网络访问

## 典型快速自检清单（5 分钟）

- `GET /health` OK
- `/well-known` endpoint OK
- `/mcp` 未授权返回 401
- 授权后 `tools/list` 可拿到工具
- 任一安全工具（如 `run_tests`）返回结构化结果
- `outcome` 路径返回预览页
