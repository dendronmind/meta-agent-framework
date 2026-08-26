# 多 Agent 编排

当任务需要多个 Agent 协作时，在 `/api/workflows` 的 `nodes` 中定义多个节点，用 `depends_on` 表达依赖。单 Agent 任务不要使用本文件，直接使用已注入 `meta-agent-server` Skill 的 fast path。

多 Agent 任务仍遵循“派发 -> 执行 -> 结果交付”。下方 `origin` / `notify` 负责结果路由，不证明异步交付能力；是否同步等待必须沿用 Skill 中对 `MAF_ASYNC_RESULT_DELIVERY` 的确定性规则。

## 多节点工作流

```json
{
  "title": "代码修复 + 审查",
  "origin": {"agent_name": "Meta-Agent-Server"},
  "notify": {"mode": "originator", "include_result": true},
  "failure_policy": "all_settled",
  "nodes": [
    {
      "id": "fix",
      "agent_name": "a2b-booster",
      "prompt": "修复 I2C 重试逻辑的问题",
      "scope": "project",
      "intent": "modify"
    },
    {
      "id": "review",
      "agent_name": "code-reviewer",
      "prompt": "审查 fix 节点的修改并给出结论",
      "depends_on": ["fix"],
      "scope": "project",
      "intent": "review"
    }
  ]
}
```

规则：

- 无依赖节点会并行执行。
- 有 `depends_on` 的节点会等待上游完成；上游结果会拼接到后继节点 prompt 前面。
- 多节点示例必须显式填写 `scope` / `intent`，避免默认 `query` 带来歧义。

## failure_policy

| 策略 | 行为 | 适用场景 |
| --- | --- | --- |
| `fail_fast` | 默认；任一节点失败后尽快结束工作流 | 强依赖链、后续无继续价值 |
| `all_settled` | 等待所有已派发/可达分支完成、失败或超时后统一汇总；被失败依赖阻塞的后继标记 `skipped` | 多 Agent 并行诊断、并行调研、希望保留其它分支结果 |

多 Agent 并行任务通常建议使用 `all_settled`，避免一个分支失败导致其它独立分支结果丢失。

## 追加工作流

当远端 Agent 只完成了部分步骤（结果中有 `[ ]` 未完成项或明确说需要继续）：

- 创建新工作流，让同一个 Agent 继续未完成的步骤。
- prompt 中说明“继续完成剩余步骤”，并粘贴上一轮关键结果。
- 不要直接操作远端项目文件。

## 用户干预

- “跳过测试直接提交” → 新工作流，prompt 明确说“跳过测试”。
- “换个 agent 来做” → 重新选 agent 并创建新 workflow。
- “算了不做了” → 直接回复用户，不调 API。
