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
- 在 `GET /admin/api/storage` 查看 project、workspace、artifact、share、telemetry 的磁盘用量与配额状态
- 对确认不再需要的项目使用 `POST /admin/api/projects/:projectId/purge` 并提交 `{ "confirm": true }` 做永久清理；普通 `/delete` 仍是 soft-delete

管理员口令：

- 优先使用 `ADMIN_PASSCODE`
- 未设置时使用 `KB_MCP_OAUTH_PASSCODE`
- `ADMIN_COOKIE_SECURE` 控制 Admin session cookie 的 `Secure` 属性：默认 `auto`，HTTPS 请求或 `X-Forwarded-Proto: https` 会启用；本地 HTTP 不启用。可设置为 `true` 或 `false` 强制覆盖。
- Admin 登录有单进程内存失败限流；多实例或公网部署仍应在反代/WAF 层对 `/admin/api/session` 加限流。

## 可观测性

- 记录：`tool_name`、`client_id`、`jobId`、`duration_ms`、`status`
- 结果页展示最近执行记录
- 对关键错误保留摘要，避免在响应中泄露敏感命令输出
- storage monitor 默认每 15 分钟扫描并记录超出 80% 的 project/user/global 用量；同时清理超过 7 天的 soft-deleted projects。全局配额会在受管写入前拒绝超额写入

## 持久任务队列

长任务由 PostgreSQL 队列与独立 worker 执行。worker 使用带心跳的租约；只有租约过期的 `running` 任务会被重新排队，新增 worker 不会重置其他 worker 正在执行的任务。任务状态带单调 `revision`，延迟到达的旧快照不能覆盖较新的终态。

默认并发配置：

```text
JOB_WORKER_CONCURRENCY=5
JOB_BROWSER_CONCURRENCY=2
JOB_BUILD_CONCURRENCY=2
JOB_AUDIO_CONCURRENCY=1
JOB_MAX_CONCURRENT_PER_USER=2
JOB_LEASE_MS=30000
JOB_HEARTBEAT_MS=2000
JOB_SHUTDOWN_GRACE_MS=30000
JOB_WORKER_POLL_MS=250
```

`JOB_HEARTBEAT_MS` 必须小于 `JOB_LEASE_MS`。分类和用户并发限制在 PostgreSQL claim 事务中执行，因此横向扩展 worker 后仍是全局上限。取消任务会清除数据库租约；worker 最迟在下一次心跳发现取消，并通过 `AbortSignal` 停止支持取消的浏览器、网络、npm、FFmpeg 与音频渲染工作。npm 通过独立进程组执行，取消时会终止其脚本子进程。

服务关闭时，容器 supervisor 会同时转发 SIGTERM 给 HTTP 和 worker 进程。worker 停止 claim 并在 `JOB_SHUTDOWN_GRACE_MS` 内排空；超时后本地执行中止，未完成任务等待租约过期后恢复。

### 并发性能基准

使用短期 OAuth token 在测试环境执行：

```bash
MCP_BENCHMARK_URL=http://127.0.0.1:6859 \
MCP_BENCHMARK_TOKEN=<short-lived-token> \
MCP_BENCHMARK_CONCURRENCY=20 \
MCP_BENCHMARK_ITERATIONS=20 \
MCP_BENCHMARK_ENQUEUE=1 \
MCP_BENCHMARK_ENFORCE=1 \
npm run benchmark:performance
```

基准覆盖 `tools/list`、轻量 job 列表调用、长任务入队和状态轮询，并输出 p50/p95/p99。默认入队使用不存在的 `benchmark_missing_project`，因此只验证队列链路并快速以环境错误结束；设置 `MCP_BENCHMARK_PROJECT_ID` 才会针对真实项目运行构建。基准环境应提高 `MCP_RATE_LIMIT_MAX_REQUESTS`，避免限流影响延迟结果。

持久化遥测同时记录 `queueWaitMs`、`executionMs`、claim 时的 `queueDepth`、进程 RSS、事件循环 p95 延迟，以及缓存后的工具列表数量和 JSON 字节数。管理后台和 `npm run report:telemetry` 均展示这些指标的分位数，便于区分排队、执行、内存压力和 MCP 列表体积造成的延迟。

### Registry 冷启动基准

工具定义由静态 manifest 提供，常用项目/文件组启动时预热；浏览器、音乐、演示、SVG、3D 与网页重建组在首次调用时动态导入。修改工具定义或分组后，构建会重新生成 manifest，`npm run typecheck` 会拒绝未生成的漂移。

```bash
npm run build:server
npm run benchmark:registry

# 在 CI/容量门禁中启用默认阈值：import p95 <= 125ms、RSS delta p95 <= 70MiB
MCP_REGISTRY_BENCHMARK_ENFORCE=1 npm run benchmark:registry
```

基准在独立 Node 进程中重复测量 registry import、完整 `server` 入口 import，并分别测量浏览器、音乐和演示域的首次加载成本，避免模块缓存污染样本。`server_entry.unexpectedlyLoadedColdGroups` 必须为空，借此发现路由或关闭钩子绕过 registry 的静态导入。阈值可通过 `MCP_REGISTRY_MAX_P95_MS` 和 `MCP_REGISTRY_MAX_RSS_P95_MIB` 覆盖。

2026-08-12 本机五次最终样本中，改造前 registry import 中位数约 `142.6ms`、RSS delta 中位数约 `87.2MiB`；改造后分别为 `48.1ms` 与 `34.8MiB`。完整 server 入口中位数约 `104.1ms` / `55.0MiB`，且没有提前加载任何受保护的重型域。音乐和演示域首次加载 p95 分别约 `20.8ms` 与 `16.1ms`。这些数值用于确认优化方向，生产容量判断仍应在部署环境重复执行。

### 存储配额配置与回滚

存储治理的变更理由：项目文件、绑定 workspace、backup/export artifact、share 和 telemetry 分散在多个 root，单看 project metadata 无法解释磁盘增长；因此加入实时扫描、写入前配额检查、保留期清理和显式 purge。

默认配置为：单项目 `5GiB`、单用户 `25GiB`、全局告警阈值 `100GiB`、80% warning、删除保留 7 天、监控间隔 15 分钟。可用以下环境变量覆盖：

```text
PROJECT_STORAGE_QUOTA=5GiB
USER_STORAGE_QUOTA=25GiB
GLOBAL_STORAGE_QUOTA=100GiB  # 全局硬上限，覆盖 project/workspace/artifact/share/telemetry
STORAGE_WARN_AT_PERCENT=80
DELETED_PROJECT_RETENTION_DAYS=7
STORAGE_MONITOR_INTERVAL_MS=15m
CONVERSATION_FILE_MAX_BYTES=100MiB  # native ChatGPT connector-file transfer ceiling
FILE_TRANSFER_TIMEOUT_MS=300000    # native connector-file download timeout
```

回滚步骤：删除这些新增环境变量并重启服务即可恢复默认值；若需要暂停硬配额/维护扫描，可将 `PROJECT_STORAGE_QUOTA=0`、`USER_STORAGE_QUOTA=0`、`GLOBAL_STORAGE_QUOTA=0`、`STORAGE_MONITOR_INTERVAL_MS=0` 后重启。永久 purge 不可回滚，操作前应先用 `/admin/api/storage` 或 `get_my_storage_usage` 确认范围。

Native ChatGPT file promotion uses a short connector file reference in JSON and downloads the binary server-side. The legacy `express.json({ limit: "40mb" })` ceiling still applies to Base64/raw JSON compatibility calls, not to the binary download itself. The native path refuses local paths, `file://` URLs, and unapproved download hosts.

## 发布流程（建议）

1. 更新文档
2. 更新实现
3. 内网自测
4. 在测试域名验证
5. 切到生产域名并保持可回滚
