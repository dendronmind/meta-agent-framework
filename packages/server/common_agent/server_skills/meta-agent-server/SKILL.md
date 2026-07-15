---
name: meta-agent-server
description: Use when acting as Meta-Agent-Server to dispatch MAF workflows, check agent status, handle proposals, evolve skills/config, or answer MAF orchestration requests. Fast path: for explicit “让/请/叫 <agent> 做 <任务>”, dispatch directly through /api/workflows without reading large docs.
---

# Meta-Agent-Server Skill

你是 Meta-Agent-Server 时使用本 skill。本文件只保留触发条件、高频速查和规则路由；完整协议以 `common_agent/instructions/Meta-Agent-Server.md` 和 `common_agent/rules/*.md` 为准。

## 效率优先规则

- 明确点名任务（“让/请/叫 `<agent_name>` 做 `<任务>`”）直接派发，不要先读大文件。
- 只在目标不确定时查询 agent 列表；查询用精简字段。
- 默认异步派发并返回“结果会自动回来”，不要主动轮询，除非用户要求同步等待或后续动作依赖结果。
- 不要亲自读业务代码、改业务代码、跑业务测试；这些都派给合适的远端 Agent。
- Proposal/Evolve、失败重试、多 Agent 编排等复杂场景按需读取 `common_agent/rules/`。

## 高频速查

确认 agent：

```bash
curl -s 'http://localhost:3000/api/agents?fields=agent_name,status,runtime,capabilities'
```

异步派发最小模板：

```bash
curl -s -X POST http://localhost:3000/api/workflows -H 'Content-Type: application/json' -d '{"title":"<概述>","origin":{"agent_name":"Meta-Agent-Server"},"notify":{"mode":"originator","include_result":true},"nodes":[{"id":"step-1","agent_name":"<agent_name>","prompt":"<忠实透传用户任务>","scope":"project","intent":"query"}]}'
```

`intent` 速查：查看/说明=`query`，修改代码=`modify`，审查=`review`，诊断=`diagnose`，跑命令/测试=`execute`。修改 agent 自身配置时 `scope="agent_self"`。

## 复杂场景按需加载

| 场景 | 读取文件 |
| --- | --- |
| 完整派发流程 / scope intent 判断 / 状态策略 | `common_agent/rules/dispatch-flow.md` |
| 多 Agent DAG / depends_on / all_settled | `common_agent/rules/multi-agent-workflow.md` |
| 同步等待、超时、失败重试 | `common_agent/rules/polling-strategy.md` |
| Proposal 采纳后分发、skill/config/MCP/broadcast 推送 | `common_agent/rules/evolve-guide.md` |
| API 端点、body schema、字段说明 | `common_agent/rules/api-reference.md` |
| 复杂 prompt 透传与约束 | `common_agent/rules/prompt-guide.md` |

## 管理边界

- 框架托管文件（`.opencode/`、`.claude/`、`.codex/`、`AGENTS.md`、`CLAUDE.md`、`common_agent/`、`scripts/`）不要直接修改。
- 需要长期积累的内容写入 `user/`。
- Server 默认地址是 `http://localhost:3000`；若用户改过端口，以 `~/.meta-agent-framework/maf.config.json` 为准。
