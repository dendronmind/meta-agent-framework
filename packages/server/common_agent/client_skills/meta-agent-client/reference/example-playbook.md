# Playbook 示例：a2b-booster

以下是一个真实 Agent 的 Playbook 示例，供参考。

```yaml
---
agent: a2b-booster
version: 1
scenarios:
  - name: code_fix
    trigger: "修复|改代码|fix|bug"
    steps:
      - id: analyze
        name: 分析问题
        required: true
        output: "根因 + 影响范围 + 证据链"
      - id: modify
        name: 修改代码
        required: true
        output: "修改文件列表 + 修改摘要"
      - id: test
        name: 运行测试
        required: true
        output: "测试命令 + 结果（通过/失败）"
      - id: commit
        name: 提交代码
        required: true
        output: "Gerrit Change-Id 或 commit hash"
    completion_criteria: "全部 4 步完成"

  - name: diagnosis
    trigger: "诊断|排查|分析日志|为什么"
    steps:
      - id: collect
        name: 收集信息
        required: true
        output: "日志片段 + 状态位 + 时序"
      - id: analyze
        name: 根因分析
        required: true
        output: "P1/P2/P3 根因 + 证据链"
      - id: recommend
        name: 处置建议
        required: false
        output: "临时方案 + 根治方案 + 验证步骤"
    completion_criteria: "collect + analyze 完成"

  - name: code_review
    trigger: "review|审查|检查代码"
    steps:
      - id: checkout
        name: 获取代码
        required: true
        output: "Change-Id + 文件列表"
      - id: review
        name: 审查代码
        required: true
        output: "问题列表（严重程度 + 位置 + 建议）"
      - id: comment
        name: 提交评论
        required: true
        output: "Gerrit 评论已提交"
      - id: vote
        name: 打分
        required: true
        output: "Code-Review +1/-1/-2 及理由"
    completion_criteria: "全部 4 步完成"
---

# a2b-booster Playbook 详细说明

## code_fix 场景

### analyze 步骤
- 必须定位到具体的函数/文件
- 输出格式遵循 Standard Output Contract（结论→证据链→根因→建议→验证）
- 不得脱离代码证据下结论

### modify 步骤
- 修改前先 `git diff` 确认当前状态
- 修改后列出所有变更文件

### test 步骤
- 优先跑项目已有的测试
- 如果没有自动化测试，说明 "项目无自动化测试" 并建议人工验证点

### commit 步骤
- 使用 Gerrit 提交（如有 gerrit-mcp）
- commit message 遵循项目规范
- 如无 Gerrit 权限，报告 "无提交权限" 而非静默跳过
```
