# Cloudflare Tunnel 部署

## 目标

将本地 MCP 服务稳定、安全地暴露为 `gmb01.xyz/mcp`，并将用户发布内容隔离到 `content.gmb01.xyz`。

## 推荐模型

### App host + content host（推荐）

```
gmb01.xyz         -> http://localhost:6859  # admin / MCP / OAuth / health
content.gmb01.xyz -> http://localhost:6859  # published projects / shares / artifacts
```

`cloudflared` 两个 hostname 可以指向同一个本地服务，但必须设置不同的 `httpHostHeader`，让应用按 Host 区分 app-only 路由和 content 路由。Docker 环境必须设置：

```
PUBLIC_BASE_URL=https://gmb01.xyz
CONTENT_BASE_URL=https://content.gmb01.xyz
```

content host 上 `/admin`、`/mcp`、`/authorize`、`/health` 等 app-only 路由应返回 404；公开 `/share/*` 和 `/artifact/*` 应从 content host 访问。

## 本地管理配置参考

1. 生成/绑定 tunnel（本地管理）
2. 配置 ingress 与服务映射
3. 路由 CNAME：`gmb01.xyz` 与 `content.gmb01.xyz`
4. 启动 `cloudflared` 路由服务
5. 验证状态与健康探测

## 验证命令（示例）

- `cloudflared tunnel route dns <tunnel-name-or-uuid> gmb01.xyz`
- `cloudflared tunnel route dns <tunnel-name-or-uuid> content.gmb01.xyz`
- `cloudflared --config /etc/cloudflared/config.yml tunnel run <tunnel-name-or-uuid>`
- `curl -D - https://gmb01.xyz/health`
- `curl -D - https://gmb01.xyz/share/`（应 302 到 `https://content.gmb01.xyz/share/`）
- `curl -D - https://content.gmb01.xyz/share/`（应 200）
- `curl -D - https://content.gmb01.xyz/admin`（应 404）
- `curl -D - https://gmb01.xyz/mcp`（未授权应返回受控响应）

## WAF 与 403 处理

若收到 `MCP streamable transport probe failed with HTTP 403` 且返回 Cloudflare 拦截页：

- 优先判定为 Edge block（非 MCP 逻辑）
- 从 Cloudflare Dashboard 查看事件、Rule、Ray ID 来源
- 常见修复是对 `gmb01.xyz` 做 host 级豁免，避免对该域名应用过度 GeoIP/Bot 规则

> 该策略应在组织安全允许范围内设置，并尽量缩小范围与最小权限。
