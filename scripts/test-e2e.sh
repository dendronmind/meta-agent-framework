#!/usr/bin/env bash
#
# Meta-Agent-Framework 端到端测试
#
# 用法：
#   npm run test:e2e              # 跑所有 case
#   npm run test:e2e -- 3         # 只跑 case 3
#   npm run test:e2e -- 14 15     # 只跑 case 14 和 15
#   npm run test:e2e -- 13-17     # 跑 case 13 到 17
#
# Case 列表：
#   1  Server 启动
#   2  OC agent 启动（Plugin → Daemon）
#   3  Agent 注册验证
#   4  Skills/MCPs 上报
#   5  CC agent 注册（共用 Daemon）
#   6  OTA 写文件
#   7  OTA Daemon 自更新
#   8  单 agent 正常退出
#   9  单 agent 异常退出
#   10 Daemon 被杀 → 自动恢复
#   11 Server 重启
#   12 按需拉起 opencode
#   13 Claude Code 任务链路
#   14 Proposal Server API
#   15 Proposal Daemon 代理
#   16 Evolve 进化推送
#   17 SSE 事件广播
#   28 check-write-path.mjs 写入保护
#   29 syncWorkspace managed asset overwrite
#   30 maf-client sessions 输出格式
#   31 Plugin 非 Manager 不接收 workflow 广播
#   32 Agent 切换时 disconnect 旧 agent
#   33 Codex runtime screen+TUI 链路
#   34 Codex plugin SessionStart 自动拉起 Daemon
#   35 Codex launcher wrapper 自动拉起 Daemon
#   36 Codex attached 默认不伪装 online
#   37 Codex attached receiver app-server bridge
#   38 Codex wrapper auto-remote attached receiver
#   39 Codex attached receiver thread/read fallback
#   40 Workflow all_settled waits for parallel branches
#   41 maf-init required input and incomplete config resume
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/server" && pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; TOTAL=0
SERVER_PID=""; MOCK_PID=""

E2E_STATE_DIR="/tmp/maf-e2e-state"
E2E_MAF_HOME="/tmp/maf-e2e-home"
E2E_USER_HOME="/tmp/maf-e2e-user"
E2E_DB_PATH="/tmp/maf-e2e.db"
E2E_BIN="/tmp/maf-e2e-bin"
DAEMON_LOG="$E2E_USER_HOME/.meta-agent-framework/logs/client-daemon.log"

# 测试端口（与真实环境隔离）
E2E_SERVER_PORT=13000
NODE_PORT=14100
E2E_SERVER="http://localhost:$E2E_SERVER_PORT"
DAEMON_URL="http://127.0.0.1:$NODE_PORT"

# ============================================================
# 参数解析：确定要跑哪些 case
# ============================================================
ALL_CASES=(1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41)
RUN_CASES=()

if [[ $# -eq 0 ]]; then
  RUN_CASES=("${ALL_CASES[@]}")
else
  for arg in "$@"; do
    if [[ "$arg" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      # 范围：13-17
      for i in $(seq "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"); do
        RUN_CASES+=($i)
      done
    elif [[ "$arg" =~ ^[0-9]+$ ]]; then
      RUN_CASES+=($arg)
    fi
  done
fi

# 判断某个 case 是否需要跑
should_run() { for c in "${RUN_CASES[@]}"; do [[ "$c" == "$1" ]] && return 0; done; return 1; }

# 计算需要的依赖 setup
NEED_SERVER=false
NEED_DAEMON=false
NEED_CC=false
for c in "${RUN_CASES[@]}"; do
  NEED_SERVER=true
  if [[ $c -ge 2 && $c -le 13 ]] || [[ $c -eq 15 ]] || [[ $c -eq 16 ]] || [[ $c -ge 18 && $c -le 21 ]] || [[ $c -eq 32 ]] || [[ $c -eq 33 ]]; then NEED_DAEMON=true; fi
  if [[ $c -eq 5 || $c -eq 7 || $c -eq 8 || $c -eq 9 || $c -eq 10 || $c -eq 11 || $c -eq 13 || $c -eq 18 ]]; then NEED_CC=true; fi
done

# ============================================================
# 工具函数
# ============================================================
assert() {
  local name=$1 expected=$2 actual=$3
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -q "$expected"; then
    echo -e "  ${GREEN}✅ ${name}${NC}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ ${name}${NC} (want: ${expected}, got: ${actual})"
    FAIL=$((FAIL + 1))
    exit 1
  fi
}

wait_until() {
  local max=$1 cmd=$2 pattern=$3
  for i in $(seq 1 $max); do
    local val
    val=$(eval "$cmd" 2>/dev/null)
    if echo "$val" | grep -q "$pattern" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

get_agent_field() {
  local field=$1 name=${2:-$AGENT_NAME}
  curl -s $E2E_SERVER/api/agents 2>/dev/null | \
    python3 -c "import json,sys;[print(a.get('$field','')) for a in json.load(sys.stdin) if a['agent_name']=='$name']" 2>/dev/null
}

CC_AGENT="cc-e2e-agent"

start_cc_agent() {
  HOME="$E2E_USER_HOME" MAF_AGENT_NAME="$CC_AGENT" MAF_RUNTIME="claude-code" \
  MAF_NODE_PORT=$NODE_PORT \
  MAF_DIRECTORY="/tmp/e2e-cc-project" MAF_USER_ID="e2e-testuser" \
  META_AGENT_SERVER="$E2E_SERVER" \
  node plugins/claude-code-plugin-maf/scripts/maf-agent.mjs --daemon --forked &>/dev/null &
  disown $!
}

start_mock_opencode() {
  HOME="$E2E_USER_HOME" MOCK_OPENCODE_PORT=$MOCK_PORT \
  MOCK_PLUGIN_DIR="$PLUGIN_DIR" \
  MOCK_DIRECTORY="/tmp/e2e-test-project" \
  META_AGENT_SERVER="$E2E_SERVER" \
  MAF_USER_ID="e2e-testuser" \
  MAF_NODE_PORT=$NODE_PORT \
  MAF_CODEX_DELIVERY="detached" \
  node "$ROOT_DIR/scripts/mock-opencode.mjs" "$AGENT_NAME" &>/dev/null &
  MOCK_PID=$!
  disown $MOCK_PID
}

cleanup() {
  echo -e "\n${YELLOW}清理...${NC}"
  [[ -n "$MOCK_PID" ]] && kill -9 "$MOCK_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && kill -9 "$SERVER_PID" 2>/dev/null
  local DAEMON_PID
  DAEMON_PID=$(ss -tlnp 2>/dev/null | grep ":${NODE_PORT} " | grep -oP 'pid=\K\d+' | head -1)
  [[ -n "$DAEMON_PID" ]] && kill -9 "$DAEMON_PID" 2>/dev/null || true
  pkill -9 -f "maf-agent.mjs.*${NODE_PORT}" 2>/dev/null || true
  pkill -f "opencode.*serve.*e2e" 2>/dev/null || true
  sleep 1
  for p in $E2E_SERVER_PORT $MOCK_PORT $NODE_PORT 14134 14135 14136 14137 14138 14139 14937 14938 14940; do
    PID=$(ss -tlnp 2>/dev/null | grep ":${p} " | grep -oP 'pid=\K\d+' | head -1)
    [[ -n "$PID" ]] && kill -9 "$PID" 2>/dev/null || true
  done
  rm -f "$E2E_DB_PATH" ~/.meta-agent-framework/ota-e2e-test.txt
  rm -f /tmp/cc-e2e-stderr.log
  rm -rf "$E2E_STATE_DIR" "$PLUGIN_DIR" "$E2E_MAF_HOME" "$E2E_USER_HOME" "$E2E_BIN" /tmp/e2e-codex-project /tmp/e2e-codex-autostart-home /tmp/e2e-codex-autostart-project /tmp/e2e-codex-wrapper-home /tmp/e2e-codex-wrapper-project /tmp/e2e-codex-wrapper-misc /tmp/e2e-codex-attached-home /tmp/e2e-codex-attached-project /tmp/e2e-codex-receiver-home /tmp/e2e-codex-receiver-project /tmp/e2e-codex-auto-remote-home /tmp/e2e-codex-auto-remote-project /tmp/e2e-codex-auto-remote-misc /tmp/e2e-codex-poll-home /tmp/e2e-codex-poll-project
}
trap cleanup EXIT

# 从 package.json 读取版本号
EXPECTED_VERSION=$(python3 -c "import json;print(json.load(open('$SCRIPT_DIR/plugins/opencode-plugin-meta-agent-framework/package.json')).get('version',''))" 2>/dev/null)

# Plugin 目录副本
PLUGIN_DIR="/tmp/maf-e2e-plugin"
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
cp "$SCRIPT_DIR/plugins/opencode-plugin-meta-agent-framework"/{index.js,package.json} "$PLUGIN_DIR/"
MOCK_PORT=14096
AGENT_NAME="e2e-agent"

CASE_TOTAL=${#RUN_CASES[@]}
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    Meta-Agent-Framework E2E 测试         ║"
echo "║    v${EXPECTED_VERSION} — Cases: ${RUN_CASES[*]}              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ============================================================
# 0. 环境清理 + Setup
# ============================================================
echo -e "${YELLOW}[setup] 环境准备${NC}"
pkill -f "mock-opencode" 2>/dev/null || true
for p in $E2E_SERVER_PORT $MOCK_PORT $NODE_PORT 14134 14135 14136 14137 14138 14139 14937 14938 14940; do
  PID=$(ss -tlnp 2>/dev/null | grep ":${p} " | grep -oP 'pid=\K\d+' | head -1)
  [[ -n "$PID" ]] && kill -9 "$PID" 2>/dev/null || true
done
sleep 1
rm -f "$E2E_DB_PATH"
rm -rf "$E2E_STATE_DIR" "$E2E_MAF_HOME" "$E2E_USER_HOME" "$E2E_BIN"
mkdir -p "$E2E_STATE_DIR" "$E2E_MAF_HOME/state" "$E2E_MAF_HOME/data" "$E2E_USER_HOME/.meta-agent-framework"
# GNU screen 在部分 CI/PTY 沙箱中默认 /run/screen 会静默创建失败；e2e 使用隔离 SCREENDIR，
# 并让 Daemon/子进程继承，避免按需拉起 screen 用例受宿主机 /run 权限影响。
export SCREENDIR="$E2E_STATE_DIR/screen"
mkdir -p "$SCREENDIR"
chmod 700 "$SCREENDIR" 2>/dev/null || true
cp "$SCRIPT_DIR/plugins/node-daemon/daemon.mjs" "$E2E_USER_HOME/.meta-agent-framework/daemon.mjs"
cat > "$E2E_USER_HOME/.meta-agent-framework/package.json" << PKGJSON
{"name":"@maf/meta-agent-daemon","version":"$EXPECTED_VERSION","type":"module"}
PKGJSON
mkdir -p "$E2E_USER_HOME/.opencode/skills/e2e-skill"
cat > "$E2E_USER_HOME/.opencode/skills/e2e-skill/SKILL.md" << SKILLEOF
# E2E Skill

Temporary skill fixture for daemon inventory tests.
SKILLEOF
cat > "$E2E_USER_HOME/.opencode/opencode.json" << MCPEOF
{"mcp":{"e2e-mcp":{"command":"echo","enabled":true}}}
MCPEOF
mkdir -p "$E2E_USER_HOME/.config/opencode/plugins/opencode-plugin-meta-agent-framework"
cp "$SCRIPT_DIR/plugins/opencode-plugin-meta-agent-framework"/{index.js,package.json} "$E2E_USER_HOME/.config/opencode/plugins/opencode-plugin-meta-agent-framework/"
cat > "$E2E_USER_HOME/.config/opencode/plugins/meta-agent-framework.js" << PLUGINEOF
export { MetaAgentBridge as server } from "./opencode-plugin-meta-agent-framework/index.js";
PLUGINEOF

mkdir -p "$E2E_BIN"
cat > "$E2E_BIN/opencode" << OPENCODEMOCK
#!/usr/bin/env bash
set -euo pipefail
agent="mock-agent"
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --agent) agent="\${2:-mock-agent}"; shift 2;;
    *) shift;;
  esac
done
export MOCK_OPENCODE_PORT="14097"
export MOCK_PLUGIN_DIR="$E2E_USER_HOME/.config/opencode/plugins/opencode-plugin-meta-agent-framework"
export MOCK_DIRECTORY="\$PWD"
exec node "$ROOT_DIR/scripts/mock-opencode.mjs" "\$agent"
OPENCODEMOCK
chmod +x "$E2E_BIN/opencode"

# e2e 使用隔离 HOME，避免依赖开发机真实 HOME；所有 runtime 和断言都应基于同一个 HOME。
export HOME="$E2E_USER_HOME"
export XDG_CONFIG_HOME="$E2E_USER_HOME/.config"
export PATH="$E2E_BIN:$PATH"

# maf-client sessions 需要 opencode session DB；创建最小 fixture，避免依赖开发机真实 HOME。
mkdir -p "$E2E_USER_HOME/.local/share/opencode"
python3 - << PYDB
import sqlite3, time
path = "$E2E_USER_HOME/.local/share/opencode/opencode.db"
con = sqlite3.connect(path)
con.execute("CREATE TABLE IF NOT EXISTS session (id TEXT, agent TEXT, title TEXT, directory TEXT, time_updated INTEGER)")
con.execute("DELETE FROM session")
con.execute("INSERT INTO session VALUES (?,?,?,?,?)", ("ses_e2e_001", "$AGENT_NAME", "E2E Session", "/tmp/e2e-test-project", int(time.time()*1000)))
con.commit(); con.close()
PYDB

# Codex mock：需要在 Daemon 启动前放进环境，让 Daemon 读取 CODEX_BIN
if should_run 33 || should_run 34 || should_run 35 || should_run 38; then
  mkdir -p "$E2E_BIN"
  cat > "$E2E_BIN/codex" << 'CODEXMOCK'
#!/usr/bin/env bash
set -euo pipefail
{ printf 'mock codex args:'; printf ' [%s]' "$@"; printf '
'; } >> "${MOCK_CODEX_ARGS_LOG:-/tmp/e2e-codex-mock-args.log}" 2>/dev/null || true
if [[ "${1:-}" == "app-server" ]]; then
  shift
  node "${MOCK_CODEX_APP_SERVER_SCRIPT:-/dev/null}" "$@"
  exit $?
fi
if [[ "${1:-}" == "plugin" ]]; then
  shift
  sub="${1:-}"
  shift || true
  case "$sub" in
    add)
      selector="${1:-maf@personal}"
      mkdir -p "$HOME/.codex"
      cat > "$HOME/.codex/config.toml" <<CFG
[plugins."$selector"]
enabled = true
CFG
      if [[ " $* " == *" --json "* ]]; then
        printf '{"pluginId":"%s","name":"maf","marketplaceName":"personal","version":"mock","installedPath":"%s","authPolicy":"ON_INSTALL"}\n' "$selector" "$HOME/.codex/plugins/cache/personal/maf/mock"
      fi
      exit 0
      ;;
    list)
      echo "maf@personal  installed, enabled  mock  $HOME/plugins/maf"
      exit 0
      ;;
    remove) exit 0;;
  esac
fi
out=""
prompt=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output-last-message) out="$2"; shift 2;;
    -C|--cd|-s|--sandbox|-p|--profile|-m|--model|-a|--ask-for-approval|--color|--remote) shift 2;;
    exec|--skip-git-repo-check) shift;;
    --dangerously-bypass-approvals-and-sandbox) shift;;
    -) prompt="$(cat)"; shift;;
    *) args+=("$1"); shift;;
  esac
done
if [[ -z "$prompt" && ${#args[@]} -gt 0 ]]; then
  prompt="${args[*]}"
fi
summary="mock codex completed: $(echo "$prompt" | grep -m1 'Codex e2e task' || echo 'no prompt match')"
if [[ -n "$out" ]]; then
  printf '%s\n' "$summary" > "$out"
else
  report_script=$(echo "$prompt" | grep -oE '/[^`"[:space:]]*maf-codex-report-[^`"[:space:]]+\.mjs' | head -1 || true)
  result_file="/tmp/maf-codex-mock-result.md"
  printf '%s\n' "$summary" > "$result_file"
  if [[ -n "$report_script" ]]; then
    node "$report_script" completed "$result_file"
  else
    echo "missing report script" >&2
    exit 3
  fi
fi
if [[ -n "${MOCK_CODEX_SLEEP_SECONDS:-}" ]]; then
  sleep "$MOCK_CODEX_SLEEP_SECONDS"
fi
echo "mock codex stdout"
CODEXMOCK
  chmod +x "$E2E_BIN/codex"
  export CODEX_BIN="$E2E_BIN/codex"
fi

# 启动 Server（所有 case 都需要）
if $NEED_SERVER; then
  MAF_HOME="$E2E_MAF_HOME" PORT=$E2E_SERVER_PORT DB_PATH="$E2E_DB_PATH" FEISHU_SYNC_DISABLED=1 node --import tsx src/index.ts &>/dev/null &
  SERVER_PID=$!
  disown $SERVER_PID
  sleep 3
  curl -s $E2E_SERVER/api/health >/dev/null 2>&1 || { echo -e "${RED}❌ Server 启动失败${NC}"; exit 1; }
  echo "  Server OK (port $E2E_SERVER_PORT)"
fi

# 启动 Daemon + OC agent
if $NEED_DAEMON; then
  start_mock_opencode
  wait_until 10 "curl -s $DAEMON_URL/health 2>/dev/null" '"ok":true' || { echo -e "${RED}❌ Daemon 启动失败${NC}"; exit 1; }
  wait_until 10 "get_agent_field status" "online" || true
  echo "  Daemon + OC agent OK (port $NODE_PORT)"
fi

# 注册 CC agent
if $NEED_CC; then
  start_cc_agent
  sleep 2
  wait_until 5 "get_agent_field status $CC_AGENT" "online" || true
  echo "  CC agent OK"
fi
echo ""

# ============================================================
# Case 1: Server 启动
# ============================================================
if should_run 1; then
echo -e "${YELLOW}[1] Server 启动${NC}"
H=$(curl -s $E2E_SERVER/api/health 2>/dev/null)
assert "Server 启动" "server_version" "$H"
fi

# ============================================================
# Case 2: OC agent 启动
# ============================================================
if should_run 2; then
echo -e "${YELLOW}[2] OC agent 启动（Plugin → 单 Daemon）${NC}"
assert "Mock Opencode 运行中" "true" "$(kill -0 $MOCK_PID 2>/dev/null && echo true || echo false)"
D=$(curl -s "$DAEMON_URL/health" 2>/dev/null || echo "{}")
assert "Node Daemon 启动" '"ok":true' "$D"
assert "Daemon hash" "daemon_hash" "$D"
fi

# ============================================================
# Case 3: Agent 注册
# ============================================================
if should_run 3; then
echo -e "${YELLOW}[3] Agent 注册${NC}"
assert "Agent 注册" "$AGENT_NAME" "$(get_agent_field agent_name)"
assert "状态 online" "online" "$(get_agent_field status)"
assert "endpoint 指向 Daemon" ":$NODE_PORT" "$(get_agent_field client_endpoint)"
assert "版本 $EXPECTED_VERSION" "$EXPECTED_VERSION" "$(get_agent_field client_version)"
fi

# ============================================================
# Case 4: Skills/MCPs
# ============================================================
if should_run 4; then
echo -e "${YELLOW}[4] Skills/MCPs 上报${NC}"
SK=$(curl -s $E2E_SERVER/api/agents 2>/dev/null | python3 -c "import json,sys;a=[x for x in json.load(sys.stdin) if x['agent_name']=='$AGENT_NAME'];print(len(json.loads(a[0].get('skills','[]'))) if a else 0)" 2>/dev/null)
MC=$(curl -s $E2E_SERVER/api/agents 2>/dev/null | python3 -c "import json,sys;a=[x for x in json.load(sys.stdin) if x['agent_name']=='$AGENT_NAME'];print(len(json.loads(a[0].get('mcps','[]'))) if a else 0)" 2>/dev/null)
assert "Skills > 0" "true" "$([ "${SK:-0}" -gt 0 ] && echo true || echo false)"
assert "MCPs > 0" "true" "$([ "${MC:-0}" -gt 0 ] && echo true || echo false)"
fi

# ============================================================
# Case 5: CC agent 注册
# ============================================================
if should_run 5; then
echo -e "${YELLOW}[5] CC agent 注册（共用 Daemon）${NC}"
D_HEALTH=$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')
assert "Daemon 管理 OC agent" "$AGENT_NAME" "$D_HEALTH"
assert "Daemon 管理 CC agent" "$CC_AGENT" "$D_HEALTH"
wait_until 5 "get_agent_field status $CC_AGENT" "online" || true
assert "CC 注册 online（刚连接）" "online" "$(get_agent_field status $CC_AGENT)"
assert "两个 agent 共用 endpoint" ":$NODE_PORT" "$(get_agent_field client_endpoint $CC_AGENT)"
assert "OC 心跳后 online" "online" "$(get_agent_field status)"
assert "CC 心跳后 online（lastSeen 新鲜）" "online" "$(get_agent_field status $CC_AGENT)"
fi

# ============================================================
# Case 6: OTA 写文件
# ============================================================
if should_run 6; then
echo -e "${YELLOW}[6] OTA 写文件${NC}"
R=$(curl -s -X POST $DAEMON_URL/ota -H 'Content-Type: application/json' \
  -d '{"files":[{"path":"~/.meta-agent-framework/ota-e2e-test.txt","content":"e2e-pass"}]}' 2>/dev/null)
assert "OTA applied" '"applied":1' "$R"
assert "OTA 内容" "e2e-pass" "$(cat "$E2E_USER_HOME/.meta-agent-framework/ota-e2e-test.txt" 2>/dev/null)"
fi

# ============================================================
# Case 7: OTA Daemon 自更新
# ============================================================
if should_run 7; then
echo -e "${YELLOW}[7] OTA Daemon 自更新${NC}"
PID_BEFORE=$(curl -s $DAEMON_URL/health 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('pid',''))" 2>/dev/null)
HASH_BEFORE=$(curl -s $DAEMON_URL/health 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('daemon_hash',''))" 2>/dev/null)
echo "  OTA 前: PID=$PID_BEFORE hash=$HASH_BEFORE"
OTA_SELF=$(python3 -c "
import json, urllib.request
payload = json.dumps({'files': [{'path': 'plugin/daemon.mjs', 'content': open('plugins/node-daemon/daemon.mjs').read()}]})
req = urllib.request.Request('$DAEMON_URL/ota', data=payload.encode(), headers={'Content-Type':'application/json'}, method='POST')
try: resp = urllib.request.urlopen(req, timeout=10); print(resp.read().decode())
except: print('{}')
" 2>/dev/null || echo "{}")
assert "OTA daemon_updated" "daemon_updated" "$OTA_SELF"
echo -n "  等待 Daemon 自杀..."
sleep 2
wait_until 3 "curl -s --max-time 1 $DAEMON_URL/health 2>/dev/null || echo dead" "dead" || true
echo -n " 等待新 Daemon..."
wait_until 10 "curl -s $DAEMON_URL/health 2>/dev/null" '"ok":true' || true
wait_until 8 "get_agent_field status" "online" || true
echo ""
assert "新 Daemon 启动" '"ok":true' "$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')"
assert "OC OTA 后恢复" "online" "$(get_agent_field status)"
start_cc_agent
sleep 2
wait_until 5 "get_agent_field status $CC_AGENT" "online" || true
assert "CC 重新注册后 online" "online" "$(get_agent_field status $CC_AGENT)"
PID_AFTER_RESTART=$(curl -s $DAEMON_URL/health 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('pid',''))" 2>/dev/null)
echo "  重启完成: PID=$PID_BEFORE → $PID_AFTER_RESTART"
D_HEALTH=$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')
assert "OC 在 Daemon" "$AGENT_NAME" "$D_HEALTH"
assert "CC 在 Daemon" "$CC_AGENT" "$D_HEALTH"
fi

# ============================================================
# Case 8: 单 agent 正常退出
# ============================================================
if should_run 8; then
echo -e "${YELLOW}[8] 单 agent 正常退出${NC}"
assert "杀前 OC online" "online" "$(get_agent_field status)"
assert "杀前 CC online" "online" "$(get_agent_field status $CC_AGENT)"
kill "$MOCK_PID" 2>/dev/null; MOCK_PID=""
echo -n "  等待 OC agent offline..."
wait_until 10 "get_agent_field status" "offline" || true
echo ""
assert "OC agent offline" "offline" "$(get_agent_field status)"
assert "CC agent 仍 online" "online" "$(get_agent_field status $CC_AGENT)"
assert "Daemon 未退出" '"ok":true' "$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')"
fi

# ============================================================
# Case 9: 单 agent 异常退出
# ============================================================
if should_run 9; then
echo -e "${YELLOW}[9] 单 agent 异常退出（无 disconnect）${NC}"
start_mock_opencode
wait_until 8 "get_agent_field status" "online" || true
assert "OC 重新上线" "online" "$(get_agent_field status)"
kill -9 "$MOCK_PID" 2>/dev/null; MOCK_PID=""
echo -n "  等待 Daemon 检测到 OC 不活跃..."
wait_until 15 "get_agent_field status" "offline" || true
echo ""
assert "OC 异常退出后 offline" "offline" "$(get_agent_field status)"
assert "CC 不受影响" "online" "$(get_agent_field status $CC_AGENT)"
assert "Daemon 依然存活" '"ok":true' "$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')"
fi

# ============================================================
# Case 10: Daemon 被杀 → 自动恢复
# ============================================================
if should_run 10; then
echo -e "${YELLOW}[10] Daemon 被杀 → 自动恢复${NC}"
start_mock_opencode
wait_until 8 "get_agent_field status" "online" || true
DAEMON_PID=$(ss -tlnp 2>/dev/null | grep ":$NODE_PORT " | grep -oP 'pid=\K\d+' | head -1)
[[ -n "$DAEMON_PID" ]] && kill -9 "$DAEMON_PID" 2>/dev/null
echo -n "  等待 Daemon 自动恢复..."
wait_until 10 "curl -s $DAEMON_URL/health 2>/dev/null" '"ok":true' || true
echo ""
assert "Daemon 自动恢复" '"ok":true' "$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')"
D_HEALTH=$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')
assert "OC agent 恢复到新 Daemon" "$AGENT_NAME" "$D_HEALTH"
wait_until 8 "get_agent_field status" "online" || true
assert "OC Server 侧恢复 online" "online" "$(get_agent_field status)"
start_cc_agent
wait_until 5 "get_agent_field status $CC_AGENT" "online" || true
assert "CC 重新注册 online" "online" "$(get_agent_field status $CC_AGENT)"
fi

# ============================================================
# Case 11: Server 重启
# ============================================================
if should_run 11; then
echo -e "${YELLOW}[11] Server 重启${NC}"
wait_until 5 "curl -s $DAEMON_URL/health 2>/dev/null" '"ok":true' || true
kill "$SERVER_PID" 2>/dev/null; SERVER_PID=""
sleep 2
assert "Server 已停止" "false" "$(curl -s --max-time 1 $E2E_SERVER/api/health &>/dev/null && echo true || echo false)"
MAF_HOME="$E2E_MAF_HOME" PORT=$E2E_SERVER_PORT DB_PATH="$E2E_DB_PATH" FEISHU_SYNC_DISABLED=1 ./node_modules/.bin/tsx src/index.ts &>/dev/null &
SERVER_PID=$!
disown $SERVER_PID
wait_until 10 "curl -s $E2E_SERVER/api/health 2>/dev/null" "server_version" || true
assert "Server 重启 health" "server_version" "$(curl -s $E2E_SERVER/api/health 2>/dev/null)"
wait_until 8 "get_agent_field status" "online" || true
wait_until 5 "get_agent_field status $CC_AGENT" "online" || true
assert "OC Server 重启后 online" "online" "$(get_agent_field status)"
assert "CC Server 重启后 online" "online" "$(get_agent_field status $CC_AGENT)"
assert "endpoint 正确" ":$NODE_PORT" "$(get_agent_field client_endpoint)"
fi

# ============================================================
# Case 12: 按需拉起
# ============================================================
if should_run 12; then
echo -e "${YELLOW}[12] 按需拉起 opencode serve${NC}"
SERVE_AGENT="serve-e2e-agent"
mkdir -p /tmp/e2e-serve-project/.opencode/agents
cat > /tmp/e2e-serve-project/.opencode/agents/${SERVE_AGENT}.md << 'AGENTEOF'
---
description: E2E 测试用 serve agent
mode: subagent
---
E2E serve test agent
AGENTEOF
curl -s -X POST $DAEMON_URL/agents/connect \
  -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERVE_AGENT\",\"runtime\":\"opencode\",\"directory\":\"/tmp/e2e-serve-project\"}" >/dev/null 2>&1
sleep 1
curl -s -X POST $DAEMON_URL/agents/disconnect \
  -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERVE_AGENT\"}" >/dev/null 2>&1
sleep 1
wait_until 10 "get_agent_field status $SERVE_AGENT" "offline\|dead" || true
SERVE_STATUS=$(get_agent_field status $SERVE_AGENT)
assert "serve agent 已注册(非 online)" "true" "$(echo $SERVE_STATUS | grep -q 'offline\|dead' && echo true || echo false)"
EXEC_RES=$(curl -s -X POST $DAEMON_URL/execute \
  -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERVE_AGENT\",\"prompt\":\"e2e serve 测试\",\"runtime\":\"opencode\",\"project_path\":\"/tmp/e2e-serve-project\"}" 2>/dev/null)
assert "按需拉起: 任务已接受" "auto-launch" "$EXEC_RES"
echo -n "  等待 serve 拉起..."
wait_until 60 "curl -s $DAEMON_URL/agents 2>/dev/null" "$SERVE_AGENT" || true
echo ""
DAEMON_AGENTS=$(curl -s $DAEMON_URL/agents 2>/dev/null)
assert "按需拉起: agent 出现在 Daemon" "$SERVE_AGENT" "$DAEMON_AGENTS"
SERVE_PIDS=$(pgrep -f "opencode.*serve" 2>/dev/null | head -1)
assert "按需拉起: serve 进程存在" "true" "$([ -n \"$SERVE_PIDS\" ] && echo true || echo false)"
pkill -f "opencode.*serve" 2>/dev/null || true
rm -rf /tmp/e2e-serve-project
fi

# ============================================================
# Case 13: Claude Code 任务链路
# ============================================================
if should_run 13; then
echo -e "${YELLOW}[13] Claude Code: 任务链路${NC}"
HOME="$E2E_USER_HOME" MAF_AGENT_NAME="$CC_AGENT" \
META_AGENT_SERVER="$E2E_SERVER" \
MAF_NODE_PORT=$NODE_PORT \
node plugins/claude-code-plugin-maf/scripts/maf-agent.mjs --wait 2>/tmp/cc-e2e-stderr.log &
CC_WAIT_PID=$!
sleep 2
CC_WF=$(curl -s -X POST $E2E_SERVER/api/workflows \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"CC e2e test\",\"nodes\":[{\"id\":\"step-1\",\"agent_name\":\"$CC_AGENT\",\"prompt\":\"e2e 测试任务\",\"scope\":\"project\",\"intent\":\"query\"}]}" 2>/dev/null)
CC_WF_ID=$(echo "$CC_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id','') if not isinstance(d,list) else d[0].get('id','') if d else '')" 2>/dev/null)
CC_WF_STATUS=$(echo "$CC_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status','') if not isinstance(d,list) else d[0].get('status','') if d else '')" 2>/dev/null)
assert "CC workflow 创建" "running" "$CC_WF_STATUS"
for i in $(seq 1 15); do kill -0 $CC_WAIT_PID 2>/dev/null || break; sleep 1; done
wait $CC_WAIT_PID 2>/dev/null
CC_WAIT_EXIT=$?
assert "CC Wait exit 2" "2" "$CC_WAIT_EXIT"
CC_STDERR=$(cat /tmp/cc-e2e-stderr.log 2>/dev/null)
assert "CC stderr 有任务" "e2e 测试任务" "$CC_STDERR"
assert "CC stderr 有 curl" "tasks/done" "$CC_STDERR"
CC_TASK_ID=$(echo "$CC_STDERR" | grep -oP '"task_id":"[^"]+' | grep -oP '[^"]+$')
REPORT_RES=$(curl -s -X POST $DAEMON_URL/tasks/done \
  -H 'Content-Type: application/json' \
  -d "{\"task_id\":\"${CC_TASK_ID}\",\"agent_name\":\"$CC_AGENT\",\"status\":\"completed\",\"result\":\"e2e test passed\"}" 2>/dev/null)
assert "CC 回报到 Daemon" '"ok":true' "$REPORT_RES"
sleep 3
WF_STATUS=$(curl -s "$E2E_SERVER/api/workflows/${CC_WF_ID}" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status','') if not isinstance(d,list) else d[0].get('status','') if d else '')" 2>/dev/null)
if [ "$WF_STATUS" != "completed" ]; then sleep 3; WF_STATUS=$(curl -s "$E2E_SERVER/api/workflows/${CC_WF_ID}" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status','') if not isinstance(d,list) else d[0].get('status','') if d else '')" 2>/dev/null); fi
assert "CC workflow completed" "completed" "$WF_STATUS"
assert "CC 版本" "$EXPECTED_VERSION" "$(get_agent_field client_version $CC_AGENT)"
fi

# ============================================================
# Case 14: Proposal Server API
# ============================================================
if should_run 14; then
echo -e "${YELLOW}[14] Proposal: Server API${NC}"
P_CREATE=$(curl -s -X POST $E2E_SERVER/api/proposals \
  -H 'Content-Type: application/json' \
  -d "{\"from_agent\":\"$AGENT_NAME\",\"type\":\"skill\",\"title\":\"好用的 draw-io skill\",\"detail\":\"这个 skill 可以画架构图\",\"user_id\":\"e2e-testuser\",\"files\":[{\"relative_path\":\"SKILL.md\",\"content\":\"# Draw IO Skill\"}],\"priority\":\"high\"}" 2>/dev/null)
P_ID=$(echo "$P_CREATE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
assert "创建 proposal" "pending" "$(echo "$P_CREATE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"
assert "proposal type=skill" "skill" "$(echo "$P_CREATE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('type',''))" 2>/dev/null)"
assert "proposal priority=high" "high" "$(echo "$P_CREATE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('priority',''))" 2>/dev/null)"
P_GET=$(curl -s "$E2E_SERVER/api/proposals/$P_ID" 2>/dev/null)
assert "获取单个 proposal" "draw-io" "$(echo "$P_GET" | python3 -c "import json,sys;print(json.load(sys.stdin).get('title',''))" 2>/dev/null)"
P_REVIEW=$(curl -s -X POST "$E2E_SERVER/api/proposals/$P_ID/review" \
  -H 'Content-Type: application/json' \
  -d '{"status":"accepted","review_comment":"很好的 skill，采纳","reviewed_by":"Meta-Agent-Server"}' 2>/dev/null)
assert "审核 accepted" "accepted" "$(echo "$P_REVIEW" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"
assert "审核评论" "采纳" "$(echo "$P_REVIEW" | python3 -c "import json,sys;print(json.load(sys.stdin).get('review_comment',''))" 2>/dev/null)"
P_APPLY=$(curl -s -X POST "$E2E_SERVER/api/proposals/$P_ID/apply" 2>/dev/null)
assert "标记 applied" "applied" "$(echo "$P_APPLY" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"
P_BAD=$(curl -s -X POST $E2E_SERVER/api/proposals -H 'Content-Type: application/json' -d '{"from_agent":"test"}' 2>/dev/null)
assert "缺少必填字段返回 error" "error" "$P_BAD"
fi

# ============================================================
# Case 15: Proposal Daemon 代理
# ============================================================
if should_run 15; then
echo -e "${YELLOW}[15] Proposal: Daemon 代理${NC}"
P_DAEMON=$(curl -s -X POST $DAEMON_URL/proposals/submit \
  -H 'Content-Type: application/json' \
  -d "{\"from_agent\":\"$AGENT_NAME\",\"type\":\"bug_report\",\"title\":\"workflow step3 顺序有问题\",\"detail\":\"应该先 build 再 test\",\"target\":\"workflow:test-wf\",\"suggested_fix\":\"交换 step3 和 step4\"}" 2>/dev/null)
P_D_ID=$(echo "$P_DAEMON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
assert "OC Daemon 代理 proposal" "pending" "$(echo "$P_DAEMON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"
assert "Daemon proposal type" "bug_report" "$(echo "$P_DAEMON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('type',''))" 2>/dev/null)"
P_CC=$(curl -s -X POST $DAEMON_URL/proposals/submit \
  -H 'Content-Type: application/json' \
  -d "{\"from_agent\":\"$CC_AGENT\",\"type\":\"prompt_improvement\",\"title\":\"Agent prompt 可以优化\",\"detail\":\"建议加入上下文\"}" 2>/dev/null)
assert "CC Daemon 代理 proposal" "pending" "$(echo "$P_CC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"
P_REJECT=$(curl -s -X POST "$E2E_SERVER/api/proposals/$P_D_ID/review" \
  -H 'Content-Type: application/json' \
  -d '{"status":"rejected","review_comment":"已知问题，下版修复"}' 2>/dev/null)
assert "审核 rejected" "rejected" "$(echo "$P_REJECT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"
P_STATS=$(curl -s "$E2E_SERVER/api/proposals/stats" 2>/dev/null)
assert "stats total >= 3" "true" "$(echo "$P_STATS" | python3 -c "import json,sys;print('true' if json.load(sys.stdin).get('total',0)>=3 else 'false')" 2>/dev/null)"
assert "stats applied = 1" "true" "$(echo "$P_STATS" | python3 -c "import json,sys;print('true' if json.load(sys.stdin).get('applied',0)==1 else 'false')" 2>/dev/null)"
P_DLIST=$(curl -s "$DAEMON_URL/proposals?status=pending" 2>/dev/null)
P_DLCOUNT=$(echo "$P_DLIST" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null)
assert "Daemon 查询 pending >= 1" "true" "$([ "${P_DLCOUNT:-0}" -ge 1 ] && echo true || echo false)"
fi

# ============================================================
# Case 16: Evolve 进化推送
# ============================================================
if should_run 16; then
echo -e "${YELLOW}[16] Evolve: 进化推送${NC}"
EVOLVE_SKILL=$(curl -s -X POST "$E2E_SERVER/api/evolve/skill" \
  -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$AGENT_NAME\",\"skill_name\":\"e2e-test-skill\",\"files\":[{\"relative_path\":\"SKILL.md\",\"content\":\"---\nname: e2e-test-skill\ndescription: E2E Test Skill\n---\n# E2E Test Skill\"}]}" 2>/dev/null)
assert "Evolve skill pushed" "true" "$(echo "$EVOLVE_SKILL" | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('pushed',False)).lower())" 2>/dev/null)"
EVOLVE_ID=$(echo "$EVOLVE_SKILL" | python3 -c "import json,sys;print(json.load(sys.stdin).get('evolve_id',''))" 2>/dev/null)
sleep 2
EVOLVE_RESULT=$(curl -s "$E2E_SERVER/api/evolve/$EVOLVE_ID" 2>/dev/null)
assert "Evolve 结果 completed" "completed" "$(echo "$EVOLVE_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"
EVOLVE_DIRECT=$(curl -s -X POST "$DAEMON_URL/evolve" \
  -H 'Content-Type: application/json' \
  -d "{\"evolve_id\":\"e2e-direct-test\",\"title\":\"直接 evolve 测试\",\"target_runtime\":\"opencode\",\"actions\":[{\"type\":\"push_files\",\"target\":\"skill\",\"files\":[{\"relative_path\":\"e2e-direct-skill/SKILL.md\",\"content\":\"---\nname: e2e-direct-skill\ndescription: Direct Test Skill\n---\n# Direct Test\"}]}]}" 2>/dev/null)
assert "Daemon evolve accepted" "true" "$(echo "$EVOLVE_DIRECT" | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('accepted',False)).lower())" 2>/dev/null)"
EVOLVE_D_STATUS=$(echo "$EVOLVE_DIRECT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('status',''))" 2>/dev/null)
assert "Daemon evolve completed" "completed" "$EVOLVE_D_STATUS"
SKILL_FILE="$E2E_USER_HOME/.config/opencode/skills/e2e-test-skill/SKILL.md"
assert "Skill 文件已写入" "true" "$([ -f "$SKILL_FILE" ] && echo true || echo false)"
assert "Skill 文件内容" "true" "$(grep -q 'E2E Test Skill' "$SKILL_FILE" 2>/dev/null && echo true || echo false)"
EVOLVE_BAD=$(curl -s -X POST "$DAEMON_URL/evolve" \
  -H 'Content-Type: application/json' \
  -d '{"evolve_id":"e2e-bad","title":"恶意写入","actions":[{"type":"push_files","target":"custom","target_path":"/tmp","files":[{"relative_path":"evil.sh","content":"rm -rf /"}]}]}' 2>/dev/null)
EVOLVE_BAD_STATUS=$(echo "$EVOLVE_BAD" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('status',''))" 2>/dev/null)
assert "白名单外拒绝" "failed" "$EVOLVE_BAD_STATUS"
rm -rf "$E2E_USER_HOME/.config/opencode/skills/e2e-test-skill" "$E2E_USER_HOME/.config/opencode/skills/e2e-direct-skill"
fi

# ============================================================
# Case 17: SSE 事件广播
# ============================================================
if should_run 17; then
echo -e "${YELLOW}[17] SSE: 事件广播${NC}"
SSE_OUTPUT="/tmp/maf-e2e-sse.log"
rm -f "$SSE_OUTPUT"
curl -s -N "$E2E_SERVER/api/events" > "$SSE_OUTPUT" 2>/dev/null &
SSE_PID=$!
sleep 1
assert "SSE 连接" "true" "$(grep -q 'connected' "$SSE_OUTPUT" 2>/dev/null && echo true || echo false)"
WF_RES=$(curl -s -X POST $E2E_SERVER/api/workflows \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"SSE 测试 workflow\",\"nodes\":[{\"id\":\"sse-1\",\"agent_name\":\"$AGENT_NAME\",\"prompt\":\"SSE test\",\"scope\":\"project\",\"intent\":\"query\"}]}" 2>/dev/null)
WF_ID=$(echo "$WF_RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id','') or d.get('id',''))" 2>/dev/null)
sleep 1
curl -s -X POST "$E2E_SERVER/api/workflows/$WF_ID/nodes/sse-1/result" \
  -H 'Content-Type: application/json' \
  -d '{"execution_id":"e2e-sse","status":"completed","result":"SSE e2e result OK","duration_ms":100}' >/dev/null 2>&1
sleep 2
assert "SSE workflow_started" "true" "$(grep -q 'workflow_started' "$SSE_OUTPUT" 2>/dev/null && echo true || echo false)"
assert "SSE 含 workflow_id" "true" "$(grep -q "$WF_ID" "$SSE_OUTPUT" 2>/dev/null && echo true || echo false)"
assert "SSE node 事件" "true" "$(grep -qE 'workflow_node_(running|completed|failed)' "$SSE_OUTPUT" 2>/dev/null && echo true || echo false)"
kill $SSE_PID 2>/dev/null
rm -f "$SSE_OUTPUT"
fi

# ============================================================
# Case 18: 多任务并发（两个 agent 同时接任务）
# ============================================================
if should_run 18; then
echo -e "${YELLOW}[18] 多任务并发${NC}"

# 确保两个 agent 都 online
wait_until 5 "get_agent_field status" "online" || true
wait_until 5 "get_agent_field status $CC_AGENT" "online" || true

# 启动 CC Wait（接收 CC agent 的任务）
HOME="$E2E_USER_HOME" MAF_AGENT_NAME="$CC_AGENT" \
META_AGENT_SERVER="$E2E_SERVER" \
MAF_NODE_PORT=$NODE_PORT \
node plugins/claude-code-plugin-maf/scripts/maf-agent.mjs --wait 2>/tmp/cc-concurrent-stderr.log &
CC_WAIT_PID=$!
sleep 2

# 同时创建两个 workflow（分别给 OC 和 CC agent）— 用临时文件捕获后台输出
curl -s -X POST $E2E_SERVER/api/workflows \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"并发测试-OC\",\"nodes\":[{\"id\":\"c1\",\"agent_name\":\"$AGENT_NAME\",\"prompt\":\"OC并发任务\",\"scope\":\"project\",\"intent\":\"query\"}]}" > /tmp/maf-wf-oc.json 2>/dev/null &
curl -s -X POST $E2E_SERVER/api/workflows \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"并发测试-CC\",\"nodes\":[{\"id\":\"c2\",\"agent_name\":\"$CC_AGENT\",\"prompt\":\"CC并发任务\",\"scope\":\"project\",\"intent\":\"query\"}]}" > /tmp/maf-wf-cc.json 2>/dev/null &
wait

WF_OC_ID=$(python3 -c "import json;d=json.load(open('/tmp/maf-wf-oc.json'));print(d.get('workflow_id','') or d.get('id',''))" 2>/dev/null)
WF_CC_ID=$(python3 -c "import json;d=json.load(open('/tmp/maf-wf-cc.json'));print(d.get('workflow_id','') or d.get('id',''))" 2>/dev/null)

assert "OC workflow 创建" "true" "$([ -n \"$WF_OC_ID\" ] && echo true || echo false)"
assert "CC workflow 创建" "true" "$([ -n \"$WF_CC_ID\" ] && echo true || echo false)"

# CC agent: 等 Wait 进程退出（收到任务后 exit 2）
for i in $(seq 1 15); do kill -0 $CC_WAIT_PID 2>/dev/null || break; sleep 1; done
wait $CC_WAIT_PID 2>/dev/null
CC_EXIT=$?
assert "CC 收到任务 (exit 2)" "2" "$CC_EXIT"

# CC 回报结果
CC_STDERR=$(cat /tmp/cc-concurrent-stderr.log 2>/dev/null)
CC_TASK_ID=$(echo "$CC_STDERR" | grep -oP '"task_id":"[^"]+' | grep -oP '[^"]+$')
if [[ -n "$CC_TASK_ID" ]]; then
  curl -s -X POST $DAEMON_URL/tasks/done \
    -H 'Content-Type: application/json' \
    -d "{\"task_id\":\"$CC_TASK_ID\",\"agent_name\":\"$CC_AGENT\",\"status\":\"completed\",\"result\":\"CC并发结果\"}" >/dev/null 2>&1
fi

# OC agent: 从 Daemon 取任务并回报（mock-opencode 已在运行，但它不会自动回报 workflow 任务）
# OC workflow 可能已经由 mock-opencode 处理，也可能 pending（取决于 mock 是否处理 workflow 推送）
# 直接查 workflow 状态，等待完成
sleep 5

# 验证两个 workflow 的最终状态
WF_OC_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$WF_OC_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)
WF_CC_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$WF_CC_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)

assert "CC workflow completed" "completed" "$WF_CC_STATUS"
# 关键验证：CC 的结果没有串到 OC 的 workflow 里
WF_OC_RESULT=$(curl -s "$E2E_SERVER/api/workflows/$WF_OC_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);ns=d.get('nodes',[]);print(ns[0].get('result','') if ns else '')" 2>/dev/null)
assert "结果不串（OC 没收到 CC 结果）" "true" "$(echo "$WF_OC_RESULT" | grep -qv 'CC并发结果' && echo true || echo false)"
# OC 和 CC 的 workflow_id 不同
assert "两个 workflow 独立" "true" "$([ \"$WF_OC_ID\" != \"$WF_CC_ID\" ] && echo true || echo false)"

rm -f /tmp/cc-concurrent-stderr.log
fi

# ============================================================
# Case 19: Workflow 跟踪查询（pending / completed）
# ============================================================
if should_run 19; then
echo -e "${YELLOW}[19] Workflow 跟踪查询${NC}"

# 用独立 agent 避免 mock-opencode 抢任务
TRACK_AGENT="track-e2e-agent"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$TRACK_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$$,\"directory\":\"/tmp\"}" >/dev/null 2>&1
sleep 1

# 通过 Daemon /execute 直接推送一个带 workflow_id 的任务
curl -s -X POST "$DAEMON_URL/execute" \
  -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$TRACK_AGENT\",\"workflow_id\":\"wf-track-test\",\"node_id\":\"n1\",\"prompt\":\"跟踪测试\",\"intent\":\"query\"}" >/dev/null 2>&1

# 查 pending — 应该有这个 workflow
PENDING=$(curl -s "$DAEMON_URL/workflows/pending" 2>/dev/null)
assert "pending 有 workflow" "wf-track-test" "$PENDING"
PENDING_COUNT=$(echo "$PENDING" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null)
assert "pending 数量 >= 1" "true" "$([ "${PENDING_COUNT:-0}" -ge 1 ] && echo true || echo false)"

# 取任务并回报完成
sleep 1
TASK_DATA=$(curl -s "$DAEMON_URL/tasks/wait?agent=$TRACK_AGENT" --max-time 3 2>/dev/null)
TASK_ID=$(echo "$TASK_DATA" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('task',{}).get('id',''))" 2>/dev/null)
if [[ -n "$TASK_ID" && "$TASK_ID" != "None" && "$TASK_ID" != "" ]]; then
  curl -s -X POST "$DAEMON_URL/tasks/done" \
    -H 'Content-Type: application/json' \
    -d "{\"task_id\":\"$TASK_ID\",\"agent_name\":\"$TRACK_AGENT\",\"status\":\"completed\",\"result\":\"跟踪测试结果\"}" >/dev/null 2>&1
fi
sleep 1

# 查 completed — 应该有这个 workflow
COMPLETED=$(curl -s "$DAEMON_URL/workflows/completed" 2>/dev/null)
assert "completed 有 workflow" "wf-track-test" "$COMPLETED"
assert "completed 有结果" "跟踪测试结果" "$COMPLETED"

# 查 pending — 应该已经没有了
PENDING2=$(curl -s "$DAEMON_URL/workflows/pending" 2>/dev/null)
PENDING2_HAS=$(echo "$PENDING2" | grep -c "wf-track-test" 2>/dev/null || echo 0)
assert "pending 已清除" "0" "$PENDING2_HAS"

# 清理
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$TRACK_AGENT\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 20: 同 agent 连续串行任务（验证队列不丢）
# ============================================================
if should_run 20; then
echo -e "${YELLOW}[20] 连续串行任务${NC}"

# 用独立 agent 避免和 mock-opencode 冲突
SERIAL_AGENT="serial-e2e-agent"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERIAL_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$$,\"directory\":\"/tmp\"}" >/dev/null 2>&1
sleep 1

# 启动 worker：持续 poll + 执行 + 回报
(while true; do
  RESP=$(curl -s "$DAEMON_URL/tasks/wait?agent=$SERIAL_AGENT" --max-time 3 2>/dev/null)
  TID=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);t=d.get('task');print(t.get('id','') if t else '')" 2>/dev/null)
  if [[ -n "$TID" && "$TID" != "" ]]; then
    sleep 1  # 模拟执行
    curl -s -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' \
      -d "{\"task_id\":\"$TID\",\"agent_name\":\"$SERIAL_AGENT\",\"status\":\"completed\",\"result\":\"done-$TID\"}" >/dev/null
  fi
done) &
SERIAL_WORKER=$!
sleep 2  # 等 worker long-poll 建立

# 连续发 3 个任务
R1=$(curl -s -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERIAL_AGENT\",\"workflow_id\":\"serial-1\",\"node_id\":\"n1\",\"prompt\":\"串行任务1\",\"intent\":\"query\"}" 2>/dev/null)
R2=$(curl -s -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERIAL_AGENT\",\"workflow_id\":\"serial-2\",\"node_id\":\"n2\",\"prompt\":\"串行任务2\",\"intent\":\"query\"}" 2>/dev/null)
R3=$(curl -s -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERIAL_AGENT\",\"workflow_id\":\"serial-3\",\"node_id\":\"n3\",\"prompt\":\"串行任务3\",\"intent\":\"query\"}" 2>/dev/null)

assert "串行任务1 accepted" "true" "$(echo "$R1" | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('accepted',False)).lower())" 2>/dev/null)"
assert "串行任务2 accepted" "true" "$(echo "$R2" | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('accepted',False)).lower())" 2>/dev/null)"
assert "串行任务3 accepted" "true" "$(echo "$R3" | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('accepted',False)).lower())" 2>/dev/null)"

# 等所有任务执行完（3 个任务各 1s 执行 + poll 间隔）
sleep 12

# 验证 3 个都完成了
COMPLETED=$(curl -s "$DAEMON_URL/workflows/completed" 2>/dev/null)
C1=$(echo "$COMPLETED" | python3 -c "import json,sys;print('true' if any(w['workflow_id']=='serial-1' and w['status']=='completed' for w in json.load(sys.stdin)) else 'false')" 2>/dev/null)
C2=$(echo "$COMPLETED" | python3 -c "import json,sys;print('true' if any(w['workflow_id']=='serial-2' and w['status']=='completed' for w in json.load(sys.stdin)) else 'false')" 2>/dev/null)
C3=$(echo "$COMPLETED" | python3 -c "import json,sys;print('true' if any(w['workflow_id']=='serial-3' and w['status']=='completed' for w in json.load(sys.stdin)) else 'false')" 2>/dev/null)

assert "串行任务1 completed" "true" "$C1"
assert "串行任务2 completed" "true" "$C2"
assert "串行任务3 completed" "true" "$C3"

# 清理
kill $SERIAL_WORKER 2>/dev/null
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SERIAL_AGENT\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 21: OC Workflow 完整链路（Server API → Daemon → Plugin → 回报 → completed）
# ============================================================
if should_run 21; then
echo -e "${YELLOW}[21] OC Workflow 完整链路${NC}"

# 用独立 agent + worker
OC_WF_AGENT="oc-wf-e2e-agent"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$OC_WF_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$$,\"directory\":\"/tmp\"}" >/dev/null 2>&1
sleep 2  # 等 Daemon 心跳注册到 Server

# 启动 worker（模拟 Plugin long-poll + 执行 + 回报）
(while true; do
  RESP=$(curl -s "$DAEMON_URL/tasks/wait?agent=$OC_WF_AGENT" --max-time 3 2>/dev/null)
  TID=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);t=d.get('task');print(t.get('id','') if t else '')" 2>/dev/null)
  if [[ -n "$TID" && "$TID" != "" ]]; then
    sleep 1
    curl -s -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' \
      -d "{\"task_id\":\"$TID\",\"agent_name\":\"$OC_WF_AGENT\",\"status\":\"completed\",\"result\":\"OC workflow 执行结果 OK\"}" >/dev/null
  fi
done) &
OC_WF_WORKER=$!
sleep 2  # 等 worker long-poll 建立

# 通过 Server API 创建 workflow
OC_WF_RES=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"OC 完整链路测试\",\"nodes\":[{\"id\":\"oc-1\",\"agent_name\":\"$OC_WF_AGENT\",\"prompt\":\"OC e2e 全链路\",\"scope\":\"project\",\"intent\":\"query\"}]}" 2>/dev/null)
OC_WF_ID=$(echo "$OC_WF_RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id','') or d.get('id',''))" 2>/dev/null)
OC_WF_STATUS=$(echo "$OC_WF_RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)

assert "OC workflow 创建" "running" "$OC_WF_STATUS"

# 等 workflow 完成（Server 收到 Daemon 回报）
sleep 8
FINAL_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$OC_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)
assert "OC workflow completed" "completed" "$FINAL_STATUS"

# 验证结果内容
FINAL_RESULT=$(curl -s "$E2E_SERVER/api/workflows/$OC_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);ns=d.get('nodes',[]);print(ns[0].get('result','') if ns else '')" 2>/dev/null)
assert "OC workflow 有结果" "OC workflow 执行结果 OK" "$FINAL_RESULT"

# 清理
kill $OC_WF_WORKER 2>/dev/null
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$OC_WF_AGENT\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 22: DELETE /api/agents/:id
# ============================================================
if should_run 22; then
echo -e "${YELLOW}[22] DELETE /api/agents/:id${NC}"

# 直接通过 Server API 注册一个临时 agent
DEL_AGENT="del-test-agent"
curl -s -X POST "$E2E_SERVER/api/clients/register" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"e2e\",\"host_user\":\"e2e\",\"client_endpoint\":\"http://127.0.0.1:$NODE_PORT\",\"agents\":[{\"agent_name\":\"$DEL_AGENT\",\"runtime\":\"opencode\",\"project_path\":\"/tmp\",\"capabilities\":\"test\",\"mode\":\"subagent\"}]}" >/dev/null 2>&1

DEL_ID=$(curl -s "$E2E_SERVER/api/agents" 2>/dev/null | python3 -c "import json,sys;agents=json.load(sys.stdin);print(next((a['id'] for a in agents if a['agent_name']=='$DEL_AGENT'),''))" 2>/dev/null)
assert "有 agent 可删" "true" "$([ -n "$DEL_ID" ] && echo true || echo false)"

# 删除
DEL_RES=$(curl -s -X DELETE "$E2E_SERVER/api/agents/$DEL_ID" 2>/dev/null)
assert "DELETE 200" "$DEL_ID" "$(echo "$DEL_RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)"

# 再删同一个 → 404
DEL_404=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$E2E_SERVER/api/agents/$DEL_ID" 2>/dev/null)
assert "DELETE 404" "404" "$DEL_404"

# 清理
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$DEL_AGENT\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 23: GET /api/agents?fields= 过滤
# ============================================================
if should_run 23; then
echo -e "${YELLOW}[23] GET /api/agents?fields= 过滤${NC}"

# 确保有 agent（直接注册）
curl -s -X POST "$E2E_SERVER/api/clients/register" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"e2e\",\"host_user\":\"e2e\",\"client_endpoint\":\"http://127.0.0.1:$NODE_PORT\",\"agents\":[{\"agent_name\":\"fields-test-agent\",\"runtime\":\"opencode\",\"project_path\":\"/tmp\",\"capabilities\":\"test\",\"mode\":\"subagent\"}]}" >/dev/null 2>&1

# 请求全量
FULL=$(curl -s "$E2E_SERVER/api/agents" 2>/dev/null | python3 -c "import json,sys;a=json.load(sys.stdin);print(len(a[0].keys()) if a else 0)" 2>/dev/null)
assert "全量字段 > 5" "true" "$([ "$FULL" -gt 5 ] && echo true || echo false)"

# 请求精简
FIELDS_RES=$(curl -s "$E2E_SERVER/api/agents?fields=agent_name,status" 2>/dev/null)
FIELD_COUNT=$(echo "$FIELDS_RES" | python3 -c "import json,sys;a=json.load(sys.stdin);print(len(a[0].keys()) if a else 0)" 2>/dev/null)
assert "fields 过滤只有 2 个字段" "2" "$FIELD_COUNT"
HAS_NAME=$(echo "$FIELDS_RES" | python3 -c "import json,sys;a=json.load(sys.stdin);print('agent_name' in a[0] if a else False)" 2>/dev/null)
assert "fields 含 agent_name" "True" "$HAS_NAME"
fi

# ============================================================
# Case 24: CC next_task 续传
# ============================================================
if should_run 24; then
echo -e "${YELLOW}[24] CC next_task 续传${NC}"

CC_CHAIN_AGENT="cc-chain-e2e"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_CHAIN_AGENT\",\"runtime\":\"claude-code\"}" >/dev/null 2>&1
sleep 1

# 入队 3 个任务
curl -s -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_CHAIN_AGENT\",\"workflow_id\":\"chain-1\",\"node_id\":\"n1\",\"prompt\":\"chain task 1\",\"intent\":\"query\"}" >/dev/null 2>&1
curl -s -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_CHAIN_AGENT\",\"workflow_id\":\"chain-2\",\"node_id\":\"n2\",\"prompt\":\"chain task 2\",\"intent\":\"query\"}" >/dev/null 2>&1
curl -s -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_CHAIN_AGENT\",\"workflow_id\":\"chain-3\",\"node_id\":\"n3\",\"prompt\":\"chain task 3\",\"intent\":\"query\"}" >/dev/null 2>&1

# 模拟 CC: take 第一个
TAKE1=$(curl -s -X POST "$DAEMON_URL/tasks/take?agent=$CC_CHAIN_AGENT" 2>/dev/null)
TID1=$(echo "$TAKE1" | python3 -c "import json,sys;t=json.load(sys.stdin).get('task');print(t['id'] if t else '')" 2>/dev/null)
assert "take 第一个任务" "true" "$([ -n "$TID1" ] && echo true || echo false)"

# 回报第一个 → 检查 next_task
DONE1=$(curl -s -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' \
  -d "{\"task_id\":\"$TID1\",\"agent_name\":\"$CC_CHAIN_AGENT\",\"status\":\"completed\",\"result\":\"done1\"}" 2>/dev/null)
NEXT1=$(echo "$DONE1" | python3 -c "import json,sys;d=json.load(sys.stdin);nt=d.get('next_task');print(nt['id'] if nt else '')" 2>/dev/null)
assert "next_task 有第二个" "true" "$([ -n "$NEXT1" ] && echo true || echo false)"

# 回报第二个 → 检查 next_task
DONE2=$(curl -s -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' \
  -d "{\"task_id\":\"$NEXT1\",\"agent_name\":\"$CC_CHAIN_AGENT\",\"status\":\"completed\",\"result\":\"done2\"}" 2>/dev/null)
NEXT2=$(echo "$DONE2" | python3 -c "import json,sys;d=json.load(sys.stdin);nt=d.get('next_task');print(nt['id'] if nt else '')" 2>/dev/null)
assert "next_task 有第三个" "true" "$([ -n "$NEXT2" ] && echo true || echo false)"

# 回报第三个 → next_task 应为 null
DONE3=$(curl -s -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' \
  -d "{\"task_id\":\"$NEXT2\",\"agent_name\":\"$CC_CHAIN_AGENT\",\"status\":\"completed\",\"result\":\"done3\"}" 2>/dev/null)
NEXT3=$(echo "$DONE3" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('next_task'))" 2>/dev/null)
assert "next_task 队列空" "None" "$NEXT3"

# 清理
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_CHAIN_AGENT\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 25: SSE 结果不串扰
# ============================================================
if should_run 25; then
echo -e "${YELLOW}[25] SSE 结果不串扰${NC}"

# 注册两个 agent
SSE_AGENT1="sse-agent1"
SSE_AGENT2="sse-agent2"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SSE_AGENT1\",\"runtime\":\"opencode\",\"plugin_pid\":$$}" >/dev/null 2>&1
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SSE_AGENT2\",\"runtime\":\"opencode\",\"plugin_pid\":$$}" >/dev/null 2>&1
sleep 2

# 给 agent1 发任务
WF_SSE=$(curl -s -X POST "$E2E_SERVER/api/workflows" -H 'Content-Type: application/json' \
  -d "{\"title\":\"sse-test\",\"nodes\":[{\"id\":\"s1\",\"agent_name\":\"$SSE_AGENT1\",\"prompt\":\"test\",\"scope\":\"project\",\"intent\":\"query\"}]}" 2>/dev/null)
WF_SSE_ID=$(echo "$WF_SSE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workflow_id',''))" 2>/dev/null)
sleep 1

# agent1 取任务并完成
TAKE_SSE=$(curl -s -X POST "$DAEMON_URL/tasks/take?agent=$SSE_AGENT1" 2>/dev/null)
TID_SSE=$(echo "$TAKE_SSE" | python3 -c "import json,sys;t=json.load(sys.stdin).get('task');print(t['id'] if t else '')" 2>/dev/null)
curl -s -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' \
  -d "{\"task_id\":\"$TID_SSE\",\"agent_name\":\"$SSE_AGENT1\",\"status\":\"completed\",\"result\":\"agent1-result\"}" >/dev/null 2>&1
sleep 2

# 验证 workflow 完成
WF_SSE_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$WF_SSE_ID" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
assert "SSE workflow completed" "completed" "$WF_SSE_STATUS"

# agent2 的队列应该是空的（没有串扰的任务结果推到它那里）
AGENT2_Q=$(curl -s "$DAEMON_URL/tasks/take?agent=$SSE_AGENT2" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('task'))" 2>/dev/null)
assert "agent2 无串扰任务" "None" "$AGENT2_Q"

# 清理
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' -d "{\"agent_name\":\"$SSE_AGENT1\"}" >/dev/null 2>&1
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' -d "{\"agent_name\":\"$SSE_AGENT2\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 26: CC agent 超时变 offline
# ============================================================
if should_run 26; then
echo -e "${YELLOW}[26] CC agent 超时变 offline${NC}"

CC_TIMEOUT_AGENT="cc-timeout-e2e"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_TIMEOUT_AGENT\",\"runtime\":\"claude-code\"}" >/dev/null 2>&1
sleep 2

# 刚注册，应该 online（lastSeen 新鲜）
wait_until 5 "get_agent_field status $CC_TIMEOUT_AGENT" "online" || true
assert "CC 刚注册 online" "online" "$(get_agent_field status $CC_TIMEOUT_AGENT)"

# 等 16s（超过 15s 阈值），不再 touchAgent
sleep 16

# 此时 lastSeen 超时，应该 offline
wait_until 5 "get_agent_field status $CC_TIMEOUT_AGENT" "offline" || true
assert "CC 超时后 offline" "offline" "$(get_agent_field status $CC_TIMEOUT_AGENT)"

# 清理
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_TIMEOUT_AGENT\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 27: CC --wait Daemon 重启后自动重连
# ============================================================
if should_run 27; then
echo -e "${YELLOW}[27] CC --wait Daemon 重启后自动重连${NC}"

CC_RECONNECT_AGENT="cc-reconnect-e2e"

# 启动 CC --wait 进程（后台）
MAF_AGENT_NAME="$CC_RECONNECT_AGENT" MAF_RUNTIME="claude-code" \
MAF_NODE_PORT=$NODE_PORT MAF_DIRECTORY="/tmp" MAF_USER_ID="e2e-testuser" \
META_AGENT_SERVER="$E2E_SERVER" \
node plugins/claude-code-plugin-maf/scripts/maf-agent.mjs --daemon &>/dev/null
MAF_AGENT_NAME="$CC_RECONNECT_AGENT" MAF_RUNTIME="claude-code" \
MAF_NODE_PORT=$NODE_PORT MAF_DIRECTORY="/tmp" MAF_USER_ID="e2e-testuser" \
META_AGENT_SERVER="$E2E_SERVER" \
node plugins/claude-code-plugin-maf/scripts/maf-agent.mjs --wait &>/dev/null &
CC_WAIT_PID=$!
sleep 2

# 确认 agent 在线
wait_until 5 "get_agent_field status $CC_RECONNECT_AGENT" "online" || true
assert "CC wait 启动后 online" "online" "$(get_agent_field status $CC_RECONNECT_AGENT)"

# 杀 Daemon
DAEMON_PID=$(ss -tlnp 2>/dev/null | grep ":$NODE_PORT " | grep -oP 'pid=\K\d+' | head -1)
[[ -n "$DAEMON_PID" ]] && kill -9 "$DAEMON_PID" 2>/dev/null
sleep 1

# 用 mock-opencode 拉起新 Daemon（模拟 OC Plugin 拉起）
start_mock_opencode
sleep 5

# CC --wait 应该自动重连到新 Daemon
wait_until 15 "get_agent_field status $CC_RECONNECT_AGENT" "online" || true
assert "CC wait 重连后 online" "online" "$(get_agent_field status $CC_RECONNECT_AGENT)"

# 清理
kill $CC_WAIT_PID 2>/dev/null
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CC_RECONNECT_AGENT\"}" >/dev/null 2>&1
fi

# ============================================================
# Case 28: check-write-path.mjs 写入保护
# ============================================================
if should_run 28; then
echo -e "\n${YELLOW}Case 28: check-write-path.mjs 写入保护${NC}"

HOOK_SCRIPT="$SCRIPT_DIR/scripts/check-write-path.mjs"

# 28a: 写 .opencode/ → 应该拒绝 (exit 2)
EXIT_CODE=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"/home/user/.meta-agent-framework/.opencode/rules/test.md"}}' \
  | node "$HOOK_SCRIPT" >/dev/null 2>&1 || EXIT_CODE=$?
assert "写 .opencode/ 被拒绝 (exit 2)" "2" "$EXIT_CODE"

# 28b: 写 common_agent/ → 应该拒绝 (exit 2)
EXIT_CODE=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"/home/user/.meta-agent-framework/common_agent/rules/test.md"}}' \
  | node "$HOOK_SCRIPT" >/dev/null 2>&1 || EXIT_CODE=$?
assert "写 common_agent/ 被拒绝 (exit 2)" "2" "$EXIT_CODE"

# 28c: 写 .codex/ → 应该拒绝 (exit 2)
EXIT_CODE=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"/home/user/.meta-agent-framework/.codex/skills/meta-agent-server/SKILL.md"}}' \
  | node "$HOOK_SCRIPT" >/dev/null 2>&1 || EXIT_CODE=$?
assert "写 .codex/ 被拒绝 (exit 2)" "2" "$EXIT_CODE"

# 28d: 写 runtime 入口文件 → 应该拒绝 (exit 2)
EXIT_CODE=0
echo '{"tool_name":"Write","tool_input":{"file_path":"/home/user/.meta-agent-framework/AGENTS.md"}}' \
  | node "$HOOK_SCRIPT" >/dev/null 2>&1 || EXIT_CODE=$?
assert "写 AGENTS.md 被拒绝 (exit 2)" "2" "$EXIT_CODE"

# 28e: 写 user/ → 应该放行 (exit 0)
EXIT_CODE=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"/home/user/.meta-agent-framework/user/notes.md"}}' \
  | node "$HOOK_SCRIPT" >/dev/null 2>&1 || EXIT_CODE=$?
assert "写 user/ 放行 (exit 0)" "0" "$EXIT_CODE"

# 28f: 写其他路径 → 放行 (exit 0)
EXIT_CODE=0
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/random-file.txt"}}' \
  | node "$HOOK_SCRIPT" >/dev/null 2>&1 || EXIT_CODE=$?
assert "写其他路径放行 (exit 0)" "0" "$EXIT_CODE"

# 28g: 非写工具 → 放行 (exit 0)
EXIT_CODE=0
echo '{"tool_name":"Read","tool_input":{"file_path":"/home/user/.meta-agent-framework/.opencode/rules/test.md"}}' \
  | node "$HOOK_SCRIPT" >/dev/null 2>&1 || EXIT_CODE=$?
assert "Read 工具不拦截 (exit 0)" "0" "$EXIT_CODE"

fi

# ============================================================
# Case 29: syncWorkspace managed asset overwrite（框架管理资产升级覆盖）
# ============================================================
if should_run 29; then
echo -e "\n${YELLOW}Case 29: syncWorkspace managed asset overwrite${NC}"

# 用真实 maf-server sync-plugins 验证源码布局映射到安装态隐藏目录。
SYNC_TEST_HOME="/tmp/maf-sync-test-home"
SYNC_TEST_MAF_HOME="/tmp/maf-sync-test-maf-home"
rm -rf "$SYNC_TEST_HOME" "$SYNC_TEST_MAF_HOME"
mkdir -p "$SYNC_TEST_HOME" \
  "$SYNC_TEST_MAF_HOME/common_agent/rules" \
  "$SYNC_TEST_MAF_HOME/skills/meta-agent-client" \
  "$SYNC_TEST_MAF_HOME/.opencode/skills/meta-agent-server" \
  "$SYNC_TEST_MAF_HOME/.claude/skills/meta-agent-server" \
  "$SYNC_TEST_MAF_HOME/.codex/skills/meta-agent-server"

# 目标：已有托管资产旧版本，升级同步必须覆盖。
echo "old framework dispatch" > "$SYNC_TEST_MAF_HOME/common_agent/rules/dispatch-flow.md"
echo "old evolve guide" > "$SYNC_TEST_MAF_HOME/common_agent/rules/evolve-guide.md"
echo "old client skill" > "$SYNC_TEST_MAF_HOME/skills/meta-agent-client/SKILL.md"
echo "old opencode server skill" > "$SYNC_TEST_MAF_HOME/.opencode/skills/meta-agent-server/SKILL.md"
echo "old claude server skill" > "$SYNC_TEST_MAF_HOME/.claude/skills/meta-agent-server/SKILL.md"
echo "old codex server skill" > "$SYNC_TEST_MAF_HOME/.codex/skills/meta-agent-server/SKILL.md"
echo "old codex agents" > "$SYNC_TEST_MAF_HOME/AGENTS.md"

HOME="$SYNC_TEST_HOME" MAF_HOME="$SYNC_TEST_MAF_HOME" \
  node "$SCRIPT_DIR/bin/maf-server.mjs" sync-plugins

# 验证：common_agent/、opencode/、claude/、codex/ 已物化为安装态 runtime 布局。
assert "common instructions 同步" "通用管理者协议" "$(cat "$SYNC_TEST_MAF_HOME/common_agent/instructions/Meta-Agent-Server.md" 2>/dev/null || true)"
assert "common rules 被覆盖" "标准派发流程" "$(cat "$SYNC_TEST_MAF_HOME/common_agent/rules/dispatch-flow.md" 2>/dev/null || true)"
assert "evolve guide 同步" "Evolve 分发指南" "$(cat "$SYNC_TEST_MAF_HOME/common_agent/rules/evolve-guide.md" 2>/dev/null || true)"
assert "opencode agent 同步到 .opencode" "opencode runtime wrapper" "$(cat "$SYNC_TEST_MAF_HOME/.opencode/agents/Meta-Agent-Server.md" 2>/dev/null || true)"
assert "opencode skill 同步到 .opencode" "Meta-Agent-Server Skill" "$(cat "$SYNC_TEST_MAF_HOME/.opencode/skills/meta-agent-server/SKILL.md" 2>/dev/null || true)"
assert "Claude skill 同步到 .claude" "Meta-Agent-Server Skill" "$(cat "$SYNC_TEST_MAF_HOME/.claude/skills/meta-agent-server/SKILL.md" 2>/dev/null || true)"
assert "Codex skill 同步到 .codex" "Meta-Agent-Server Skill" "$(cat "$SYNC_TEST_MAF_HOME/.codex/skills/meta-agent-server/SKILL.md" 2>/dev/null || true)"
assert "client skill 被覆盖" "Meta-Agent Client Protocol" "$(cat "$SYNC_TEST_MAF_HOME/skills/meta-agent-client/SKILL.md" 2>/dev/null || true)"
assert "opencode 配置同步" "instructions" "$(cat "$SYNC_TEST_MAF_HOME/opencode.json" 2>/dev/null || true)"
assert "Claude settings 同步" "SessionStart" "$(cat "$SYNC_TEST_MAF_HOME/.claude/settings.local.json" 2>/dev/null || true)"
assert "Claude 入口同步" "Meta-Agent-Server" "$(cat "$SYNC_TEST_MAF_HOME/CLAUDE.md" 2>/dev/null || true)"
assert "Codex 入口被覆盖" "Codex project agent: Meta-Agent-Server" "$(cat "$SYNC_TEST_MAF_HOME/AGENTS.md" 2>/dev/null || true)"

rm -rf "$SYNC_TEST_HOME" "$SYNC_TEST_MAF_HOME"
fi

# ============================================================
# Case 30: maf-client sessions 输出格式
# ============================================================
if should_run 30; then
echo -e "\n${YELLOW}Case 30: maf-client sessions${NC}"

# 验证 sessions 命令能正常执行（不报错，输出包含表头）
SESSIONS_OUTPUT=$(node "$ROOT_DIR/packages/client/bin/maf-install.mjs" sessions 2>&1) || true
assert "sessions 命令有表头" "Agent" "$SESSIONS_OUTPUT"
assert "sessions 命令有分隔线" "────" "$SESSIONS_OUTPUT"

fi

# ============================================================
# Case 31: Plugin 非 Manager 不接收 workflow 广播
# ============================================================
if should_run 31; then
echo -e "\n${YELLOW}Case 31: 非 Manager 不接收 workflow 广播${NC}"

# 验证 Plugin 代码中 isRelevant 只对 Meta-Agent-Server 为 true
RELEVANT_LINE=$(grep "isRelevant" "$SCRIPT_DIR/plugins/opencode-plugin-meta-agent-framework/index.js")
assert "isRelevant 只认 Meta-Agent-Server" "Meta-Agent-Server" "$RELEVANT_LINE"

# 验证不再包含 nodes.some 逻辑（旧代码）
NODES_SOME=$(grep "nodes.*some.*activeAgent" "$SCRIPT_DIR/plugins/opencode-plugin-meta-agent-framework/index.js" 2>/dev/null || echo "not_found")
assert "不再有 nodes.some 旧逻辑" "not_found" "$NODES_SOME"

# 验证 Codex maf-server 能被 receiver 识别为 Meta-Agent-Server
assert "Server Codex AGENTS marker" "Codex project agent: Meta-Agent-Server" "$(head -n 1 "$SCRIPT_DIR/codex/AGENTS.md" 2>/dev/null || true)"
assert "maf-server codex env agent" "MAF_AGENT_NAME: \"Meta-Agent-Server\"" "$(grep 'MAF_AGENT_NAME: \"Meta-Agent-Server\"' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server Codex plugin source" '"name": "maf"' "$(cat "$SCRIPT_DIR/plugins/codex/.codex-plugin/plugin.json" 2>/dev/null || true)"
assert "Server Codex installer source" "Server-served Codex client installer" "$(head -n 8 "$SCRIPT_DIR/plugins/codex-install.mjs" 2>/dev/null || true)"
assert "Server install.sh detects Codex" "HAS_CODEX" "$(grep 'HAS_CODEX' "$SCRIPT_DIR/plugins/install.sh" 2>/dev/null || true)"
assert "sync-client-pkg syncs Codex" 'cp -r "$SRC/codex" "$DST/codex"' "$(grep 'SRC/codex' "$ROOT_DIR/scripts/sync-client-pkg.sh" 2>/dev/null || true)"
assert "Codex ACK notification default off" 'MAF_CODEX_NOTIFY_ACK === "1"' "$(grep 'MAF_CODEX_NOTIFY_ACK' "$ROOT_DIR/packages/client/codex/scripts/maf-codex-attached-receiver.mjs" 2>/dev/null || true)"
assert "Server Codex installer route" "Server-served Codex client installer" "$(curl -s "$E2E_SERVER/codex-install.mjs" 2>/dev/null || true)"
assert "Server Codex plugin route" '"name": "maf"' "$(curl -s "$E2E_SERVER/codex-plugins/.codex-plugin/plugin.json" 2>/dev/null || true)"
assert "Server Claude dotfile plugin route" '"name": "maf"' "$(curl -s "$E2E_SERVER/cc-plugins/.claude-plugin/plugin.json" 2>/dev/null || true)"

# 验证 Server agent 资产已拆到非隐藏源码目录，安装时再物化为 runtime 隐藏布局
assert "Server common_agent source layout" "common_agent/" "$(grep 'common_agent/' "$SCRIPT_DIR/package.json" 2>/dev/null || true)"
assert "Server source no dot opencode package files" "not_found" "$(grep '\".opencode/' "$SCRIPT_DIR/package.json" 2>/dev/null || echo "not_found")"
assert "Server sync maps common instructions" "common_agent/instructions" "$(grep 'common_agent/instructions' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server sync maps server skills" "common_agent/server_skills" "$(grep 'common_agent/server_skills' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server sync maps opencode agents" "opencode/agents" "$(grep 'opencode/agents' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server sync maps codex AGENTS" "codex/AGENTS.md" "$(grep 'codex/AGENTS.md' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Opencode write guard protects .codex" "/.codex/" "$(grep '/.codex/' "$SCRIPT_DIR/plugins/opencode-plugin-meta-agent-framework/index.js" 2>/dev/null || true)"

# 验证 Meta-Agent-Server 异步派发模板带结果通知路由元数据，且明确点名任务走 fast path
DISPATCH_DOC="$(cat "$SCRIPT_DIR/common_agent/instructions/Meta-Agent-Server.md" "$SCRIPT_DIR/common_agent/rules/dispatch-flow.md" "$SCRIPT_DIR/opencode/agents/Meta-Agent-Server.md" "$SCRIPT_DIR/codex/AGENTS.md" "$SCRIPT_DIR/claude/CLAUDE.md" 2>/dev/null || true)"
assert "Meta-Agent-Server dispatch origin" '"origin"' "$DISPATCH_DOC"
assert "Meta-Agent-Server dispatch notify" '"notify"' "$DISPATCH_DOC"
assert "Meta-Agent-Server dispatch origin agent" '"agent_name": "Meta-Agent-Server"' "$DISPATCH_DOC"
assert "Meta-Agent-Server explicit dispatch fast path" "明确点名" "$DISPATCH_DOC"
assert "Meta-Agent-Server avoids reading big rules first" "不要先读取" "$DISPATCH_DOC"

fi

# ============================================================
# Case 32: Agent 切换时 disconnect 旧 agent（一个 TUI 只注册一个）
# ============================================================
if should_run 32; then
echo -e "\n${YELLOW}Case 32: Agent 切换 disconnect 旧 agent${NC}"

# 模拟：同一个 Plugin 先连 agent-A，再连 agent-B，验证 A 被 disconnect
SWITCH_AGENT_A="switch-test-a"
SWITCH_AGENT_B="switch-test-b"
SWITCH_PID=99999

# 连接 agent-A
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SWITCH_AGENT_A\",\"runtime\":\"opencode\",\"plugin_pid\":$SWITCH_PID,\"directory\":\"/tmp\"}" >/dev/null 2>&1

# 验证 A 在线
AGENTS_LIST=$(curl -s "$DAEMON_URL/agents" 2>/dev/null)
HAS_A=$(echo "$AGENTS_LIST" | python3 -c "import json,sys;d=json.load(sys.stdin);print('yes' if any(a['agent_name']=='$SWITCH_AGENT_A' for a in d['agents']) else 'no')" 2>/dev/null)
assert "agent-A 注册成功" "yes" "$HAS_A"

# 模拟 Tab 切换：先 disconnect A，再 connect B（Plugin chat.message 逻辑）
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SWITCH_AGENT_A\",\"plugin_pid\":$SWITCH_PID}" >/dev/null 2>&1
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SWITCH_AGENT_B\",\"runtime\":\"opencode\",\"plugin_pid\":$SWITCH_PID,\"directory\":\"/tmp\"}" >/dev/null 2>&1

# 验证：B 在线，A 不在
AGENTS_LIST=$(curl -s "$DAEMON_URL/agents" 2>/dev/null)
HAS_B=$(echo "$AGENTS_LIST" | python3 -c "import json,sys;d=json.load(sys.stdin);print('yes' if any(a['agent_name']=='$SWITCH_AGENT_B' for a in d['agents']) else 'no')" 2>/dev/null)
HAS_A_AFTER=$(echo "$AGENTS_LIST" | python3 -c "import json,sys;d=json.load(sys.stdin);print('yes' if any(a['agent_name']=='$SWITCH_AGENT_A' for a in d['agents']) else 'no')" 2>/dev/null)
assert "agent-B 注册成功" "yes" "$HAS_B"
assert "agent-A 已被 disconnect" "no" "$HAS_A_AFTER"

# 清理
curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$SWITCH_AGENT_B\",\"plugin_pid\":$SWITCH_PID}" >/dev/null 2>&1

fi


# ============================================================
# Case 33: Codex runtime screen+TUI 链路
# ============================================================
if should_run 33; then
echo -e "\n${YELLOW}Case 33: Codex runtime screen+TUI 链路${NC}"

CODEX_AGENT="codex-e2e-agent"
CODEX_PROJECT="/tmp/e2e-codex-project"
mkdir -p "$CODEX_PROJECT/.codex/agents"
cat > "$CODEX_PROJECT/AGENTS.md" << 'AGENTSEOF'
# E2E Codex Project

Respond briefly for tests.
AGENTSEOF
cat > "$CODEX_PROJECT/.codex/agents/${CODEX_AGENT}.md" << 'CODEXAGENT'
---
description: Codex E2E test agent
mode: subagent
runtime: codex
---

# Codex E2E Agent

用于验证 MAF Daemon 的 codex exec 链路。
CODEXAGENT

curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CODEX_AGENT\",\"runtime\":\"codex\",\"directory\":\"$CODEX_PROJECT\"}" >/dev/null 2>&1

wait_until 10 "get_agent_field runtime $CODEX_AGENT" "codex" || true
assert "Codex agent runtime" "codex" "$(get_agent_field runtime $CODEX_AGENT)"
assert "Codex agent online" "online" "$(get_agent_field status $CODEX_AGENT)"

CODEX_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Codex e2e workflow\",\"nodes\":[{\"id\":\"codex-1\",\"agent_name\":\"$CODEX_AGENT\",\"prompt\":\"Codex e2e task: say hello\",\"scope\":\"project\",\"intent\":\"query\"}]}")
CODEX_WF_ID=$(echo "$CODEX_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id',''))" 2>/dev/null)
assert "Codex workflow 创建" "true" "$([ -n "$CODEX_WF_ID" ] && echo true || echo false)"

for i in $(seq 1 20); do
  CODEX_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$CODEX_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)
  [[ "$CODEX_STATUS" == "completed" ]] && break
  sleep 1
done
assert "Codex workflow completed" "completed" "$CODEX_STATUS"
CODEX_RESULT=$(curl -s "$E2E_SERVER/api/workflows/$CODEX_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);ns=d.get('nodes',[]);print(ns[0].get('result','') if ns else '')" 2>/dev/null)
assert "Codex result from mock" "mock codex completed" "$CODEX_RESULT"

fi

# ============================================================
# Case 34: Codex plugin SessionStart 自动拉起 Daemon
# ============================================================
if should_run 34; then
echo -e "\n${YELLOW}Case 34: Codex plugin SessionStart 自动拉起 Daemon${NC}"

CODEX_AUTO_AGENT="codex-autostart-agent"
CODEX_AUTO_HOME="/tmp/e2e-codex-autostart-home"
CODEX_AUTO_PROJECT="/tmp/e2e-codex-autostart-project"
CODEX_AUTO_PORT=14134
CODEX_AUTO_DAEMON="http://127.0.0.1:${CODEX_AUTO_PORT}"
rm -rf "$CODEX_AUTO_HOME" "$CODEX_AUTO_PROJECT"
mkdir -p "$CODEX_AUTO_HOME" "$CODEX_AUTO_PROJECT"
cat > "$CODEX_AUTO_PROJECT/AGENTS.md" << AGENTEOF
# Codex project agent: ${CODEX_AUTO_AGENT}

E2E Codex autostart project.
AGENTEOF

PATH="$E2E_BIN:$PATH" HOME="$CODEX_AUTO_HOME" XDG_CONFIG_HOME="$CODEX_AUTO_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_AUTO_PORT" MAF_CODEX_DELIVERY="detached" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" --auto >/tmp/e2e-codex-autostart-install.log 2>&1

assert "Codex plugin source installed" "true" "$([ -f "$CODEX_AUTO_HOME/plugins/maf/scripts/maf-codex-hook.mjs" ] && echo true || echo false)"
assert "Codex plugin enabled" "maf@personal" "$(cat "$CODEX_AUTO_HOME/.codex/config.toml" 2>/dev/null || true)"

HOME="$CODEX_AUTO_HOME" XDG_CONFIG_HOME="$CODEX_AUTO_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_AUTO_PORT" MAF_CODEX_DELIVERY="detached" \
  node "$CODEX_AUTO_HOME/plugins/maf/scripts/maf-codex-hook.mjs" << JSON
{"cwd":"$CODEX_AUTO_PROJECT","eventName":"SessionStart"}
JSON

wait_until 10 "curl -s $CODEX_AUTO_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex hook daemon running" '"ok":true' "$(curl -s $CODEX_AUTO_DAEMON/health 2>/dev/null)"
assert "Codex hook daemon agent" "$CODEX_AUTO_AGENT" "$(curl -s $CODEX_AUTO_DAEMON/agents 2>/dev/null)"

wait_until 10 "get_agent_field runtime $CODEX_AUTO_AGENT" "codex" || true
assert "Codex autostart runtime" "codex" "$(get_agent_field runtime $CODEX_AUTO_AGENT)"
assert "Codex autostart online" "online" "$(get_agent_field status $CODEX_AUTO_AGENT)"

AUTO_PID=$(ss -tlnp 2>/dev/null | grep ":${CODEX_AUTO_PORT} " | grep -oP 'pid=\K\d+' | head -1)
[[ -n "$AUTO_PID" ]] && kill -9 "$AUTO_PID" 2>/dev/null || true

fi

# ============================================================
# Case 35: Codex launcher wrapper 自动拉起 Daemon
# ============================================================
if should_run 35; then
echo -e "\n${YELLOW}Case 35: Codex launcher wrapper 自动拉起 Daemon${NC}"

CODEX_WRAP_AGENT="codex-wrapper-agent"
CODEX_WRAP_HOME="/tmp/e2e-codex-wrapper-home"
CODEX_WRAP_PROJECT="/tmp/e2e-codex-wrapper-project"
CODEX_WRAP_MISC="/tmp/e2e-codex-wrapper-misc"
CODEX_WRAP_PORT=14135
CODEX_WRAP_DAEMON="http://127.0.0.1:${CODEX_WRAP_PORT}"
rm -rf "$CODEX_WRAP_HOME" "$CODEX_WRAP_PROJECT" "$CODEX_WRAP_MISC"
mkdir -p "$CODEX_WRAP_HOME" "$CODEX_WRAP_PROJECT" "$CODEX_WRAP_MISC"
cat > "$CODEX_WRAP_PROJECT/AGENTS.md" << AGENTEOF
# Codex project agent: ${CODEX_WRAP_AGENT}

E2E Codex wrapper project.
AGENTEOF

PATH="$E2E_BIN:$PATH" HOME="$CODEX_WRAP_HOME" XDG_CONFIG_HOME="$CODEX_WRAP_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_WRAP_PORT" MAF_CODEX_DELIVERY="detached" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" --auto >/tmp/e2e-codex-wrapper-install.log 2>&1

assert "Codex wrapper installed" "true" "$([ -x "$CODEX_WRAP_HOME/.local/bin/codex" ] && echo true || echo false)"
assert "Codex wrapper points to mock" "$E2E_BIN/codex" "$(grep 'REAL_CODEX=' "$CODEX_WRAP_HOME/.local/bin/codex" 2>/dev/null || true)"

(cd "$CODEX_WRAP_MISC" && PATH="$CODEX_WRAP_HOME/.local/bin:$E2E_BIN:$PATH" HOME="$CODEX_WRAP_HOME" XDG_CONFIG_HOME="$CODEX_WRAP_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_WRAP_PORT" MAF_CODEX_DELIVERY="detached" \
  MAF_CODEX_WRAPPER_DISABLE="" \
  timeout 5s codex --no-alt-screen >/tmp/e2e-codex-wrapper-misc-run.log 2>&1 || true)

wait_until 10 "curl -s $CODEX_WRAP_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex wrapper arbitrary-dir daemon running" '"ok":true' "$(curl -s $CODEX_WRAP_DAEMON/health 2>/dev/null)"
assert "Codex wrapper arbitrary-dir no agent" '"agents":\[\]' "$(curl -s $CODEX_WRAP_DAEMON/health 2>/dev/null)"
assert "Codex wrapper arbitrary-dir log" "daemon ready without explicit" "$(cat "$CODEX_WRAP_HOME/.meta-agent-framework/logs/codex-plugin.log" 2>/dev/null || true)"

(cd "$CODEX_WRAP_MISC" && PATH="$CODEX_WRAP_HOME/.local/bin:$E2E_BIN:$PATH" HOME="$CODEX_WRAP_HOME" XDG_CONFIG_HOME="$CODEX_WRAP_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_WRAP_PORT" MAF_CODEX_DELIVERY="detached" \
  MAF_CODEX_WRAPPER_DISABLE="" \
  timeout 5s codex -C "$CODEX_WRAP_PROJECT" --no-alt-screen >/tmp/e2e-codex-wrapper-run.log 2>&1 || true)

wait_until 10 "curl -s $CODEX_WRAP_DAEMON/agents 2>/dev/null" "$CODEX_WRAP_AGENT" || true
assert "Codex wrapper daemon agent" "$CODEX_WRAP_AGENT" "$(curl -s $CODEX_WRAP_DAEMON/agents 2>/dev/null)"
assert "Codex wrapper log" "codex-wrapper" "$(cat "$CODEX_WRAP_HOME/.meta-agent-framework/logs/codex-plugin.log" 2>/dev/null || true)"

wait_until 10 "get_agent_field runtime $CODEX_WRAP_AGENT" "codex" || true
assert "Codex wrapper runtime" "codex" "$(get_agent_field runtime $CODEX_WRAP_AGENT)"

WRAP_PID=$(ss -tlnp 2>/dev/null | grep ":${CODEX_WRAP_PORT} " | grep -oP 'pid=\K\d+' | head -1)
[[ -n "$WRAP_PID" ]] && kill -9 "$WRAP_PID" 2>/dev/null || true

fi


# ============================================================
# Case 36: Codex attached 默认不伪装 online
# ============================================================
if should_run 36; then
echo -e "\n${YELLOW}Case 36: Codex attached 默认不伪装 online${NC}"

CODEX_ATT_AGENT="codex-attached-agent"
CODEX_ATT_HOME="/tmp/e2e-codex-attached-home"
CODEX_ATT_PROJECT="/tmp/e2e-codex-attached-project"
CODEX_ATT_PORT=14136
CODEX_ATT_DAEMON="http://127.0.0.1:${CODEX_ATT_PORT}"
rm -rf "$CODEX_ATT_HOME" "$CODEX_ATT_PROJECT"
mkdir -p "$CODEX_ATT_HOME/.meta-agent-framework" "$CODEX_ATT_PROJECT"
cp "$SCRIPT_DIR/plugins/node-daemon/daemon.mjs" "$CODEX_ATT_HOME/.meta-agent-framework/daemon.mjs"
cat > "$CODEX_ATT_HOME/.meta-agent-framework/package.json" << PKGJSON
{"name":"@maf/meta-agent-daemon","version":"$EXPECTED_VERSION","type":"module"}
PKGJSON
cat > "$CODEX_ATT_PROJECT/AGENTS.md" << AGENTEOF
# Codex project agent: ${CODEX_ATT_AGENT}

Default attached delivery should not pretend to be online without an attached receiver.
AGENTEOF

HOME="$CODEX_ATT_HOME" XDG_CONFIG_HOME="$CODEX_ATT_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_ATT_PORT" MAF_DIRECTORY="$CODEX_ATT_PROJECT" \
  node "$CODEX_ATT_HOME/.meta-agent-framework/daemon.mjs" >/tmp/e2e-codex-attached-daemon.log 2>&1 &
CODEX_ATT_PID=$!
disown $CODEX_ATT_PID

wait_until 10 "curl -s $CODEX_ATT_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex attached daemon running" '"ok":true' "$(curl -s $CODEX_ATT_DAEMON/health 2>/dev/null)"

curl -s -X POST "$CODEX_ATT_DAEMON/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CODEX_ATT_AGENT\",\"runtime\":\"codex\",\"directory\":\"$CODEX_ATT_PROJECT\"}" >/dev/null 2>&1

wait_until 10 "get_agent_field runtime $CODEX_ATT_AGENT" "codex" || true
assert "Codex attached runtime" "codex" "$(get_agent_field runtime $CODEX_ATT_AGENT)"
assert "Codex attached default offline" "offline" "$(get_agent_field status $CODEX_ATT_AGENT)"

ATT_EXEC=$(curl -s -w '\nHTTP:%{http_code}' -X POST "$CODEX_ATT_DAEMON/execute" \
  -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CODEX_ATT_AGENT\",\"runtime\":\"codex\",\"prompt\":\"should fail attached clearly\"}")
assert "Codex attached execute rejected" "HTTP:409" "$ATT_EXEC"
assert "Codex attached clear error" "attached delivery" "$ATT_EXEC"

kill -9 "$CODEX_ATT_PID" 2>/dev/null || true

fi


# ============================================================
# Case 37: Codex attached receiver app-server bridge
# ============================================================
if should_run 37; then
echo -e "\n${YELLOW}Case 37: Codex attached receiver app-server bridge${NC}"

CODEX_RECV_AGENT="codex-receiver-agent"
CODEX_RECV_HOME="/tmp/e2e-codex-receiver-home"
CODEX_RECV_PROJECT="/tmp/e2e-codex-receiver-project"
CODEX_RECV_PORT=14137
CODEX_RECV_DAEMON="http://127.0.0.1:${CODEX_RECV_PORT}"
CODEX_RECV_TURN_LOG="/tmp/e2e-codex-receiver-turns.log"
rm -rf "$CODEX_RECV_HOME" "$CODEX_RECV_PROJECT"
rm -f "$CODEX_RECV_TURN_LOG"
mkdir -p "$CODEX_RECV_HOME/.meta-agent-framework" "$CODEX_RECV_PROJECT"
cp "$SCRIPT_DIR/plugins/node-daemon/daemon.mjs" "$CODEX_RECV_HOME/.meta-agent-framework/daemon.mjs"
cat > "$CODEX_RECV_HOME/.meta-agent-framework/package.json" << PKGJSON
{"name":"@maf/meta-agent-daemon","version":"$EXPECTED_VERSION","type":"module"}
PKGJSON
cat > "$CODEX_RECV_PROJECT/AGENTS.md" << AGENTEOF
# Codex project agent: ${CODEX_RECV_AGENT}

E2E Codex attached receiver project.
AGENTEOF

HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  node "$CODEX_RECV_HOME/.meta-agent-framework/daemon.mjs" >/tmp/e2e-codex-receiver-daemon.log 2>&1 &
CODEX_RECV_DAEMON_PID=$!
disown $CODEX_RECV_DAEMON_PID

wait_until 10 "curl -s $CODEX_RECV_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex receiver daemon running" '"ok":true' "$(curl -s $CODEX_RECV_DAEMON/health 2>/dev/null)"

HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MOCK_CODEX_TURN_LOG="$CODEX_RECV_TURN_LOG" \
  MAF_CODEX_NOTIFY_ACK=1 \
  MAF_CODEX_APP_SERVER_CMD="node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-hook.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"SessionStart"}
HOOKJSON
CODEX_RECV_PID_FILE="$CODEX_RECV_HOME/.meta-agent-framework/codex-attached-receiver-${CODEX_RECV_AGENT}.pid"
CODEX_RECV_PID="$(cat "$CODEX_RECV_PID_FILE" 2>/dev/null || true)"
assert "Codex attached receiver spawned by hook" "true" "$([[ -n "$CODEX_RECV_PID" ]] && kill -0 "$CODEX_RECV_PID" 2>/dev/null && echo true || echo false)"

wait_until 10 "get_agent_field status $CODEX_RECV_AGENT" "online" || true
assert "Codex attached receiver online" "online" "$(get_agent_field status $CODEX_RECV_AGENT)"
assert "Codex attached receiver runtime" "codex" "$(get_agent_field runtime $CODEX_RECV_AGENT)"

RECV_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Codex attached receiver e2e\",\"nodes\":[{\"id\":\"recv-1\",\"agent_name\":\"$CODEX_RECV_AGENT\",\"prompt\":\"Codex attached e2e task: say hello from current receiver\",\"scope\":\"project\",\"intent\":\"query\"}]}")
RECV_WF_ID=$(echo "$RECV_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id',''))" 2>/dev/null)
assert "Codex attached workflow 创建" "true" "$([ -n "$RECV_WF_ID" ] && echo true || echo false)"

for i in $(seq 1 20); do
  RECV_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$RECV_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)
  [[ "$RECV_STATUS" == "completed" ]] && break
  sleep 1
done
assert "Codex attached workflow completed" "completed" "$RECV_STATUS"
RECV_RESULT=$(curl -s "$E2E_SERVER/api/workflows/$RECV_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);ns=d.get('nodes',[]);print(ns[0].get('result','') if ns else '')" 2>/dev/null)
assert "Codex attached result from mock" "mock attached codex completed" "$RECV_RESULT"
assert "Codex attached did not create screen" "No Sockets" "$(screen -ls 2>&1 || true)"
wait_until 10 "cat '$CODEX_RECV_TURN_LOG' 2>/dev/null" "\\[MAF 任务回报完成\\]" || true
assert "Codex attached ACK injected" "\\[MAF 任务回报完成\\]" "$(cat "$CODEX_RECV_TURN_LOG" 2>/dev/null || true)"
assert "Codex attached ACK confirms workflow reported" "workflow_reported: true" "$(cat "$CODEX_RECV_TURN_LOG" 2>/dev/null || true)"
assert "Codex attached ACK prompt concise" "MAF 通知，请原样回显" "$(cat "$CODEX_RECV_TURN_LOG" 2>/dev/null || true)"
assert "Codex attached ACK prompt no verbose instruction" "true" "$(! grep -q '请只输出下面这段 MAF 通知原文' "$CODEX_RECV_TURN_LOG" 2>/dev/null && echo true || echo false)"

CODEX_NOTIFY_PORT=14937
CODEX_NOTIFY_ENDPOINT="http://127.0.0.1:${CODEX_NOTIFY_PORT}"
CODEX_NOTIFY_AGENT="codex-notify-worker-$$"
CODEX_NOTIFY_PORT="$CODEX_NOTIFY_PORT" node -e '
const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/execute" && req.method === "POST") {
    req.resume();
    res.writeHead(202, {"content-type":"application/json"});
    res.end(JSON.stringify({accepted:true}));
    return;
  }
  res.writeHead(req.url === "/health" ? 200 : 404, {"content-type":"application/json"});
  res.end(JSON.stringify({ok:req.url === "/health"}));
});
server.listen(process.env.CODEX_NOTIFY_PORT, "127.0.0.1");
' >/tmp/e2e-codex-notify-endpoint.log 2>&1 &
CODEX_NOTIFY_ENDPOINT_PID=$!
disown $CODEX_NOTIFY_ENDPOINT_PID
wait_until 10 "curl -s $CODEX_NOTIFY_ENDPOINT/health 2>/dev/null" '"ok":true' || true

curl -s -X POST "$E2E_SERVER/api/clients/register" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"codex-notify-e2e\",\"host_user\":\"local\",\"client_endpoint\":\"$CODEX_NOTIFY_ENDPOINT\",\"agents\":[{\"agent_name\":\"$CODEX_NOTIFY_AGENT\",\"project_path\":\"/tmp\",\"capabilities\":\"codex notify worker\",\"runtime\":\"opencode\"}]}" >/dev/null
wait_until 10 "get_agent_field status $CODEX_NOTIFY_AGENT" "online" || true

NOTIFY_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Codex origin notification e2e\",\"origin\":{\"agent_name\":\"$CODEX_RECV_AGENT\",\"runtime\":\"codex\",\"thread_id\":\"mock-thread-1\"},\"notify\":{\"mode\":\"originator\",\"include_result\":true},\"nodes\":[{\"id\":\"notify-1\",\"agent_name\":\"$CODEX_NOTIFY_AGENT\",\"prompt\":\"notify current Codex origin\",\"scope\":\"project\",\"intent\":\"query\"}]}")
NOTIFY_WF_ID=$(echo "$NOTIFY_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id',''))" 2>/dev/null)
assert "Codex origin notify workflow 创建" "true" "$([ -n "$NOTIFY_WF_ID" ] && echo true || echo false)"
sleep 1
curl -s -X POST "$E2E_SERVER/api/workflows/$NOTIFY_WF_ID/nodes/notify-1/result" \
  -H 'Content-Type: application/json' \
  -d '{"execution_id":"codex-notify-manual","status":"completed","result":"codex origin notification result"}' >/dev/null
wait_until 10 "cat '$CODEX_RECV_TURN_LOG' 2>/dev/null" "\\[MAF 后台任务结果通知\\]" || true
assert "Codex origin workflow notification injected" "\\[MAF 后台任务结果通知\\]" "$(cat "$CODEX_RECV_TURN_LOG" 2>/dev/null || true)"
assert "Codex origin workflow notification result" "codex origin notification result" "$(cat "$CODEX_RECV_TURN_LOG" 2>/dev/null || true)"

kill -TERM "$CODEX_RECV_PID" 2>/dev/null || true
wait_until 10 "get_agent_field status $CODEX_RECV_AGENT" "offline" || true
assert "Codex attached receiver disconnect offline" "offline" "$(get_agent_field status $CODEX_RECV_AGENT)"

kill -9 "$CODEX_RECV_PID" "$CODEX_RECV_DAEMON_PID" "$CODEX_NOTIFY_ENDPOINT_PID" 2>/dev/null || true

fi


# ============================================================
# Case 38: Codex wrapper 自动 remote 化并接入 attached receiver
# ============================================================
if should_run 38; then
echo -e "
${YELLOW}Case 38: Codex wrapper auto-remote attached receiver${NC}"

CODEX_REMOTE_AGENT="codex-auto-remote-agent-$$"
CODEX_REMOTE_HOME="/tmp/e2e-codex-auto-remote-home"
CODEX_REMOTE_PROJECT="/tmp/e2e-codex-auto-remote-project"
CODEX_REMOTE_MISC="/tmp/e2e-codex-auto-remote-misc"
CODEX_REMOTE_PORT=14138
CODEX_REMOTE_APP_PORT=14938
CODEX_REMOTE_DAEMON="http://127.0.0.1:${CODEX_REMOTE_PORT}"
CODEX_REMOTE_ARGS_LOG="/tmp/e2e-codex-auto-remote-args.log"
rm -rf "$CODEX_REMOTE_HOME" "$CODEX_REMOTE_PROJECT" "$CODEX_REMOTE_MISC" "$CODEX_REMOTE_ARGS_LOG"
mkdir -p "$CODEX_REMOTE_HOME" "$CODEX_REMOTE_PROJECT" "$CODEX_REMOTE_MISC"
cat > "$CODEX_REMOTE_PROJECT/AGENTS.md" << AGENTEOF
# Codex project agent: ${CODEX_REMOTE_AGENT}

E2E Codex wrapper auto-remote project.
AGENTEOF

PATH="$E2E_BIN:$PATH" HOME="$CODEX_REMOTE_HOME" XDG_CONFIG_HOME="$CODEX_REMOTE_HOME/.config"   META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_REMOTE_PORT"   node "$ROOT_DIR/packages/client/bin/maf-install.mjs" --auto >/tmp/e2e-codex-auto-remote-install.log 2>&1

assert "Codex auto-remote wrapper installed" "true" "$([ -x "$CODEX_REMOTE_HOME/.local/bin/codex" ] && echo true || echo false)"
assert "Codex auto-remote helper installed" "true" "$([ -x "$CODEX_REMOTE_HOME/plugins/maf/scripts/maf-codex-app-server.mjs" ] && echo true || echo false)"

(cd "$CODEX_REMOTE_MISC" && PATH="$CODEX_REMOTE_HOME/.local/bin:$E2E_BIN:$PATH" HOME="$CODEX_REMOTE_HOME" XDG_CONFIG_HOME="$CODEX_REMOTE_HOME/.config"   META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_REMOTE_PORT"   MAF_CODEX_APP_SERVER_PORT="$CODEX_REMOTE_APP_PORT" MAF_CODEX_THREAD_WAIT_MS=5000 MAF_CODEX_WRAPPER_DISABLE=""   MOCK_CODEX_APP_SERVER_SCRIPT="$ROOT_DIR/scripts/mock-codex-app-server.mjs" MOCK_CODEX_ARGS_LOG="$CODEX_REMOTE_ARGS_LOG" MOCK_CODEX_SLEEP_SECONDS=10   "$CODEX_REMOTE_HOME/.local/bin/codex" -C "$CODEX_REMOTE_PROJECT" resume --last --all >/tmp/e2e-codex-auto-remote-run.log 2>&1) &
CODEX_REMOTE_WRAPPER_PID=$!

wait_until 10 "curl -s $CODEX_REMOTE_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex auto-remote daemon running" '"ok":true' "$(curl -s $CODEX_REMOTE_DAEMON/health 2>/dev/null)"
assert "Codex auto-remote arg injected" "[--remote]" "$(cat "$CODEX_REMOTE_ARGS_LOG" 2>/dev/null || true)"
assert "Codex auto-remote url injected" "ws://127.0.0.1:${CODEX_REMOTE_APP_PORT}" "$(cat "$CODEX_REMOTE_ARGS_LOG" 2>/dev/null || true)"
assert "Codex auto-remote wrapper log" "auto remote url=ws://127.0.0.1:${CODEX_REMOTE_APP_PORT}" "$(cat "$CODEX_REMOTE_HOME/.meta-agent-framework/logs/codex-plugin.log" 2>/dev/null || true)"

wait_until 15 "get_agent_field status $CODEX_REMOTE_AGENT" "online" || true
assert "Codex auto-remote receiver online" "online" "$(get_agent_field status $CODEX_REMOTE_AGENT)"
assert "Codex auto-remote runtime" "codex" "$(get_agent_field runtime $CODEX_REMOTE_AGENT)"

REMOTE_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Codex auto remote receiver e2e\",\"nodes\":[{\"id\":\"remote-1\",\"agent_name\":\"$CODEX_REMOTE_AGENT\",\"prompt\":\"Codex attached e2e task: hello from auto remote wrapper\",\"scope\":\"project\",\"intent\":\"query\"}]}")
REMOTE_WF_ID=$(echo "$REMOTE_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id',''))" 2>/dev/null)
assert "Codex auto-remote workflow 创建" "true" "$([ -n "$REMOTE_WF_ID" ] && echo true || echo false)"

for i in $(seq 1 20); do
  REMOTE_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$REMOTE_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)
  [[ "$REMOTE_STATUS" == "completed" ]] && break
  sleep 1
done
assert "Codex auto-remote workflow completed" "completed" "$REMOTE_STATUS"
REMOTE_RESULT=$(curl -s "$E2E_SERVER/api/workflows/$REMOTE_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);ns=d.get('nodes',[]);print(ns[0].get('result','') if ns else '')" 2>/dev/null)
assert "Codex auto-remote result from mock" "mock attached codex completed" "$REMOTE_RESULT"
assert "Codex auto-remote did not create screen" "No Sockets" "$(screen -ls 2>&1 || true)"

wait "$CODEX_REMOTE_WRAPPER_PID" 2>/dev/null || true
wait_until 10 "get_agent_field status $CODEX_REMOTE_AGENT" "offline" || true
assert "Codex auto-remote wrapper exit offline" "offline" "$(get_agent_field status $CODEX_REMOTE_AGENT)"

CODEX_REMOTE_APP_PID=$(python3 -c "import json,sys,pathlib; p=pathlib.Path('$CODEX_REMOTE_HOME/.meta-agent-framework/state/codex-app-server-${CODEX_REMOTE_AGENT}.json'); print(json.loads(p.read_text()).get('pid','') if p.exists() else '')" 2>/dev/null || true)
CODEX_REMOTE_RECV_PID=$(cat "$CODEX_REMOTE_HOME/.meta-agent-framework/codex-attached-receiver-${CODEX_REMOTE_AGENT}.pid" 2>/dev/null || true)
CODEX_REMOTE_DAEMON_PID=$(ss -tlnp 2>/dev/null | grep ":${CODEX_REMOTE_PORT} " | grep -oP 'pid=\K\d+' | head -1)
kill -9 "$CODEX_REMOTE_APP_PID" "$CODEX_REMOTE_RECV_PID" "$CODEX_REMOTE_DAEMON_PID" "$CODEX_REMOTE_WRAPPER_PID" 2>/dev/null || true

fi

# ============================================================
# Case 39: Codex attached receiver thread/read fallback
# ============================================================
if should_run 39; then
echo -e "
${YELLOW}Case 39: Codex attached receiver thread/read fallback${NC}"

CODEX_POLL_AGENT="codex-poll-agent"
CODEX_POLL_HOME="/tmp/e2e-codex-poll-home"
CODEX_POLL_PROJECT="/tmp/e2e-codex-poll-project"
CODEX_POLL_PORT=14139
CODEX_POLL_DAEMON="http://127.0.0.1:${CODEX_POLL_PORT}"
rm -rf "$CODEX_POLL_HOME" "$CODEX_POLL_PROJECT"
mkdir -p "$CODEX_POLL_HOME/.meta-agent-framework" "$CODEX_POLL_PROJECT"
cp "$SCRIPT_DIR/plugins/node-daemon/daemon.mjs" "$CODEX_POLL_HOME/.meta-agent-framework/daemon.mjs"
cat > "$CODEX_POLL_HOME/.meta-agent-framework/package.json" << PKGJSON
{"name":"@maf/meta-agent-daemon","version":"$EXPECTED_VERSION","type":"module"}
PKGJSON
cat > "$CODEX_POLL_PROJECT/AGENTS.md" << AGENTEOF
# Codex project agent: ${CODEX_POLL_AGENT}

E2E Codex attached receiver polling fallback project.
AGENTEOF

HOME="$CODEX_POLL_HOME" XDG_CONFIG_HOME="$CODEX_POLL_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_POLL_PORT" MAF_DIRECTORY="$CODEX_POLL_PROJECT" \
  node "$CODEX_POLL_HOME/.meta-agent-framework/daemon.mjs" >/tmp/e2e-codex-poll-daemon.log 2>&1 &
CODEX_POLL_DAEMON_PID=$!
disown $CODEX_POLL_DAEMON_PID

wait_until 10 "curl -s $CODEX_POLL_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex poll daemon running" '"ok":true' "$(curl -s $CODEX_POLL_DAEMON/health 2>/dev/null)"

HOME="$CODEX_POLL_HOME" XDG_CONFIG_HOME="$CODEX_POLL_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_POLL_PORT" \
  MAF_AGENT_NAME="$CODEX_POLL_AGENT" MAF_DIRECTORY="$CODEX_POLL_PROJECT" \
  MAF_CODEX_TURN_POLL_MS=100 \
  MAF_CODEX_APP_SERVER_CMD="MOCK_CODEX_NO_TURN_COMPLETED=1 node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-poll-hook.log 2>&1
{"cwd":"$CODEX_POLL_PROJECT","eventName":"SessionStart"}
HOOKJSON
CODEX_POLL_PID_FILE="$CODEX_POLL_HOME/.meta-agent-framework/codex-attached-receiver-${CODEX_POLL_AGENT}.pid"
CODEX_POLL_PID="$(cat "$CODEX_POLL_PID_FILE" 2>/dev/null || true)"
assert "Codex poll receiver spawned by hook" "true" "$([[ -n "$CODEX_POLL_PID" ]] && kill -0 "$CODEX_POLL_PID" 2>/dev/null && echo true || echo false)"

wait_until 10 "get_agent_field status $CODEX_POLL_AGENT" "online" || true
assert "Codex poll receiver online" "online" "$(get_agent_field status $CODEX_POLL_AGENT)"
assert "Codex poll receiver runtime" "codex" "$(get_agent_field runtime $CODEX_POLL_AGENT)"

POLL_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Codex attached receiver poll fallback e2e\",\"nodes\":[{\"id\":\"poll-1\",\"agent_name\":\"$CODEX_POLL_AGENT\",\"prompt\":\"Codex attached e2e task: complete via thread read polling\",\"scope\":\"project\",\"intent\":\"query\"}]}")
POLL_WF_ID=$(echo "$POLL_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id',''))" 2>/dev/null)
assert "Codex poll workflow 创建" "true" "$([ -n "$POLL_WF_ID" ] && echo true || echo false)"

for i in $(seq 1 20); do
  POLL_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$POLL_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''))" 2>/dev/null)
  [[ "$POLL_STATUS" == "completed" ]] && break
  sleep 1
done
assert "Codex poll workflow completed" "completed" "$POLL_STATUS"
POLL_RESULT=$(curl -s "$E2E_SERVER/api/workflows/$POLL_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);ns=d.get('nodes',[]);print(ns[0].get('result','') if ns else '')" 2>/dev/null)
assert "Codex poll result from mock" "mock attached codex completed" "$POLL_RESULT"
assert "Codex poll used thread/read fallback" "turn poll completed" "$(cat "$CODEX_POLL_HOME/.meta-agent-framework/logs/codex-plugin.log" 2>/dev/null || true)"
assert "Codex poll did not create screen" "No Sockets" "$(screen -ls 2>&1 || true)"

kill -9 "$CODEX_POLL_PID" "$CODEX_POLL_DAEMON_PID" 2>/dev/null || true

fi

# ============================================================
# Case 40: Workflow all_settled 等待并行分支完成/失败后再汇总
# ============================================================
if should_run 40; then
echo -e "
${YELLOW}Case 40: Workflow all_settled waits for parallel branches${NC}"

SETTLED_PORT=14940
SETTLED_ENDPOINT="http://127.0.0.1:${SETTLED_PORT}"
SETTLED_AGENT_A="settled-agent-a-$$"
SETTLED_AGENT_B="settled-agent-b-$$"

SETTLED_PORT="$SETTLED_PORT" node -e '
const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/execute" && req.method === "POST") {
    req.resume();
    res.writeHead(202, {"content-type":"application/json"});
    res.end(JSON.stringify({accepted:true}));
    return;
  }
  res.writeHead(req.url === "/health" ? 200 : 404, {"content-type":"application/json"});
  res.end(JSON.stringify({ok:req.url === "/health"}));
});
server.listen(process.env.SETTLED_PORT, "127.0.0.1");
' >/tmp/e2e-all-settled-endpoint.log 2>&1 &
SETTLED_ENDPOINT_PID=$!
disown $SETTLED_ENDPOINT_PID

wait_until 10 "curl -s $SETTLED_ENDPOINT/health 2>/dev/null" '"ok":true' || true
assert "all_settled fake endpoint running" '"ok":true' "$(curl -s $SETTLED_ENDPOINT/health 2>/dev/null)"

curl -s -X POST "$E2E_SERVER/api/clients/register" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"all-settled-e2e\",\"host_user\":\"local\",\"client_endpoint\":\"$SETTLED_ENDPOINT\",\"agents\":[{\"agent_name\":\"$SETTLED_AGENT_A\",\"project_path\":\"/tmp\",\"capabilities\":\"all settled A\",\"runtime\":\"opencode\"},{\"agent_name\":\"$SETTLED_AGENT_B\",\"project_path\":\"/tmp\",\"capabilities\":\"all settled B\",\"runtime\":\"opencode\"}]}" >/dev/null

wait_until 10 "get_agent_field status $SETTLED_AGENT_A" "online" || true
assert "all_settled agent A online" "online" "$(get_agent_field status $SETTLED_AGENT_A)"
assert "all_settled agent B online" "online" "$(get_agent_field status $SETTLED_AGENT_B)"

SETTLED_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"all_settled e2e\",\"failure_policy\":\"all_settled\",\"nodes\":[{\"id\":\"a\",\"agent_name\":\"$SETTLED_AGENT_A\",\"prompt\":\"branch A fails\",\"scope\":\"project\",\"intent\":\"query\"},{\"id\":\"b\",\"agent_name\":\"$SETTLED_AGENT_B\",\"prompt\":\"branch B completes\",\"scope\":\"project\",\"intent\":\"query\"},{\"id\":\"c\",\"agent_name\":\"$SETTLED_AGENT_A\",\"prompt\":\"depends on A and should skip\",\"depends_on\":[\"a\"],\"scope\":\"project\",\"intent\":\"query\"}]}")
SETTLED_WF_ID=$(echo "$SETTLED_WF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('workflow_id',''))" 2>/dev/null)
assert "all_settled workflow 创建" "true" "$([ -n "$SETTLED_WF_ID" ] && echo true || echo false)"

sleep 1
curl -s -X POST "$E2E_SERVER/api/workflows/$SETTLED_WF_ID/nodes/a/result" \
  -H 'Content-Type: application/json' \
  -d '{"execution_id":"manual-a","status":"failed","result":"branch A failed intentionally"}' >/dev/null

sleep 1
SETTLED_STATUS_AFTER_A=$(curl -s "$E2E_SERVER/api/workflows/$SETTLED_WF_ID" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
assert "all_settled still running after one failure" "running" "$SETTLED_STATUS_AFTER_A"
SETTLED_NODE_C_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$SETTLED_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(n.get('status','') for n in d.get('nodes',[]) if n.get('id')=='c'))" 2>/dev/null)
assert "all_settled blocked dependent skipped" "skipped" "$SETTLED_NODE_C_STATUS"

curl -s -X POST "$E2E_SERVER/api/workflows/$SETTLED_WF_ID/nodes/b/result" \
  -H 'Content-Type: application/json' \
  -d '{"execution_id":"manual-b","status":"completed","result":"branch B completed"}' >/dev/null

for i in $(seq 1 10); do
  SETTLED_FINAL_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$SETTLED_WF_ID" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  [[ "$SETTLED_FINAL_STATUS" == "failed" ]] && break
  sleep 1
done
assert "all_settled final workflow failed after all branches settled" "failed" "$SETTLED_FINAL_STATUS"
SETTLED_NODE_STATUSES=$(curl -s "$E2E_SERVER/api/workflows/$SETTLED_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(f\"{n.get('id')}:{n.get('status')}\" for n in d.get('nodes',[])))" 2>/dev/null)
assert "all_settled keeps completed branch result" "b:completed" "$SETTLED_NODE_STATUSES"
assert "all_settled keeps failed branch result" "a:failed" "$SETTLED_NODE_STATUSES"
assert "all_settled keeps skipped dependent" "c:skipped" "$SETTLED_NODE_STATUSES"

kill -9 "$SETTLED_ENDPOINT_PID" 2>/dev/null || true

fi

# ============================================================
# Case 41: maf-init 必填项空输入提示 + 未完成配置继续流程
# ============================================================
if should_run 41; then
echo -e "
${YELLOW}Case 41: maf-init required inputs${NC}"

INIT_TEST_BASE="/tmp/maf-init-e2e-$$"
rm -rf "$INIT_TEST_BASE"
mkdir -p "$INIT_TEST_BASE/incomplete/.meta-agent-framework" "$INIT_TEST_BASE/feishu"
cat > "$INIT_TEST_BASE/incomplete/.meta-agent-framework/maf.config.json" <<'JSON'
{"role":"server","server":{"url":"http://127.0.0.1:3000","port":3000},"daemon":{"port":4100},"registry":{"type":"none"}}
JSON

INIT_OUTPUT=$(INIT_SCRIPT="$SCRIPT_DIR/scripts/maf-init.mjs" INIT_TEST_BASE="$INIT_TEST_BASE" python3 <<'PY'
import json
import os
import pty
import select
import subprocess
import time

script = os.environ["INIT_SCRIPT"]
base = os.environ["INIT_TEST_BASE"]

def run_init(home, steps, timeout=20):
    env = os.environ.copy()
    env["HOME"] = home
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        ["node", script, "server"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        cwd=os.path.dirname(os.path.dirname(script)),
    )
    os.close(slave)
    chunks = []
    cursor = 0

    def read_available(wait=0.1):
        nonlocal chunks
        ready, _, _ = select.select([master], [], [], wait)
        if ready:
            try:
                data = os.read(master, 4096)
            except OSError:
                data = b""
            if data:
                chunks.append(data.decode("utf-8", "replace"))
                return True
        return False

    for pattern, reply in steps:
        deadline = time.time() + timeout
        while True:
            text = "".join(chunks)
            if pattern in text[cursor:]:
                cursor = len(text)
                break
            if proc.poll() is not None:
                raise AssertionError(f"process exited before pattern {pattern!r}; output={text}")
            if time.time() > deadline:
                raise AssertionError(f"timeout waiting for {pattern!r}; output={text}")
            read_available()
        if reply is not None:
            os.write(master, reply.encode())

    deadline = time.time() + timeout
    while proc.poll() is None and time.time() < deadline:
        read_available()
    if proc.poll() is None:
        proc.kill()
        raise AssertionError("maf-init did not exit")
    while read_available(0):
        pass
    return proc.returncode, "".join(chunks)

home1 = os.path.join(base, "incomplete")
steps1 = [
    ("Server 监听端口", "\n"),
    ("Daemon 端口", "\n"),
    ("启用飞书", "\n"),
    ("Runtime (必选", "\n"),
    ("Runtime 为必选项", "codex\n"),
    ("自动添加", "n\n"),
]
code1, out1 = run_init(home1, steps1)
if code1 != 0:
    raise AssertionError(f"incomplete config init failed: {code1}\n{out1}")
if "覆盖？" in out1:
    raise AssertionError(f"incomplete config should not ask overwrite\n{out1}")
if "配置未完成" not in out1 or "Runtime 为必选项" not in out1:
    raise AssertionError(f"missing incomplete/required warning\n{out1}")
cfg1 = json.load(open(os.path.join(home1, ".meta-agent-framework", "maf.config.json")))
if cfg1.get("server", {}).get("runtime") != "codex":
    raise AssertionError(f"runtime not saved as codex: {cfg1}")

home2 = os.path.join(base, "feishu")
steps2 = [
    ("Server 监听端口", "\n"),
    ("Daemon 端口", "\n"),
    ("启用飞书", "y\n"),
    ("飞书 App ID", "\n"),
    ("此项为必填", "app-id\n"),
    ("飞书 App Secret", "\n"),
    ("此项为必填", "app-secret\n"),
    ("飞书 API URL", "\n"),
    ("Bitable App Token", "\n"),
    ("此项为必填", "app-token\n"),
    ("Bitable Table ID", "\n"),
    ("此项为必填", "tbl-id\n"),
    ("Bitable View ID", "\n"),
    ("Runtime (必选", "codex\n"),
    ("自动添加", "n\n"),
]
code2, out2 = run_init(home2, steps2)
if code2 != 0:
    raise AssertionError(f"feishu required init failed: {code2}\n{out2}")
if out2.count("此项为必填") < 4:
    raise AssertionError(f"required warning should appear for feishu required fields\n{out2}")
cfg2 = json.load(open(os.path.join(home2, ".meta-agent-framework", "maf.config.json")))
if cfg2.get("registry", {}).get("type") != "feishu":
    raise AssertionError(f"registry not feishu: {cfg2}")
if cfg2.get("feishu", {}).get("app_id") != "app-id":
    raise AssertionError(f"app_id not saved: {cfg2}")
if cfg2.get("feishu", {}).get("app_secret") != "app-secret":
    raise AssertionError(f"app_secret not saved: {cfg2}")
if cfg2.get("feishu", {}).get("bitable", {}).get("app_token") != "app-token":
    raise AssertionError(f"bitable token not saved: {cfg2}")
if cfg2.get("feishu", {}).get("bitable", {}).get("table_id") != "tbl-id":
    raise AssertionError(f"table id not saved: {cfg2}")

print("INCOMPLETE_NO_OVERWRITE=ok")
print("RUNTIME_REQUIRED=ok")
print("FEISHU_REQUIRED=ok")
PY
)

assert "未完成配置不再提示覆盖" "INCOMPLETE_NO_OVERWRITE=ok" "$INIT_OUTPUT"
assert "Runtime 空输入提示必选" "RUNTIME_REQUIRED=ok" "$INIT_OUTPUT"
assert "飞书必填项空输入提示" "FEISHU_REQUIRED=ok" "$INIT_OUTPUT"

rm -rf "$INIT_TEST_BASE"
fi

# ============================================================
# 结果
# ============================================================
echo ""
echo "══════════════════════════════════════════"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}全部通过: ${PASS}/${TOTAL}${NC}"
else
  echo -e "${RED}失败: ${FAIL}/${TOTAL} (通过: ${PASS})${NC}"
fi
echo "══════════════════════════════════════════"
echo ""
exit $FAIL
