# Coding MCP ChatGPT

一个**已落地实现**的 MCP（Model Context Protocol）HTTP 服务（TypeScript + Express，入口
[`src/server.ts`](src/server.ts)）。它把一组受控工具（项目交付、研究、音乐生成、浏览器 QA、
Git 等）通过 ChatGPT 连接器（开发者模式 / OAuth）暴露给 ChatGPT，并经 `gmb01.xyz`/`/mcp`
对外提供；工具在服务端做真实副作用（创建持久化项目、构建并发布静态站点、渲染音乐），通过预览/
分享页返回可访问产物链接，支持“编码 -> 验证 -> 可访问产物链接”闭环。

核心能力：

- 持久化 **Project** 工具链：创建/写入/校验/发布静态站点，产出 `https://gmb01.xyz/share/{projectId}/index.html`
- 研究工作区、音乐合成与渲染、浏览器 QA / 抓取重建、SEO/Blog 内容生成
- ChatGPT MCP 接入规范与安全边界（OAuth + PKCE + DCR、两层工具访问门、路径白名单、SSRF 防护）
- Cloudflare Tunnel 暴露与 Docker Compose 部署
- MIT-safe 的浏览器端视频演示导出：MCP 生成可发布 HTML 预览页，用户在浏览器中通过 WebCodecs 导出 MP4；默认核心不打包服务端视频渲染器或媒体编码二进制。

> **新接手的工程师从这里开始读 → [`docs/handover.md`](docs/handover.md)**（系统心智模型、代码地图、
> 本地开发与测试、部署、约定与避坑）。下面的章节是面向接入/运维的参考。

## 许可证

本项目采用 MIT License。视频演示导出功能保持 MIT-safe：默认只生成浏览器端 Canvas/WebCodecs 页面，不在 MCP 核心中打包付费渲染引擎、源代码可见但非开源的渲染器，或带 copyleft 约束的媒体编码二进制。

## 目录

- [项目目标](#项目目标)
- [快速开始](#快速开始)
- [架构与边界](#架构与边界)
- [目录结构](#目录结构)
- [配置说明](#配置说明)
- [运行与验证](#运行与验证)
- [ChatGPT 连接说明](#chatgpt-连接说明)
- [Cloudflare Tunnel 部署](#cloudflare-tunnel-部署)
- [工具与 API 约定](#工具与-api-约定)
- [运维与安全](#运维与安全)
- [故障排查](#故障排查)
- [开发规范](#开发规范)

## 项目目标

1. 通过 `https://gmb01.xyz/mcp` 提供 MCP 入口
2. 支持 OAuth（ChatGPT 推荐）与本地/其他客户端兼容认证方案
3. 实现结果预览链路，任务完成后返回可访问链接
4. 规范 Cloudflare Tunnel + WAF/安全策略的部署方式
5. 明确可观测性、访问控制和边界限制
6. 支持分享独立 HTML 产物：`https://gmb01.xyz/share/{id}/{file}.html`

## 快速开始

以下示例为项目初始化模板，适合先搭文档与部署雏形后再接入实现代码。

1. 安装依赖：
   - `npm install`
2. 配置环境变量（见 [配置说明](#配置说明)）
3. 启动本地服务并验证：
   - `GET /health`
   - `POST /mcp`（初始化 JSON-RPC）
   - `.well-known` OAuth 发现端点
4. 用 Cloudflare Tunnel 把本地端口映射到 `gmb01.xyz`
5. 在 ChatGPT 的自定义应用 / 开发者模式里添加应用并绑定 `https://gmb01.xyz/mcp`
6. 用最小工具集验证写作流：创建/修改文件 -> 运行 -> 返回 preview 链接

### Docker 快速启动

```bash
cp .env.docker.example .env.docker
npm run docker:up
curl -sS http://127.0.0.1:6859/health
```

更多容器部署与数据目录说明见 `docs/docker.md`。

## 架构与边界

### 建议架构

- **边缘入口**：Cloudflare Tunnel (`gmb01.xyz`)
- **API/MCP 主服务**：本地运行的 HTTP MCP 服务（Streamable HTTP / SSE）
- **OAuth 授权服务**：同一服务内提供 OIDC/OAuth 发现、授权、token 与 DCR 支持
- **执行引擎**：MCP 工具执行层（文件读写、构建、预览）
- **产物托管**：本地预览服务 `/outcome/{jobId}` 与独立分享页 `/share/{id}/{file}.html`

### 边界与约束

- MCP 仅处理你希望暴露的工具集合，**不默认开放**文件系统全量访问
- 结果页链接只返回任务摘要与白名单资源路径
- 云端（Cloudflare）与本地服务应做到职责分离：Cloudflare 负责 ingress 与流量防护，应用负责业务鉴权

## 目录结构

```text
.
├── README.md                 # 本文件（接入/运维参考）
├── Dockerfile, docker-compose.yml
├── package.json              # npm scripts: dev / build / test / typecheck / check:mcp / docker:*
├── docs/                     # 工程文档（见下方索引）
├── scripts/                  # check-mcp-registry.mjs 等校验脚本
├── tests/                    # node:test 测试（tsx --test tests/*.test.ts）
├── admin-ui/                 # React Admin 运维控制台前端
└── src/
    ├── server.ts             # 入口：Express bootstrap + 路由挂载
    ├── mcp/                  # MCP 核心：registry / router / result / types / tools/
    ├── projects/             # 持久化 Project store（核心交付路径）
    ├── research/             # 研究工作区
    ├── blog/ · site/         # 内容 / SEO / 落地页
    ├── web-capture/          # Playwright 抓取 / 重建 / 浏览器审计
    ├── oauth.ts              # OAuth / OIDC / PKCE / DCR
    ├── skills/ · tool-state.ts · special-tools.ts  # 两层工具访问门
    ├── security/             # 路径白名单 / SSRF / origin 隔离
    └── jobs/ · activity.ts · admin*.ts · telemetry/
```

> 完整的模块逐项说明见 [`docs/code-map.md`](docs/code-map.md)。

### 工程文档索引（开发者）

| 文档 | 内容 |
|---|---|
| [docs/handover.md](docs/handover.md) | **新人入门主文档**：心智模型、代码地图、开发/测试、部署、约定与避坑 |
| [docs/code-map.md](docs/code-map.md) | `src/` 逐模块说明 |
| [docs/request-lifecycle.md](docs/request-lifecycle.md) | 一次 `tools/call` 的完整链路（鉴权 → 访问门 → handler → 结果） |
| [docs/adding-a-tool.md](docs/adding-a-tool.md) | 新增 MCP 工具的分步指南 |
| [docs/mcp-tools.md](docs/mcp-tools.md) | 工具目录 + 默认访问规则 |
| [docs/music-workflow.md](docs/music-workflow.md) | 音乐子系统开发者深潜（最复杂子系统范例） |
| [docs/architecture.md](docs/architecture.md) · [docs/mcp.md](docs/mcp.md) | 架构与边界 / MCP 协议约定 |
| [docs/project-management.md](docs/project-management.md) · [docs/research-workflow.md](docs/research-workflow.md) | Project / Research 工作流 |
| [docs/setup.md](docs/setup.md) · [docs/docker.md](docs/docker.md) · [docs/operations.md](docs/operations.md) · [docs/cloudflare.md](docs/cloudflare.md) | 运行 / 容器 / 运维 / 暴露 |
| [docs/security-origin-isolation.md](docs/security-origin-isolation.md) · [docs/troubleshooting.md](docs/troubleshooting.md) | 安全 / 故障排查 |

## 配置说明

环境变量示例（按你的实现填写）：

- `PORT`：HTTP 监听端口（默认 `6859`）
- `KB_MCP_OAUTH_ENABLED`：`1` 启用 OAuth
- `KB_MCP_OAUTH_ISSUER`：OAuth 发行者标识
- `KB_MCP_OAUTH_PASSCODE`：ChatGPT 同意页 owner passcode
- `KB_MCP_HTTP_KEY`：非 ChatGPT 客户端可用的静态 Key（若保留）
- `ADMIN_SESSION_SECRET`：管理员会话保护（如有前端管理页）
- `ADMIN_PASSCODE`：访问 `/admin` 的管理员口令（默认可复用 OAuth owner passcode）
- `ADMIN_COOKIE_SECURE`：Admin session cookie 的 `Secure` 策略，支持 `auto` / `true` / `false`（默认 `auto`，按 HTTPS 请求或 `X-Forwarded-Proto: https` 自动启用）
- `NODE_ENV`：`development` / `production`
- `MCP_DEV_TOKEN`：MVP 阶段保护 `/mcp` 的 Bearer token
- `PUBLIC_BASE_URL`：外部访问地址（默认 `https://gmb01.xyz`）
- `WORKSPACE_ROOT`：允许工具操作的工作目录
- `SHARE_ROOT`：分享 HTML 产物存储目录（默认 `.shares`）
- `COMMAND_TIMEOUT_MS`：命令执行超时时间（默认 `30000`）

注意：  
1. ChatGPT 连接器通常仅提供 `No Auth`/`OAuth`，为避免明文 token 风险，建议走 OAuth 为主。  
2. 当前 MVP 已提供内存版 OAuth authorization code + PKCE + DCR + refresh/revoke 流程，可用于 ChatGPT Connector 冒烟测试。  
3. `MCP_DEV_TOKEN` 仅用于本地调试；公网 ChatGPT 连接应使用 OAuth。  

## 运行与验证

### 本地自检命令（示例）

> 以 HTTP 工具链实现为准替换 URL/端口

- `curl -sS http://127.0.0.1:6859/health`
- `curl -sS https://gmb01.xyz/.well-known/oauth-protected-resource/mcp`
- `curl -sS https://gmb01.xyz/.well-known/oauth-authorization-server`
- `curl -i -X POST https://gmb01.xyz/mcp -H 'content-type: application/json' -H 'authorization: Bearer <MCP_DEV_TOKEN>' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'`

### 预期验收

- `.well-known` 端点返回 OAuth metadata JSON
- 设置 `MCP_DEV_TOKEN` 后，无授权访问 `/mcp` 返回 401 并给出正确的 auth 引导
- 授权后可返回 tool 列表
- 工具执行后返回预览链接（或可直接映射到 `/outcome/<id>`）

## ChatGPT 连接说明

请参考 `docs/chatgpt.md` 的完整流程。简要如下：

1. 开发者模式启用并进入 Apps/Connectors
2. 选择创建应用，填写 MCP URL：`https://gmb01.xyz/mcp`
3. 选择 OAuth（DCR 自动注册，PKCE 授权码）
4. 完成认证授权
5. 在对话中调用工具（可按工具名称锁定工具调用）

## Cloudflare Tunnel 部署

请参考 `docs/cloudflare.md` 的标准配置。高层步骤：

1. Cloudflare Zero Trust 创建 Tunnel（或本地管理）
2. 绑定公开 Hostname：`gmb01.xyz`
3. 本地 service 映射到 `http://127.0.0.1:3000`
4. 在 DNS 中确认 CNAME 或路由记录
5. 运行时验证域名可达与证书状态

## 工具与 API 约定

建议至少提供以下工具：

- `write_file`：受控文件写入
- `run_tests`：执行测试并汇总
- `build_project`：构建/打包
- `create_preview`：构建产物映射成可预览链接
- `create_app_project`：从模板创建 Vite React/Vue/Vanilla app 项目
- `install_project_dependencies` / `run_project_build`：受控安装依赖与构建
- `publish_project_dist`：发布 `dist/` 到 `/share/{projectId}/index.html`
- `create_share`：发布单个独立 HTML 文件并返回分享链接
- `get_preview_url`：返回 `https://gmb01.xyz/outcome/{jobId}`
- `list_dir` / `read_file` / `search_files`：工作区读/检索能力
- `tail_file`：读取文件尾部
- `create_directory`：创建目录
- `delete_file` / `rename_file`：文件管理
- `file_info` / `git_*`：文件元信息与 Git 诊断

每个工具建议输出统一字段：

- `ok`（布尔）
- `summary`
- `errors`
- `jobId`
- `previewUrl`
- `shareUrl`
- `artifacts`
- `logs`

### 推荐 Agent 项目交付流程

ChatGPT 或其他 AI agent 交付编码项目时，应优先使用持久化 Project 工具链：

1. `deliver_static_project`：一次提交多个静态文本文件，自动创建项目、验证、发布和浏览器检查
2. `get_project_activity`：需要诊断失败或查看历史时读取 task history 和 latest validation
3. `get_project_manifest`：需要完整项目上下文时读取 manifest
4. `validate_project` / `publish_and_report`：仅在修复或增量编辑时使用分步流程

不要用 legacy `create_share` 交付项目。它默认关闭，仅保留给兼容测试；正式项目链接应来自 `deliver_static_project` 或 `publish_and_report`，格式为 `https://gmb01.xyz/share/{projectId}/index.html`。

如果用户要把一个 idea 变成 React/Vue/Vite demo，应使用 app project 工具链：`create_app_project` -> `write_app_project_file` -> `install_project_dependencies` -> `run_project_dev`（需要临时预览时）-> `run_project_build` -> `publish_project_dist`。

## 运维与安全

- 建议 MCP token、静态 key、OAuth passcode 放在 `http.env` 或加密配置管理中，不直接写入代码仓库
- 对写类工具加：
  - 请求参数 schema 校验
  - 允许路径白名单
  - 文件大小与执行时长限制
- 可按客户端设置访问级别：`read-only` / `full`
- `/admin` 提供 ChatGPT connector 状态、工具开关、活动日志、job/share 统计

## 故障排查

- **ChatGPT 连接提示 403**：先判断是否 Cloudflare Edge 拦截（Look for block page / RayID），通常不是 MCP 应用逻辑问题
- **工具列表为空**：确认 MCP server tool registration 及 schema 输出
- **OAuth 无法完成**：检查 `.well-known` 端点、回调域名一致性、passcode 与 session 状态
- **Preview 链接失效**：检查 cloudflared ingress/路由、应用服务端口、`/outcome/{id}` 生命周期策略

## 开发规范

- 文档优先：每次行为变更需同步到 `docs/` 对应章节
- 修改配置前先在 `docs/operations.md` 记录变更理由与回滚步骤
- 使用显式工具名称调用，降低模型选择错误
- 保持最小权限：优先 read-only，上线前再开启 full

## 新增工具调用示例

### create_directory

```bash
curl -sS -X POST http://127.0.0.1:6859/mcp \
  -H 'authorization: Bearer <MCP_DEV_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"tools/call",
    "params":{
      "name":"create_directory",
      "arguments":{"relativePath":"tmp/reports","recursive":true}
    }
  }'
```

### tail_file

```bash
curl -sS -X POST http://127.0.0.1:6859/mcp \
  -H 'authorization: Bearer <MCP_DEV_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/call",
    "params":{
      "name":"tail_file",
      "arguments":{"relativePath":"dist/server.ts","maxLines":120}
    }
  }'
```

### delete_file

```bash
curl -sS -X POST http://127.0.0.1:6859/mcp \
  -H 'authorization: Bearer <MCP_DEV_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"delete_file",
      "arguments":{"relativePath":"tmp/reports/old.txt","confirm":true}
    }
  }'
```

## 贡献方式

1. 阅读 `docs/architecture.md` 与 `docs/operations.md`
2. 更新文档后再提交代码
3. 以“小范围可回滚”原则提交功能改动

## Persistent Project CRUD

ChatGPT can now create persistent static coding projects through MCP tools. Projects are stored under `.projects/{projectId}/files/`, can be published to `https://gmb01.xyz/share/{projectId}/index.html`, viewed in Admin, and downloaded as ZIP files.

Key tools:

- `create_project`
- `write_project_file`
- `read_project_file`
- `list_projects`
- `get_project`
- `publish_project`
- `delete_project_file`
- `delete_project` disabled by default

Admin endpoints:

- `/admin` serves the React Admin operations console with cookie-session login.
- `/admin/projects/:projectId` is a React project detail route for project status, files, validation, and task history.
- `/admin/api/projects/:projectId/download.zip` downloads project files for authenticated admins.
- `/admin/api/*` provides the JSON API used by the Admin UI for projects, connectors, tools, skills, special tools, activity, and settings.
- Admin login applies an in-memory per-process failed-login limiter. For multi-instance or public deployments, keep a reverse proxy/WAF rate limit in front of `/admin/api/session`.

See `docs/project-management.md` for details.

## Research Delivery MCP

ChatGPT should use its own web search for discovery and reasoning. This MCP provides the persistent research workspace: source records, notes, evidence links, agent-authored `report.md` / `report.html`, validation, and publishing.

Key research tools:

- `create_research_project`
- `add_research_source`
- `list_research_sources`
- `add_research_note`
- `record_research_evidence`
- `get_research_manifest`
- `write_research_report`
- `publish_research_report`

Research projects are backed by normal Project storage under `.projects/{projectId}/files/` and publish through `/share/{projectId}/report.html`. See `docs/research-workflow.md` for the recommended agent workflow and validation rules.

## Tool registry architecture

MCP tools are registered through `src/mcp/registry.ts`. Each tool module owns its definition, validation schema, handler, and `enabledByDefault` flag. `src/mcp/tools.ts` remains as a compatibility re-export during the transition.

See `docs/mcp-tools.md` for the current tool groups and default access rules.

## MCP high-risk tool access

Some tools exist but are disabled by default and must be temporarily enabled from Admin before ChatGPT can call them:

- `delete_project`
- `create_share`
- `check_url`
- `open_local_server`
- `stop_local_server`
- `open_local_server_and_check`
- `run_lint`
- `run_format_check`
- `run_format_write`
- `diagnostic_bundle`
- `diagnostic_bundle_full`

For project deliverables, ChatGPT should use `create_project`, `write_project_file`, and `publish_project`. Do not use legacy `create_share` for project outcomes because it is not restart-safe.

Before deploying MCP tool changes, run:

```bash
npm run check:mcp
```

## Command tool defaults

Stable command and browser-inspection helpers enabled by default:

- `run_command`
- `run_typecheck`
- `run_tests`
- `run_build`
- `bind_project_workspace`
- `list_project_files`
- `search_in_project`
- `apply_patch`
- `write_project_workspace_asset`
- `import_project_workspace_asset_from_local_file`
- `run_project_npm_command`
- `inspect_project_workspace`
- `record_project_workspace_video`
- `publish_project_workspace`
- `record_project_task`
- `inspect_webpage`
- `inspect_webpage_plus`
- `audit_accessibility`
- `audit_lighthouse`
- `inspect_interaction_flow`
- `inspect_local_project`

The following command and network/process helpers are disabled by default and must be enabled from Admin before use:

- `run_shell_command`
- `run_lint`
- `run_format_check`
- `run_format_write`
- `diagnostic_bundle`
- `diagnostic_bundle_full`
- `check_url`
- `open_local_server`
- `stop_local_server`
- `open_local_server_and_check`

`run_format_write` is mutating and should only be used when you intentionally want ChatGPT to rewrite repository files through a formatter.

Browser QA tools:

- `check_url`: fast HTTP reachability and response preview.
- `inspect_webpage`: lightweight Chromium responsive screenshot and layout check.
- `inspect_webpage_plus`: deeper browser debugging with console, page, network, screenshot, and optional trace artifacts.
- `audit_accessibility`: axe-powered WCAG-style accessibility scan.
- `audit_lighthouse`: Lighthouse quality audit for performance, accessibility, best practices, SEO, and PWA.
- `inspect_interaction_flow`: safe declarative browser flow test without arbitrary JavaScript execution.
- `inspect_local_project`: starts the local project server, runs browser QA, and stops the server by default.

Real repository workflow:

- `bind_project_workspace`: attach a `projectId` to a real Git repository under `WORKSPACE_ROOT`.
- `git_status`, `git_diff`, `git_commit`, and `git_push`: accept optional `projectId` so Git runs in the bound repository instead of the MCP server's default workspace.
- `list_project_files` / `search_in_project`: inspect the bound repository.
- `apply_patch`: apply a unified diff after `git apply --check`.
- `write_project_workspace_asset` / `import_project_workspace_asset_from_local_file`: add binary assets such as textures, GLB/GLTF models, HDR files, audio, and video to the bound repository.
- `run_project_npm_command`: run install/build/test/lint/typecheck in the bound repository.
- `inspect_project_workspace`: run responsive screenshot, console, layout, and optional accessibility checks against the bound repository's local dev server.
- `record_project_workspace_video`: record real browser output to WebM, or MP4 when `ffmpeg` is installed; failed MP4 conversion still returns the WebM artifact.
- `publish_project_workspace`: publish built output such as `dist/` to the project share URL.
- `record_project_task`: append queue/progress state to project activity history.
