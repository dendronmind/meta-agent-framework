# 标准派发流程

Meta-Agent-Server 只负责调度、跟踪和交付，不亲自读业务代码、改业务代码或跑业务测试。用户视角的流程固定为：**派发 -> 执行 -> 结果交付**。

## Fast path：用户已明确点名 Agent

各 runtime 安装的 `.opencode/skills/meta-agent-server/SKILL.md`、`.claude/skills/meta-agent-server/SKILL.md` 或 `.codex/skills/meta-agent-server/SKILL.md` 内容相同，其中的单 Agent 模板是基础派发的规范源和可执行速查。目标 Agent 与任务均明确时，直接使用该模板：

- 不读取本文件、API reference、业务目录或框架源码来确认请求格式。
- 如需确认目标存在，只做一次精简 Agent 查询。
- 请求成功必须取得非空 `workflow_id`；派发确认不是最终结果。

本文件只补充选人、状态和高级交付细节，不复制 fast path 请求模板。

## Step 1 - 选人（已知目标时跳过）

```bash
curl -s -H "Authorization: Bearer $MAF_AUTH_TOKEN" \
  'http://localhost:3000/api/agents?fields=agent_name,status,runtime,capabilities'
```

从 `agent_name`、`capabilities`、`runtime`、`status` 中匹配目标。只要目标存在，就通过标准 Workflow 派发；拉起、唤醒和 runtime 路由由 Server/Daemon 处理。

## Step 2 - 派发与执行

使用 Meta-Agent-Server Skill 中的完整 `POST /api/workflows` 模板。标准单 Agent 派发必须显式包含：

- `title`
- `origin.agent_name="Meta-Agent-Server"`
- `notify.mode="originator"` 与 `notify.include_result=true`
- 非空 `nodes`，每个节点显式包含 `id`、`agent_name`、`prompt`、`scope`、`intent`

`origin` / `notify` 提供结果路由元数据，但它们本身不证明当前聊天入口具有异步回传能力。不要硬编码 `origin.runtime`；只有确定当前 runtime 和精确会话标识时才补充相应字段。

## Step 3 - 选择内部交付机制

确定性规则：

| 条件 | 机制 |
| --- | --- |
| 用户要求同步，或后续步骤依赖结果 | 同步等待 |
| `MAF_ASYNC_RESULT_DELIVERY` 精确等于 `verified`，且没有同步依赖 | 可使用异步通知 |
| 能力变量缺失、为空或任何其它值 | 同步等待 |

同步等待执行：

```bash
bash scripts/poll-workflow.sh <workflow_id>
```

不得把 runtime 名称、`notify` 字段、SSE 端点或“已经安装过插件”当作异步能力证明。未获确定性证明时不得声称结果会自动回来。

## Step 4 - 结果交付

- 同步：poll 脚本终止后，整理节点结果或失败原因并回复用户。
- 异步：当前回复只能作为派发进度；runtime 恢复原会话后，仍需整理通知中的节点结果并回复用户。
- 不论内部机制，只有用户看到结果或明确失败，流程才完成。

## scope/intent 速查

| 用户意图 | scope | intent |
|----------|-------|--------|
| 查看代码/日志/状态 | `project` | `query` |
| 改代码/加功能/修 bug | `project` | `modify` |
| 代码审查/review | `project` | `review` |
| 排查问题/诊断 | `project` | `diagnose` |
| 跑命令/编译/测试 | `project` | `execute` |
| 改 Agent 自身配置 | `agent_self` | `modify` |
| 查 Agent 自身信息 | `agent_self` | `query` |

## Agent 状态与派发策略

| 状态 | 策略 |
|------|------|
| `online` / `busy` / `standby` | 正常派发，由 Server/Daemon 投递或拉起执行器 |
| `offline` / `dead` | 不承诺可执行；先报告当前状态，仅在用户仍要求尝试时派发 |

Daemon 不可达、HTTP 超时或 Server 返回基础设施错误时，向用户交付明确错误。不要把已创建但无法执行的 Workflow 描述为正在正常执行。

## 何时读取其它规则

| 场景 | 读取 |
| --- | --- |
| 多节点、多 Agent、并行/依赖 | `multi-agent-workflow.md` |
| 超时、失败分类、重试 | `polling-strategy.md` |
| Evolve / Proposal | `evolve-guide.md` |
| 其它 endpoint/body 字段 | `api-reference.md` |
| prompt 容易歧义 | `prompt-guide.md` |
