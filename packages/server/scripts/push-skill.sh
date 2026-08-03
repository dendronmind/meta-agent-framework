#!/usr/bin/env bash
#
# push-skill.sh — 将整个 skill 目录推送到指定 agent
#
# 用法:
#   bash scripts/push-skill.sh <agent_name> <skill_name> [skill_dir]
#
# 示例:
#   bash scripts/push-skill.sh a2b-booster meta-agent-client
#   bash scripts/push-skill.sh MAF-developer meta-agent-client common_agent/client_skills/meta-agent-client
#
# skill_dir 默认优先使用安装态 skills/<skill_name>；
# 在源码包内开发运行时，回退到 common_agent/client_skills/<skill_name>。

set -euo pipefail

AGENT_NAME="${1:-}"
SKILL_NAME="${2:-}"
SKILL_DIR="${3:-}"
# Server URL：环境变量 > maf.config.json > 默认
if [[ -n "${META_AGENT_SERVER:-}" ]]; then
  SERVER_URL="$META_AGENT_SERVER"
elif [[ -f "$HOME/.meta-agent-framework/maf.config.json" ]]; then
  SERVER_URL=$(python3 -c "import json;print(json.load(open('$HOME/.meta-agent-framework/maf.config.json')).get('server',{}).get('url','http://localhost:3000'))" 2>/dev/null || echo "http://localhost:3000")
else
  SERVER_URL="http://localhost:3000"
fi
MAF_STATE_HOME="${MAF_HOME:-$HOME/.meta-agent-framework}"
AUTH_TOKEN="${MAF_AUTH_TOKEN:-}"
if [[ -z "$AUTH_TOKEN" && -f "$MAF_STATE_HOME/maf.config.json" ]]; then
  AUTH_TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("auth",{}).get("token",""))' "$MAF_STATE_HOME/maf.config.json" 2>/dev/null || true)
fi
if [[ -z "$AUTH_TOKEN" && -f "$MAF_STATE_HOME/auth/admin-token" ]]; then
  AUTH_TOKEN=$(<"$MAF_STATE_HOME/auth/admin-token")
fi
if [[ -z "$AUTH_TOKEN" ]]; then
  echo "无法读取 MAF Admin Token: $MAF_STATE_HOME/auth/admin-token" >&2
  exit 2
fi

if [[ -z "$AGENT_NAME" || -z "$SKILL_NAME" ]]; then
  echo "用法: bash scripts/push-skill.sh <agent_name> <skill_name> [skill_dir]"
  exit 1
fi

# 定位 skill 目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [[ -z "$SKILL_DIR" ]]; then
  SKILL_DIR="$PROJECT_ROOT/skills/$SKILL_NAME"
  if [[ ! -d "$SKILL_DIR" && -d "$PROJECT_ROOT/common_agent/client_skills/$SKILL_NAME" ]]; then
    SKILL_DIR="$PROJECT_ROOT/common_agent/client_skills/$SKILL_NAME"
  fi
fi

if [[ ! -d "$SKILL_DIR" ]]; then
  echo "❌ skill 目录不存在: $SKILL_DIR"
  exit 1
fi

# 扫描目录下所有文件，构建 files JSON 数组
FILES_JSON="["
FIRST=true

while IFS= read -r -d '' filepath; do
  # 计算相对路径
  rel_path="${filepath#$SKILL_DIR/}"
  # 读取文件内容，转义为 JSON 字符串
  content=$(python3 -c "
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    print(json.dumps(f.read()))
" "$filepath")

  if [[ "$FIRST" == "true" ]]; then
    FIRST=false
  else
    FILES_JSON+=","
  fi
  FILES_JSON+="{\"relative_path\":$(python3 -c "import json; print(json.dumps('$rel_path'))"),\"content\":$content}"
done < <(find "$SKILL_DIR" -type f -print0 | sort -z)

FILES_JSON+="]"

# 构建完整请求 body
BODY=$(python3 -c "
import json, sys
body = {
    'agent_name': sys.argv[1],
    'skill_name': sys.argv[2],
    'files': json.loads(sys.argv[3])
}
print(json.dumps(body))
" "$AGENT_NAME" "$SKILL_NAME" "$FILES_JSON")

# 推送
echo "📦 推送 skill '$SKILL_NAME' → $AGENT_NAME"
echo "   目录: $SKILL_DIR"
echo "   文件数: $(echo "$FILES_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"

RESULT=$(curl -s -X POST "$SERVER_URL/api/evolve/skill" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY")

PUSHED=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('pushed', False))" 2>/dev/null || echo "false")

if [[ "$PUSHED" == "True" ]]; then
  echo "✅ 推送成功"
  echo "   $RESULT"
else
  echo "❌ 推送失败"
  echo "   $RESULT"
  exit 1
fi
