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
maf-client install http://<Server-IP>:3000  # 推荐；例如 http://192.168.1.100:3000
maf-client init                            # 未传地址时交互式配置
```

请填写完整的 HTTP(S) URL；为兼容已有用法，裸 IP 仍会自动规范化为 `http://<IP>:3000`。Server 默认监听 `0.0.0.0`，但 Client 必须填写 Server 的实际 LAN/VPN IP 或域名。显式安装参数会同步覆盖 `maf.config.json` 和 `.bashrc` 中的旧地址，并自动重启正在运行的 Node Daemon 使新配置立即生效。

#### 配置 local-only Agent

Client 可以在本机 `~/.meta-agent-framework/maf.config.json` 中决定哪些 Agent 只由本机 Daemon 管理、永不向 Server 发布。隐藏少数 Agent 时使用：

```json
{
  "client": {
    "agent_publication": {
      "mode": "all",
      "local_only": ["private-agent", "temporary-agent"],
      "client_network": "when-published"
    }
  }
}
```

`local_only` 中的 Agent 仍会出现在本机 localhost 的 Daemon `/health` 和 `/agents` 中，插件也可以正常连接，但不会进入注册、心跳、inventory、任务轮询或远端 health 响应，Server 向该名称派发任务时只会得到 `404`。

如果希望默认所有 Agent 都是 local-only，只显式发布少数 Agent，使用白名单模式：

```json
{
  "client": {
    "agent_publication": {
      "mode": "explicit",
      "include": ["MAF-developer", "shared-reviewer"],
      "local_only": [],
      "client_network": "when-published"
    }
  }
}
```

- `local_only` 优先级高于 `include`。
- `client_network: "when-published"` 表示没有公开 Agent 时不进行 Client enrollment；`"always"` 保留旧版常驻 enrollment 行为。
- 隐私策略只读取用户级配置，项目目录中的 `maf.config.json` 不能覆盖它。
- 修改后需要重启 Node Daemon。该配置只阻止后续发布，不能删除 Server、飞书或日志中已经存在的历史记录。

#### 通用 Execution API

Server 本机集成可使用 `POST /api/v1/executions` 提交需要 MAS 语义路由和远端 Agent 执行的通用任务。框架字段是 `request_id`、`external_id`、`source_type`、`source_ref` 和透明 `metadata`；MAF 不校验或解释 Jira、Case、Run 等业务模型。

```json
{
  "request_id": "caller-idempotency-key",
  "external_id": "external-object-id",
  "source_type": "caller-defined-source",
  "source_ref": "source://reference",
  "title": "分析并修复问题",
  "prompt": "任务正文",
  "metadata": { "opaque_caller_context": {} },
  "timeout_seconds": 3600,
  "auto_start": false
}
```

`request_id` 是幂等键。默认 `auto_start` 为 `true`；需要先上传证据时设为 `false`，依次调用 `PUT /api/v1/executions/:id/artifacts/<path>` 和 `POST /api/v1/executions/:id/start`。结果通过 `GET /api/v1/executions/:id` 查询。调用方可用 `POST /api/v1/executions/:id/cancel` 请求取消；Execution 还有覆盖 MAS、Workflow 和远端进程的总截止时间。

正式 Execution 固定使用 Agent 注册的 `project_path`，不会 clone 或复制第二份源码。Codex Agent
TOML 必须配置 `target_branch`；只有目标分支存在于多个 remote、无法唯一判断时才需要
`remote_name`。Daemon 对同一注册仓库串行加锁并同步远程基线：仓库不干净或 Git 配置不明确时
只读分析；仓库干净时切换到临时任务分支，要求 Agent 只创建一个带 Gerrit `Change-Id` 的
非 merge commit。Daemon 在 Push 前确认远程未前进且本地仅领先一个提交，再 Push 到
`refs/for/<target_branch>` 并恢复原分支。输入输出仍位于
`$MAF_HOME/executions/<execution-id>/input|output`；下载证据不得写入源码仓库。

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

无需手动启动。只要 Client 机器的 Daemon 在运行（`maf-client install http://<Server-IP>:3000` 后自动常驻），Server 派发任务时会自动通过 `screen` 远程拉起对应 Agent。前提是在 Server 的 Agent 注册表中已配置该 Agent。

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
maf-client install http://<Server-IP>:3000  # 配置 Server 地址 + 安装 Plugin
maf-client init       # 交互式配置 Server 地址 + 安装 Plugin
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
- Server 默认监听 `0.0.0.0`；必须用主机防火墙/VPN 将端口限制在可信 LAN/VPN，不能直接暴露到公网
- 防火墙规则限制 Server 端口（默认 3000）和 Daemon 端口（默认 4100）只允许内网访问

## 开发

参见 [CONTRIBUTING.md](./CONTRIBUTING.md)（开发环境搭建、测试、发版流程）。

## License

MIT
