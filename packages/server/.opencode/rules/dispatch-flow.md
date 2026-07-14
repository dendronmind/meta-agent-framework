# 标准派发流程

每次需要远端 Agent 执行任务时，严格按以下固定步骤操作，**不需要额外推理**。

## 步骤（机械执行，不要思考）

### Step 1 — 选人（如已知目标 agent 可跳过）
```bash
curl -s http://localhost:3000/api/agents
```
从返回的 agent 列表中匹配 `agent_name`、`capabilities` 关键词。
opencode agent 不论 status 都可派发（Daemon 会自动拉起）；claude-code agent 需 status=online。

### Step 2 — 派发
```bash
curl -s -X POST http://localhost:3000/api/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "title": "<一句话概述>",
    "origin": {
      "agent_name": "Meta-Agent-Server"
    },
    "notify": {
      "mode": "originator",
      "include_result": true
    },
    "nodes": [{
      "id": "step-1",
      "agent_name": "<agent名>",
      "prompt": "<目标描述>",
      "scope": "<project|agent_self>",
      "intent": "<query|modify|review|diagnose|execute>"
    }]
}'
```
从返回中提取 `workflow_id`。

`origin` / `notify` 是后台结果回到当前/发起方 TUI 的路由元数据，不参与任务执行，也不会改变目标 agent runtime。异步派发不要省略它们；至少必须保留 `origin.agent_name="Meta-Agent-Server"` 和 `notify.mode="originator"`。通用模板不要硬编码 `origin.runtime`，只有明确当前 runtime 时才额外填写。

### Step 3 — 轮询（用脚本，不要手动 curl）
```bash
bash scripts/poll-workflow.sh <workflow_id>
```
脚本会自动显示进度并输出结果。

### Step 4 — 交付
将脚本输出的结果整理后汇报给用户。如果失败，按 polling-strategy.md 的失败处理规则应对。

## scope/intent 速查

| 用户意图 | scope | intent |
|----------|-------|--------|
| 查看代码/日志/状态 | project | query |
| 改代码/加功能/修 bug | project | modify |
| 代码审查/review | project | review |
| 排查问题/诊断 | project | diagnose |
| 跑命令/编译/测试 | project | execute |
| 改 agent 自身配置 | agent_self | modify |
| 查 agent 自身信息 | agent_self | query |

## Agent 状态与派发策略

| 状态 | 能否派发 |
|------|---------|
| `online` | ✅ 直接派发，立即执行 |
| `offline` / `dead` | ✅ 正常派发 — Daemon 可达时自动通过 screen 拉起 TUI 执行 |

- **所有 agent 不论 runtime 不论状态都正常派发**，Daemon 自动处理拉起
- 如果 Daemon 也不可达（HTTP 超时），Server workflow 会报失败，此时告知用户检查远端机器

## 注意

- prompt 只写"做什么"，不写"怎么做"
- 远端 Agent 是领域专家，它自己决定实现方式
- 首次自动拉起可能需要 ~15-30s 启动时间
- 用户可通过 `screen -r maf-{agent名}` 附上去查看被拉起的 agent
