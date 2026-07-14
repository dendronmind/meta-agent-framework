# Agent Playbook 规范

## 概述

Playbook 是每个从 Agent 的「做事剧本」，定义它在不同场景下应该走哪些步骤。

**两个读者：**
- **从 Agent 自己**：知道"我应该按什么顺序做事"
- **Meta-Agent-Server**：知道"它应该做完哪些步骤，做到哪一步了，下一步该催它干嘛"

## 文件位置

Playbook 放在 agent 的项目目录中，紧挨着 agent 定义文件：

```
# opencode 运行时
{project_path}/.opencode/agents/
  ├── my-agent.md          # agent 定义
  └── my-agent.playbook.md # 该 agent 的 playbook

# claude-code 运行时
{project_path}/
  ├── CLAUDE.md             # agent 定义
  └── PLAYBOOK.md           # 该 agent 的 playbook
```

## 格式规范

Playbook 用 YAML frontmatter + Markdown 描述：

```yaml
---
agent: a2b-booster                  # 对应的 agent 名称
version: 1
scenarios:                          # 场景列表（一个 agent 可能处理多种场景）
  - name: code_fix                  # 场景标识符
    trigger: "修复代码|改代码|fix"    # 触发关键词（Meta-Agent-Server 用来匹配）
    steps:
      - id: analyze
        name: 分析问题
        required: true               # 必需步骤
        output: "问题根因 + 影响范围"  # 期望输出
      - id: modify
        name: 修改代码
        required: true
        output: "修改文件列表 + 修改摘要"
      - id: test
        name: 运行测试
        required: true
        output: "测试结果（通过/失败 + 详情）"
      - id: commit
        name: 提交代码
        required: true
        output: "Gerrit Change-Id 或 Git commit hash"
    completion_criteria: "所有 required 步骤完成"

  - name: diagnosis
    trigger: "诊断|排查|分析日志"
    steps:
      - id: collect
        name: 收集信息
        required: true
        output: "日志关键片段 + 状态位"
      - id: analyze
        name: 根因分析
        required: true
        output: "根因结论 + 证据链"
      - id: recommend
        name: 处置建议
        required: false
        output: "临时方案 + 根治方案"
    completion_criteria: "collect + analyze 完成"
---

# Playbook 详细说明

（以下 Markdown 内容是给 agent 自己参考的详细指引...）
```

## 关键设计点

### 1. Meta-Agent-Server 如何使用 Playbook

```
任务进入 "帮 a2b-booster 修复 I2C 重试逻辑"
  ↓
Meta-Agent-Server 查找 a2b-booster 的 playbook
  ↓
匹配场景：trigger 含"修复" → code_fix 场景
  ↓
看到 4 个步骤：analyze → modify → test → commit
  ↓
第一轮：下发 prompt "分析 + 修改代码"
  ↓
a2b-booster 回报："改完了，修改了 3 个文件"
  ↓
Meta-Agent-Server 对照 playbook：
  ✅ analyze — 有根因分析
  ✅ modify — 有文件列表
  ❌ test — 未提及测试
  ❌ commit — 未提交
  ↓
第二轮：下发 prompt "请运行测试并提交到 Gerrit"
  ↓
a2b-booster 回报："测试通过，已提交 Change-Id: I1234"
  ↓
Meta-Agent-Server 对照 playbook：
  ✅ analyze ✅ modify ✅ test ✅ commit
  → 全部完成，工作流结束
```

### 2. 从 Agent 如何使用 Playbook

从 Agent 在收到任务时，应该：
1. 读取自己的 playbook
2. 识别当前场景
3. 按步骤顺序执行
4. 每个步骤的输出包含明确的状态标记

### 3. 没有 Playbook 的 Agent

- Meta-Agent-Server 当作"单步任务"处理：发 prompt → 收结果 → 结束
- 不做多轮检查
