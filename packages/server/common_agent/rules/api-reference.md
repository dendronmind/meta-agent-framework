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
| 创建工作流 | POST | `/api/workflows` | `{id, status, title}` |
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

### Evolve API Body 格式

```
POST /api/evolve/skill     → { "agent_name": "xxx", "skill_name": "yyy", "files": [{"relative_path": "SKILL.md", "content": "..."}] }
POST /api/evolve/agent-config → { "agent_name": "xxx", "files": [...], "restart?": true, "project_path?": "..." }
POST /api/evolve/mcp        → { "agent_name": "xxx", "files": [...], "install_command?": "npm install ...", "project_path?": "..." }
```

> ✅ Daemon `/evolve` 路由已实现（v0.4.0），推送功能正常可用。

## Node Daemon API（通过 agent 的 client_endpoint 访问）

| 操作 | 方法 | 端点 | 说明 |
|------|------|------|------|
| 健康检查 | GET | `/health` | `{ok, agents, version, server}` |
| 查看管理的 agent | GET | `/agents` | `{agents: [{agent_name, runtime, lastSeen}]}` |

## Agent 状态说明

| status | 含义 | 派发 |
|--------|------|------|
| `online` | runtime 接收端在线 | ✅ 立即执行 |
| `offline` | 心跳超时 15s | ✅ Daemon 可达时自动拉起 |
| `dead` | 心跳超时 45s | ✅ Daemon 可达时自动拉起 |

- 所有 agent 不论 runtime 不论状态都优先通过 Workflow 正常派发
- Daemon 会按 runtime 能力自动拉起、唤醒或转交任务
- Daemon 不可达时 Server workflow 会报失败（HTTP 超时）

## 创建工作流 Body 格式

```json
{
  "title": "任务简述",
  "nodes": [
    {
      "id": "step-1",
      "agent_name": "目标 agent 名称",
      "prompt": "描述目标即可，不要写具体命令",
      "scope": "project",
      "intent": "query"
    }
  ]
}
```

### 必填字段

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 节点 ID |
| agent_name | string | 目标 agent 名称 |
| prompt | string | 任务描述（只写目标） |
| scope | `"project"` \| `"agent_self"` | 操作范围（代码硬约束） |
| intent | `"query"` \| `"modify"` \| `"review"` \| `"diagnose"` \| `"execute"` | 任务意图（代码硬约束） |

### 可选字段

| 字段 | 说明 |
|------|------|
| depends_on | `string[]` 依赖的前置节点 ID |

- scope/intent 不填时默认 `project` / `query`，但建议显式填写
- 返回中若无 `workflow_id`，需从 `GET /api/workflows` 列表中取最新的
