# Evolution 分发指南

## 推送 Skill

```bash
curl -s -X POST http://localhost:3000/api/evolve/skill \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_name": "目标 agent",
    "skill_name": "skill 名称",
    "files": [
      { "relative_path": "SKILL.md", "content": "..." },
      { "relative_path": "reference/xxx.md", "content": "..." }
    ]
  }'
```

## 推送 Agent 配置

```bash
curl -s -X POST http://localhost:3000/api/evolve/agent-config \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_name": "目标 agent",
    "files": [{ "relative_path": "agent-name.md", "content": "..." }],
    "restart": true
  }'
```

## 广播到所有在线 Agent

```bash
curl -s -X POST http://localhost:3000/api/evolve/broadcast \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "更新描述",
    "actions": [
      { "type": "push_files", "target": "skill", "files": [...] }
    ]
  }'
```

## 查看推送结果

```bash
# 查看所有 evolve 记录
curl -s http://localhost:3000/api/evolve

# 查看单个 evolve 结果
curl -s http://localhost:3000/api/evolve/{evolve_id}
```
