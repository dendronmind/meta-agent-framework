# API Reference

Base URL: `http://localhost:3000`（默认端口，实际以 `~/.meta-agent-framework/maf.config.json` 中 `server.port` 为准）

Daemon URL: `http://127.0.0.1:4100`（默认端口，实际以配置中 `daemon.port` 为准）

鉴权：Dashboard 不登录、不读取 Access Token。通过 `localhost` / `127.0.0.1` / `::1` 访问时具备管理写权限；通过 LAN/VPN 地址访问时只能匿名读取 Dashboard 固定 GET/SSE 通路。Server 只依据 TCP 对端 `socket.remoteAddress` 判断本机，不信任 Host、Origin 或转发 Header。远端即使携带 Admin Bearer 也不能执行写操作。Client 的任务领取、机器配置读取和结果回报由 Client 机器密钥签名；Server 下发到 Daemon 的任务由 Server Ed25519 密钥签名，Agent 不手工构造签名。

## Server API

| 操作 | 方法 | 端点 | 返回关键字段 |
|------|------|------|-------------|
| 查看所有 Agent | GET | `/api/agents` | Dashboard 只读接口，允许匿名；支持 `?fields=...` 和 `?all=true` |
| Dashboard 访问上下文 | GET | `/api/access-context` | `{local, can_write}`；仅供 UI 展示，Server 仍独立强制鉴权 |
| 删除 Agent | DELETE | `/api/agents/<id>` | 被删除的 agent 对象（404 如不存在） |
| 关闭 Agent | POST | `/api/agents/<id>/stop` | `{ok, agent:{status:"stopped"}, cancelled, remote}`；默认 `force:false`，有活动工作返回 409 |
| 启动 Agent | POST | `/api/agents/<id>/start` | `{ok, agent, remote}`；解除 stopped 门禁，状态按远端真实执行器返回 |
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
| Client 机器身份 | GET | `/api/auth/clients` | `[{client_id, fingerprint, status, source_ip}]` |
| 批准 Client | POST | `/api/auth/clients/<id>/approve` | `{client_id, status:"active"}` |
| 吊销 Client | POST | `/api/auth/clients/<id>/revoke` | `{client_id, status:"revoked"}` |

### Agent 生命周期语义

`stopped` 表示管理员主动关闭 Agent：不可派发、不计入在线、不自动拉起，并跨 Server/Daemon 重启保留。普通 stop 在 Agent 有活动 Task、Workflow、Execution 或 Codex turn 时返回 `409`，不会静默截断；只有调用方已取得明确授权时才传 `{"force":true}`，Server 会先取消关联工作，再让 Daemon 终止 MAF 托管的执行器。

`start` 只解除 stopped 门禁，不伪造在线状态。返回可能是 `standby`、`offline` 或真实执行器仍存活时的 `online`。Node Daemon 是同机多个 Agent 共享的进程，不得使用 Daemon `/shutdown` 代替单 Agent stop。`DELETE /api/agents/<id>` 仍只负责清理 `offline/dead` 历史记录，不能删除 stopped Agent。

## Workflow Body Schema

下列 body 是 Meta-Agent-Server 的标准派发契约。HTTP API 为兼容第三方调用只在代码层强制 `title`、非空 `nodes` 及节点的 `id/agent_name/prompt`；Meta-Agent-Server 自身派发还必须显式提供 `origin`、`notify`、`scope` 和 `intent`，以保证结果路由和意图边界。基础派发直接使用已注入 `meta-agent-server` Skill 中的可执行模板，不需要读取本 API reference。

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
| title | string | 必填；工作流标题 |
| origin | object | 第三方 API 可选，Meta-Agent-Server 标准派发必填；发起方上下文，用于结果通知路由 |
| notify | object | 第三方 API 可选，Meta-Agent-Server 标准派发必填；使用 `{mode:"originator", include_result:true}`。该字段不代表当前入口具备异步交付能力 |
| failure_policy | `"fail_fast"` \| `"all_settled"` | 可选；默认 `fail_fast`，多并行分支建议 `all_settled` |
| nodes | array | 必填；非空工作流节点列表 |

### Node 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 节点 ID |
| agent_name | string | 目标 agent 名称 |
| prompt | string | 任务描述（只写目标） |
| scope | `"project"` \| `"agent_self"` | 可选，默认 `project`；建议显式填写 |
| intent | `"query"` \| `"modify"` \| `"review"` \| `"diagnose"` \| `"execute"` | 可选，默认 `query`；建议显式填写 |
| depends_on | `string[]` | 可选；依赖的前置节点 ID |
| delivery_mode / execution_mode | `"managed"` \| `"attached"` \| `"detached"` \| `"auto"` | 可选；Codex 投递语义。默认 `managed`，由私有 app-server 执行并实时持久化公开事件；`detached` 是 screen/TUI 兼容回退 |

传统 Task 通过 `POST /api/tasks` 创建时，可在 `metadata` 中设置同一字段：

```json
{
  "type": "custom",
  "title": "后台 Codex 任务",
  "description": "分析问题并给出结果",
  "target_agent": "codex-agent",
  "metadata": { "delivery_mode": "managed" }
}
```

取消入口为 `POST /api/workflows/:id/cancel` 和 `POST /api/tasks/:id/cancel`；managed Codex 会映射为 app-server `turn/interrupt`。Workflow 查询返回的 Codex managed 节点包含 `conversation_id` 和 `conversation_turn_id`，可直接查询 `/api/codex/conversations/:id` 或在 Dashboard 打开实时执行过程。

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

`/health` 匿名；Plugin/Hook 调本机 Daemon 的进程间接口时使用 `Authorization: Bearer $(cat ~/.meta-agent-framework/auth/local-token)`。任务入口 `POST /execute` 是例外：它只接受 `X-MAF-Role: server`、`X-MAF-ID: maf-server` 和有效 Server Ed25519 签名，本机 `local-token` 也不能下发任务。Workflow 统一通过该签名入口派发；旧 `/api/tasks/poll` 的响应同样由 Server 签名，Client 验签通过后才入队。

## Agent 状态字段

| status | 含义 |
|--------|------|
| `online` | runtime 接收端在线 |
| `offline` | 心跳超时 15s |
| `dead` | 心跳超时 45s |

派发策略见 `common_agent/rules/dispatch-flow.md`。
