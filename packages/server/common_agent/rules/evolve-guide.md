# Evolve 分发指南

Evolve 是 Meta-Agent-Server 将 skill、agent 配置、MCP 配置或自定义文件推送到远端 Client 的通道。它适合用于 Proposal 审核通过后的能力扩散，也适合做小范围配置修正。

## 使用前检查

1. 确认目标 agent 在线或 Daemon 可达：

```bash
curl -s 'http://localhost:3000/api/agents?fields=agent_name,status,runtime,client_endpoint,capabilities'
```

2. 如需查看全网 skill/MCP 分布：

```bash
curl -s http://localhost:3000/api/agents/inventory
```

3. 如果 Evolve 来自 Proposal，先查看详情：

```bash
curl -s http://localhost:3000/api/proposals/<proposal_id>
```

## Proposal → Evolve → Apply 闭环

```bash
# 1. 接受提议
curl -s -X POST http://localhost:3000/api/proposals/<proposal_id>/review \
  -H 'Content-Type: application/json' \
  -d '{"status":"accepted","review_comment":"采纳并准备分发","reviewed_by":"Meta-Agent-Server"}'

# 2. 执行 Evolve（按下方 skill/config/MCP/broadcast 示例之一）

# 3. 确认 Evolve 结果
curl -s http://localhost:3000/api/evolve/<evolve_id>

# 4. 确认已落地后标记 Proposal 已应用
curl -s -X POST http://localhost:3000/api/proposals/<proposal_id>/apply
```

不要在 Evolve 尚未成功时提前 `apply`。

## 推送 Skill

```bash
curl -s -X POST http://localhost:3000/api/evolve/skill \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_name": "目标 agent",
    "skill_name": "skill-name",
    "files": [
      {
        "relative_path": "SKILL.md",
        "content": "---\nname: skill-name\ndescription: What this skill does.\n---\n\n# Skill\n\n..."
      },
      {
        "relative_path": "reference/guide.md",
        "content": "# Guide\n..."
      }
    ]
  }'
```

注意：

- `SKILL.md` 应包含 YAML frontmatter：`name` 和 `description`。
- `name` 使用小写字母、数字、连字符，例如 `meta-agent-client`。
- Server 只声明逻辑目标 `skill`；Daemon 会按 runtime 映射到实际目录：
  - opencode → `~/.config/opencode/skills/<skill_name>/`
  - Claude Code → `~/.claude/skills/<skill_name>/`
  - Codex → `~/.codex/skills/<skill_name>/`

## 推送 Agent 配置

```bash
curl -s -X POST http://localhost:3000/api/evolve/agent-config \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_name": "目标 agent",
    "restart": true,
    "files": [
      {
        "relative_path": "agent-name.md",
        "content": "# Agent config\n..."
      }
    ]
  }'
```

如需写入项目级 agent 配置，传入 `project_path`；否则 Daemon 使用 runtime 的默认 agent 目录。

## 推送 MCP 配置

```bash
curl -s -X POST http://localhost:3000/api/evolve/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_name": "目标 agent",
    "install_command": "npm install -g some-mcp-server",
    "files": [
      {
        "relative_path": "mcp.json",
        "content": "{\"mcpServers\":{}}"
      }
    ]
  }'
```

MCP 变更通常需要结合目标 runtime 的配置格式；不确定时先派发诊断任务给目标 Agent，让它报告当前 MCP 配置。

## 广播到所有在线 Agent

```bash
curl -s -X POST http://localhost:3000/api/evolve/broadcast \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "广播 skill 更新",
    "actions": [
      {
        "type": "push_files",
        "target": "skill",
        "files": [
          {"relative_path": "skill-name/SKILL.md", "content": "..."}
        ]
      }
    ]
  }'
```

广播只适合低风险、跨团队通用的能力更新。高风险配置应先小范围推送验证。

## 查看推送结果

```bash
# 查看所有 evolve 记录
curl -s http://localhost:3000/api/evolve

# 查看单个 evolve 结果
curl -s http://localhost:3000/api/evolve/<evolve_id>
```

成功后可再次查看 inventory，确认 skill/MCP 分布已更新：

```bash
curl -s http://localhost:3000/api/agents/inventory
```

## 失败处理

| 现象 | 处理 |
| --- | --- |
| `Agent "xxx" not online` | 先按普通 workflow 派发/唤醒，或检查 Daemon 是否可达 |
| `白名单外` | 文件目标路径不在安全白名单；改用 `skill` / `agent-config` / `mcp` 标准目标 |
| skill 不显示 | 检查 `SKILL.md` frontmatter 的 `name` / `description` |
| 写入成功但未生效 | 检查目标 runtime 是否需要重启或重新加载配置 |
