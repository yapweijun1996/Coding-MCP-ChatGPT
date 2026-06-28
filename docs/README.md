# 文档索引

本目录记录 ChatGPT MCP + Cloudflare Tunnel 项目的工程文档。

## 新接手的工程师从这里开始

1. [**工程接手指南 / Handover**](./handover.md) — 心智模型、代码地图、开发与测试、部署、约定与避坑（**先读这个**）
2. [代码地图 code-map](./code-map.md) — `src/` 逐模块说明
3. [请求生命周期 request-lifecycle](./request-lifecycle.md) — 一次 `tools/call` 的完整链路
4. [新增工具 adding-a-tool](./adding-a-tool.md) — 添加一个 MCP 工具的分步指南

## 架构与协议

- [架构 architecture](./architecture.md)
- [MCP 协议与工具 mcp](./mcp.md)
- [工具目录与默认访问 mcp-tools](./mcp-tools.md)
- [Agent 可靠交付流程](./agent-delivery-reliability.md)

## 子系统

- [Project 管理 project-management](./project-management.md)
- [研究工作流 research-workflow](./research-workflow.md)
- [音乐子系统深潜 music-workflow](./music-workflow.md)
- [项目工作流与 Git project-workflows-and-git](./project-workflows-and-git.md)
- [任务跟踪 task-tracking](./task-tracking.md)
- [更新工具 updating-tools](./updating-tools.md)

## 接入 / 部署 / 运维

- [快速设置 setup](./setup.md)
- [ChatGPT MCP 对接 chatgpt](./chatgpt.md)
- [Cloudflare Tunnel 部署 cloudflare](./cloudflare.md)
- [Docker 部署 docker](./docker.md)
- [运维与治理 operations](./operations.md)

## 安全与排查

- [安全与 origin 隔离 security-origin-isolation](./security-origin-isolation.md)
- [故障排查 troubleshooting](./troubleshooting.md)

---

文档更新原则：

- 行为变更先更新 `architecture.md` 与 `operations.md`，并同步对应子系统文档
- 配置变更同步更新 `setup.md` 与相关专项文档
- 每次新工具或行为变更必须补充对应说明（与代码同一次提交）
