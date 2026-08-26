# common_agent

这里存放 **Meta-Agent-Server 跨 runtime 通用资产的源码形态**。

`common_agent/` 承载跨 runtime 共享的协议、规则和 skill 模板；opencode/Claude/Codex 的入口 wrapper 仍放在各自 runtime 目录中，例如 `opencode/agents/`、`claude/`、`codex/`。

`maf-server start` / `maf-server sync-plugins` 会把这些通用文件同步到 `MAF_HOME` 的可见托管目录，并把 runtime 入口和 server skill 物化到对应隐藏运行态目录。

| 源码路径 | 安装后路径 | 用途 |
| --- | --- | --- |
| `common_agent/instructions/` | `common_agent/instructions/` | Meta-Agent-Server 通用管理者协议 |
| `common_agent/rules/` | `common_agent/rules/` | 通用调度/API/轮询/多 Agent 编排规则 |
| `common_agent/server_skills/` | `.opencode/skills/`、`.claude/skills/`、`.codex/skills/` | Server agent 跨 runtime skill；基础派发的完整可执行模板与交付选择规范源 |
| `common_agent/client_skills/` | `skills/` | 由 Server 推送给远端 agent 的 client skill 模板 |

runtime 专属源码映射示例：

| 源码路径 | 安装后路径 | 用途 |
| --- | --- | --- |
| `opencode/agents/` | `.opencode/agents/` | opencode agent 定义 |
| `opencode/opencode.json` | `opencode.json` | opencode 项目配置 |
| `claude/CLAUDE.md` | `CLAUDE.md` | Claude Code 入口说明 |
| `claude/settings.local.json` | `.claude/settings.local.json` | Claude Code hooks 配置 |
| `codex/AGENTS.md` | `AGENTS.md` | Codex 入口说明 |
| `codex/agents/` | `.codex/agents/` | Codex 标准 custom agent TOML 定义 |

用户可长期维护的内容应写入安装工作区的 `user/` 目录；`common_agent/`、`.opencode/`、`.claude/`、`.codex/`、`AGENTS.md`、`CLAUDE.md` 等安装态文件由框架生成和升级。
