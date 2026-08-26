# Polling & Error Handling

## 何时必须等待

同步等待不是用户流程的另一种模式，而是完成“派发 -> 执行 -> 结果交付”的内部机制。以下任一条件成立即必须等待：

- 用户要求同步看到结果；
- 当前步骤之后的判断或操作依赖远端结果；
- 当前进程环境中的 `MAF_ASYNC_RESULT_DELIVERY` 不精确等于 `verified`。

只有官方 runtime 入口注入的 `verified` 才表示当前聊天可以被恢复并展示异步结果。变量缺失、`notify` 字段存在、SSE 可访问或 runtime 理论支持通知均不足以跳过等待。无法确认时必须同步等待，不能承诺结果会自动回来。

## 等待结果

**必须使用 long-poll 脚本**，禁止手动循环 curl：

```bash
bash scripts/poll-workflow.sh <workflow_id>
```

脚本使用 **long-poll 模式**（`?wait=true`）：
- Server hold 连接直到工作流完成，零轮询延迟
- 每轮最多等 10 秒，超时自动发起下一轮
- 默认最多 360 轮（约 60 分钟总时限）
- 完成时打印结果，失败时打印错误，超时时提示

可选参数：`bash scripts/poll-workflow.sh <id> [timeout_per_poll=10] [max_retries=360]`

## 失败处理

| result 关键词 | 含义 | 应对 |
|--------------|------|------|
| `推送失败` / `Daemon 不可达` | 远端 Daemon 不在线 | 告知用户"远端机器不可达，请检查 Daemon 是否在运行" |
| `Server-side 超时` | 执行超时 | 告知用户"执行超时"，可能是任务太复杂或 agent 拉起慢 |
| 其他 | 业务错误 | 展示具体错误 |

注意：所有 agent 即使 offline/dead 也会通过标准 Workflow 进入 Daemon 处理，Daemon 会按 runtime 能力尝试拉起或唤醒。只有 Daemon 不可达才是真正的基础设施失败。

失败后可 `curl -s -H "Authorization: Bearer $MAF_AUTH_TOKEN" http://localhost:3000/api/agents` 确认 agent 当前状态，决定是否建议重试。

## 脚本退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功完成 |
| 1 | 任务失败 |
| 2 | 异常状态 |
| 3 | 轮询超时 |
