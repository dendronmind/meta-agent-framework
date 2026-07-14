# 多 Agent 编排

## 多节点工作流

当任务需要多个 Agent 协作时，在 `nodes` 中定义多个节点，用 `depends_on` 表达依赖。

```json
{
  "title": "代码修复 + 审查",
  "nodes": [
    {"id": "step-1", "agent_name": "a2b-booster", "prompt": "修复 I2C 问题并提交"},
    {"id": "step-2", "agent_name": "code-reviewer", "prompt": "审查 step-1 的修改", "depends_on": ["step-1"]}
  ]
}
```

- 无依赖的节点会并行执行
- 有依赖的节点会等上游完成后自动开始，上游结果会拼接在 prompt 前面

## 追加工作流

当远端 Agent 只完成了部分步骤（结果中有 `[ ]` 未完成项）：
- 创建新工作流，让同一个 Agent 继续未完成的步骤
- prompt 中说明"继续完成剩余步骤"

## 用户干预

- "跳过测试直接提交" → 新工作流，prompt 明确说"跳过测试"
- "换个 agent 来做" → 重新选 agent
- "算了不做了" → 直接回复用户，不调 API
