# Meta-Agent Framework

**打破编码 Agent 孤岛** —— 让内网中不同机器上的 AI Agent 自动组网互联，形成有组织架构的 Agent 集群。用户只需与 Server Agent 对话，即可指挥所有远端 Agent 协同工作。同时具备 Agent 间协同进化、互相学习的能力，持续提升整个团队的能力上限。

[English](./README.en.md) | 中文

## 演示

![demo](./docs/demo.gif)

## 架构

```
                    ┌─────────────────────────────┐
                    │     用户（自然语言对话）       │
                    └──────────────┬──────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    Server（中控调度）                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Workflow  │ │  Agent   │ │  Health  │ │    Evolve     │  │
│  │  Engine   │ │ Registry │ │ Monitor  │ │ (协同进化)     │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │ push / heartbeat / result
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐
     │  Machine A │ │  Machine B │ │  Machine C │
     │  Daemon    │ │  Daemon    │ │  Daemon    │
     │  ├ Agent 1 │ │  ├ Agent 3 │ │  ├ Agent 5 │
     │  └ Agent 2 │ │  └ Agent 4 │ │  └ Agent 6 │
     └────────────┘ └────────────┘ └────────────┘
```

## 核心特性

- **自动组网** — Agent 启动即注册，形成可调度的分布式网络
- **对话式调度** — 与 Server Agent 自然语言对话，它自动判断派给谁
- **异步协作** — 任务派发后不阻塞，结果自动回传并渲染展示
- **协同进化** — Server 可向所有 Agent 推送 skill / 配置 / MCP 工具，整体能力同步提升
- **按需拉起** — Agent 离线时 Daemon 自动通过 screen 拉起 TUI 执行
- **三 Runtime** — 支持 [opencode](https://opencode.ai)、[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 [Codex CLI](https://github.com/openai/codex)
- **任务队列** — 连续多任务串行执行，不丢不乱
- **全 Client OTA** — 自动同步 Daemon、OpenCode、Claude Code 与 Codex 运行组件，按 bundle hash 校验并由 Daemon 自恢复

## 快速开始

### 前置条件

- Node.js >= 18
- AI Runtime：[opencode](https://opencode.ai)、[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)

如果尚未安装 Node.js 或版本过低，运行环境准备脚本（自动安装 nvm + Node.js 20）：

```bash
curl -fsSL https://github.com/dendronmind/meta-agent-framework/releases/download/latest/env_install.sh | bash
```

### 1. 安装

```bash
# Server（调度中心，一台机器）
npm install -g https://github.com/dendronmind/meta-agent-framework/releases/download/latest/meta-agent-server.tgz

# Client（Agent 运行的机器，可以多台）
npm install -g https://github.com/dendronmind/meta-agent-framework/releases/download/latest/meta-agent-client.tgz
```

### 卸载

```bash
# Server
npm uninstall -g @maf/meta-agent-server

# Client
npm uninstall -g @maf/meta-agent-client
```

### 2. 启动 Server

```bash
maf-server start
```

首次运行自动进入配置，完成后启动 Server 并进入 Meta-Agent-Server 交互界面。

### 3. 配置 Client（远端机器）

```bash
maf-client init    # 交互式配置 Server 地址 + 安装 Plugin
```

安装完成后支持手动启动和自动拉起两种运行模式：

**手动启动 Agent：**
```bash
opencode --agent <name>    # opencode Agent
claude --agent <name>      # Claude Code Agent
codex -C <project-dir>     # Codex Agent（从 .codex/agents 或项目目录名识别）
```

> ⚠️ **Agent 配置要求**：每个 Agent 项目目录下必须有标准格式的 agent 定义文件：
> - opencode：`.opencode/agents/<agent-name>.md`（注意是 `agents` 复数）
> - Claude Code：`.claude/agents/<agent-name>.md`
> - Codex：`.codex/agents/<agent-name>.toml`；若未配置，MAF 会使用项目目录名作为 `agent_name`
>
> agent 定义文件中的 `model` 字段必须配置实际可用的模型，否则 API 调用会失败（opencode HTTP API 不会像 TUI 一样自动 fallback 默认模型）。

**自动拉起（推荐）：**

无需手动启动。只要 Client 机器的 Daemon 在运行（`maf-client init` 后自动常驻），Server 派发任务时会自动通过 `screen` 远程拉起对应 Agent。前提是在 Server 的 Agent 注册表中已配置该 Agent。

### 4. 使用

在 Server Agent 的对话中用自然语言描述需求即可：

> "帮我看看项目 A 最近有什么改动"
> "让前端组的 Agent 跑一下单元测试"
> "把这个 bug 修复方案同步给负责后端的 Agent"

Server Agent 自动判断派给谁、派发任务、等待结果、展示给你。

## 命令参考

```bash
# Server
maf-server start      # 启动（首次自动配置）+ 进入交互界面
maf-server resume     # 恢复上次对话（Ctrl+C 退出后用这个继续）
maf-server tui        # 启动全新交互会话
maf-server stop       # 停止
maf-server restart    # 重启
maf-server status     # 查看状态
maf-server logs       # 查看日志
maf-server uninstall  # 卸载（停止 + 清数据 + 删 npm 包）
maf-server help       # 查看所有命令

# Client
maf-client init       # 配置 Server 地址 + 安装 Plugin
maf-client resume [agent]  # 恢复指定 Agent 的上次对话
maf-client sessions   # 列出最近的 sessions
maf-client status     # 查看状态
maf-client uninstall  # 卸载（停 Daemon + 清 Plugin + 删 npm 包）
maf-client help       # 查看所有命令
```

## 安全说明

Meta-Agent-Framework 设计为**内网/局域网部署**，不建议暴露到公网：

- Server 和 Daemon 之间通过 HTTP 通信（无 TLS），仅适用于可信网络
- 无内置认证机制，同一网段内的机器可直接连接
- 如需跨公网部署，请自行在前面加 VPN、SSH 隧道或反向代理（nginx + TLS + Basic Auth）

**典型安全部署方式：**
- 所有机器在同一个 VPN / 局域网内
- Server 监听内网 IP（如 `10.x.x.x` 或 `192.168.x.x`），不绑定 `0.0.0.0` 到公网端口
- 防火墙规则限制 Server 端口（默认 3000）和 Daemon 端口（默认 4100）只允许内网访问

## 开发

参见 [CONTRIBUTING.md](./CONTRIBUTING.md)（开发环境搭建、测试、发版流程）。

## License

MIT
