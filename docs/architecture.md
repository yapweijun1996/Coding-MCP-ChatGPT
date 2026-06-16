# 架构说明

## 目标

建立一个可用于 ChatGPT 的远程 MCP 服务，满足以下目标：

- 提供可发现、可鉴权、可执行的 MCP 工具集合
- 支持开发/编码场景下的文件读写与构建结果返回
- 对外统一暴露在 `https://gmb01.xyz/mcp`
- 支持任务完成后返回可预览链接，例如 `https://gmb01.xyz/outcome/<jobId>`

## 组件关系

```text
ChatGPT（开发者模式）
   │
   ├── MCP App / 连接配置
   │       │
   └── HTTPS + OAuth
           │
           └── gmb01.xyz/mcp（Cloudflare Tunnel）
                    │
                    └── 本地 MCP 服务（Node/TS）
                           ├── OAuth/认证模块
                           ├── MCP 工具路由
                           ├── 任务执行引擎（命令/构建/文件）
                           └── Preview/结果存储
```

## 模块职责

### 1. 边界入口（Cloudflare + /mcp）

- 统一暴露外网入口
- 处理 TLS、HTTP 路由、基础 WAF 与速率策略
- 将流量转发到内部 MCP 服务

### 2. MCP 服务（应用层）

- 实现 MCP JSON-RPC/Streamable HTTP 或 SSE
- 提供 `initialize`、`tools/list`、`tools/call` 等标准接口
- 维护 tool registry 与访问分组

### 3. 认证模块

- 提供 OAuth discovery 与动态注册（建议）
- 支持 owner passcode 管理
- 可选支持静态 key（兼容非 ChatGPT 客户端）

### 4. 工具执行层

- 受控实现如 `write_file`、`run_tests`、`build_project`
- 对参数做 schema 校验和权限校验
- 记录执行日志和任务状态

### 5. 结果与预览层

- 每个任务生成 `jobId`
- 输出可访问结果链接 `/outcome/{jobId}`
- 提供摘要、日志、产物文件映射

## 设计边界

- 不在未授权场景下暴露写类接口
- 不默认共享全部工作目录读写权限
- 不在 ChatGPT 写入链路上自动执行高风险操作

