# 标准派发流程

每次需要远端 Agent 执行业务任务时，按本文件操作。Meta-Agent-Server 自己只负责调度、跟踪和交付，不亲自读业务代码、改业务代码或跑业务测试。

## Fast path：用户已明确点名 agent

如果用户已经明确说“让/请/叫 `<agent_name>` 做 `<任务>`”：

1. 不要再读取完整 agent/rules 文档；不要为简单派发 `sed`/`cat` 大文件。
2. 如需确认目标是否存在，只做一次精简状态查询：
   `curl -s 'http://localhost:3000/api/agents?fields=agent_name,status,runtime,capabilities'`
3. 直接执行下方 Step 2 的异步 `POST /api/workflows`。
4. 派发后不轮询，回复“已派发给 xxx，结果会自动回来。”

只有目标不明确、多 Agent 编排、同步等待、失败重试、Proposal/Evolve 等情况才加载其它规则文件。

## Step 1 — 选人（如已知目标 agent 可跳过）

```bash
curl -s 'http://localhost:3000/api/agents?fields=agent_name,status,runtime,capabilities'
```

从返回的 `agent_name`、`capabilities`、`runtime`、`status` 中匹配目标。只要目标 agent 存在，就优先通过标准 Workflow 派发；是否需要拉起、唤醒或等待由 Server/Daemon 根据 runtime 能力处理。

## Step 2 — 派发

默认使用异步派发，让结果通过后台通知回到发起方：

```bash
curl -s -X POST http://localhost:3000/api/workflows \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "<一句话概述>",
    "origin": {"agent_name": "Meta-Agent-Server"},
    "notify": {"mode": "originator", "include_result": true},
    "nodes": [{
      "id": "step-1",
      "agent_name": "<agent名>",
      "prompt": "<忠实透传用户任务；只写目标，不写具体命令>",
      "scope": "<project|agent_self>",
      "intent": "<query|modify|review|diagnose|execute>"
    }]
  }'
```

要点：

- 异步派发必须保留 `origin.agent_name="Meta-Agent-Server"`、`notify.mode="originator"`、`notify.include_result=true`。
- `origin` / `notify` 只用于把完成结果路由回发起方，不改变目标 agent runtime。
- 通用模板不要硬编码 `origin.runtime`；只有明确知道当前 runtime 时才额外填写。
- 从返回中提取 `workflow_id`；如果需要同步等待，进入 Step 3。

## Step 3 — 同步等待（仅必要时）

用户明确要求立即看到结果，或后续操作依赖该结果时使用：

```bash
bash scripts/poll-workflow.sh <workflow_id>
```

不要手动循环 curl。脚本会自动 long-poll 并输出结果；超时/失败细节见 `polling-strategy.md`。

## Step 4 — 交付

将异步通知或 poll 脚本输出的结果整理后汇报给用户。如果失败，按 `polling-strategy.md` 的失败处理规则应对。

## scope/intent 速查

| 用户意图 | scope | intent |
|----------|-------|--------|
| 查看代码/日志/状态 | `project` | `query` |
| 改代码/加功能/修 bug | `project` | `modify` |
| 代码审查/review | `project` | `review` |
| 排查问题/诊断 | `project` | `diagnose` |
| 跑命令/编译/测试 | `project` | `execute` |
| 改 agent 自身配置 | `agent_self` | `modify` |
| 查 agent 自身信息 | `agent_self` | `query` |

## Agent 状态与派发策略

| 状态 | 策略 |
|------|------|
| `online` | 直接派发，通常会立即执行 |
| `offline` / `dead` | 仍正常派发；Daemon 可达时会按 runtime 能力尝试拉起或唤醒 |

- **所有 agent 不论 runtime、不论状态，都优先通过 Workflow 正常派发。**
- 只有 Daemon 不可达、HTTP 超时或 Server 明确返回基础设施错误时，才告知用户检查远端机器/Daemon。
- 首次自动拉起可能需要约 15–30 秒。

## 何时读取其它规则

| 场景 | 读取 |
| --- | --- |
| 多节点、多 Agent、并行/依赖 | `multi-agent-workflow.md` |
| 同步等待、超时、失败重试 | `polling-strategy.md` |
| Evolve / Proposal 采纳后推送 | `evolve-guide.md` |
| 查 endpoint/body 字段 | `api-reference.md` |
| prompt 容易歧义 | `prompt-guide.md` |
