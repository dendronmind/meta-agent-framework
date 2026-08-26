---
name: meta-agent-server
description: Use when acting as Meta-Agent-Server to dispatch MAF workflows, check agent status, handle proposals, evolve skills/config, or answer MAF orchestration requests. For an explicitly named target agent, this skill contains the complete executable dispatch contract; do not search source directories for the API shape.
---

# Meta-Agent-Server Skill

本 Skill 是 Meta-Agent-Server 高频调度契约。明确点名 Agent 的任务必须优先使用这里的模板，不要为确认 `POST /api/workflows` 格式读取业务项目、框架源码或大段规则文件。

## 固定用户流程

对用户始终交付同一个完整流程：**派发 -> 执行 -> 结果交付**。

- `POST /api/workflows` 成功只表示已经派发，不表示用户请求已经完成。
- 异步通知和同步等待只是内部结果交付机制，不能改变或截断上述流程。
- 最终必须向原用户会话展示远端结果或明确失败；“已派发”不能作为任务最终答复。

## 明确点名任务

用户已经给出准确 `<agent_name>` 和任务时：如需确认 Agent 是否存在，只查询一次精简列表；随后直接执行完整模板。不要读取 `common_agent/rules/` 或搜索 `packages/`、`src/`、业务目录来补全请求格式。

```bash
curl -s -H "Authorization: Bearer $MAF_AUTH_TOKEN" \
  'http://localhost:3000/api/agents?fields=agent_name,status,runtime,capabilities'
```

最小、完整、可直接执行的单 Agent 模板：

<!-- MAF_MINIMAL_WORKFLOW_TEMPLATE_BEGIN -->
```bash
curl -s -X POST http://localhost:3000/api/workflows \
  -H "Authorization: Bearer $MAF_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "title": "<一句话任务标题>",
  "origin": {
    "agent_name": "Meta-Agent-Server"
  },
  "notify": {
    "mode": "originator",
    "include_result": true
  },
  "nodes": [
    {
      "id": "step-1",
      "agent_name": "<准确的目标 agent_name>",
      "prompt": "<忠实、完整地透传用户任务>",
      "scope": "project",
      "intent": "query"
    }
  ]
}
JSON
```
<!-- MAF_MINIMAL_WORKFLOW_TEMPLATE_END -->

从响应中提取并保留非空 `workflow_id`。请求失败或响应没有 `workflow_id` 时，不得声称已派发。

`intent`：查看/说明=`query`，修改代码=`modify`，审查=`review`，诊断=`diagnose`，跑命令/测试=`execute`。修改 Agent 自身配置时使用 `scope="agent_self"`；其它任务使用 `scope="project"`。

## 结果交付选择

按以下顺序确定内部机制，不凭感觉或 runtime 名称推断：

1. 用户明确要求同步结果，或本轮后续操作依赖远端结果：同步等待。
2. 否则，仅当当前进程环境精确满足 `MAF_ASYNC_RESULT_DELIVERY=verified` 时，才允许异步通知。
3. 变量缺失、为空或为其它值时一律同步等待。`notify` 已填写、SSE 存在、某 runtime 理论上支持回调，都不是能力证明。

同步等待使用：

```bash
bash scripts/poll-workflow.sh <workflow_id>
```

禁止手写循环 `curl`。等待结束后整理节点结果并向用户交付；失败时交付具体错误。

异步仅表示官方 runtime 入口已经确认能恢复发起会话并展示通知。此时可以把“已派发，正在执行；完成后将在本会话交付结果”作为进度消息，但收到回调后仍必须完成结果交付。无法确认能力时，不得说“结果会自动回来”。

## Agent 生命周期控制

这些操作语义不同，必须按用户意图选择：

| 用户意图 | 操作 |
| --- | --- |
| 停止当前工作，但 Agent 之后仍可接任务 | 取消对应 Task、Workflow 或 Execution |
| 关闭一个远程 Agent，并禁止它自动拉起 | `POST /api/agents/<id>/stop` |
| 恢复被管理员关闭的 Agent | `POST /api/agents/<id>/start` |
| 关闭一台机器共享的 Node Daemon | 影响同机所有 Agent，不作为 Agent 生命周期操作 |
| 清理离线历史记录 | `DELETE /api/agents/<id>`，只允许 `offline/dead` |

先用精简查询取得准确 ID，不根据简称猜测：

```bash
curl -s -H "Authorization: Bearer $MAF_AUTH_TOKEN" \
  'http://localhost:3000/api/agents?fields=id,agent_name,status,runtime'
```

普通关闭模板：

<!-- MAF_AGENT_STOP_TEMPLATE_BEGIN -->
```bash
curl -s -X POST \
  "http://localhost:3000/api/agents/<agent-id>/stop" \
  -H "Authorization: Bearer $MAF_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"force":false,"reason":"用户要求关闭远程 Agent"}'
```
<!-- MAF_AGENT_STOP_TEMPLATE_END -->

启动模板：

<!-- MAF_AGENT_START_TEMPLATE_BEGIN -->
```bash
curl -s -X POST \
  "http://localhost:3000/api/agents/<agent-id>/start" \
  -H "Authorization: Bearer $MAF_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"用户要求恢复远程 Agent"}'
```
<!-- MAF_AGENT_START_TEMPLATE_END -->

- 默认只能使用 `force:false`。响应 `409` 表示存在活动工作，应向用户说明冲突，不得擅自重试。
- 只有用户明确要求强制关闭，或在获知会取消哪些活动工作后再次确认，才可把同一请求改成 `force:true`。
- `stopped` 是持久门禁：不可派发、不计入在线，Daemon/Plugin/Hook 重连也不会自动恢复；`start` 只解除门禁，返回状态仍以远端真实执行器为准。
- 不直接调用 Daemon `/shutdown`。该端点用于共享 Daemon 的维护重启，错误使用会影响同机所有 Agent。

## 复杂场景

仅在需要对应能力时读取：

| 场景 | 读取文件 |
| --- | --- |
| Agent 选择、状态策略、完整交付细节 | `common_agent/rules/dispatch-flow.md` |
| 多 Agent DAG / depends_on / all_settled | `common_agent/rules/multi-agent-workflow.md` |
| 超时、失败分类、重试 | `common_agent/rules/polling-strategy.md` |
| Proposal / Evolve | `common_agent/rules/evolve-guide.md` |
| 生命周期 API 详细语义 | `common_agent/rules/api-reference.md` |
| 其它 API schema | `common_agent/rules/api-reference.md` |
| 复杂 prompt 透传 | `common_agent/rules/prompt-guide.md` |

不要亲自读业务代码、改业务代码或跑业务测试。框架托管文件不要直接修改；长期内容写入 `user/`。Server 默认地址为 `http://localhost:3000`，实际端口以 `~/.meta-agent-framework/maf.config.json` 为准。
