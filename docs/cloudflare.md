# Cloudflare Tunnel 部署

## 目标

将本地 MCP 服务稳定、安全地暴露为 `gmb01.xyz/mcp`，并可访问结果页 `/outcome/*`。

## 推荐模型

### Published application（单域名）

```
gmb01.xyz -> http://127.0.0.1:6859
```

优点：配置简单、维护直观，适合你当前方案。

## 本地管理配置参考

1. 生成/绑定 tunnel（本地管理）
2. 配置 ingress 与服务映射
3. 路由 CNAME：`gmb01.xyz`
4. 启动 `cloudflared` 路由服务
5. 验证状态与健康探测

## 验证命令（示例）

- `cloudflared tunnel route dns <tunnel-name-or-uuid> gmb01.xyz`
- `cloudflared --config ~/.cloudflared/config.yml tunnel run <tunnel-name-or-uuid>`
- `curl -D - https://gmb01.xyz/health`
- `curl -D - https://gmb01.xyz/mcp`（未授权应返回受控响应）

## WAF 与 403 处理

若收到 `MCP streamable transport probe failed with HTTP 403` 且返回 Cloudflare 拦截页：

- 优先判定为 Edge block（非 MCP 逻辑）
- 从 Cloudflare Dashboard 查看事件、Rule、Ray ID 来源
- 常见修复是对 `gmb01.xyz` 做 host 级豁免，避免对该域名应用过度 GeoIP/Bot 规则

> 该策略应在组织安全允许范围内设置，并尽量缩小范围与最小权限。
