# 运维与治理

## 上线前检查

1. 环境变量不含明文密钥
2. OAuth 发现与注册端点返回可解析 JSON
3. MCP `initialize`/`tools/list` 可正常返回
4. ChatGPT app 侧可完成连接流程
5. 结果预览链接可访问

## 运维操作

### PM2 服务管理

当前服务名：

```text
coding-mcp-chatgpt
```

常用命令：

```bash
pm2 status
pm2 logs coding-mcp-chatgpt
pm2 restart coding-mcp-chatgpt
pm2 save
```

服务配置：

```text
ecosystem.config.cjs
```

重启机器后恢复需要 PM2 startup 已安装到 launchd，并且执行过 `pm2 save`。

### 回滚

1. 停止 MCP 服务（仅回滚当前服务版本）
2. 回退配置（如 `KB_MCP_OAUTH_PASSCODE`、鉴权策略）
3. 重启 tunnel 与服务
4. 使用 `curl` 验证基础端点

### 回收 OAuth 授权

- 单客户端回收：在管理界面（若有）撤销该 client
- 全量回收：重启服务即可清空当前内存 OAuth state（会要求客户端重授权）

### 访问控制

- 推荐默认 `read-only`，按需求放开 `full`
- 结果链接建议使用短期有效 token 或签名校验
- 管理端可记录客户端与工具调用日志

## Admin 页面

访问：

```text
https://gmb01.xyz/admin
```

本地：

```text
http://127.0.0.1:6859/admin
```

功能：

- 查看 ChatGPT OAuth connector 注册状态
- 查看 active access token / refresh token 数量
- 查看 last used 与 request count
- revoke 不再使用的 connector（会删除 client、auth code、access token、refresh token、stats）
- 开关 MCP 工具
- 查看最近 MCP activity log
- 查看 job/project 数量与 share 数量

管理员口令：

- 优先使用 `ADMIN_PASSCODE`
- 未设置时使用 `KB_MCP_OAUTH_PASSCODE`
- `ADMIN_COOKIE_SECURE` 控制 Admin session cookie 的 `Secure` 属性：默认 `auto`，HTTPS 请求或 `X-Forwarded-Proto: https` 会启用；本地 HTTP 不启用。可设置为 `true` 或 `false` 强制覆盖。
- Admin 登录有单进程内存失败限流；多实例或公网部署仍应在反代/WAF 层对 `/admin/api/session` 加限流。

## 可观测性

- 记录：`tool_name`、`client_id`、`jobId`、`duration_ms`、`status`
- 结果页展示最近执行记录
- 对关键错误保留摘要，避免在响应中泄露敏感命令输出

## 发布流程（建议）

1. 更新文档
2. 更新实现
3. 内网自测
4. 在测试域名验证
5. 切到生产域名并保持可回滚
