#!/usr/bin/env bash
#
# 等待工作流完成（long-poll 模式，零延迟）
#
# Server 支持 ?wait=true：工作流未完成时 hold 连接（最多 55s），完成后立即返回。
# 脚本循环发起 long-poll，直到工作流完成/失败或超过总时限。
#
# 用法：bash scripts/poll-workflow.sh <workflow_id> [timeout_per_poll=55] [max_retries=8]
#
set -uo pipefail

WF_ID="${1:?用法: bash scripts/poll-workflow.sh <workflow_id> [timeout_per_poll] [max_retries]}"
POLL_TIMEOUT="${2:-55}"
MAX="${3:-8}"

# Server URL：环境变量 > maf.config.json > 默认
if [[ -n "${META_AGENT_SERVER:-}" ]]; then
  BASE="$META_AGENT_SERVER"
elif [[ -f "$HOME/.meta-agent-framework/maf.config.json" ]]; then
  BASE=$(python3 -c "import json;print(json.load(open('$HOME/.meta-agent-framework/maf.config.json')).get('server',{}).get('url','http://localhost:3000'))" 2>/dev/null || echo "http://localhost:3000")
else
  BASE="http://localhost:3000"
fi

# 管理 API 使用 Server 本机 Admin Bearer。maf-server 启动 runtime 时会注入
# MAF_AUTH_TOKEN；直接运行脚本时则从 Server 状态目录读取。
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

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'

FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
FRAME_COUNT=${#FRAMES[@]}

IS_TTY=false
[[ -t 1 ]] && IS_TTY=true

echo ""

for ((try=1; try<=MAX; try++)); do
  # 显示等待状态
  if $IS_TTY; then
    printf "\r\033[2K  ${CYAN}${FRAMES[0]}${NC} long-poll 等待结果 [${try}/${MAX}] ${DIM}(最多 ${POLL_TIMEOUT}s)${NC}"
  else
    echo -e "  ${CYAN}⏳${NC} long-poll 等待结果 [${try}/${MAX}] — 最多 ${POLL_TIMEOUT}s ..."
  fi

  # long-poll 请求：Server hold 连接直到工作流完成或超时
  RESP=$(curl -s --max-time $((POLL_TIMEOUT + 5)) \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    "${BASE}/api/workflows/${WF_ID}?wait=true&timeout=$((POLL_TIMEOUT * 1000))" 2>/dev/null)

  $IS_TTY && printf "\r\033[2K"

  STATUS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "error")

  case "$STATUS" in
    completed)
      echo -e "  ${GREEN}✅ 任务完成${NC}"
      echo ""
      echo "$RESP" | python3 -c "
import json, sys
wf = json.load(sys.stdin)
for n in wf.get('nodes', []):
    name = n.get('agent_name', '?')
    result = n.get('result', '(无结果)')
    print(f'--- [{name}] ---')
    print(result)
    print()
" 2>/dev/null
      exit 0
      ;;
    failed)
      echo -e "  ${RED}❌ 任务失败${NC}"
      echo ""
      echo "$RESP" | python3 -c "
import json, sys
wf = json.load(sys.stdin)
for n in wf.get('nodes', []):
    name = n.get('agent_name', '?')
    result = n.get('result', '(无结果)')
    status = n.get('status', '?')
    print(f'[{name}] status={status}')
    print(result)
    print()
" 2>/dev/null
      exit 1
      ;;
    running)
      # Server long-poll 超时返回了当前状态，继续下一轮
      ;;
    *)
      echo -e "  ${YELLOW}⚠ 异常状态: ${STATUS}${NC}"
      echo "$RESP"
      exit 2
      ;;
  esac
done

echo -e "  ${RED}⏱ 超时：${MAX} 轮 long-poll 后任务仍在运行（总计 ~$((MAX * POLL_TIMEOUT))s）${NC}"
exit 3
