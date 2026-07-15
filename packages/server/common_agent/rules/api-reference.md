# API Reference

Base URL: `http://localhost:3000`（默认端口，实际以 `~/.meta-agent-framework/maf.config.json` 中 `server.port` 为准）

Daemon URL: `http://127.0.0.1:4100`（默认端口，实际以配置中 `daemon.port` 为准）

## Server API

| 操作 | 方法 | 端点 | 返回关键字段 |
|------|------|------|-------------|
| 查看所有 Agent | GET | `/api/agents` | 全量字段；支持 `?fields=agent_name,status,runtime` 逗号过滤 |
| 删除 Agent | DELETE | `/api/agents/<id>` | 被删除的 agent 对象（404 如不存在） |
| 搜索 Agent | GET | `/api/agents/search?q=关键词` | 按 capabilities/agent_name 模糊匹配 |
| 按用户查 Agent | GET | `/api/agents/by-user/<user_id>` | 该用户的所有 agent |
| 创建工作流 | POST | `/api/workflows` | `{workflow_id, status, title, failure_policy}` |
| 查看工作流详情 | GET | `/api/workflows/<id>` | `{id, status, nodes: [{status, result}]}` |
| 等待工作流完成（long-poll） | GET | `/api/workflows/<id>?wait=true` | 工作流完成后立即返回（最多 hold 60s） |
| 查看所有工作流 | GET | `/api/workflows` | `[{id, status, title}]` |
| 健康检查 | GET | `/api/health` | `{status: "ok", server_version}` |
| 查看待审核提议 | GET | `/api/proposals?status=pending` | `[{id, from_agent, type, title, detail, status}]` |
| 查看提议详情 | GET | `/api/proposals/<id>` | `{id, from_agent, type, title, detail, files, status}` |
| 审核提议 | POST | `/api/proposals/<id>/review` | `{id, status, review_comment}` |
| 标记已应用 | POST | `/api/proposals/<id>/apply` | `{id, status: "applied"}` |
| 提议统计 | GET | `/api/proposals/stats` | `{total, pending, accepted, rejected, applied}` |
| Skill/MCP 全网视图 | GET | `/api/agents/inventory` | `{skills: {coverage, gaps}, mcps: {coverage, gaps}}` |
| 推送 Skill | POST | `/api/evolve/skill` | `{evolve_id, pushed, message}` |
| 推送 Agent 配置 | POST | `/api/evolve/agent-config` | `{evolve_id, pushed, message}` |
| 推送 MCP 配置 | POST | `/api/evolve/mcp` | `{evolve_id, pushed, message}` |
| 自定义进化 | POST | `/api/evolve/custom` | `{evolve_id, pushed, message}` |
| 广播进化 | POST | `/api/evolve/broadcast` | `{total, pushed, results}` |
| 查询进化结果 | GET | `/api/evolve/<id>` | `{evolve_id, status, actions}` |
| 查所有进化记录 | GET | `/api/evolve` | `[{evolve_id, status, type, target_agents}]` |
| 创建提议（Client→Server） | POST | `/api/proposals` | `{id, from_agent, type, title, status}` |
| SSE 事件流 | GET | `/api/events` | Server-Sent Events（workflow_completed 等） |

## Workflow Body Schema

```json
{
  "title": "任务简述",
  "origin": {"agent_name": "Meta-Agent-Server"},
  "notify": {"mode": "originator", "include_result": true},
  "failure_policy": "fail_fast",
  "nodes": [
    {
      "id": "step-1",
      "agent_name": "目标 agent 名称",
      "prompt": "描述目标即可，不要写具体命令",
      "scope": "project",
      "intent": "query",
      "depends_on": []
    }
  ]
}
```

### Workflow 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 工作流标题 |
| origin | object | 可选；发起方上下文，用于结果通知路由 |
| notify | object | 可选；通知偏好，异步派发建议 `{mode:"originator", include_result:true}` |
| failure_policy | `"fail_fast"` \| `"all_settled"` | 可选；默认 `fail_fast`，多并行分支建议 `all_settled` |
| nodes | array | 工作流节点列表 |

### Node 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 节点 ID |
| agent_name | string | 目标 agent 名称 |
| prompt | string | 任务描述（只写目标） |
| scope | `"project"` \| `"agent_self"` | 可选，默认 `project`；建议显式填写 |
| intent | `"query"` \| `"modify"` \| `"review"` \| `"diagnose"` \| `"execute"` | 可选，默认 `query`；建议显式填写 |
| depends_on | `string[]` | 可选；依赖的前置节点 ID |
| delivery_mode / execution_mode | `"attached"` \| `"detached"` \| `"auto"` | 可选；Codex 投递语义 |

## Evolve API Body Schema

```text
POST /api/evolve/skill        → { "agent_name": "xxx", "skill_name": "yyy", "files": [{"relative_path": "SKILL.md", "content": "..."}] }
POST /api/evolve/agent-config → { "agent_name": "xxx", "files": [...], "restart?": true, "project_path?": "..." }
POST /api/evolve/mcp          → { "agent_name": "xxx", "files": [...], "install_command?": "npm install ...", "project_path?": "..." }
POST /api/evolve/broadcast    → { "title": "...", "actions": [{"type": "push_files", "target": "skill", "files": [...]}] }
```

Evolve cookbook 见 `common_agent/rules/evolve-guide.md`。

## Node Daemon API（通过 agent 的 client_endpoint 访问）

| 操作 | 方法 | 端点 | 说明 |
|------|------|------|------|
| 健康检查 | GET | `/health` | `{ok, agents, version, server}` |
| 查看管理的 agent | GET | `/agents` | `{agents: [{agent_name, runtime, lastSeen}]}` |

## Agent 状态字段

| status | 含义 |
|--------|------|
| `online` | runtime 接收端在线 |
| `offline` | 心跳超时 15s |
| `dead` | 心跳超时 45s |

派发策略见 `common_agent/rules/dispatch-flow.md`。
