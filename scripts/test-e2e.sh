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
#   6  全 Runtime Client OTA + bundle hash + 原子写入
#   7  OTA Daemon 自更新 + 自拉起
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
#   41 maf-init required input + Server listen default + Client install address
#   42 Server 控制面身份不计入 Agent 看板
#   43 管理鉴权 + Client 机器身份自动注册
#   44 错 task_id / execution_id / status 回报拒绝
#   45 OpenCode HTTP 失败、超时、空结果、旧结果不得误报成功
#   46 MAS headless runtime 空输出不得误报成功
#   47 Client local-only Agent 发布边界
#   48 Headless Codex 首次终态回报不可被自动收尾覆盖
#   49 通用 Execution 两阶段 Artifact + direct repository + Gerrit
#   50 Codex Dashboard 实时对话完整链路
#   51 Codex managed Workflow/Task 默认投递 + 取消
#   52 Agent stop/start 持久生命周期
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/server" && pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; TOTAL=0
SERVER_PID=""; MOCK_PID=""; CC_KEEPALIVE_PID=""; PRIVACY_DAEMON_PID=""; RESULT_DAEMON_PID=""; CODEX_CONVERSATION_SSE_PID=""

E2E_STATE_DIR="/tmp/maf-e2e-state"
E2E_MAF_HOME="/tmp/maf-e2e-home"
E2E_USER_HOME="/tmp/maf-e2e-user"
E2E_DB_PATH="/tmp/maf-e2e.db"
E2E_BIN="/tmp/maf-e2e-bin"
MAS_RUNTIME_MOCK="$E2E_BIN/mas-runtime-mock"
MOCK_CODEX_PROMPT_LOG="/tmp/e2e-codex-mock-prompt.log"
MOCK_CODEX_ARGS_LOG="/tmp/e2e-codex-mock-args.log"
DAEMON_LOG="$E2E_USER_HOME/.meta-agent-framework/logs/client-daemon.log"

# 测试端口（与真实环境隔离）
E2E_SERVER_PORT=13000
NODE_PORT=14100
E2E_SERVER="http://localhost:$E2E_SERVER_PORT"
E2E_REMOTE_HOST="$(node -e 'const os=require("node:os"); for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) if (item.family === "IPv4" && !item.internal) { process.stdout.write(item.address); process.exit(0); }')"
E2E_REMOTE_SERVER="http://${E2E_REMOTE_HOST}:$E2E_SERVER_PORT"
DAEMON_URL="http://127.0.0.1:$NODE_PORT"
export MAF_AUTH_TOKEN="maf-e2e-auth-token-0123456789abcdef0123456789abcdef"
export MAF_LOCAL_TOKEN="$MAF_AUTH_TOKEN"

# 不继承启动本测试的真实 Codex 会话/attached receiver 上下文。
# 各 Codex case 必须只使用自己显式设置的隔离 app-server 参数。
unset MAF_CODEX_APP_SERVER_URL MAF_CODEX_APP_SERVER_CMD MAF_CODEX_REMOTE \
  MAF_CODEX_THREAD_ID MAF_CODEX_SESSION_PID MAF_CODEX_WRAPPER_ACTIVE \
  MAF_AGENT_NAME MAF_DIRECTORY CODEX_CWD MAF_RUNTIME MAF_HOME

# 测试默认走已鉴权链路；鉴权负例使用 command curl 绕过此包装。
curl() {
  command curl -H "Authorization: Bearer ${MAF_AUTH_TOKEN}" "$@"
}
export -f curl

# ============================================================
# 参数解析：确定要跑哪些 case
# ============================================================
ALL_CASES=(1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52)
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
  if [[ $c -ge 2 && $c -le 13 ]] || [[ $c -eq 15 ]] || [[ $c -eq 16 ]] || [[ $c -ge 18 && $c -le 21 ]] || [[ $c -eq 32 ]] || [[ $c -eq 33 ]] || [[ $c -ge 43 && $c -le 45 ]] || [[ $c -ge 48 && $c -le 52 ]]; then NEED_DAEMON=true; fi
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

stop_e2e_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

start_e2e_server() {
  local runtime=${1:-opencode}
  local server_log="/tmp/maf-e2e-server-${runtime}.log"
  MAF_HOME="$E2E_MAF_HOME" PORT=$E2E_SERVER_PORT DB_PATH="$E2E_DB_PATH" FEISHU_SYNC_DISABLED=1 \
    MAF_SERVER_RUNTIME="$runtime" OPENCODE_BIN="$MAS_RUNTIME_MOCK" \
    CLAUDE_BIN="$MAS_RUNTIME_MOCK" CODEX_BIN="$MAS_RUNTIME_MOCK" \
    node --import tsx src/index.ts >"$server_log" 2>&1 &
  SERVER_PID=$!
  disown $SERVER_PID
  wait_until 10 "command curl -s $E2E_SERVER/api/health 2>/dev/null" "server_version"
}

get_agent_field() {
  local field=$1 name=${2:-$AGENT_NAME}
  curl -s $E2E_SERVER/api/agents 2>/dev/null | \
    python3 -c "import json,sys;[print(a.get('$field','')) for a in json.load(sys.stdin) if a['agent_name']=='$name']" 2>/dev/null
}

client_signed_fetch() {
  local url=$1 method=${2:-GET} body=${3:-}
  MAF_SIGNED_URL="$url" MAF_SIGNED_METHOD="$method" MAF_SIGNED_BODY="$body" node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const url = process.env.MAF_SIGNED_URL;
const method = process.env.MAF_SIGNED_METHOD || "GET";
const body = process.env.MAF_SIGNED_BODY || "";
const authDir = path.join(os.homedir(), ".meta-agent-framework", "auth");
const clientId = fs.readFileSync(path.join(authDir, "client-id"), "utf8").trim();
const privateKey = fs.readFileSync(path.join(authDir, "client-private.pem"), "utf8");
const timestamp = String(Date.now());
const nonce = crypto.randomBytes(18).toString("base64url");
const parsed = new URL(url);
const target = `${parsed.pathname}${parsed.search}`;
const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
const canonical = Buffer.from([method.toUpperCase(), target, timestamp, nonce, bodyHash].join("\n"));
const signature = crypto.sign(null, canonical, privateKey).toString("base64url");
const headers = {
  "X-MAF-Role": "client",
  "X-MAF-ID": clientId,
  "X-MAF-Timestamp": timestamp,
  "X-MAF-Nonce": nonce,
  "X-MAF-Signature": signature,
};
if (body) headers["Content-Type"] = "application/json";
fetch(url, { method, headers, body: body || undefined })
  .then(async res => {
    const responseBody = await res.text();
    const responseTimestamp = res.headers.get("x-maf-timestamp") || "";
    const responseNonce = res.headers.get("x-maf-nonce") || "";
    const responseSignature = res.headers.get("x-maf-signature") || "";
    let serverSignatureValid = false;
    try {
      const serverPublicKey = fs.readFileSync(path.join(authDir, "server-public.pem"), "utf8");
      const responseHash = crypto.createHash("sha256").update(responseBody).digest("hex");
      const responseCanonical = Buffer.from([
        method.toUpperCase(),
        target,
        responseTimestamp,
        responseNonce,
        responseHash,
      ].join("\n"));
      serverSignatureValid = res.headers.get("x-maf-role") === "server"
        && res.headers.get("x-maf-id") === "maf-server"
        && crypto.verify(null, responseCanonical, serverPublicKey, Buffer.from(responseSignature, "base64url"));
    } catch {}
    process.stdout.write(`HTTP:${res.status}\nSERVER_SIGNATURE_VALID:${serverSignatureValid}\n${responseBody}`);
  })
  .catch(err => { console.error(err.message); process.exit(1); });
NODE
}

server_signed_fetch() {
  local url=$1 method=${2:-GET} body=${3:-}
  MAF_SIGNED_URL="$url" MAF_SIGNED_METHOD="$method" MAF_SIGNED_BODY="$body" \
    MAF_SERVER_PRIVATE_KEY="$E2E_MAF_HOME/auth/server-private.pem" node <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const url = process.env.MAF_SIGNED_URL;
const method = process.env.MAF_SIGNED_METHOD || "GET";
const body = process.env.MAF_SIGNED_BODY || "";
const privateKey = fs.readFileSync(process.env.MAF_SERVER_PRIVATE_KEY, "utf8");
const timestamp = String(Date.now());
const nonce = crypto.randomBytes(18).toString("base64url");
const parsed = new URL(url);
const target = `${parsed.pathname}${parsed.search}`;
const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
const canonical = Buffer.from([method.toUpperCase(), target, timestamp, nonce, bodyHash].join("\n"));
const headers = {
  "X-MAF-Role": "server",
  "X-MAF-ID": "maf-server",
  "X-MAF-Timestamp": timestamp,
  "X-MAF-Nonce": nonce,
  "X-MAF-Signature": crypto.sign(null, canonical, privateKey).toString("base64url"),
};
if (body) headers["Content-Type"] = "application/json";
fetch(url, { method, headers, body: body || undefined })
  .then(async res => process.stdout.write(`HTTP:${res.status}\n${await res.text()}`))
  .catch(err => { console.error(err.message); process.exit(1); });
NODE
}

create_codex_agent_toml() {
  local project=$1 agent=$2 description=${3:-"Codex E2E test agent"}
  mkdir -p "$project/.codex/agents"
  cat > "$project/.codex/agents/${agent}.toml" << TOMLEOF
name = "${agent}"
description = "${description}"
sandbox_mode = "workspace-write"

developer_instructions = """
You are ${agent}, a Codex runtime agent used by the MAF e2e suite.
Respond briefly and follow the MAF task instructions.
"""
TOMLEOF
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

start_cc_wait_keepalive() {
  [[ -n "$CC_KEEPALIVE_PID" ]] && kill "$CC_KEEPALIVE_PID" 2>/dev/null || true
  HOME="$E2E_USER_HOME" MAF_AGENT_NAME="$CC_AGENT" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT=$NODE_PORT \
  node plugins/claude-code-plugin-maf/scripts/maf-agent.mjs --wait &>/tmp/cc-keepalive.log &
  CC_KEEPALIVE_PID=$!
}

stop_cc_wait_keepalive() {
  [[ -n "$CC_KEEPALIVE_PID" ]] && kill "$CC_KEEPALIVE_PID" 2>/dev/null || true
  CC_KEEPALIVE_PID=""
}

start_mock_opencode() {
  HOME="$E2E_USER_HOME" MOCK_OPENCODE_PORT=$MOCK_PORT \
  MOCK_PLUGIN_DIR="$PLUGIN_DIR" \
  MOCK_DIRECTORY="/tmp/e2e-test-project" \
  META_AGENT_SERVER="$E2E_SERVER" \
  MAF_USER_ID="e2e-testuser" \
  MAF_NODE_PORT=$NODE_PORT \
  MAF_OPENCODE_IDLE_TIMEOUT_MS=500 \
  node "$ROOT_DIR/scripts/mock-opencode.mjs" "$AGENT_NAME" &>/dev/null &
  MOCK_PID=$!
  disown $MOCK_PID
}

cleanup() {
  echo -e "\n${YELLOW}清理...${NC}"
  [[ -n "$MOCK_PID" ]] && kill -9 "$MOCK_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && kill -9 "$SERVER_PID" 2>/dev/null
  [[ -n "$PRIVACY_DAEMON_PID" ]] && kill -9 "$PRIVACY_DAEMON_PID" 2>/dev/null
  [[ -n "$RESULT_DAEMON_PID" ]] && kill -9 "$RESULT_DAEMON_PID" 2>/dev/null
  [[ -n "$CODEX_CONVERSATION_SSE_PID" ]] && kill "$CODEX_CONVERSATION_SSE_PID" 2>/dev/null
  pkill -f '/tmp/e2e-codex-.*/maf-codex-attached-receiver\.mjs' 2>/dev/null || true
  pkill -f '/tmp/e2e-codex-.*/maf-codex-app-server\.mjs' 2>/dev/null || true
  stop_cc_wait_keepalive
  local DAEMON_PID
  DAEMON_PID=$(ss -tlnp 2>/dev/null | grep ":${NODE_PORT} " | grep -oP 'pid=\K\d+' | head -1)
  [[ -n "$DAEMON_PID" ]] && kill -9 "$DAEMON_PID" 2>/dev/null || true
  pkill -9 -f "maf-agent.mjs.*${NODE_PORT}" 2>/dev/null || true
  pkill -f "opencode.*serve.*e2e" 2>/dev/null || true
  sleep 1
  for p in $E2E_SERVER_PORT $MOCK_PORT $NODE_PORT 14134 14135 14136 14137 14138 14139 14143 14147 14148 14937 14938 14940 14941; do
    PID=$(ss -tlnp 2>/dev/null | grep ":${p} " | grep -oP 'pid=\K\d+' | head -1)
    [[ -n "$PID" ]] && kill -9 "$PID" 2>/dev/null || true
  done
  rm -f "$E2E_DB_PATH" ~/.meta-agent-framework/ota-e2e-test.txt
  rm -f /tmp/cc-e2e-stderr.log
  rm -rf "$E2E_STATE_DIR" "$PLUGIN_DIR" "$E2E_MAF_HOME" "$E2E_USER_HOME" "$E2E_BIN" /tmp/maf-e2e-late-client /tmp/maf-e2e-agent-privacy /tmp/maf-e2e-result-idempotency /tmp/maf-e2e-execution-origin.git /tmp/maf-e2e-execution-seed /tmp/maf-e2e-execution-base /tmp/e2e-codex-project /tmp/e2e-codex-autostart-home /tmp/e2e-codex-autostart-project /tmp/e2e-codex-wrapper-home /tmp/e2e-codex-wrapper-project /tmp/e2e-codex-wrapper-misc /tmp/e2e-codex-attached-home /tmp/e2e-codex-attached-project /tmp/e2e-codex-receiver-home /tmp/e2e-codex-receiver-project /tmp/e2e-codex-auto-remote-home /tmp/e2e-codex-auto-remote-project /tmp/e2e-codex-auto-remote-misc /tmp/e2e-codex-poll-home /tmp/e2e-codex-poll-project /tmp/e2e-codex-conversation-project /tmp/e2e-codex-managed-project /tmp/e2e-codex-lifecycle-project /tmp/maf-e2e-codex-conversation.sse /tmp/maf-e2e-lifecycle-normal-stop.json /tmp/maf-e2e-lifecycle-reconnect.json "$MOCK_CODEX_PROMPT_LOG" "$MOCK_CODEX_ARGS_LOG"
}
trap cleanup EXIT

# 从 package.json 读取版本号
EXPECTED_VERSION=$(python3 -c "import json;print(json.load(open('$ROOT_DIR/package.json')).get('version',''))" 2>/dev/null)

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
pkill -f '/tmp/e2e-codex-.*/maf-codex-attached-receiver\.mjs' 2>/dev/null || true
pkill -f '/tmp/e2e-codex-.*/maf-codex-app-server\.mjs' 2>/dev/null || true
for p in $E2E_SERVER_PORT $MOCK_PORT $NODE_PORT 14134 14135 14136 14137 14138 14139 14143 14147 14148 14937 14938 14940 14941; do
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

cat > "$MAS_RUNTIME_MOCK" << 'MASRUNTIMEMOCK'
#!/usr/bin/env bash
set -euo pipefail
mode_file="${MAF_HOME}/state/mas-runtime-mode"
mode=$(cat "$mode_file" 2>/dev/null || echo normal)
stdin_prompt=$(cat || true)
args_prompt="$*"
if [[ "$stdin_prompt $args_prompt" == *"不得自行 POST /api/workflows"* ]]; then
  router_protocol=true
else
  router_protocol=false
fi
printf 'cwd=%s\nauth_token=%s\nlocal_token=%s\nserver_url=%s\nrouter_protocol=%s\nrouter_agent=%s\n' \
  "$PWD" "${MAF_AUTH_TOKEN+present}" "${MAF_LOCAL_TOKEN+present}" "${META_AGENT_SERVER+present}" \
  "$router_protocol" "${MAF_AGENT_NAME:-}" > "${MAF_HOME}/state/mas-runtime-observed"
if [[ "$mode" == "empty" ]]; then
  printf '  \n'
  exit 0
fi

if [[ "$mode" == "workflow" ]]; then
  if [[ "$stdin_prompt $args_prompt" == *"# 历史交互"* ]]; then
    result="remote workflow result summarized"
  else
    target_agent=$(cat "${MAF_HOME}/state/mas-runtime-agent")
    result="{\"workflow\":{\"title\":\"generic managed execution\",\"nodes\":[{\"id\":\"managed-step\",\"agent_name\":\"$target_agent\",\"prompt\":\"MAF_E2E_MANAGED_EXECUTION\"}],\"failure_policy\":\"all_settled\"}}"
  fi
else
  result="MAS ${MAF_RUNTIME:-unknown} mock result"
fi
if [[ "${MAF_RUNTIME:-}" == "codex" ]]; then
  output_file=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--output-last-message" ]]; then
      output_file="${2:-}"
      break
    fi
    shift
  done
  [[ -n "$output_file" ]] || { echo "missing --output-last-message" >&2; exit 3; }
  printf '%s\n' "$result" > "$output_file"
else
  printf '%s\n' "$result"
fi
MASRUNTIMEMOCK
chmod +x "$MAS_RUNTIME_MOCK"

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
if should_run 33 || should_run 34 || should_run 35 || should_run 38 || should_run 48 || should_run 49 || should_run 50 || should_run 51 || should_run 52; then
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
has_remote=0
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output-last-message) out="$2"; shift 2;;
    --remote) has_remote=1; shift 2;;
    -C|--cd|-s|--sandbox|-p|--profile|-m|--model|-a|--ask-for-approval|--color) shift 2;;
    exec|--skip-git-repo-check) shift;;
    --dangerously-bypass-approvals-and-sandbox) shift;;
    -) prompt="$(cat)"; shift;;
    *) args+=("$1"); shift;;
  esac
done
if [[ -z "$prompt" && ${#args[@]} -gt 0 ]]; then
  prompt="${args[*]}"
fi
if [[ -n "${MOCK_CODEX_PROMPT_LOG:-}" ]]; then
  printf '%s\n' "$prompt" >> "$MOCK_CODEX_PROMPT_LOG"
fi
if [[ "$prompt" == *"MAF_E2E_MANAGED_EXECUTION"* ]]; then
  printf 'changed by generic managed execution\n' > "${MAF_SOURCE_DIR}/source.txt"
  printf 'artifact consumed\n' > "${MAF_OUTPUT_DIR}/agent-output.txt"
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
  elif [[ "$has_remote" == "1" ]]; then
    :
  else
    echo "missing report script" >&2
    exit 3
  fi
fi
if [[ "$prompt" == *"MAF_E2E_WAIT_FOR_MANUAL_REPORT"* ]]; then
  sleep 5
fi
if [[ -n "${MOCK_CODEX_SLEEP_SECONDS:-}" ]]; then
  sleep "$MOCK_CODEX_SLEEP_SECONDS"
fi
echo "mock codex stdout"
CODEXMOCK
  chmod +x "$E2E_BIN/codex"
  export CODEX_BIN="$E2E_BIN/codex"
  export MOCK_CODEX_PROMPT_LOG MOCK_CODEX_ARGS_LOG
  export MOCK_CODEX_APP_SERVER_SCRIPT="$ROOT_DIR/scripts/mock-codex-app-server.mjs"
  if should_run 49 || should_run 50 || should_run 51 || should_run 52; then export MAF_CODEX_APP_SERVER_BIN="$E2E_BIN/codex"; fi
fi

# 启动 Server（所有 case 都需要）
if $NEED_SERVER; then
  start_e2e_server opencode || { echo -e "${RED}❌ Server 启动失败${NC}"; exit 1; }
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
assert "Server health ok" '"ok":true' "$H"
assert "Dashboard Server 显示 1" "serverOnline ? '1' : '-'" "$(grep "serverOnline ? '1' : '-'" "$SCRIPT_DIR/src/public/index.html" 2>/dev/null || true)"
assert "Dashboard 版本使用 Server 统一版本" "state.health.server_version" "$(grep "state.health.server_version" "$SCRIPT_DIR/src/public/index.html" 2>/dev/null || true)"
assert "Dashboard 无独立 Console 版本硬编码" "not_found" "$(grep -o "0.1.0" "$SCRIPT_DIR/src/public/index.html" 2>/dev/null || echo not_found)"
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
# Case 6: 全 Runtime Client OTA + 原子 hash 校验
# ============================================================
if should_run 6; then
echo -e "${YELLOW}[6] 全 Runtime Client OTA + 原子 hash 校验${NC}"
wait_until 10 "test -f '$E2E_USER_HOME/.meta-agent-framework/ota-manifest.json' && echo ready" "ready" || true
AUTO_OTA_VERSION=$(python3 -c "import json;print(json.load(open('$E2E_USER_HOME/.meta-agent-framework/ota-manifest.json')).get('version',''))" 2>/dev/null)
assert "同 semver 不同 bundle hash 自动 OTA" "$EXPECTED_VERSION" "$AUTO_OTA_VERSION"
R=$(curl -s -X POST $DAEMON_URL/ota -H 'Content-Type: application/json' \
  -d '{"files":[{"path":"~/.meta-agent-framework/ota-e2e-test.txt","content":"e2e-pass"}]}' 2>/dev/null)
assert "OTA applied" '"applied":1' "$R"
assert "OTA 内容" "e2e-pass" "$(cat "$E2E_USER_HOME/.meta-agent-framework/ota-e2e-test.txt" 2>/dev/null)"

CLAUDE_OTA_SOURCE="$E2E_USER_HOME/.claude/plugins/marketplaces/maf-plugins/claude-code-plugin-maf"
CLAUDE_OTA_CACHE="$E2E_USER_HOME/.claude/plugins/cache/maf-plugins/maf/$EXPECTED_VERSION"
CODEX_OTA_SOURCE="$E2E_USER_HOME/plugins/maf"
CODEX_OTA_CACHE="$E2E_USER_HOME/.codex/plugins/cache/personal/maf/local"
mkdir -p "$CLAUDE_OTA_SOURCE/scripts" "$CLAUDE_OTA_CACHE/scripts" "$CODEX_OTA_SOURCE/scripts" "$CODEX_OTA_CACHE/scripts"
printf 'stale claude source\n' > "$CLAUDE_OTA_SOURCE/scripts/maf-agent.mjs"
printf 'stale claude cache\n' > "$CLAUDE_OTA_CACHE/scripts/maf-agent.mjs"
printf 'stale codex source\n' > "$CODEX_OTA_SOURCE/scripts/maf-codex-attached-receiver.mjs"
printf 'stale codex cache\n' > "$CODEX_OTA_CACHE/scripts/maf-codex-attached-receiver.mjs"
mkdir -p "$E2E_USER_HOME/.claude/plugins"
cat > "$E2E_USER_HOME/.claude/plugins/installed_plugins.json" << JSON
{"version":2,"plugins":{"maf@maf-plugins":[{"scope":"user","installPath":"$CLAUDE_OTA_CACHE","version":"$EXPECTED_VERSION"}]}}
JSON

OTA_PUSH=$(curl -s -X POST "$E2E_SERVER/api/ota/push" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$AGENT_NAME\"}" 2>/dev/null)
assert "全 Runtime OTA 无失败" '"failed":0' "$OTA_PUSH"
assert "Claude source OTA" "same" "$(cmp -s "$SCRIPT_DIR/plugins/claude-code-plugin-maf/scripts/maf-agent.mjs" "$CLAUDE_OTA_SOURCE/scripts/maf-agent.mjs" && echo same || echo different)"
assert "Claude active cache OTA" "same" "$(cmp -s "$SCRIPT_DIR/plugins/claude-code-plugin-maf/scripts/maf-agent.mjs" "$CLAUDE_OTA_CACHE/scripts/maf-agent.mjs" && echo same || echo different)"
assert "Codex source receiver OTA" "same" "$(cmp -s "$SCRIPT_DIR/plugins/codex/scripts/maf-codex-attached-receiver.mjs" "$CODEX_OTA_SOURCE/scripts/maf-codex-attached-receiver.mjs" && echo same || echo different)"
assert "Codex active cache receiver OTA" "same" "$(cmp -s "$SCRIPT_DIR/plugins/codex/scripts/maf-codex-attached-receiver.mjs" "$CODEX_OTA_CACHE/scripts/maf-codex-attached-receiver.mjs" && echo same || echo different)"
assert "Codex hook OTA" "same" "$(cmp -s "$SCRIPT_DIR/plugins/codex/scripts/maf-codex-hook.mjs" "$CODEX_OTA_CACHE/scripts/maf-codex-hook.mjs" && echo same || echo different)"

OTA_BUNDLE_HASH=$(python3 -c "import json;print(json.load(open('$E2E_USER_HOME/.meta-agent-framework/ota-manifest.json')).get('bundle_hash',''))" 2>/dev/null)
assert "OTA bundle manifest hash" "true" "$([[ "$OTA_BUNDLE_HASH" =~ ^[a-f0-9]{16}$ ]] && echo true || echo false)"
wait_until 5 "get_agent_field plugin_hash" "$OTA_BUNDLE_HASH" || true
assert "Client 上报 bundle hash" "$OTA_BUNDLE_HASH" "$(get_agent_field plugin_hash)"
OTA_STATUS=$(curl -s "$E2E_SERVER/api/ota/status" 2>/dev/null)
assert "OTA status 返回 bundle hash" "$OTA_BUNDLE_HASH" "$OTA_STATUS"

printf 'ota-original\n' > "$E2E_USER_HOME/.meta-agent-framework/ota-atomic-test.txt"
OTA_BAD_HASH=$(curl -s -X POST "$DAEMON_URL/ota" -H 'Content-Type: application/json' \
  -d '{"files":[{"path":"~/.meta-agent-framework/ota-atomic-test.txt","content":"ota-corrupt","hash":"0000000000000000"}]}' 2>/dev/null)
assert "OTA 错误 hash 失败" '"failed":1' "$OTA_BAD_HASH"
assert "OTA 错误 hash 不覆盖旧文件" "ota-original" "$(cat "$E2E_USER_HOME/.meta-agent-framework/ota-atomic-test.txt" 2>/dev/null)"
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
req = urllib.request.Request('$DAEMON_URL/ota', data=payload.encode(), headers={'Content-Type':'application/json','Authorization':'Bearer $MAF_AUTH_TOKEN'}, method='POST')
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
start_cc_wait_keepalive
wait_until 5 "get_agent_field status $CC_AGENT" "online" || true
assert "杀前 OC online" "online" "$(get_agent_field status)"
assert "杀前 CC online" "online" "$(get_agent_field status $CC_AGENT)"
kill "$MOCK_PID" 2>/dev/null; MOCK_PID=""
echo -n "  等待 OC agent offline..."
wait_until 10 "get_agent_field status" "offline" || true
echo ""
assert "OC agent offline" "offline" "$(get_agent_field status)"
assert "CC agent 仍 online" "online" "$(get_agent_field status $CC_AGENT)"
assert "Daemon 未退出" '"ok":true' "$(curl -s $DAEMON_URL/health 2>/dev/null || echo '{}')"
stop_cc_wait_keepalive
fi

# ============================================================
# Case 9: 单 agent 异常退出
# ============================================================
if should_run 9; then
echo -e "${YELLOW}[9] 单 agent 异常退出（无 disconnect）${NC}"
start_cc_wait_keepalive
wait_until 5 "get_agent_field status $CC_AGENT" "online" || true
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
stop_cc_wait_keepalive
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
stop_e2e_server
sleep 2
assert "Server 已停止" "false" "$(curl -s --max-time 1 $E2E_SERVER/api/health &>/dev/null && echo true || echo false)"
start_e2e_server opencode || true
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
EXEC_RES=$(server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$SERVE_AGENT\",\"prompt\":\"e2e serve 测试\",\"runtime\":\"opencode\",\"project_path\":\"/tmp/e2e-serve-project\"}" 2>/dev/null)
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
WF_EXEC_ID=$(curl -s "$E2E_SERVER/api/workflows/$WF_ID" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(n.get('execution_id','') for n in d.get('nodes',[]) if n.get('id')=='sse-1'))")
curl -s -X POST "$E2E_SERVER/api/workflows/$WF_ID/nodes/sse-1/result" \
  -H 'Content-Type: application/json' \
  -d "{\"execution_id\":\"$WF_EXEC_ID\",\"agent_name\":\"$AGENT_NAME\",\"status\":\"completed\",\"result\":\"SSE e2e result OK\",\"duration_ms\":100}" >/dev/null 2>&1
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
server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$TRACK_AGENT\",\"workflow_id\":\"wf-track-test\",\"node_id\":\"n1\",\"prompt\":\"跟踪测试\",\"intent\":\"query\"}" >/dev/null 2>&1

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
R1=$(server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$SERIAL_AGENT\",\"workflow_id\":\"serial-1\",\"node_id\":\"n1\",\"prompt\":\"串行任务1\",\"intent\":\"query\"}" 2>/dev/null)
R2=$(server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$SERIAL_AGENT\",\"workflow_id\":\"serial-2\",\"node_id\":\"n2\",\"prompt\":\"串行任务2\",\"intent\":\"query\"}" 2>/dev/null)
R3=$(server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$SERIAL_AGENT\",\"workflow_id\":\"serial-3\",\"node_id\":\"n3\",\"prompt\":\"串行任务3\",\"intent\":\"query\"}" 2>/dev/null)

assert "串行任务1 accepted" "true" "$(echo "$R1" | sed '1d' | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('accepted',False)).lower())" 2>/dev/null)"
assert "串行任务2 accepted" "true" "$(echo "$R2" | sed '1d' | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('accepted',False)).lower())" 2>/dev/null)"
assert "串行任务3 accepted" "true" "$(echo "$R3" | sed '1d' | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('accepted',False)).lower())" 2>/dev/null)"

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

# 在线 Agent 受保护；下一次注册改为 offline 后 ID 仍必须稳定。
assert "在线 agent 不可删除" "409" "$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$E2E_SERVER/api/agents/$DEL_ID" 2>/dev/null)"
curl -s -X POST "$E2E_SERVER/api/clients/register" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"e2e\",\"host_user\":\"e2e\",\"client_endpoint\":\"http://127.0.0.1:$NODE_PORT\",\"agent_statuses\":{\"$DEL_AGENT\":\"offline\"},\"agents\":[{\"agent_name\":\"$DEL_AGENT\",\"runtime\":\"opencode\",\"project_path\":\"/tmp\",\"capabilities\":\"updated test\",\"mode\":\"subagent\"}]}" >/dev/null 2>&1
DEL_ID_AFTER=$(curl -s "$E2E_SERVER/api/agents" 2>/dev/null | python3 -c "import json,sys;agents=json.load(sys.stdin);print(next((a['id'] for a in agents if a['agent_name']=='$DEL_AGENT'),''))" 2>/dev/null)
assert "重复注册保留 agent ID" "$DEL_ID" "$DEL_ID_AFTER"

# 历史记录允许删除
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
server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$CC_CHAIN_AGENT\",\"workflow_id\":\"chain-1\",\"node_id\":\"n1\",\"prompt\":\"chain task 1\",\"intent\":\"query\"}" >/dev/null 2>&1
server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$CC_CHAIN_AGENT\",\"workflow_id\":\"chain-2\",\"node_id\":\"n2\",\"prompt\":\"chain task 2\",\"intent\":\"query\"}" >/dev/null 2>&1
server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"agent_name\":\"$CC_CHAIN_AGENT\",\"workflow_id\":\"chain-3\",\"node_id\":\"n3\",\"prompt\":\"chain task 3\",\"intent\":\"query\"}" >/dev/null 2>&1

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
  "$SYNC_TEST_HOME/bin" \
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
mkdir -p "$SYNC_TEST_MAF_HOME/.codex/agents"
echo "old codex agent toml" > "$SYNC_TEST_MAF_HOME/.codex/agents/Meta-Agent-Server.toml"

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
assert "Codex 入口被覆盖" "Codex runtime" "$(cat "$SYNC_TEST_MAF_HOME/AGENTS.md" 2>/dev/null || true)"
assert "Codex standard agent 同步" "name = \"Meta-Agent-Server\"" "$(cat "$SYNC_TEST_MAF_HOME/.codex/agents/Meta-Agent-Server.toml" 2>/dev/null || true)"

# 三种 runtime 安装同一份规范 Skill，不能在安装态产生漂移。
for runtime_dir in .opencode .claude .codex; do
  assert "$runtime_dir server skill 与规范源逐字一致" "same" \
    "$(cmp -s "$SCRIPT_DIR/common_agent/server_skills/meta-agent-server/SKILL.md" "$SYNC_TEST_MAF_HOME/$runtime_dir/skills/meta-agent-server/SKILL.md" && echo same || echo different)"
done
assert "Codex AGENTS 与规范源逐字一致" "same" \
  "$(cmp -s "$SCRIPT_DIR/codex/AGENTS.md" "$SYNC_TEST_MAF_HOME/AGENTS.md" && echo same || echo different)"
assert "Claude CLAUDE 与规范源逐字一致" "same" \
  "$(cmp -s "$SCRIPT_DIR/claude/CLAUDE.md" "$SYNC_TEST_MAF_HOME/CLAUDE.md" && echo same || echo different)"

# 用 mock runtime 直接观察 maf-server 启动时注入的交付能力标记。
DELIVERY_PROBE="$SYNC_TEST_HOME/delivery-capabilities.log"
for runtime_bin in opencode claude codex; do
  cat > "$SYNC_TEST_HOME/bin/$runtime_bin" <<'RUNTIMEPROBE'
#!/usr/bin/env bash
printf '%s=%s\n' "$(basename "$0")" "${MAF_ASYNC_RESULT_DELIVERY:-missing}" >> "$MAF_DELIVERY_PROBE"
RUNTIMEPROBE
  chmod +x "$SYNC_TEST_HOME/bin/$runtime_bin"
done
cat > "$SYNC_TEST_MAF_HOME/maf.config.json" <<JSON
{"server":{"port":$E2E_SERVER_PORT}}
JSON
for runtime in opencode claude codex; do
  HOME="$SYNC_TEST_HOME" MAF_HOME="$SYNC_TEST_MAF_HOME" \
    MAF_DELIVERY_PROBE="$DELIVERY_PROBE" PATH="$SYNC_TEST_HOME/bin:$PATH" \
    node "$SCRIPT_DIR/bin/maf-server.mjs" tui "$runtime" >/dev/null
done
assert "opencode 入口确认异步恢复能力" "opencode=verified" "$(cat "$DELIVERY_PROBE" 2>/dev/null || true)"
assert "Claude 入口确认 asyncRewake 能力" "claude=verified" "$(cat "$DELIVERY_PROBE" 2>/dev/null || true)"
assert "Codex 入口默认同步等待" "codex=unverified" "$(cat "$DELIVERY_PROBE" 2>/dev/null || true)"

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
assert "Server Codex AGENTS entry" "Meta-Agent-Server" "$(head -n 1 "$SCRIPT_DIR/codex/AGENTS.md" 2>/dev/null || true)"
assert "Server Codex standard agent source" "name = \"Meta-Agent-Server\"" "$(cat "$SCRIPT_DIR/codex/agents/Meta-Agent-Server.toml" 2>/dev/null || true)"
assert "maf-server codex env agent" "MAF_AGENT_NAME: \"Meta-Agent-Server\"" "$(grep 'MAF_AGENT_NAME: \"Meta-Agent-Server\"' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server Codex plugin source" '"name": "maf"' "$(cat "$SCRIPT_DIR/plugins/codex/.codex-plugin/plugin.json" 2>/dev/null || true)"
assert "Server Codex installer source" "Server-served Codex client installer" "$(head -n 8 "$SCRIPT_DIR/plugins/codex-install.mjs" 2>/dev/null || true)"
assert "Server install.sh detects Codex" "HAS_CODEX" "$(grep 'HAS_CODEX' "$SCRIPT_DIR/plugins/install.sh" 2>/dev/null || true)"
assert "sync-client-pkg syncs Codex" 'cp -r "$SRC/codex" "$DST/codex"' "$(grep 'SRC/codex' "$ROOT_DIR/scripts/sync-client-pkg.sh" 2>/dev/null || true)"
assert "Codex default delivery is detached" 'MAF_CODEX_DELIVERY || "detached"' "$(grep 'MAF_CODEX_DELIVERY || "detached"' "$ROOT_DIR/packages/server/plugins/node-daemon/daemon.mjs" 2>/dev/null || true)"
assert "Codex detached exec default timeout is 45m" '45 \* 60_000' "$(grep 'CODEX_TASK_TIMEOUT_MS' "$ROOT_DIR/packages/server/plugins/node-daemon/daemon.mjs" 2>/dev/null || true)"
assert "Codex attached overall timeout is 45m" '45 \* 60 \* 1000' "$(grep 'TASK_TIMEOUT_MS' "$ROOT_DIR/packages/client/codex/scripts/maf-codex-attached-receiver.mjs" 2>/dev/null || true)"
assert "Workflow node timeout is 50m" '3000000' "$(grep 'NODE_TIMEOUT_MS' "$ROOT_DIR/packages/server/src/services/workflow-engine.ts" 2>/dev/null || true)"
assert "Workflow poll uses short repeated waits" 'POLL_TIMEOUT="\${2:-10}"' "$(grep 'POLL_TIMEOUT=' "$ROOT_DIR/packages/server/scripts/poll-workflow.sh" 2>/dev/null || true)"
assert "sync-client-pkg verifies copies" "check-client-sync.sh" "$(grep 'check-client-sync.sh' "$ROOT_DIR/scripts/sync-client-pkg.sh" 2>/dev/null || true)"
assert "GitHub release syncs client package" "sync-client-pkg.sh" "$(grep 'sync-client-pkg.sh' "$ROOT_DIR/.github/workflows/release.yml" 2>/dev/null || true)"
assert "版本只保留根 package.json" "package.json" "$(git -C "$ROOT_DIR" grep -l '"version": "'$EXPECTED_VERSION'"' -- ':!package.json' ':!node_modules' ':!package-lock.json' ':!packages/server/package-lock.json' 2>/dev/null || echo package.json)"
assert "pack staging 注入版本" "pkg.version = version" "$(grep 'pkg.version = version' "$ROOT_DIR/scripts/pack-package.mjs" 2>/dev/null || true)"
assert "Codex ACK notification default off" 'MAF_CODEX_NOTIFY_ACK === "1"' "$(grep 'MAF_CODEX_NOTIFY_ACK' "$ROOT_DIR/packages/client/codex/scripts/maf-codex-attached-receiver.mjs" 2>/dev/null || true)"
assert "Server Codex installer route" "Server-served Codex client installer" "$(curl -s "$E2E_SERVER/codex-install.mjs" 2>/dev/null || true)"
assert "Server opencode plugin route injects version" '"version": "'$EXPECTED_VERSION'"' "$(curl -s "$E2E_SERVER/plugins/package.json" 2>/dev/null || true)"
assert "Server Codex plugin route" '"name": "maf"' "$(curl -s "$E2E_SERVER/codex-plugins/.codex-plugin/plugin.json" 2>/dev/null || true)"
assert "Server Codex plugin route injects version" '"version": "'$EXPECTED_VERSION'"' "$(curl -s "$E2E_SERVER/codex-plugins/.codex-plugin/plugin.json" 2>/dev/null || true)"
assert "Server Claude dotfile plugin route" '"name": "maf"' "$(curl -s "$E2E_SERVER/cc-plugins/.claude-plugin/plugin.json" 2>/dev/null || true)"
assert "Server Claude plugin route injects version" '"version": "'$EXPECTED_VERSION'"' "$(curl -s "$E2E_SERVER/cc-plugins/.claude-plugin/plugin.json" 2>/dev/null || true)"

# 验证 Server agent 资产已拆到非隐藏源码目录，安装时再物化为 runtime 隐藏布局
assert "Server common_agent source layout" "common_agent/" "$(grep 'common_agent/' "$SCRIPT_DIR/package.json" 2>/dev/null || true)"
assert "Server source no dot opencode package files" "not_found" "$(grep '\".opencode/' "$SCRIPT_DIR/package.json" 2>/dev/null || echo "not_found")"
assert "Server sync maps common instructions" "common_agent/instructions" "$(grep 'common_agent/instructions' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server sync maps server skills" "common_agent/server_skills" "$(grep 'common_agent/server_skills' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server sync maps opencode agents" "opencode/agents" "$(grep 'opencode/agents' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server sync maps codex AGENTS" "codex/AGENTS.md" "$(grep 'codex/AGENTS.md' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Server sync maps codex standard agents" "codex/agents" "$(grep 'codex/agents' "$SCRIPT_DIR/bin/maf-server.mjs" 2>/dev/null || true)"
assert "Opencode write guard protects .codex" "/.codex/" "$(grep '/.codex/' "$SCRIPT_DIR/plugins/opencode-plugin-meta-agent-framework/index.js" 2>/dev/null || true)"

# 验证 Meta-Agent-Server Skill 自包含完整模板，runtime 入口优先使用 Skill，交付策略默认保守。
DISPATCH_SKILL="$(cat "$SCRIPT_DIR/common_agent/server_skills/meta-agent-server/SKILL.md" 2>/dev/null || true)"
DISPATCH_DOC="$(cat "$SCRIPT_DIR/common_agent/instructions/Meta-Agent-Server.md" "$SCRIPT_DIR/common_agent/rules/dispatch-flow.md" "$SCRIPT_DIR/opencode/agents/Meta-Agent-Server.md" "$SCRIPT_DIR/codex/AGENTS.md" "$SCRIPT_DIR/claude/CLAUDE.md" 2>/dev/null || true)"
DISPATCH_ALL="$DISPATCH_SKILL
$DISPATCH_DOC"
assert "Meta-Agent-Server dispatch origin" '"origin"' "$DISPATCH_SKILL"
assert "Meta-Agent-Server dispatch notify" '"notify"' "$DISPATCH_SKILL"
assert "Meta-Agent-Server dispatch origin agent" '"agent_name": "Meta-Agent-Server"' "$DISPATCH_SKILL"
assert "Meta-Agent-Server dispatch nodes" '"nodes"' "$DISPATCH_SKILL"
assert "Meta-Agent-Server executable heredoc template" "MAF_MINIMAL_WORKFLOW_TEMPLATE_BEGIN" "$DISPATCH_SKILL"
assert "Meta-Agent-Server explicit dispatch fast path" "明确点名" "$DISPATCH_ALL"
assert "Meta-Agent-Server avoids source search" "不要搜索业务目录" "$DISPATCH_ALL"
assert "Meta-Agent-Server fixed user flow" "派发 -> 执行 -> 结果交付" "$DISPATCH_ALL"
assert "Meta-Agent-Server deterministic delivery capability" "MAF_ASYNC_RESULT_DELIVERY=verified" "$DISPATCH_ALL"
assert "Meta-Agent-Server sync fallback" "bash scripts/poll-workflow.sh <workflow_id>" "$DISPATCH_ALL"
assert "Meta-Agent-Server removed unconditional async promise" "not_found" \
  "$(rg -n '默认异步派发并返回|派发后不轮询|回复用户.*结果会自动回来' "$SCRIPT_DIR/common_agent" "$SCRIPT_DIR/opencode" "$SCRIPT_DIR/codex" "$SCRIPT_DIR/claude" 2>/dev/null || echo not_found)"

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

# 同名新实例退出时，如果旧后台/任务仍在执行，不能删除 taskQueue，避免 workflow 上下文丢失
DUP_AGENT="same-agent-context"
DUP_PID_1=91001
DUP_PID_2=91002
DUP_TASK="same-agent-task-001"
DUP_WF="same-agent-wf-001"
DUP_NODE="same-agent-node-001"

curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$DUP_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$DUP_PID_1,\"directory\":\"/tmp\"}" >/dev/null 2>&1
server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"task_id\":\"$DUP_TASK\",\"workflow_id\":\"$DUP_WF\",\"node_id\":\"$DUP_NODE\",\"agent_name\":\"$DUP_AGENT\",\"runtime\":\"opencode\",\"title\":\"same agent context test\",\"description\":\"same agent context test\"}" >/dev/null 2>&1
DUP_WAIT=$(curl -s "$DAEMON_URL/tasks/wait?agent=$DUP_AGENT" 2>/dev/null)
assert "同名测试任务已分发" "$DUP_TASK" "$DUP_WAIT"

curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$DUP_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$DUP_PID_2,\"directory\":\"/tmp\"}" >/dev/null 2>&1
DUP_DISCONNECT=$(curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$DUP_AGENT\",\"plugin_pid\":$DUP_PID_2}" 2>/dev/null)
assert "同名当前实例断开时保留执行中队列" '"deferred":true' "$DUP_DISCONNECT"

DUP_DONE=$(curl -s -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$DUP_AGENT\",\"task_id\":\"$DUP_TASK\",\"status\":\"completed\",\"result\":\"same agent preserved result\",\"duration_ms\":1}" 2>/dev/null)
assert "同名断开后任务回报仍被接受" '"ok":true' "$DUP_DONE"
DUP_COMPLETED=$(curl -s "$DAEMON_URL/workflows/completed?limit=10" 2>/dev/null)
assert "同名断开后 workflow 上下文仍保留" "$DUP_WF" "$DUP_COMPLETED"
assert "同名断开后结果仍保留" "same agent preserved result" "$DUP_COMPLETED"

curl -s -X POST "$DAEMON_URL/agents/disconnect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$DUP_AGENT\"}" >/dev/null 2>&1

fi


# ============================================================
# Case 33: Codex runtime screen+TUI 链路
# ============================================================
if should_run 33; then
echo -e "\n${YELLOW}Case 33: Codex runtime screen+TUI 链路${NC}"

CODEX_AGENT="codex-e2e-agent"
CODEX_PROJECT="/tmp/e2e-codex-project"
mkdir -p "$CODEX_PROJECT"
cat > "$CODEX_PROJECT/AGENTS.md" << 'AGENTSEOF'
# E2E Codex Project

Respond briefly for tests.
AGENTSEOF
create_codex_agent_toml "$CODEX_PROJECT" "$CODEX_AGENT" "Codex E2E test agent"
rm -f "$MOCK_CODEX_ARGS_LOG"

curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CODEX_AGENT\",\"runtime\":\"codex\",\"directory\":\"$CODEX_PROJECT\"}" >/dev/null 2>&1

wait_until 10 "get_agent_field runtime $CODEX_AGENT" "codex" || true
assert "Codex agent runtime" "codex" "$(get_agent_field runtime $CODEX_AGENT)"
assert "Codex managed Agent 尚无执行器时待启动" "standby" "$(get_agent_field status $CODEX_AGENT)"

CODEX_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Codex e2e workflow\",\"nodes\":[{\"id\":\"codex-1\",\"agent_name\":\"$CODEX_AGENT\",\"prompt\":\"Codex e2e task: say hello\",\"scope\":\"project\",\"intent\":\"query\",\"delivery_mode\":\"detached\"}]}")
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
CODEX_ARGS=$(cat "$MOCK_CODEX_ARGS_LOG" 2>/dev/null || true)
assert "Codex detached 使用 danger-full-access" '\[-s\] \[danger-full-access\]' "$CODEX_ARGS"
assert "Codex detached 禁止交互审批" '\[-a\] \[never\]' "$CODEX_ARGS"

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
# E2E Codex autostart project

E2E Codex autostart project.
AGENTEOF
create_codex_agent_toml "$CODEX_AUTO_PROJECT" "$CODEX_AUTO_AGENT" "Codex autostart e2e agent"

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
assert "Codex autostart detached 待启动" "standby" "$(get_agent_field status $CODEX_AUTO_AGENT)"

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
# Codex project agent: $CODEX_WRAP_AGENT

E2E Codex wrapper project.
AGENTEOF

PATH="$E2E_BIN:$PATH" HOME="$CODEX_WRAP_HOME" XDG_CONFIG_HOME="$CODEX_WRAP_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_WRAP_PORT" MAF_CODEX_DELIVERY="detached" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" --auto >/tmp/e2e-codex-wrapper-install.log 2>&1

assert "Codex wrapper installed" "true" "$([ -x "$CODEX_WRAP_HOME/.local/bin/codex" ] && echo true || echo false)"
assert "Codex wrapper points to mock" "$E2E_BIN/codex" "$(grep 'REAL_CODEX=' "$CODEX_WRAP_HOME/.local/bin/codex" 2>/dev/null || true)"

(cd "$CODEX_WRAP_HOME" && PATH="$CODEX_WRAP_HOME/.local/bin:$E2E_BIN:$PATH" HOME="$CODEX_WRAP_HOME" XDG_CONFIG_HOME="$CODEX_WRAP_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_WRAP_PORT" MAF_CODEX_DELIVERY="detached" \
  MAF_CODEX_WRAPPER_DISABLE="" \
  timeout 5s codex --no-alt-screen >/tmp/e2e-codex-wrapper-home-run.log 2>&1 || true)

wait_until 10 "curl -s $CODEX_WRAP_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex wrapper home-dir daemon running" '"ok":true' "$(curl -s $CODEX_WRAP_DAEMON/health 2>/dev/null)"
assert "Codex wrapper home-dir no agent" '"agents":\[\]' "$(curl -s $CODEX_WRAP_DAEMON/health 2>/dev/null)"
assert "Codex wrapper home-dir log" "daemon ready without valid" "$(cat "$CODEX_WRAP_HOME/.meta-agent-framework/logs/codex-plugin.log" 2>/dev/null || true)"

CODEX_WRAP_MISC_AGENT="$(basename "$CODEX_WRAP_MISC")"
(cd "$CODEX_WRAP_MISC" && PATH="$CODEX_WRAP_HOME/.local/bin:$E2E_BIN:$PATH" HOME="$CODEX_WRAP_HOME" XDG_CONFIG_HOME="$CODEX_WRAP_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_WRAP_PORT" MAF_CODEX_DELIVERY="detached" \
  MAF_CODEX_WRAPPER_DISABLE="" \
  timeout 5s codex --no-alt-screen >/tmp/e2e-codex-wrapper-misc-run.log 2>&1 || true)

wait_until 10 "curl -s $CODEX_WRAP_DAEMON/agents 2>/dev/null" "$CODEX_WRAP_MISC_AGENT" || true
assert "Codex wrapper directory-name fallback agent" "$CODEX_WRAP_MISC_AGENT" "$(curl -s $CODEX_WRAP_DAEMON/agents 2>/dev/null)"

(cd "$CODEX_WRAP_MISC" && PATH="$CODEX_WRAP_HOME/.local/bin:$E2E_BIN:$PATH" HOME="$CODEX_WRAP_HOME" XDG_CONFIG_HOME="$CODEX_WRAP_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_WRAP_PORT" MAF_CODEX_DELIVERY="detached" \
  MAF_CODEX_WRAPPER_DISABLE="" \
  timeout 5s codex -C "$CODEX_WRAP_PROJECT" --no-alt-screen >/tmp/e2e-codex-wrapper-run.log 2>&1 || true)

wait_until 10 "curl -s $CODEX_WRAP_DAEMON/agents 2>/dev/null" "$CODEX_WRAP_AGENT" || true
assert "Codex wrapper AGENTS marker agent" "$CODEX_WRAP_AGENT" "$(curl -s $CODEX_WRAP_DAEMON/agents 2>/dev/null)"
assert "Codex wrapper log" "codex-wrapper" "$(cat "$CODEX_WRAP_HOME/.meta-agent-framework/logs/codex-plugin.log" 2>/dev/null || true)"

wait_until 10 "get_agent_field runtime $CODEX_WRAP_AGENT" "codex" || true
assert "Codex wrapper runtime" "codex" "$(get_agent_field runtime $CODEX_WRAP_AGENT)"

WRAP_PID=$(ss -tlnp 2>/dev/null | grep ":${CODEX_WRAP_PORT} " | grep -oP 'pid=\K\d+' | head -1)
[[ -n "$WRAP_PID" ]] && kill -9 "$WRAP_PID" 2>/dev/null || true

fi


# ============================================================
# Case 36: Codex 显式 attached 不伪装 online
# ============================================================
if should_run 36; then
echo -e "\n${YELLOW}Case 36: Codex 显式 attached 不伪装 online${NC}"

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
# E2E Codex attached project

Default attached delivery should not pretend to be online without an attached receiver.
AGENTEOF

HOME="$CODEX_ATT_HOME" XDG_CONFIG_HOME="$CODEX_ATT_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_ATT_PORT" MAF_DIRECTORY="$CODEX_ATT_PROJECT" \
  MAF_CODEX_DELIVERY="attached" \
  node "$CODEX_ATT_HOME/.meta-agent-framework/daemon.mjs" >/tmp/e2e-codex-attached-daemon.log 2>&1 &
CODEX_ATT_PID=$!
disown $CODEX_ATT_PID

wait_until 10 "curl -s $CODEX_ATT_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex attached daemon running" '"ok":true' "$(curl -s $CODEX_ATT_DAEMON/health 2>/dev/null)"

curl -s -X POST "$CODEX_ATT_DAEMON/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CODEX_ATT_AGENT\",\"runtime\":\"codex\",\"directory\":\"$CODEX_ATT_PROJECT\"}" >/dev/null 2>&1

wait_until 10 "get_agent_field runtime $CODEX_ATT_AGENT" "codex" || true
assert "Codex attached runtime" "codex" "$(get_agent_field runtime $CODEX_ATT_AGENT)"
assert "Codex explicit attached offline" "offline" "$(get_agent_field status $CODEX_ATT_AGENT)"

ATT_EXEC=$(server_signed_fetch "$CODEX_ATT_DAEMON/execute" POST \
  "{\"agent_name\":\"$CODEX_ATT_AGENT\",\"runtime\":\"codex\",\"prompt\":\"should fail attached clearly\"}")
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
# E2E Codex attached receiver project

E2E Codex attached receiver project.
AGENTEOF

HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_DELIVERY="attached" \
  node "$CODEX_RECV_HOME/.meta-agent-framework/daemon.mjs" >/tmp/e2e-codex-receiver-daemon.log 2>&1 &
CODEX_RECV_DAEMON_PID=$!
disown $CODEX_RECV_DAEMON_PID

wait_until 10 "curl -s $CODEX_RECV_DAEMON/health 2>/dev/null" '"ok":true' || true
assert "Codex receiver daemon running" '"ok":true' "$(curl -s $CODEX_RECV_DAEMON/health 2>/dev/null)"

HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MOCK_CODEX_TURN_LOG="$CODEX_RECV_TURN_LOG" \
  MOCK_CODEX_REQUIRE_WORKSPACE_WRITE=1 \
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
  -d "{\"title\":\"Codex attached receiver e2e\",\"nodes\":[{\"id\":\"recv-1\",\"agent_name\":\"$CODEX_RECV_AGENT\",\"prompt\":\"Codex attached e2e task: say hello from current receiver\",\"scope\":\"project\",\"intent\":\"query\",\"delivery_mode\":\"attached\"}]}")
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
NOTIFY_EXEC_ID=$(curl -s "$E2E_SERVER/api/workflows/$NOTIFY_WF_ID" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(n.get('execution_id','') for n in d.get('nodes',[]) if n.get('id')=='notify-1'))")
curl -s -X POST "$E2E_SERVER/api/workflows/$NOTIFY_WF_ID/nodes/notify-1/result" \
  -H 'Content-Type: application/json' \
  -d "{\"execution_id\":\"$NOTIFY_EXEC_ID\",\"agent_name\":\"$CODEX_NOTIFY_AGENT\",\"status\":\"completed\",\"result\":\"codex origin notification result\"}" >/dev/null
wait_until 10 "cat '$CODEX_RECV_TURN_LOG' 2>/dev/null" "\\[MAF 后台任务结果通知\\]" || true
assert "Codex origin workflow notification injected" "\\[MAF 后台任务结果通知\\]" "$(cat "$CODEX_RECV_TURN_LOG" 2>/dev/null || true)"
assert "Codex origin workflow notification result" "codex origin notification result" "$(cat "$CODEX_RECV_TURN_LOG" 2>/dev/null || true)"

CODEX_RECV_OLD_PID="$CODEX_RECV_PID"
sleep 30 &
CODEX_RECV_SESSION_A_PID=$!
HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_SESSION_PID="$CODEX_RECV_SESSION_A_PID" \
  MAF_CODEX_APP_SERVER_CMD="node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-replace.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"WrapperStart","sessionPid":"$CODEX_RECV_SESSION_A_PID"}
HOOKJSON
CODEX_RECV_REPLACEMENT_PID="$(cat "$CODEX_RECV_PID_FILE" 2>/dev/null || true)"
assert "Codex receiver replacement uses a new pid" "true" "$([[ -n "$CODEX_RECV_REPLACEMENT_PID" && "$CODEX_RECV_REPLACEMENT_PID" != "$CODEX_RECV_OLD_PID" ]] && echo true || echo false)"
assert "Codex receiver replacement stops previous process" "gone" "$(kill -0 "$CODEX_RECV_OLD_PID" 2>/dev/null && echo alive || echo gone)"
assert "Codex receiver replacement keeps new pid file" "$CODEX_RECV_REPLACEMENT_PID" "$(cat "$CODEX_RECV_PID_FILE" 2>/dev/null || true)"

HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_SESSION_PID="$CODEX_RECV_SESSION_A_PID" \
  MAF_CODEX_APP_SERVER_CMD="node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-reuse.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"WrapperStart","sessionPid":"$CODEX_RECV_SESSION_A_PID"}
HOOKJSON
assert "Codex repeated session hook reuses receiver" "$CODEX_RECV_REPLACEMENT_PID" "$(cat "$CODEX_RECV_PID_FILE" 2>/dev/null || true)"

HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_SESSION_PID="$CODEX_RECV_SESSION_A_PID" \
  MAF_CODEX_APP_SERVER_CMD="node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-stop.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"WrapperEnd","sessionPid":"$CODEX_RECV_SESSION_A_PID"}
HOOKJSON
assert "Codex WrapperEnd confirms receiver exit" "gone" "$(kill -0 "$CODEX_RECV_REPLACEMENT_PID" 2>/dev/null && echo alive || echo gone)"
assert "Codex WrapperEnd removes owned pid file" "missing" "$([[ -e "$CODEX_RECV_PID_FILE" ]] && echo present || echo missing)"
assert "Codex WrapperEnd removes owned meta file" "missing" "$([[ -e "$CODEX_RECV_HOME/.meta-agent-framework/codex-attached-receiver-${CODEX_RECV_AGENT}.json" ]] && echo present || echo missing)"
kill "$CODEX_RECV_SESSION_A_PID" 2>/dev/null || true
wait "$CODEX_RECV_SESSION_A_PID" 2>/dev/null || true

sleep 30 &
CODEX_RECV_SESSION_B_PID=$!
HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_SESSION_PID="$CODEX_RECV_SESSION_B_PID" \
  MAF_CODEX_APP_SERVER_CMD="node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-session-exit.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"WrapperStart","sessionPid":"$CODEX_RECV_SESSION_B_PID"}
HOOKJSON
CODEX_RECV_SESSION_BOUND_PID="$(cat "$CODEX_RECV_PID_FILE" 2>/dev/null || true)"
assert "Codex session-bound receiver spawned" "true" "$([[ -n "$CODEX_RECV_SESSION_BOUND_PID" ]] && kill -0 "$CODEX_RECV_SESSION_BOUND_PID" 2>/dev/null && echo true || echo false)"
kill "$CODEX_RECV_SESSION_B_PID" 2>/dev/null || true
wait "$CODEX_RECV_SESSION_B_PID" 2>/dev/null || true
wait_until 8 "kill -0 '$CODEX_RECV_SESSION_BOUND_PID' 2>/dev/null && echo alive || echo gone" "gone" || true
assert "Codex receiver exits when session disappears" "gone" "$(kill -0 "$CODEX_RECV_SESSION_BOUND_PID" 2>/dev/null && echo alive || echo gone)"
assert "Codex session exit removes owned pid file" "missing" "$([[ -e "$CODEX_RECV_PID_FILE" ]] && echo present || echo missing)"

sleep 30 &
CODEX_RECV_UNRELATED_PID=$!
printf '%s\n' "$CODEX_RECV_UNRELATED_PID" > "$CODEX_RECV_PID_FILE"
cat > "$CODEX_RECV_HOME/.meta-agent-framework/codex-attached-receiver-${CODEX_RECV_AGENT}.json" << METAJSON
{"agent_name":"$CODEX_RECV_AGENT","pid":$CODEX_RECV_UNRELATED_PID,"project_path":"$CODEX_RECV_PROJECT","session_pid":"stale"}
METAJSON
sleep 30 &
CODEX_RECV_SESSION_C_PID=$!
HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_SESSION_PID="$CODEX_RECV_SESSION_C_PID" \
  MAF_CODEX_APP_SERVER_CMD="node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-stale-pid.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"WrapperStart","sessionPid":"$CODEX_RECV_SESSION_C_PID"}
HOOKJSON
CODEX_RECV_FINAL_PID="$(cat "$CODEX_RECV_PID_FILE" 2>/dev/null || true)"
assert "Codex stale pid does not signal unrelated process" "alive" "$(kill -0 "$CODEX_RECV_UNRELATED_PID" 2>/dev/null && echo alive || echo gone)"
assert "Codex stale pid is replaced with receiver pid" "true" "$([[ -n "$CODEX_RECV_FINAL_PID" && "$CODEX_RECV_FINAL_PID" != "$CODEX_RECV_UNRELATED_PID" ]] && echo true || echo false)"

HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_SESSION_PID="$CODEX_RECV_SESSION_C_PID" \
  MAF_CODEX_APP_SERVER_CMD="node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-final-stop.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"WrapperEnd","sessionPid":"$CODEX_RECV_SESSION_C_PID"}
HOOKJSON

CODEX_RECV_DROP_PORT=14947
CODEX_RECV_DROP_URL="ws://127.0.0.1:${CODEX_RECV_DROP_PORT}"
node "$ROOT_DIR/scripts/mock-codex-app-server.mjs" --listen "$CODEX_RECV_DROP_URL" >/tmp/e2e-codex-receiver-drop-app.log 2>&1 &
CODEX_RECV_DROP_APP_PID=$!
wait_until 10 "command curl -s http://127.0.0.1:${CODEX_RECV_DROP_PORT}/readyz 2>/dev/null" '"ok":true' || true
sleep 30 &
CODEX_RECV_SESSION_D_PID=$!
HOME="$CODEX_RECV_HOME" XDG_CONFIG_HOME="$CODEX_RECV_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_RECV_PORT" \
  MAF_AGENT_NAME="$CODEX_RECV_AGENT" MAF_DIRECTORY="$CODEX_RECV_PROJECT" \
  MAF_CODEX_SESSION_PID="$CODEX_RECV_SESSION_D_PID" MAF_CODEX_APP_SERVER_URL="$CODEX_RECV_DROP_URL" \
  node "$ROOT_DIR/packages/client/codex/scripts/maf-codex-hook.mjs" << HOOKJSON >/tmp/e2e-codex-receiver-drop-hook.log 2>&1
{"cwd":"$CODEX_RECV_PROJECT","eventName":"WrapperStart","sessionPid":"$CODEX_RECV_SESSION_D_PID"}
HOOKJSON
CODEX_RECV_DROP_PID="$(cat "$CODEX_RECV_PID_FILE" 2>/dev/null || true)"
assert "Codex app-server-drop receiver spawned" "true" "$([[ -n "$CODEX_RECV_DROP_PID" ]] && kill -0 "$CODEX_RECV_DROP_PID" 2>/dev/null && echo true || echo false)"
kill "$CODEX_RECV_DROP_APP_PID" 2>/dev/null || true
wait "$CODEX_RECV_DROP_APP_PID" 2>/dev/null || true
wait_until 8 "kill -0 '$CODEX_RECV_DROP_PID' 2>/dev/null && echo alive || echo gone" "gone" || true
assert "Codex receiver exits when app-server disconnects" "gone" "$(kill -0 "$CODEX_RECV_DROP_PID" 2>/dev/null && echo alive || echo gone)"
assert "Codex app-server disconnect removes state" "missing" "$([[ -e "$CODEX_RECV_PID_FILE" || -e "$CODEX_RECV_HOME/.meta-agent-framework/codex-attached-receiver-${CODEX_RECV_AGENT}.json" ]] && echo present || echo missing)"
kill "$CODEX_RECV_SESSION_D_PID" 2>/dev/null || true
wait "$CODEX_RECV_SESSION_D_PID" 2>/dev/null || true

wait_until 10 "get_agent_field status $CODEX_RECV_AGENT" "offline" || true
assert "Codex attached receiver disconnect offline" "offline" "$(get_agent_field status $CODEX_RECV_AGENT)"
assert "Codex receiver lifecycle lock removed" "missing" "$([[ -e "$CODEX_RECV_HOME/.meta-agent-framework/codex-attached-receiver-${CODEX_RECV_AGENT}.lock" ]] && echo present || echo missing)"

kill -9 "$CODEX_RECV_OLD_PID" "$CODEX_RECV_REPLACEMENT_PID" "$CODEX_RECV_SESSION_BOUND_PID" "$CODEX_RECV_FINAL_PID" "$CODEX_RECV_DROP_PID" \
  "$CODEX_RECV_SESSION_A_PID" "$CODEX_RECV_SESSION_B_PID" "$CODEX_RECV_SESSION_C_PID" "$CODEX_RECV_SESSION_D_PID" "$CODEX_RECV_UNRELATED_PID" \
  "$CODEX_RECV_DROP_APP_PID" \
  "$CODEX_RECV_DAEMON_PID" "$CODEX_NOTIFY_ENDPOINT_PID" 2>/dev/null || true
wait "$CODEX_RECV_SESSION_C_PID" "$CODEX_RECV_UNRELATED_PID" 2>/dev/null || true

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
# E2E Codex wrapper auto-remote project

E2E Codex wrapper auto-remote project.
AGENTEOF
create_codex_agent_toml "$CODEX_REMOTE_PROJECT" "$CODEX_REMOTE_AGENT" "Codex auto remote e2e agent"

PATH="$E2E_BIN:$PATH" HOME="$CODEX_REMOTE_HOME" XDG_CONFIG_HOME="$CODEX_REMOTE_HOME/.config"   META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_REMOTE_PORT"   node "$ROOT_DIR/packages/client/bin/maf-install.mjs" --auto >/tmp/e2e-codex-auto-remote-install.log 2>&1

assert "Codex auto-remote wrapper installed" "true" "$([ -x "$CODEX_REMOTE_HOME/.local/bin/codex" ] && echo true || echo false)"
assert "Codex auto-remote helper installed" "true" "$([ -x "$CODEX_REMOTE_HOME/plugins/maf/scripts/maf-codex-app-server.mjs" ] && echo true || echo false)"

(cd "$CODEX_REMOTE_MISC" && PATH="$CODEX_REMOTE_HOME/.local/bin:$E2E_BIN:$PATH" HOME="$CODEX_REMOTE_HOME" XDG_CONFIG_HOME="$CODEX_REMOTE_HOME/.config"   META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$CODEX_REMOTE_PORT"   MAF_CODEX_APP_SERVER_PORT="$CODEX_REMOTE_APP_PORT" MAF_CODEX_THREAD_WAIT_MS=5000 MAF_CODEX_WRAPPER_DISABLE=""   MOCK_CODEX_APP_SERVER_SCRIPT="$ROOT_DIR/scripts/mock-codex-app-server.mjs" MOCK_CODEX_REQUIRE_WORKSPACE_WRITE=1 MOCK_CODEX_ARGS_LOG="$CODEX_REMOTE_ARGS_LOG" MOCK_CODEX_SLEEP_SECONDS=10   "$CODEX_REMOTE_HOME/.local/bin/codex" -C "$CODEX_REMOTE_PROJECT" resume --last --all >/tmp/e2e-codex-auto-remote-run.log 2>&1) &
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
  -d "{\"title\":\"Codex auto remote receiver e2e\",\"nodes\":[{\"id\":\"remote-1\",\"agent_name\":\"$CODEX_REMOTE_AGENT\",\"prompt\":\"Codex attached e2e task: hello from auto remote wrapper\",\"scope\":\"project\",\"intent\":\"query\",\"delivery_mode\":\"attached\"}]}")
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
wait_until 10 "get_agent_field status $CODEX_REMOTE_AGENT" "standby" || true
assert "Codex auto-remote wrapper 退出后无执行器待启动" "standby" "$(get_agent_field status $CODEX_REMOTE_AGENT)"

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
# E2E Codex attached receiver polling fallback project

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
  MAF_CODEX_APP_SERVER_CMD="MOCK_CODEX_NO_TURN_COMPLETED=1 MOCK_CODEX_TURN_STATUS_OBJECT=1 MOCK_CODEX_REQUIRE_WORKSPACE_WRITE=1 MOCK_CODEX_TURN_DELAY_MS=450 node $ROOT_DIR/scripts/mock-codex-app-server.mjs" \
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
  -d "{\"title\":\"Codex attached receiver poll fallback e2e\",\"nodes\":[{\"id\":\"poll-1\",\"agent_name\":\"$CODEX_POLL_AGENT\",\"prompt\":\"Codex attached e2e task: complete via thread read polling\",\"scope\":\"project\",\"intent\":\"query\",\"delivery_mode\":\"attached\"}]}")
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
assert "Codex poll observes running before completion" "inProgress" "$(cat "$CODEX_POLL_HOME/.meta-agent-framework/logs/codex-plugin.log" 2>/dev/null || true)"
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
SETTLED_WF_JSON=$(curl -s "$E2E_SERVER/api/workflows/$SETTLED_WF_ID")
SETTLED_EXEC_A=$(echo "$SETTLED_WF_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(n.get('execution_id','') for n in d.get('nodes',[]) if n.get('id')=='a'))")
SETTLED_EXEC_B=$(echo "$SETTLED_WF_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(n.get('execution_id','') for n in d.get('nodes',[]) if n.get('id')=='b'))")
curl -s -X POST "$E2E_SERVER/api/workflows/$SETTLED_WF_ID/nodes/a/result" \
  -H 'Content-Type: application/json' \
  -d "{\"execution_id\":\"$SETTLED_EXEC_A\",\"agent_name\":\"$SETTLED_AGENT_A\",\"status\":\"failed\",\"result\":\"branch A failed intentionally\"}" >/dev/null

sleep 1
SETTLED_STATUS_AFTER_A=$(curl -s "$E2E_SERVER/api/workflows/$SETTLED_WF_ID" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
assert "all_settled still running after one failure" "running" "$SETTLED_STATUS_AFTER_A"
SETTLED_NODE_C_STATUS=$(curl -s "$E2E_SERVER/api/workflows/$SETTLED_WF_ID" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(n.get('status','') for n in d.get('nodes',[]) if n.get('id')=='c'))" 2>/dev/null)
assert "all_settled blocked dependent skipped" "skipped" "$SETTLED_NODE_C_STATUS"

curl -s -X POST "$E2E_SERVER/api/workflows/$SETTLED_WF_ID/nodes/b/result" \
  -H 'Content-Type: application/json' \
  -d "{\"execution_id\":\"$SETTLED_EXEC_B\",\"agent_name\":\"$SETTLED_AGENT_B\",\"status\":\"completed\",\"result\":\"branch B completed\"}" >/dev/null

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
if cfg1.get("server", {}).get("host") != "0.0.0.0":
    raise AssertionError(f"server listen host should default to 0.0.0.0: {cfg1}")

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
print("SERVER_LISTEN_DEFAULT=ok")
PY
)

assert "未完成配置不再提示覆盖" "INCOMPLETE_NO_OVERWRITE=ok" "$INIT_OUTPUT"
assert "Runtime 空输入提示必选" "RUNTIME_REQUIRED=ok" "$INIT_OUTPUT"
assert "飞书必填项空输入提示" "FEISHU_REQUIRED=ok" "$INIT_OUTPUT"
assert "Server 默认监听所有网卡" "SERVER_LISTEN_DEFAULT=ok" "$INIT_OUTPUT"

CLIENT_INSTALL_HOME="$INIT_TEST_BASE/client-install"
mkdir -p "$CLIENT_INSTALL_HOME"
cat > "$CLIENT_INSTALL_HOME/.bashrc" <<'BASHRCEOF'
export META_AGENT_SERVER=http://192.0.2.10:3000
export META_AGENT_SERVER=http://192.0.2.11:3000
BASHRCEOF

CLIENT_INSTALL_OUTPUT=$(HOME="$CLIENT_INSTALL_HOME" XDG_CONFIG_HOME="$CLIENT_INSTALL_HOME/.config" \
  META_AGENT_SERVER="http://192.0.2.12:3000" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" install 192.168.1.100 2>&1)
CLIENT_INSTALL_CONFIG=$(python3 -c "import json; print(json.load(open('$CLIENT_INSTALL_HOME/.meta-agent-framework/maf.config.json'))['server']['url'])")
CLIENT_INSTALL_BASHRC=$(grep -c '^[[:space:]]*export[[:space:]]\+META_AGENT_SERVER=' "$CLIENT_INSTALL_HOME/.bashrc" || true)
assert "Client 尾随 IP 自动补协议和端口" "http://192.168.1.100:3000" "$CLIENT_INSTALL_CONFIG"
assert "Client 显式地址优先于旧环境变量" "Server: http://192.168.1.100:3000" "$CLIENT_INSTALL_OUTPUT"
assert "Client 安装清理 bashrc 旧 Server 地址" "0" "$CLIENT_INSTALL_BASHRC"

CLIENT_STATUS_OUTPUT=$(HOME="$CLIENT_INSTALL_HOME" XDG_CONFIG_HOME="$CLIENT_INSTALL_HOME/.config" \
  META_AGENT_SERVER="http://192.0.2.19:3000" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" status 2>&1)
assert "Client status 以配置文件为准" "Server (effective): http://192.168.1.100:3000" "$CLIENT_STATUS_OUTPUT"
assert "Client status 明示忽略冲突环境变量" "忽略与配置文件不一致的旧环境变量" "$CLIENT_STATUS_OUTPUT"

CLIENT_RELOAD_PORT=14941
HOME="$CLIENT_INSTALL_HOME" META_AGENT_SERVER="http://192.0.2.20:3000" MAF_NODE_PORT="$CLIENT_RELOAD_PORT" \
  node "$CLIENT_INSTALL_HOME/.meta-agent-framework/daemon.mjs" >/dev/null 2>&1 &
CLIENT_RELOAD_OLD_PID=$!
wait_until 10 "command curl -s http://127.0.0.1:$CLIENT_RELOAD_PORT/health 2>/dev/null" '192.168.1.100' || true
CLIENT_CONFIG_FIRST_HEALTH=$(command curl -s "http://127.0.0.1:$CLIENT_RELOAD_PORT/health" 2>/dev/null)
assert "Daemon 配置文件优先于冲突环境变量" "http://192.168.1.100:3000" "$CLIENT_CONFIG_FIRST_HEALTH"
CLIENT_RELOAD_OUTPUT=$(HOME="$CLIENT_INSTALL_HOME" XDG_CONFIG_HOME="$CLIENT_INSTALL_HOME/.config" \
  META_AGENT_SERVER="http://192.0.2.21:3000" MAF_NODE_PORT="$CLIENT_RELOAD_PORT" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" install 192.168.1.101 2>&1)
CLIENT_RELOAD_HEALTH=$(command curl -s "http://127.0.0.1:$CLIENT_RELOAD_PORT/health" 2>/dev/null)
CLIENT_RELOAD_NEW_PID=$(echo "$CLIENT_RELOAD_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('pid',''))" 2>/dev/null)
assert "Client 重装自动重启运行中 Daemon" "true" "$([ -n "$CLIENT_RELOAD_NEW_PID" ] && [ "$CLIENT_RELOAD_NEW_PID" != "$CLIENT_RELOAD_OLD_PID" ] && echo true || echo false)"
assert "Client 重装后 Daemon 立即使用新地址" "http://192.168.1.101:3000" "$CLIENT_RELOAD_HEALTH"
assert "Client 重装输出 Daemon 配置生效" "Node Daemon 已重启并连接" "$CLIENT_RELOAD_OUTPUT"
kill "$CLIENT_RELOAD_NEW_PID" 2>/dev/null || true
wait "$CLIENT_RELOAD_OLD_PID" 2>/dev/null || true

CLIENT_UNROUTABLE_CODE=0
CLIENT_UNROUTABLE_OUTPUT=$(HOME="$CLIENT_INSTALL_HOME" XDG_CONFIG_HOME="$CLIENT_INSTALL_HOME/.config" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" install 0.0.0.0 2>&1) || CLIENT_UNROUTABLE_CODE=$?
assert "Client 拒绝 0.0.0.0 作为远端地址" "只能作为 Server 监听地址" "$CLIENT_UNROUTABLE_OUTPUT"
assert "Client 非法远端地址返回失败" "true" "$([ "$CLIENT_UNROUTABLE_CODE" -ne 0 ] && echo true || echo false)"

CLIENT_INVALID_CODE=0
CLIENT_INVALID_OUTPUT=$(HOME="$CLIENT_INSTALL_HOME" XDG_CONFIG_HOME="$CLIENT_INSTALL_HOME/.config" \
  node "$ROOT_DIR/packages/client/bin/maf-install.mjs" install http://192.168.1.100:3000/path 2>&1) || CLIENT_INVALID_CODE=$?
assert "Client 地址校验提示完整 URL 格式" "请输入完整 URL，例如 http://192.168.1.100:3000" "$CLIENT_INVALID_OUTPUT"
assert "Client 地址校验不暴露解析细节" "true" "$([ "$CLIENT_INVALID_CODE" -ne 0 ] && [[ "$CLIENT_INVALID_OUTPUT" != *"路径、查询参数或片段"* ]] && echo true || echo false)"

rm -rf "$INIT_TEST_BASE"
fi

# ============================================================
# Case 42: Server 控制面身份不计入 Agent 看板
# ============================================================
if should_run 42; then
echo -e "\n${YELLOW}Case 42: Server 控制面身份不计入 Agent 看板${NC}"

BASE_STATS_RES=$(curl -s "$E2E_SERVER/api/agents/stats" 2>/dev/null)
BASE_TOTAL=$(echo "$BASE_STATS_RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('agents_total',0))" 2>/dev/null)
BASE_ONLINE=$(echo "$BASE_STATS_RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('agents_online',0))" 2>/dev/null)
BASE_INVENTORY_TOTAL=$(curl -s "$E2E_SERVER/api/agents/inventory" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('total_agents',0))" 2>/dev/null)
BOARD_AGENT="board-agent-e2e-$$"
STANDBY_BOARD_AGENT="standby-board-agent-e2e-$$"
REGISTER_RES=$(curl -s -X POST "$E2E_SERVER/api/clients/register" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"e2e\",\"host_user\":\"e2e\",\"client_endpoint\":\"http://127.0.0.1:$NODE_PORT\",\"agent_statuses\":{\"$BOARD_AGENT\":\"online\",\"$STANDBY_BOARD_AGENT\":\"standby\"},\"agents\":[{\"agent_name\":\"Meta-Agent-Server\",\"kind\":\"server\",\"runtime\":\"codex\",\"project_path\":\"/tmp/maf-server\",\"capabilities\":\"server control plane\",\"mode\":\"primary\"},{\"agent_name\":\"$BOARD_AGENT\",\"runtime\":\"opencode\",\"project_path\":\"/tmp\",\"capabilities\":\"test\",\"mode\":\"subagent\"},{\"agent_name\":\"$STANDBY_BOARD_AGENT\",\"runtime\":\"codex\",\"project_path\":\"/tmp\",\"capabilities\":\"standby test\",\"mode\":\"subagent\"}]}" 2>/dev/null)

REGISTER_NAMES=$(echo "$REGISTER_RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(a.get('agent_name','') for a in d.get('agents',[])))" 2>/dev/null)
assert "注册响应只返回 Client Agent" "$BOARD_AGENT,$STANDBY_BOARD_AGENT" "$REGISTER_NAMES"
assert "注册响应不含 Server" "not_found" "$(echo "$REGISTER_NAMES" | grep -o 'Meta-Agent-Server' || echo not_found)"

AGENTS_RES=$(curl -s "$E2E_SERVER/api/agents?all=true" 2>/dev/null)
SERVER_IN_BOARD=$(echo "$AGENTS_RES" | python3 -c "import json,sys;print(any(a.get('agent_name')=='Meta-Agent-Server' for a in json.load(sys.stdin)))" 2>/dev/null)
BOARD_IN_BOARD=$(echo "$AGENTS_RES" | python3 -c "import json,sys;print(any(a.get('agent_name')=='$BOARD_AGENT' for a in json.load(sys.stdin)))" 2>/dev/null)
STANDBY_STATUS=$(echo "$AGENTS_RES" | python3 -c "import json,sys;print(next((a.get('status','') for a in json.load(sys.stdin) if a.get('agent_name')=='$STANDBY_BOARD_AGENT'),''))" 2>/dev/null)
assert "Agent 看板不含 Server" "False" "$SERVER_IN_BOARD"
assert "Agent 看板保留普通 Agent" "True" "$BOARD_IN_BOARD"
assert "Agent 看板保留待启动 Agent" "standby" "$STANDBY_STATUS"

STATS_RES=$(curl -s "$E2E_SERVER/api/agents/stats" 2>/dev/null)
AGENTS_TOTAL=$(echo "$STATS_RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('agents_total',''))" 2>/dev/null)
AGENTS_ONLINE=$(echo "$STATS_RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('agents_online',''))" 2>/dev/null)
EXPECTED_TOTAL=$((BASE_TOTAL + 2))
EXPECTED_ONLINE=$((BASE_ONLINE + 1))
assert "Agent stats total 排除 Server" "$EXPECTED_TOTAL" "$AGENTS_TOTAL"
assert "Agent stats online 排除 Server" "$EXPECTED_ONLINE" "$AGENTS_ONLINE"
assert "Agent stats online 排除 standby" "$EXPECTED_ONLINE" "$AGENTS_ONLINE"

INVENTORY_TOTAL=$(curl -s "$E2E_SERVER/api/agents/inventory" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('total_agents',''))" 2>/dev/null)
EXPECTED_INVENTORY_TOTAL=$((BASE_INVENTORY_TOTAL + 2))
assert "Inventory total 排除 Server" "$EXPECTED_INVENTORY_TOTAL" "$INVENTORY_TOTAL"
fi

# ============================================================
# Case 43: 管理鉴权 + Client 机器身份自动注册
# ============================================================
if should_run 43; then
echo -e "\n${YELLOW}Case 43: 管理鉴权 + Client 自动注册${NC}"

assert "Server health 匿名可访问" "200" "$(command curl -s -o /dev/null -w '%{http_code}' "$E2E_SERVER/api/health")"
assert "E2E 具备非 loopback 地址" "true" "$([ -n "$E2E_REMOTE_HOST" ] && echo true || echo false)"
LOCAL_ACCESS=$(command curl -s "$E2E_SERVER/api/access-context")
REMOTE_ACCESS=$(command curl --noproxy '*' -s "$E2E_REMOTE_SERVER/api/access-context")
assert "localhost Dashboard 识别为本机" '"local":true' "$LOCAL_ACCESS"
assert "localhost Dashboard 具备写权限" '"can_write":true' "$LOCAL_ACCESS"
assert "LAN Dashboard 识别为远端" '"local":false' "$REMOTE_ACCESS"
assert "LAN Dashboard 只有只读权限" '"can_write":false' "$REMOTE_ACCESS"

PUBLIC_AGENT_SUMMARY_URL="$E2E_REMOTE_SERVER/api/agents?fields=agent_name,status,runtime,capabilities"
assert "Agent 安全摘要允许 LAN 匿名查询" "200" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$PUBLIC_AGENT_SUMMARY_URL")"
assert "LAN Dashboard Agent 看板匿名可读" "200" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$E2E_REMOTE_SERVER/api/agents?all=true")"
assert "LAN Dashboard Task 看板匿名可读" "200" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$E2E_REMOTE_SERVER/api/tasks?limit=80")"
assert "LAN Dashboard Workflow 看板匿名可读" "200" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$E2E_REMOTE_SERVER/api/workflows")"
assert "LAN Dashboard Client 身份摘要匿名可读" "200" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$E2E_REMOTE_SERVER/api/auth/clients")"
assert "LAN Dashboard SSE 匿名可订阅" "200" "$(command curl --noproxy '*' -s --max-time 1 -o /dev/null -w '%{http_code}' "$E2E_REMOTE_SERVER/api/events" || true)"
assert "LAN 匿名 Client 任务轮询被拒绝" "401" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$E2E_REMOTE_SERVER/api/tasks/poll?agent_name=$AGENT_NAME&user_id=e2e-testuser")"

LOCAL_WORKFLOW_BODY='{"title":"localhost-management-e2e","nodes":[{"id":"n1","agent_name":"missing-localhost-e2e-agent","prompt":"localhost signed dispatch test"}]}'
assert "localhost 无 Token 可创建 Workflow" "202" "$(command curl -s -o /dev/null -w '%{http_code}' -X POST "$E2E_SERVER/api/workflows" -H 'Content-Type: application/json' -d "$LOCAL_WORKFLOW_BODY")"
assert "LAN 匿名不能创建 Workflow" "401" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -X POST "$E2E_REMOTE_SERVER/api/workflows" -H 'Content-Type: application/json' -d "$LOCAL_WORKFLOW_BODY")"
assert "LAN 错误 Token 不能创建 Workflow" "401" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer wrong-token-value-012345678901234567890' "$E2E_REMOTE_SERVER/api/workflows" -H 'Content-Type: application/json' -d "$LOCAL_WORKFLOW_BODY")"
assert "LAN Admin Token 也不能创建 Workflow" "401" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $MAF_AUTH_TOKEN" "$E2E_REMOTE_SERVER/api/workflows" -H 'Content-Type: application/json' -d "$LOCAL_WORKFLOW_BODY")"
assert "LAN Admin Token 不能批准 Client" "401" "$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $MAF_AUTH_TOKEN" "$E2E_REMOTE_SERVER/api/auth/clients/nonexistent/approve")"

assert "Dashboard 不再弹 Access Token" "not_found" "$(command curl -s "$E2E_SERVER/" | rg -o "window\\.prompt\\('MAF access token'\\)" || echo not_found)"
assert "Dashboard 不再读取 Token" "not_found" "$(command curl -s "$E2E_SERVER/" | rg -o 'AUTH_TOKEN|maf_auth_token' || echo not_found)"
assert "Dashboard 根据访问来源切换只读" "config.readonly = config.readonlyRequested" "$(command curl -s "$E2E_SERVER/")"
assert "Dashboard 查询访问上下文" "/api/access-context" "$(command curl -s "$E2E_SERVER/")"

assert "Daemon health 匿名可访问" "200" "$(command curl -s -o /dev/null -w '%{http_code}' "$DAEMON_URL/health")"
assert "Daemon 控制 API 拒绝匿名" "401" "$(command curl -s -o /dev/null -w '%{http_code}' "$DAEMON_URL/status")"
assert "匿名服务不能向 Daemon 下发任务" "401" "$(command curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' -d '{"agent_name":"test-agent","prompt":"anonymous command"}')"
assert "本机 Token 不能向 Daemon 下发任务" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/execute" -H 'Content-Type: application/json' -d '{"agent_name":"test-agent","prompt":"local token command"}')"
assert "合法 Server 签名通过 Daemon 鉴权" "HTTP:400" "$(server_signed_fetch "$DAEMON_URL/execute" POST '{}')"
assert "Daemon 控制 API 拒绝错误 Token" "401" "$(command curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong-token-value-012345678901234567890' "$DAEMON_URL/status")"
assert "Daemon 控制 API 接受本机 Token" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$DAEMON_URL/status")"

CLIENT_ID=$(command curl -s "$DAEMON_URL/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('client_id',''))")
assert "Client 自动生成机器 ID" "true" "$([ -n "$CLIENT_ID" ] && echo true || echo false)"
assert "Client 自动准入 active" "active" "$(command curl -s "$DAEMON_URL/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('enrollment_status',''))")"
assert "Client 私钥权限 0600" "600" "$(stat -c '%a' "$E2E_USER_HOME/.meta-agent-framework/auth/client-private.pem")"
assert "Client 本机 Token 权限 0600" "600" "$(stat -c '%a' "$E2E_USER_HOME/.meta-agent-framework/auth/local-token")"
assert "Server 保存 Client 公钥身份" "$CLIENT_ID" "$(curl -s "$E2E_SERVER/api/auth/clients")"
assert "Dashboard 提供 Client 审批入口" "data-client-action" "$(command curl -s "$E2E_SERVER/")"

CLIENT_IDENTITY_JSON=$(curl -s "$E2E_SERVER/api/auth/clients" | python3 -c "import json,sys;print(json.dumps(next(i for i in json.load(sys.stdin) if i['client_id']=='$CLIENT_ID')))" 2>/dev/null)
ENROLL_REPLAY=$(MAF_REPLAY_IDENTITY="$CLIENT_IDENTITY_JSON" META_AGENT_SERVER="$E2E_SERVER" node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const identity = JSON.parse(process.env.MAF_REPLAY_IDENTITY);
const authDir = path.join(os.homedir(), ".meta-agent-framework", "auth");
const publicKey = fs.readFileSync(path.join(authDir, "client-public.pem"), "utf8");
const privateKey = fs.readFileSync(path.join(authDir, "client-private.pem"), "utf8");
const url = `${process.env.META_AGENT_SERVER}/api/auth/enroll`;
const body = JSON.stringify({
  client_id: identity.client_id,
  public_key: publicKey,
  client_endpoint: identity.client_endpoint,
  hostname: identity.hostname,
  user_id: identity.user_id,
  host_user: identity.host_user,
});
const timestamp = String(Date.now());
const nonce = crypto.randomBytes(18).toString("base64url");
const target = new URL(url).pathname;
const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
const canonical = Buffer.from(["POST", target, timestamp, nonce, bodyHash].join("\n"));
const headers = {
  "Content-Type": "application/json",
  "X-MAF-Role": "client",
  "X-MAF-ID": identity.client_id,
  "X-MAF-Timestamp": timestamp,
  "X-MAF-Nonce": nonce,
  "X-MAF-Signature": crypto.sign(null, canonical, privateKey).toString("base64url"),
};
(async () => {
  const first = await fetch(url, { method: "POST", headers, body });
  const second = await fetch(url, { method: "POST", headers, body });
  process.stdout.write(`${first.status},${second.status}`);
})().catch(err => { console.error(err); process.exit(1); });
NODE
)
assert "Enrollment nonce 防重放" "200,401" "$ENROLL_REPLAY"

SIGNED_POLL=$(client_signed_fetch "$E2E_SERVER/api/tasks/poll?agent_name=$AGENT_NAME&user_id=e2e-testuser")
assert "Client 签名可访问 Client API" "HTTP:200" "$SIGNED_POLL"
assert "Task poll 响应具有有效 Server 签名" "SERVER_SIGNATURE_VALID:true" "$SIGNED_POLL"

POLL_AUTH_AGENT="poll-signature-agent-$$"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$POLL_AUTH_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$$,\"directory\":\"/tmp\",\"user_id\":\"e2e-testuser\"}" >/dev/null
wait_until 10 "get_agent_field status $POLL_AUTH_AGENT" "online" || true
cp "$E2E_USER_HOME/.meta-agent-framework/auth/server-public.pem" \
  "$E2E_USER_HOME/.meta-agent-framework/auth/server-public.pem.e2e-backup"
cp "$E2E_USER_HOME/.meta-agent-framework/auth/client-public.pem" \
  "$E2E_USER_HOME/.meta-agent-framework/auth/server-public.pem"
POLL_TASK=$(command curl -s -X POST "$E2E_SERVER/api/tasks" -H 'Content-Type: application/json' \
  -d '{"type":"custom","title":"poll response signature e2e","description":"must require Server signature"}')
POLL_TASK_ID=$(echo "$POLL_TASK" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
command curl -s -X POST "$E2E_SERVER/api/tasks/$POLL_TASK_ID/dispatch" -H 'Content-Type: application/json' \
  -d "{\"agent\":\"$POLL_AUTH_AGENT\"}" >/dev/null
sleep 2
POLL_REJECTED_QUEUE=$(curl -s "$DAEMON_URL/tasks/pending?agent=$POLL_AUTH_AGENT")
assert "Daemon 拒绝错误 Server 公钥签名的 poll 任务" "not_found" \
  "$(echo "$POLL_REJECTED_QUEUE" | rg -o "$POLL_TASK_ID" || echo not_found)"
mv "$E2E_USER_HOME/.meta-agent-framework/auth/server-public.pem.e2e-backup" \
  "$E2E_USER_HOME/.meta-agent-framework/auth/server-public.pem"
wait_until 10 "curl -s '$DAEMON_URL/tasks/pending?agent=$POLL_AUTH_AGENT'" "$POLL_TASK_ID" || true
assert "Daemon 恢复正确 Server 公钥后接收 poll 任务" "$POLL_TASK_ID" \
  "$(curl -s "$DAEMON_URL/tasks/pending?agent=$POLL_AUTH_AGENT")"

SIGNED_ADMIN=$(client_signed_fetch "$E2E_SERVER/api/clients")
assert "Client 签名不能访问管理 API" "HTTP:403" "$SIGNED_ADMIN"
assert "旧 pairing 接口已移除" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$E2E_SERVER/api/auth/pair")"
assert "安装器不要求配对码" "not_found" "$(rg -o 'MAF_PAIRING_CODE|Pairing Code|配对码' "$SCRIPT_DIR/plugins/install.sh" "$ROOT_DIR/packages/client/bin/maf-install.mjs" 2>/dev/null || echo not_found)"

LATE_HOME="/tmp/maf-e2e-late-client"
LATE_PORT=14143
LATE_DAEMON="http://127.0.0.1:$LATE_PORT"
mkdir -p "$LATE_HOME/.meta-agent-framework"
cp "$SCRIPT_DIR/plugins/node-daemon/daemon.mjs" "$LATE_HOME/.meta-agent-framework/daemon.mjs"
cat > "$LATE_HOME/.meta-agent-framework/package.json" << PKGJSON
{"name":"@maf/meta-agent-daemon","version":"$EXPECTED_VERSION","type":"module"}
PKGJSON
env -u MAF_AUTH_TOKEN -u MAF_LOCAL_TOKEN HOME="$LATE_HOME" META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$LATE_PORT" \
  node "$LATE_HOME/.meta-agent-framework/daemon.mjs" >/tmp/maf-e2e-late-client.log 2>&1 &
LATE_PID=$!
disown $LATE_PID
wait_until 10 "command curl -s $LATE_DAEMON/health 2>/dev/null" '"enrollment_status":"active"' || true
LATE_HEALTH=$(command curl -s "$LATE_DAEMON/health" 2>/dev/null)
assert "晚启动 Client 无配对信息自动准入" '"enrollment_status":"active"' "$LATE_HEALTH"
LATE_CLIENT_ID=$(echo "$LATE_HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin).get('client_id',''))")
LATE_USER_ID=$(echo "$LATE_HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin).get('user_id',''))")
assert "晚启动 Client 进入 Server 身份表" "$LATE_CLIENT_ID" "$(curl -s "$E2E_SERVER/api/auth/clients")"
assert "Client 用户身份已持久化" "$LATE_USER_ID" "$(cat "$LATE_HOME/.meta-agent-framework/auth/user-id")"
assert "Client 用户身份文件权限 0600" "600" "$(stat -c '%a' "$LATE_HOME/.meta-agent-framework/auth/user-id")"
kill -9 "$LATE_PID" 2>/dev/null || true
wait "$LATE_PID" 2>/dev/null || true
rm -f "$LATE_HOME/.meta-agent-framework/auth/client-public.pem"
env -u MAF_AUTH_TOKEN -u MAF_LOCAL_TOKEN HOME="$LATE_HOME" MAF_USER_ID="must-not-replace-stable-id" META_AGENT_SERVER="$E2E_SERVER" MAF_NODE_PORT="$LATE_PORT" \
  node "$LATE_HOME/.meta-agent-framework/daemon.mjs" >/tmp/maf-e2e-late-client-repair.log 2>&1 &
LATE_REPAIR_PID=$!
disown $LATE_REPAIR_PID
wait_until 10 "command curl -s $LATE_DAEMON/health 2>/dev/null" '"enrollment_status":"active"' || true
LATE_REPAIRED_ID=$(command curl -s "$LATE_DAEMON/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('client_id',''))")
assert "Client 公钥缺失后从私钥恢复" "$LATE_CLIENT_ID" "$LATE_REPAIRED_ID"
assert "Client 重启后忽略变化的进程用户标识" "$LATE_USER_ID" "$(command curl -s "$LATE_DAEMON/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('user_id',''))")"
kill -9 "$LATE_REPAIR_PID" 2>/dev/null || true
fi

# ============================================================
# Case 44: task / execution / status 严格关联
# ============================================================
if should_run 44; then
echo -e "\n${YELLOW}Case 44: task / execution / status 严格关联${NC}"

STRICT_AGENT="strict-result-agent-$$"
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$STRICT_AGENT\",\"runtime\":\"claude-code\",\"directory\":\"/tmp\",\"user_id\":\"e2e-testuser\"}" >/dev/null
wait_until 10 "get_agent_field status $STRICT_AGENT" "online" || true

server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"task_id\":\"strict-task-1\",\"agent_name\":\"$STRICT_AGENT\",\"runtime\":\"claude-code\",\"prompt\":\"strict task id test\"}" >/dev/null
TAKEN=$(curl -s -X POST "$DAEMON_URL/tasks/take?agent=$STRICT_AGENT")
assert "严格校验测试任务已领取" "strict-task-1" "$TAKEN"
assert "错误 task_id 返回 409" "409" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' -d "{\"agent_name\":\"$STRICT_AGENT\",\"task_id\":\"wrong-task\",\"status\":\"completed\",\"result\":\"bad\"}")"
assert "非法 task status 返回 422" "422" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' -d "{\"agent_name\":\"$STRICT_AGENT\",\"task_id\":\"strict-task-1\",\"status\":\"success\",\"result\":\"bad\"}")"
assert "错误回报后正确任务仍可完成" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' -d "{\"agent_name\":\"$STRICT_AGENT\",\"task_id\":\"strict-task-1\",\"status\":\"completed\",\"result\":\"correct\"}")"

STRICT_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" -H 'Content-Type: application/json' \
  -d "{\"title\":\"strict workflow result e2e\",\"nodes\":[{\"id\":\"strict-node\",\"agent_name\":\"$STRICT_AGENT\",\"prompt\":\"strict workflow result\",\"scope\":\"project\",\"intent\":\"query\"}]}")
STRICT_WF_ID=$(echo "$STRICT_WF" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workflow_id',''))")
wait_until 10 "curl -s -X POST '$DAEMON_URL/tasks/take?agent=$STRICT_AGENT'" "execution_id" || true
STRICT_TASK=$(curl -s "$DAEMON_URL/tasks/pending?agent=$STRICT_AGENT" 2>/dev/null || true)
STRICT_WF_JSON=$(curl -s "$E2E_SERVER/api/workflows/$STRICT_WF_ID")
STRICT_EXEC_ID=$(echo "$STRICT_WF_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['nodes'][0].get('execution_id',''))")

WRONG_EXEC=$(curl -s -w '\nHTTP:%{http_code}' -X POST "$E2E_SERVER/api/workflows/$STRICT_WF_ID/nodes/strict-node/result" -H 'Content-Type: application/json' \
  -d "{\"execution_id\":\"wrong-execution\",\"agent_name\":\"$STRICT_AGENT\",\"status\":\"completed\",\"result\":\"bad\"}")
assert "错误 execution_id 返回 409" "HTTP:409" "$WRONG_EXEC"
assert "错误 agent 返回 409" "409" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$E2E_SERVER/api/workflows/$STRICT_WF_ID/nodes/strict-node/result" -H 'Content-Type: application/json' -d "{\"execution_id\":\"$STRICT_EXEC_ID\",\"agent_name\":\"wrong-agent\",\"status\":\"completed\",\"result\":\"bad\"}")"
assert "非法 workflow status 返回 422" "422" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$E2E_SERVER/api/workflows/$STRICT_WF_ID/nodes/strict-node/result" -H 'Content-Type: application/json' -d "{\"execution_id\":\"$STRICT_EXEC_ID\",\"agent_name\":\"$STRICT_AGENT\",\"status\":\"success\",\"result\":\"bad\"}")"
assert "错误 workflow 回报后节点仍 running" "running" "$(curl -s "$E2E_SERVER/api/workflows/$STRICT_WF_ID" | python3 -c "import json,sys;print(json.load(sys.stdin)['nodes'][0]['status'])")"

# take 请求已在 wait_until 中领取任务，按真实 execution_id 完成。
assert "正确 workflow 任务回报成功" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/tasks/done" -H 'Content-Type: application/json' -d "{\"agent_name\":\"$STRICT_AGENT\",\"task_id\":\"$STRICT_EXEC_ID\",\"status\":\"completed\",\"result\":\"strict workflow correct\"}")"
wait_until 10 "curl -s '$E2E_SERVER/api/workflows/$STRICT_WF_ID'" '"status":"completed"' || true
assert "Workflow 最终 completed" "completed" "$(curl -s "$E2E_SERVER/api/workflows/$STRICT_WF_ID" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
assert "迟到回报返回 422" "422" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$E2E_SERVER/api/workflows/$STRICT_WF_ID/nodes/strict-node/result" -H 'Content-Type: application/json' -d "{\"execution_id\":\"$STRICT_EXEC_ID\",\"agent_name\":\"$STRICT_AGENT\",\"status\":\"completed\",\"result\":\"late\"}")"
fi

# ============================================================
# Case 45: OpenCode 失败不得误报成功
# ============================================================
if should_run 45; then
echo -e "\n${YELLOW}Case 45: OpenCode 失败不得误报成功${NC}"

for MODE in error empty stale timeout; do
  command curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__mock/mode" -H 'Content-Type: application/json' -d "{\"mode\":\"$MODE\"}" >/dev/null
  MODE_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" -H 'Content-Type: application/json' \
    -d "{\"title\":\"OpenCode $MODE must fail\",\"nodes\":[{\"id\":\"mode-node\",\"agent_name\":\"$AGENT_NAME\",\"prompt\":\"OpenCode mode $MODE\",\"scope\":\"project\",\"intent\":\"query\"}]}")
  MODE_WF_ID=$(echo "$MODE_WF" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workflow_id',''))")
  wait_until 10 "curl -s '$E2E_SERVER/api/workflows/$MODE_WF_ID'" '"status":"failed"' || true
  MODE_WF_JSON=$(curl -s "$E2E_SERVER/api/workflows/$MODE_WF_ID")
  assert "OpenCode $MODE 最终 failed" "failed" "$(echo "$MODE_WF_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
  MODE_RESULT=$(echo "$MODE_WF_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['nodes'][0].get('result',''))")
  if [[ "$MODE" == "error" ]]; then
    assert "OpenCode HTTP error 保留原因" "HTTP 500" "$MODE_RESULT"
  elif [[ "$MODE" == "timeout" ]]; then
    assert "OpenCode timeout 保留原因" "超时" "$MODE_RESULT"
  else
    assert "OpenCode $MODE 无新结果原因" "新 assistant 结果" "$MODE_RESULT"
  fi
done

command curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__mock/mode" -H 'Content-Type: application/json' -d '{"mode":"success"}' >/dev/null
SUCCESS_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" -H 'Content-Type: application/json' \
  -d "{\"title\":\"OpenCode success remains working\",\"nodes\":[{\"id\":\"success-node\",\"agent_name\":\"$AGENT_NAME\",\"prompt\":\"OpenCode success after failures\",\"scope\":\"project\",\"intent\":\"query\"}]}")
SUCCESS_WF_ID=$(echo "$SUCCESS_WF" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workflow_id',''))")
wait_until 10 "curl -s '$E2E_SERVER/api/workflows/$SUCCESS_WF_ID'" '"status":"completed"' || true
assert "OpenCode 正常链路仍 completed" "completed" "$(curl -s "$E2E_SERVER/api/workflows/$SUCCESS_WF_ID" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
fi

# ============================================================
# Case 46: MAS headless runtime 空输出不得误报成功
# ============================================================
if should_run 46; then
echo -e "\n${YELLOW}Case 46: MAS headless runtime 空输出不得误报成功${NC}"

for RUNTIME in opencode claude codex; do
  stop_e2e_server
  start_e2e_server "$RUNTIME" || { echo -e "${RED}❌ $RUNTIME Server 启动失败${NC}"; exit 1; }

  printf 'empty\n' > "$E2E_MAF_HOME/state/mas-runtime-mode"
  EMPTY_MAS=$(curl -s -X POST "$E2E_SERVER/api/workflows/mas/task" -H 'Content-Type: application/json' \
    -d "{\"title\":\"MAS $RUNTIME empty output\",\"description\":\"empty output must fail\"}")
  EMPTY_MAS_ID=$(echo "$EMPTY_MAS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('session_id',''))")
  assert "MAS $RUNTIME 空输出 session failed" "failed" "$(echo "$EMPTY_MAS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
  EMPTY_MAS_DETAIL=$(curl -s "$E2E_SERVER/api/workflows/mas/sessions/$EMPTY_MAS_ID")
  case "$RUNTIME" in
    opencode) EMPTY_LABEL="opencode run" ;;
    claude) EMPTY_LABEL="claude --print" ;;
    codex) EMPTY_LABEL="codex exec" ;;
  esac
  assert "MAS $RUNTIME 空输出保留失败原因" "$EMPTY_LABEL completed without output" \
    "$(echo "$EMPTY_MAS_DETAIL" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['rounds'][0].get('mas_output',''))")"

  printf 'normal\n' > "$E2E_MAF_HOME/state/mas-runtime-mode"
  SUCCESS_MAS=$(curl -s -X POST "$E2E_SERVER/api/workflows/mas/task" -H 'Content-Type: application/json' \
    -d "{\"title\":\"MAS $RUNTIME normal output\",\"description\":\"normal output must complete\"}")
  SUCCESS_MAS_ID=$(echo "$SUCCESS_MAS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('session_id',''))")
  assert "MAS $RUNTIME 正常输出 session completed" "completed" "$(echo "$SUCCESS_MAS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
  SUCCESS_MAS_DETAIL=$(curl -s "$E2E_SERVER/api/workflows/mas/sessions/$SUCCESS_MAS_ID")
  assert "MAS $RUNTIME 正常输出保留结果" "mock result" \
    "$(echo "$SUCCESS_MAS_DETAIL" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['rounds'][0].get('mas_output',''))")"
  MAS_OBSERVED=$(cat "$E2E_MAF_HOME/state/mas-runtime-observed")
  assert "MAS $RUNTIME Router 不继承管理 Token" "" "$(echo "$MAS_OBSERVED" | sed -n 's/^auth_token=//p')"
  assert "MAS $RUNTIME Router 不继承本机 Token" "" "$(echo "$MAS_OBSERVED" | sed -n 's/^local_token=//p')"
  assert "MAS $RUNTIME Router 不继承 Server URL" "" "$(echo "$MAS_OBSERVED" | sed -n 's/^server_url=//p')"
  assert "MAS $RUNTIME Router 使用隔离临时目录" "true" "$(echo "$MAS_OBSERVED" | rg -q '^cwd=/tmp/maf-mas-router-' && echo true || echo false)"
  assert "MAS $RUNTIME Router 收到只读协议" "router_protocol=true" "$MAS_OBSERVED"
  assert "MAS $RUNTIME Router 使用独立身份" "router_agent=Meta-Agent-Router" "$MAS_OBSERVED"
done
fi

# ============================================================
# Case 47: Client local-only Agent 发布边界
# ============================================================
if should_run 47; then
echo -e "\n${YELLOW}Case 47: Client local-only Agent 发布边界${NC}"

PRIVACY_HOME="/tmp/maf-e2e-agent-privacy"
PRIVACY_PORT=14147
PRIVACY_DAEMON="http://127.0.0.1:${PRIVACY_PORT}"
PRIVACY_REMOTE_DAEMON="http://${E2E_REMOTE_HOST}:${PRIVACY_PORT}"
PRIVATE_AGENT="private-agent-$$"
UNLISTED_AGENT="unlisted-agent-$$"
PUBLIC_AGENT="published-agent-$$"
rm -rf "$PRIVACY_HOME"
mkdir -p "$PRIVACY_HOME/.meta-agent-framework"
cp "$SCRIPT_DIR/plugins/node-daemon/daemon.mjs" "$PRIVACY_HOME/.meta-agent-framework/daemon.mjs"
cat > "$PRIVACY_HOME/.meta-agent-framework/package.json" << PKGJSON
{"name":"@maf/meta-agent-daemon","version":"$EXPECTED_VERSION","type":"module"}
PKGJSON
cat > "$PRIVACY_HOME/.meta-agent-framework/maf.config.json" << PRIVACYJSON
{
  "server": { "url": "$E2E_SERVER" },
  "daemon": { "port": $PRIVACY_PORT },
  "client": {
    "agent_publication": {
      "mode": "explicit",
      "include": ["$PUBLIC_AGENT"],
      "local_only": ["$PRIVATE_AGENT"],
      "client_network": "when-published"
    }
  }
}
PRIVACYJSON

HOME="$PRIVACY_HOME" XDG_CONFIG_HOME="$PRIVACY_HOME/.config" \
  MAF_LOCAL_TOKEN="$MAF_AUTH_TOKEN" MAF_USER_ID="privacy-e2e" MAF_NODE_PORT="$PRIVACY_PORT" \
  node "$PRIVACY_HOME/.meta-agent-framework/daemon.mjs" >/tmp/maf-e2e-agent-privacy.log 2>&1 &
PRIVACY_DAEMON_PID=$!
disown "$PRIVACY_DAEMON_PID"

wait_until 10 "command curl -s '$PRIVACY_DAEMON/health' 2>/dev/null" '"ok":true' || true
PRIVACY_HEALTH=$(command curl -s "$PRIVACY_DAEMON/health")
assert "隐私 Daemon 启动" '"ok":true' "$PRIVACY_HEALTH"
PRIVACY_CLIENT_ID=$(echo "$PRIVACY_HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin).get('client_id',''))")
assert "无公开 Agent 时不 enrollment" "False" \
  "$(curl -s "$E2E_SERVER/api/auth/clients" | python3 -c "import json,sys;print(any(c.get('client_id')=='$PRIVACY_CLIENT_ID' for c in json.load(sys.stdin)))")"

PRIVATE_CONNECT=$(curl -s -X POST "$PRIVACY_DAEMON/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$PRIVATE_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$$,\"directory\":\"/tmp/private\",\"user_id\":\"privacy-e2e\"}")
assert "显式 local_only 连接成功" '"local_only":true' "$PRIVATE_CONNECT"

UNLISTED_CONNECT=$(curl -s -X POST "$PRIVACY_DAEMON/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$UNLISTED_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$$,\"directory\":\"/tmp/unlisted\",\"user_id\":\"privacy-e2e\"}")
assert "explicit 模式未列入 include 的 Agent 自动 local-only" '"local_only":true' "$UNLISTED_CONNECT"

sleep 1
assert "local-only 连接不触发 enrollment" "False" \
  "$(curl -s "$E2E_SERVER/api/auth/clients" | python3 -c "import json,sys;print(any(c.get('client_id')=='$PRIVACY_CLIENT_ID' for c in json.load(sys.stdin)))")"
assert "本机 health 保留 local-only Agent" "$PRIVATE_AGENT" "$(command curl -s "$PRIVACY_DAEMON/health")"
assert "本机 agents 标记 local-only" '"visibility":"local-only"' "$(curl -s "$PRIVACY_DAEMON/agents")"

REMOTE_PRIVATE_HEALTH=$(command curl --noproxy '*' -s "$PRIVACY_REMOTE_DAEMON/health")
assert "远端 health 不暴露 local-only Agent" "not_found" \
  "$(echo "$REMOTE_PRIVATE_HEALTH" | rg -o "$PRIVATE_AGENT" || echo not_found)"
assert "远端 health 不暴露 Client ID" "not_found" \
  "$(echo "$REMOTE_PRIVATE_HEALTH" | rg -o "$PRIVACY_CLIENT_ID" || echo not_found)"

PUBLIC_CONNECT=$(curl -s -X POST "$PRIVACY_DAEMON/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$PUBLIC_AGENT\",\"runtime\":\"opencode\",\"plugin_pid\":$$,\"directory\":\"/tmp/public\",\"user_id\":\"privacy-e2e\"}")
assert "include 中 Agent 正常发布" '"local_only":false' "$PUBLIC_CONNECT"
wait_until 10 "get_agent_field status '$PUBLIC_AGENT'" "online" || true
assert "Server 只看到公开 Agent" "$PUBLIC_AGENT" "$(get_agent_field agent_name "$PUBLIC_AGENT")"
assert "Server 不存在显式 local-only Agent" "not_found" \
  "$(get_agent_field agent_name "$PRIVATE_AGENT" | rg -o "$PRIVATE_AGENT" || echo not_found)"
assert "Server 不存在 implicit local-only Agent" "not_found" \
  "$(get_agent_field agent_name "$UNLISTED_AGENT" | rg -o "$UNLISTED_AGENT" || echo not_found)"
assert "首个公开 Agent 触发 enrollment" "True" \
  "$(curl -s "$E2E_SERVER/api/auth/clients" | python3 -c "import json,sys;print(any(c.get('client_id')=='$PRIVACY_CLIENT_ID' for c in json.load(sys.stdin)))")"

REMOTE_PUBLISHED_HEALTH=$(command curl --noproxy '*' -s "$PRIVACY_REMOTE_DAEMON/health")
assert "远端 health 只显示公开 Agent" "$PUBLIC_AGENT" "$REMOTE_PUBLISHED_HEALTH"
assert "远端 health 仍不显示 private Agent" "not_found" \
  "$(echo "$REMOTE_PUBLISHED_HEALTH" | rg -o "$PRIVATE_AGENT" || echo not_found)"
assert "Server 不能向 local-only Agent 派发" "HTTP:404" \
  "$(server_signed_fetch "$PRIVACY_DAEMON/execute" POST "{\"agent_name\":\"$PRIVATE_AGENT\",\"prompt\":\"must stay local\"}")"
assert "local-only Agent 不能向 Server 提交 proposal" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PRIVACY_DAEMON/proposals/submit" -H 'Content-Type: application/json' -d "{\"from_agent\":\"$PRIVATE_AGENT\",\"type\":\"other\",\"title\":\"must stay local\"}")"

kill -9 "$PRIVACY_DAEMON_PID" 2>/dev/null || true
wait "$PRIVACY_DAEMON_PID" 2>/dev/null || true
PRIVACY_DAEMON_PID=""
fi

# ============================================================
# Case 48: Headless Codex 只接受首次成功终态回报
# ============================================================
if should_run 48; then
echo -e "\n${YELLOW}Case 48: Headless Codex 终态回报幂等${NC}"

RESULT_HOME="/tmp/maf-e2e-result-idempotency"
RESULT_PORT=14148
RESULT_DAEMON="http://127.0.0.1:${RESULT_PORT}"
RESULT_AGENT="codex-result-idempotency-$$"
rm -f "$MOCK_CODEX_ARGS_LOG"
mkdir -p "$RESULT_HOME/.meta-agent-framework"
cp "$SCRIPT_DIR/plugins/node-daemon/daemon.mjs" "$RESULT_HOME/.meta-agent-framework/daemon.mjs"
cat > "$RESULT_HOME/.meta-agent-framework/package.json" << PKGJSON
{"name":"@maf/meta-agent-daemon","version":"$EXPECTED_VERSION","type":"module"}
PKGJSON

HOME="$RESULT_HOME" XDG_CONFIG_HOME="$RESULT_HOME/.config" \
  META_AGENT_SERVER="$E2E_SERVER" MAF_LOCAL_TOKEN="$MAF_AUTH_TOKEN" MAF_USER_ID="result-e2e" \
  MAF_NODE_PORT="$RESULT_PORT" MAF_CODEX_MODE="exec" CODEX_BIN="$CODEX_BIN" \
  MOCK_CODEX_PROMPT_LOG="$MOCK_CODEX_PROMPT_LOG" \
  node "$RESULT_HOME/.meta-agent-framework/daemon.mjs" >/tmp/maf-e2e-result-idempotency.log 2>&1 &
RESULT_DAEMON_PID=$!
disown "$RESULT_DAEMON_PID"

wait_until 10 "command curl -s '$RESULT_DAEMON/health' 2>/dev/null" '"ok":true' || true
curl -s -X POST "$RESULT_DAEMON/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$RESULT_AGENT\",\"runtime\":\"codex\",\"directory\":\"/tmp\"}" >/dev/null
wait_until 10 "get_agent_field status '$RESULT_AGENT'" "online" || true

RESULT_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" -H 'Content-Type: application/json' -d "{
  \"title\":\"headless result idempotency\",
  \"nodes\":[{\"id\":\"result-node\",\"agent_name\":\"$RESULT_AGENT\",\"prompt\":\"MAF_E2E_WAIT_FOR_MANUAL_REPORT\",\"scope\":\"project\",\"intent\":\"query\"}]
}")
RESULT_WF_ID=$(echo "$RESULT_WF" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workflow_id',''))")
wait_until 10 "curl -s '$E2E_SERVER/api/workflows/$RESULT_WF_ID'" '"status":"running"' || true
RESULT_EXEC_ID=$(curl -s "$E2E_SERVER/api/workflows/$RESULT_WF_ID" | python3 -c "import json,sys;print(json.load(sys.stdin)['nodes'][0].get('execution_id',''))")
RESULT_DONE=$(curl -s -X POST "$RESULT_DAEMON/tasks/done" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$RESULT_AGENT\",\"task_id\":\"$RESULT_EXEC_ID\",\"status\":\"completed\",\"result\":\"authoritative detailed report\",\"duration_ms\":1}")
assert "首次 Headless 终态回报成功" '"ok":true' "$RESULT_DONE"
wait_until 10 "curl -s '$E2E_SERVER/api/workflows/$RESULT_WF_ID'" '"status":"completed"' || true
sleep 6
RESULT_WF_RESULT=$(curl -s "$E2E_SERVER/api/workflows/$RESULT_WF_ID" | python3 -c "import json,sys;print(json.load(sys.stdin)['nodes'][0].get('result',''))")
assert "自动收尾未覆盖 Server 权威结果" "authoritative detailed report" "$RESULT_WF_RESULT"
assert "重复终态回报被明确忽略" "忽略任务重复终态回报" "$(tail -n 80 "$RESULT_HOME/.meta-agent-framework/logs/client-daemon.log")"
assert "Headless Prompt 禁止自行回报" "不要调用 /tasks/done" "$(cat "$MOCK_CODEX_PROMPT_LOG")"
RESULT_CODEX_ARGS=$(cat "$MOCK_CODEX_ARGS_LOG" 2>/dev/null || true)
assert "Codex headless 使用 danger-full-access" '\[-s\] \[danger-full-access\]' "$RESULT_CODEX_ARGS"
assert "Codex headless 禁止交互审批" '\[-a\] \[never\]' "$RESULT_CODEX_ARGS"

kill -9 "$RESULT_DAEMON_PID" 2>/dev/null || true
wait "$RESULT_DAEMON_PID" 2>/dev/null || true
RESULT_DAEMON_PID=""
fi

# ============================================================
# Case 49: 通用 Execution 两阶段 Artifact + direct repository + Gerrit
# ============================================================
if should_run 49; then
echo -e "\n${YELLOW}Case 49: 通用 managed Execution 完整链路${NC}"

EXEC_ORIGIN="/tmp/maf-e2e-execution-origin.git"
EXEC_SEED="/tmp/maf-e2e-execution-seed"
EXEC_BASE="/tmp/maf-e2e-execution-base"
EXEC_AGENT="managed-execution-agent"
rm -rf "$EXEC_ORIGIN" "$EXEC_SEED" "$EXEC_BASE"
git init --bare "$EXEC_ORIGIN" >/dev/null
git init -b main "$EXEC_SEED" >/dev/null
git -C "$EXEC_SEED" config user.name "MAF E2E"
git -C "$EXEC_SEED" config user.email "maf-e2e@local"
printf 'original baseline\n' > "$EXEC_SEED/source.txt"
create_codex_agent_toml "$EXEC_SEED" "$EXEC_AGENT" "Managed Execution direct repository agent"
cat >> "$EXEC_SEED/.codex/agents/${EXEC_AGENT}.toml" << 'TOMLEOF'
target_branch = "main"
remote_name = "origin"
TOMLEOF
git -C "$EXEC_SEED" add source.txt .codex
git -C "$EXEC_SEED" commit -m initial >/dev/null
git -C "$EXEC_SEED" remote add origin "$EXEC_ORIGIN"
git -C "$EXEC_SEED" push -u origin main >/dev/null
git -C "$EXEC_ORIGIN" symbolic-ref HEAD refs/heads/main
git clone "$EXEC_ORIGIN" "$EXEC_BASE" >/dev/null

curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$EXEC_AGENT\",\"runtime\":\"codex\",\"directory\":\"$EXEC_BASE\"}" >/dev/null
wait_until 10 "get_agent_field status '$EXEC_AGENT'" "online" || true
printf '%s\n' "$EXEC_AGENT" > "$E2E_MAF_HOME/state/mas-runtime-agent"
printf 'workflow\n' > "$E2E_MAF_HOME/state/mas-runtime-mode"

EXEC_CREATE=$(curl -s -X POST "$E2E_SERVER/api/v1/executions" -H 'Content-Type: application/json' -d '{
  "request_id":"generic-request-001",
  "external_id":"external-object-001",
  "source_type":"arbitrary-source",
  "source_ref":"source://example/001",
  "title":"generic managed execution e2e",
  "prompt":"Use the supplied artifact and update the repository.",
  "metadata":{"opaque_context":{"priority":7}},
  "workdir_policy":"managed_workspace",
  "auto_start":false
}')
EXEC_ID=$(echo "$EXEC_CREATE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
assert "Execution 创建后保持 queued" "queued" "$(echo "$EXEC_CREATE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
assert "Execution 接受任意 source_type" "arbitrary-source" "$EXEC_CREATE"
assert "Execution 透明保留 metadata" '"opaque_context"' "$EXEC_CREATE"

ARTIFACT_STATUS=$(printf 'generic evidence\n' | curl -s -o /dev/null -w '%{http_code}' -X PUT \
  "$E2E_SERVER/api/v1/executions/$EXEC_ID/artifacts/evidence/input.txt" --data-binary @-)
assert "Execution 启动前可上传 Artifact" "201" "$ARTIFACT_STATUS"
EXEC_START=$(curl -s -X POST "$E2E_SERVER/api/v1/executions/$EXEC_ID/start")
assert "显式启动 Execution" '"started":true' "$EXEC_START"
wait_until 25 "curl -s '$E2E_SERVER/api/v1/executions/$EXEC_ID'" '"status":"completed"' || true

EXEC_FINAL=$(curl -s "$E2E_SERVER/api/v1/executions/$EXEC_ID")
assert "managed Execution 最终 completed" "completed" "$(echo "$EXEC_FINAL" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
assert "Execution 枚举已上传 Artifact" "evidence/input.txt" "$EXEC_FINAL"
assert "Execution 使用当前 direct_repository 策略" '"workdir_policy":"direct_repository"' "$EXEC_FINAL"
assert "Direct repository 不生成旧 Patch" '"available":false' "$EXEC_FINAL"
assert "Managed app-server 完成 Gerrit 收尾" "Gerrit 交付" "$EXEC_FINAL"
assert "Managed Execution 使用 app-server stdio" '\[app-server\] \[--stdio\]' "$(cat "$MOCK_CODEX_ARGS_LOG" 2>/dev/null || true)"
assert "基础仓库未被改写" "original baseline" "$(cat "$EXEC_BASE/source.txt")"
assert "基础仓库保持 clean" "" "$(git -C "$EXEC_BASE" status --porcelain)"
assert "Gerrit refs/for/main 收到提交" "changed by generic managed execution" "$(git --git-dir="$EXEC_ORIGIN" show refs/for/main:source.txt)"
assert "成功后释放 repository lock" "0" "$(find "$E2E_MAF_HOME/repository-locks" -type f 2>/dev/null | wc -l)"

EXEC_DUPLICATE=$(curl -s -X POST "$E2E_SERVER/api/v1/executions" -H 'Content-Type: application/json' \
  -d '{"request_id":"generic-request-001","title":"must not replace","prompt":"must not replace"}')
assert "request_id 重试返回同一 Execution" "$EXEC_ID" "$(echo "$EXEC_DUPLICATE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")"
assert "request_id 重试不覆盖原始标题" "generic managed execution e2e" "$EXEC_DUPLICATE"
printf 'normal\n' > "$E2E_MAF_HOME/state/mas-runtime-mode"
fi

# ============================================================
# Case 50: Codex Dashboard 实时对话完整链路
# ============================================================
if should_run 50; then
echo -e "\n${YELLOW}Case 50: Codex Dashboard 实时对话完整链路${NC}"

CODEX_CONVERSATION_PROJECT="/tmp/e2e-codex-conversation-project"
CODEX_CONVERSATION_AGENT="codex-conversation-e2e"
CODEX_CONVERSATION_SSE_FILE="/tmp/maf-e2e-codex-conversation.sse"
rm -rf "$CODEX_CONVERSATION_PROJECT"
rm -f "$CODEX_CONVERSATION_SSE_FILE" "$MOCK_CODEX_ARGS_LOG"
mkdir -p "$CODEX_CONVERSATION_PROJECT"
create_codex_agent_toml "$CODEX_CONVERSATION_PROJECT" "$CODEX_CONVERSATION_AGENT" "Codex realtime conversation e2e agent"

CODEX_CONVERSATION_CONNECT=$(curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CODEX_CONVERSATION_AGENT\",\"runtime\":\"codex\",\"directory\":\"$CODEX_CONVERSATION_PROJECT\"}")
assert "Codex conversation Agent 连接 Daemon" '"ok":true' "$CODEX_CONVERSATION_CONNECT"
wait_until 10 "get_agent_field status '$CODEX_CONVERSATION_AGENT'" "standby" || true
assert "Codex conversation Agent 尚无 app-server 时待启动" "standby" "$(get_agent_field status "$CODEX_CONVERSATION_AGENT")"

CODEX_CONVERSATION_AGENT_ID=$(curl -s "$E2E_SERVER/api/agents?all=true" | python3 -c "import json,sys; print(next((a.get('id','') for a in json.load(sys.stdin) if a.get('agent_name')=='$CODEX_CONVERSATION_AGENT'),''))")
CODEX_CONVERSATION_CREATE=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations" -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$CODEX_CONVERSATION_AGENT_ID\",\"title\":\"Realtime E2E\"}")
CODEX_CONVERSATION_ID=$(echo "$CODEX_CONVERSATION_CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('conversation',{}).get('id',''))" 2>/dev/null)
assert "Codex conversation 创建成功" "true" "$([ -n "$CODEX_CONVERSATION_ID" ] && echo true || echo false)"
assert "Codex conversation thread 已就绪" "mock-thread-1" "$CODEX_CONVERSATION_CREATE"
CODEX_CONVERSATION_REOPEN=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations" -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$CODEX_CONVERSATION_AGENT_ID\"}")
assert "同一 Agent 重复打开复用 conversation" "$CODEX_CONVERSATION_ID" "$(echo "$CODEX_CONVERSATION_REOPEN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('conversation',{}).get('id',''))")"
assert "Agent conversation 使用统一 source_type" '"source_type":"agent"' "$CODEX_CONVERSATION_REOPEN"
assert "Codex conversation 默认 danger-full-access" '"sandbox_mode":"danger-full-access"' "$CODEX_CONVERSATION_CREATE"
assert "Codex conversation 默认 never approval" '"approval_policy":"never"' "$CODEX_CONVERSATION_CREATE"
assert "Codex app-server 使用私有 stdio" '\[app-server\] \[--stdio\]' "$(cat "$MOCK_CODEX_ARGS_LOG" 2>/dev/null || true)"
wait_until 10 "get_agent_field status '$CODEX_CONVERSATION_AGENT'" "online" || true
assert "Codex conversation app-server 启动后在线" "online" "$(get_agent_field status "$CODEX_CONVERSATION_AGENT")"

command curl -sN "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/stream?after_seq=0" >"$CODEX_CONVERSATION_SSE_FILE" &
CODEX_CONVERSATION_SSE_PID=$!
sleep 0.2
CODEX_TURN_ONE=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' -d '{"input":"Codex attached e2e task: realtime first turn"}')
assert "Codex realtime 第一 turn 已接受" "true" "$(echo "$CODEX_TURN_ONE" | python3 -c "import json,sys; print('true' if json.load(sys.stdin).get('id') else 'false')" 2>/dev/null)"
wait_until 10 "curl -s '$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID' | python3 -c \"import json,sys; print(sum(t.get('status')=='completed' for t in json.load(sys.stdin).get('turns',[])))\"" "1" || true
wait_until 10 "cat '$CODEX_CONVERSATION_SSE_FILE'" "realtime first turn" || true
CODEX_SSE_FIRST=$(cat "$CODEX_CONVERSATION_SSE_FILE" 2>/dev/null || true)
assert "SSE 实时收到 Assistant delta" "item/agentMessage/delta" "$CODEX_SSE_FIRST"
assert "SSE 实时收到 Assistant completed item" "item/completed" "$CODEX_SSE_FIRST"
assert "SSE 实时收到 turn completed" "turn/completed" "$CODEX_SSE_FIRST"
assert "SSE 实时收到 Assistant 文本" "realtime first turn" "$CODEX_SSE_FIRST"

CODEX_FIRST_LAST_SEQ=$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/events?after_seq=0&limit=5000" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[-1]['seq'] if d else 0)")
kill "$CODEX_CONVERSATION_SSE_PID" 2>/dev/null || true
wait "$CODEX_CONVERSATION_SSE_PID" 2>/dev/null || true
CODEX_CONVERSATION_SSE_PID=""
: > "$CODEX_CONVERSATION_SSE_FILE"
command curl -sN "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/stream?after_seq=$CODEX_FIRST_LAST_SEQ" >"$CODEX_CONVERSATION_SSE_FILE" &
CODEX_CONVERSATION_SSE_PID=$!
sleep 0.2

CODEX_TURN_TWO=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' -d '{"input":"Codex attached e2e task: realtime second turn"}')
assert "Codex realtime 第二 turn 已接受" "true" "$(echo "$CODEX_TURN_TWO" | python3 -c "import json,sys; print('true' if json.load(sys.stdin).get('id') else 'false')" 2>/dev/null)"
wait_until 10 "curl -s '$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID' | python3 -c \"import json,sys; print(sum(t.get('status')=='completed' for t in json.load(sys.stdin).get('turns',[])))\"" "2" || true
CODEX_REMOTE_DETAIL=$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID")
assert "远端 thread/read 还原第一条用户消息" "realtime first turn" "$(echo "$CODEX_REMOTE_DETAIL" | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join(str(i.get('text','')) for t in (d.get('remote') or {}).get('thread',{}).get('turns',[]) for i in t.get('items',[]) if i.get('type')=='userMessage'))")"
assert "远端 thread/read 还原第二条用户消息" "realtime second turn" "$(echo "$CODEX_REMOTE_DETAIL" | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join(str(i.get('text','')) for t in (d.get('remote') or {}).get('thread',{}).get('turns',[]) for i in t.get('items',[]) if i.get('type')=='userMessage'))")"
assert "Server turn 元数据不保存用户输入" "metadata_empty" "$(echo "$CODEX_REMOTE_DETAIL" | python3 -c "import json,sys;d=json.load(sys.stdin);print('metadata_empty' if d.get('turns') and all(not t.get('input') and not t.get('result') for t in d.get('turns',[])) else 'content_found')")"
wait_until 10 "cat '$CODEX_CONVERSATION_SSE_FILE'" "realtime second turn" || true
CODEX_SSE_RESUMED=$(cat "$CODEX_CONVERSATION_SSE_FILE" 2>/dev/null || true)
assert "SSE after_seq 增量续传收到新 turn" "realtime second turn" "$CODEX_SSE_RESUMED"
assert "SSE after_seq 不重放第一 turn" "not_found" "$(echo "$CODEX_SSE_RESUMED" | rg -o 'realtime first turn' || echo not_found)"

CODEX_TURN_SLOW=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' -d '{"input":"MAF_E2E_SLOW_TURN Codex attached e2e task: interrupt me"}')
assert "Codex realtime 慢 turn 已接受" "true" "$(echo "$CODEX_TURN_SLOW" | python3 -c "import json,sys; print('true' if json.load(sys.stdin).get('id') else 'false')" 2>/dev/null)"
wait_until 10 "get_agent_field status '$CODEX_CONVERSATION_AGENT'" "busy" || true
assert "Codex realtime 活动 turn 标记 busy" "busy" "$(get_agent_field status "$CODEX_CONVERSATION_AGENT")"
CODEX_INTERRUPT=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/interrupt" -H 'Content-Type: application/json' -d '{}')
assert "Codex realtime turn 中断请求成功" '"ok":true' "$CODEX_INTERRUPT"
wait_until 10 "curl -s '$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID' | python3 -c \"import json,sys; print(json.load(sys.stdin).get('turns',[])[-1].get('status',''))\"" "interrupted" || true
CODEX_CONVERSATION_DETAIL=$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID")
assert "Codex realtime 中断状态保留在 turn 元数据" "interrupted" "$CODEX_CONVERSATION_DETAIL"
wait_until 10 "get_agent_field status '$CODEX_CONVERSATION_AGENT'" "online" || true
assert "Codex realtime turn 结束后 bridge 仍在线" "online" "$(get_agent_field status "$CODEX_CONVERSATION_AGENT")"

CODEX_EVENTS=$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/events?after_seq=0&limit=5000")
CODEX_SEQ_CHECK=$(echo "$CODEX_EVENTS" | python3 -c "import json,sys; d=json.load(sys.stdin); s=[e['seq'] for e in d]; print('ordered_unique' if s and s==sorted(s) and len(s)==len(set(s)) else 'bad')")
assert "Codex event seq 严格递增且唯一" "ordered_unique" "$CODEX_SEQ_CHECK"
assert "Codex 当前进程事件包含用户消息" "maf/userMessage" "$CODEX_EVENTS"
assert "Codex 当前进程事件包含 interrupt 状态" "interrupted" "$CODEX_EVENTS"

REMOTE_CODEX_READ=$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$E2E_REMOTE_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID")
REMOTE_CODEX_WRITE=$(command curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -X POST "$E2E_REMOTE_SERVER/api/codex/conversations/$CODEX_CONVERSATION_ID/turns" -H 'Content-Type: application/json' -d '{"input":"must be rejected"}')
assert "远端 Dashboard 可匿名只读 conversation" "200" "$REMOTE_CODEX_READ"
assert "远端 Dashboard 不能写 conversation" "401" "$REMOTE_CODEX_WRITE"
LOCAL_TOKEN_INJECTION=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/codex/conversations/start" -H 'Content-Type: application/json' \
  -d "{\"conversation_id\":\"local-token-must-fail-0001\",\"agent_name\":\"$CODEX_CONVERSATION_AGENT\",\"project_path\":\"$CODEX_CONVERSATION_PROJECT\"}")
assert "Daemon conversation 控制拒绝 local token 注入" "403" "$LOCAL_TOKEN_INJECTION"

CODEX_CONVERSATION_RESET=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations" -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$CODEX_CONVERSATION_AGENT_ID\",\"reset\":true}")
assert "新开远端会话保持 Agent conversation ID" "$CODEX_CONVERSATION_ID" "$(echo "$CODEX_CONVERSATION_RESET" | python3 -c "import json,sys;print(json.load(sys.stdin).get('conversation',{}).get('id',''))")"
assert "新开远端会话清空 turn 关联元数据" "0" "$(echo "$CODEX_CONVERSATION_RESET" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('turns',[])))")"
assert "新开远端会话的 thread/read 为空" "0" "$(echo "$CODEX_CONVERSATION_RESET" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(((d.get('remote') or {}).get('thread') or {}).get('turns',[])))")"

kill "$CODEX_CONVERSATION_SSE_PID" 2>/dev/null || true
wait "$CODEX_CONVERSATION_SSE_PID" 2>/dev/null || true
CODEX_CONVERSATION_SSE_PID=""
fi

# ============================================================
# Case 51: Codex managed Workflow/Task 默认投递 + 取消
# ============================================================
if should_run 51; then
echo -e "\n${YELLOW}Case 51: Codex managed Workflow/Task 默认投递 + 取消${NC}"

CODEX_MANAGED_PROJECT="/tmp/e2e-codex-managed-project"
CODEX_MANAGED_AGENT="codex-managed-e2e"
rm -rf "$CODEX_MANAGED_PROJECT"
rm -f "$MOCK_CODEX_ARGS_LOG"
mkdir -p "$CODEX_MANAGED_PROJECT"
create_codex_agent_toml "$CODEX_MANAGED_PROJECT" "$CODEX_MANAGED_AGENT" "Codex managed workflow e2e agent"

CODEX_MANAGED_CONNECT=$(curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$CODEX_MANAGED_AGENT\",\"runtime\":\"codex\",\"directory\":\"$CODEX_MANAGED_PROJECT\"}")
assert "Codex managed Agent 连接 Daemon" '"ok":true' "$CODEX_MANAGED_CONNECT"
wait_until 10 "get_agent_field status '$CODEX_MANAGED_AGENT'" "standby" || true
assert "Codex managed Agent 尚无 app-server 时待启动" "standby" "$(get_agent_field status "$CODEX_MANAGED_AGENT")"

CODEX_MANAGED_WF=$(curl -s -X POST "$E2E_SERVER/api/workflows" -H 'Content-Type: application/json' -d "{
  \"title\":\"Codex managed default workflow\",
  \"nodes\":[{\"id\":\"managed-1\",\"agent_name\":\"$CODEX_MANAGED_AGENT\",\"prompt\":\"Codex managed e2e workflow task\",\"scope\":\"project\",\"intent\":\"query\"}]
}")
CODEX_MANAGED_WF_ID=$(echo "$CODEX_MANAGED_WF" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workflow_id',''))")
assert "Codex managed Workflow 创建" "true" "$([ -n "$CODEX_MANAGED_WF_ID" ] && echo true || echo false)"
wait_until 20 "curl -s '$E2E_SERVER/api/workflows/$CODEX_MANAGED_WF_ID' | python3 -c \"import json,sys;print(json.load(sys.stdin).get('status',''))\"" "completed" || true
CODEX_MANAGED_WF_DETAIL=$(curl -s "$E2E_SERVER/api/workflows/$CODEX_MANAGED_WF_ID")
assert "Codex Workflow 默认 managed 完成" "completed" "$(echo "$CODEX_MANAGED_WF_DETAIL" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
CODEX_MANAGED_CONVERSATION_ID=$(echo "$CODEX_MANAGED_WF_DETAIL" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('nodes',[{}])[0].get('conversation_id',''))")
assert "Workflow 节点关联 managed conversation" "true" "$([ -n "$CODEX_MANAGED_CONVERSATION_ID" ] && echo true || echo false)"
CODEX_MANAGED_CONVERSATION=$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_MANAGED_CONVERSATION_ID")
assert "Workflow 复用 Agent conversation source_type" '"source_type":"agent"' "$CODEX_MANAGED_CONVERSATION"
assert "Workflow turn 严格关联 workflow_id" "$CODEX_MANAGED_WF_ID" "$CODEX_MANAGED_CONVERSATION"
assert "Workflow Assistant 结果来自远端 thread/read" "mock attached codex completed" "$(echo "$CODEX_MANAGED_CONVERSATION" | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join(str(i.get('text','')) for t in ((d.get('remote') or {}).get('thread') or {}).get('turns',[]) for i in t.get('items',[]) if i.get('type')=='agentMessage'))")"
assert "Workflow turn 不保存正文" "metadata_empty" "$(echo "$CODEX_MANAGED_CONVERSATION" | python3 -c "import json,sys;d=json.load(sys.stdin);print('metadata_empty' if all(not t.get('input') and not t.get('result') for t in d.get('turns',[])) else 'content_found')")"
assert "Managed Workflow 使用 app-server stdio" '\[app-server\] \[--stdio\]' "$(cat "$MOCK_CODEX_ARGS_LOG" 2>/dev/null || true)"
assert "Managed Workflow 未调用 Codex detached 参数" "not_found" "$(rg -o '\[-s\]|\[exec\]' "$MOCK_CODEX_ARGS_LOG" 2>/dev/null || echo not_found)"
wait_until 10 "get_agent_field status '$CODEX_MANAGED_AGENT'" "online" || true
assert "Managed Workflow app-server 空闲后在线" "online" "$(get_agent_field status "$CODEX_MANAGED_AGENT")"

CODEX_MANAGED_TASK=$(curl -s -X POST "$E2E_SERVER/api/tasks" -H 'Content-Type: application/json' -d "{
  \"type\":\"custom\",
  \"title\":\"Codex managed traditional task\",
  \"description\":\"Codex attached e2e task: managed traditional task\",
  \"target_agent\":\"$CODEX_MANAGED_AGENT\",
  \"metadata\":{\"delivery_mode\":\"managed\"}
}")
CODEX_MANAGED_TASK_ID=$(echo "$CODEX_MANAGED_TASK" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
wait_until 20 "curl -s '$E2E_SERVER/api/tasks/$CODEX_MANAGED_TASK_ID' | python3 -c \"import json,sys;print(json.load(sys.stdin).get('status',''))\"" "completed" || true
assert "传统 Task managed 完成" "completed" "$(curl -s "$E2E_SERVER/api/tasks/$CODEX_MANAGED_TASK_ID" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
CODEX_TASK_CONVERSATION_ID="$CODEX_MANAGED_CONVERSATION_ID"
CODEX_TASK_CONVERSATION=$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_TASK_CONVERSATION_ID")
assert "Workflow 与传统 Task 复用 conversation" "$CODEX_MANAGED_CONVERSATION_ID" "$CODEX_TASK_CONVERSATION_ID"
assert "传统 Task conversation 保持 Agent source_type" '"source_type":"agent"' "$CODEX_TASK_CONVERSATION"
assert "传统 Task turn 严格关联 task_id" "$CODEX_MANAGED_TASK_ID" "$CODEX_TASK_CONVERSATION"

CODEX_CANCEL_TASK=$(curl -s -X POST "$E2E_SERVER/api/tasks" -H 'Content-Type: application/json' -d "{
  \"type\":\"custom\",
  \"title\":\"Codex managed cancellation task\",
  \"description\":\"MAF_E2E_SLOW_TURN Codex attached e2e task: cancel managed task\",
  \"target_agent\":\"$CODEX_MANAGED_AGENT\",
  \"metadata\":{\"delivery_mode\":\"managed\"}
}")
CODEX_CANCEL_TASK_ID=$(echo "$CODEX_CANCEL_TASK" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
CODEX_CANCEL_CONVERSATION_ID="$CODEX_MANAGED_CONVERSATION_ID"
for i in $(seq 1 20); do
  CODEX_CANCEL_TURN_STATUS=$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_CANCEL_CONVERSATION_ID" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((t.get('status','') for t in reversed(d.get('turns',[])) if t.get('task_id')=='$CODEX_CANCEL_TASK_ID'),''))")
  [[ "$CODEX_CANCEL_TURN_STATUS" == "running" ]] && break
  sleep 0.1
done
assert "取消 Task 仍复用同一 Agent conversation" "$CODEX_MANAGED_CONVERSATION_ID" "$CODEX_CANCEL_CONVERSATION_ID"
CODEX_CANCEL_RESPONSE=$(curl -s -X POST "$E2E_SERVER/api/tasks/$CODEX_CANCEL_TASK_ID/cancel" -H 'Content-Type: application/json' -d '{"reason":"managed e2e cancellation"}')
assert "传统 managed Task 取消成功" '"status":"cancelled"' "$CODEX_CANCEL_RESPONSE"
wait_until 10 "curl -s '$E2E_SERVER/api/codex/conversations/$CODEX_CANCEL_CONVERSATION_ID' | python3 -c \"import json,sys;d=json.load(sys.stdin);print(next((t.get('status','') for t in reversed(d.get('turns',[])) if t.get('task_id')=='$CODEX_CANCEL_TASK_ID'),''))\"" "interrupted" || true
assert "Task cancel 映射到 turn interrupt" "interrupted" "$(curl -s "$E2E_SERVER/api/codex/conversations/$CODEX_CANCEL_CONVERSATION_ID" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((t.get('status','') for t in reversed(d.get('turns',[])) if t.get('task_id')=='$CODEX_CANCEL_TASK_ID'),''))")"
sleep 2.2
assert "取消后的迟到结果不覆盖 Task" "cancelled" "$(curl -s "$E2E_SERVER/api/tasks/$CODEX_CANCEL_TASK_ID" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")"
fi

# ============================================================
# Case 52: Agent stop/start 持久生命周期
# ============================================================
if should_run 52; then
echo -e "\n${YELLOW}Case 52: Agent stop/start 持久生命周期${NC}"

LIFECYCLE_PROJECT="/tmp/e2e-codex-lifecycle-project"
LIFECYCLE_AGENT="codex-lifecycle-e2e"
LIFECYCLE_PEER="codex-lifecycle-peer-e2e"
rm -rf "$LIFECYCLE_PROJECT"
mkdir -p "$LIFECYCLE_PROJECT"
create_codex_agent_toml "$LIFECYCLE_PROJECT" "$LIFECYCLE_AGENT" "Codex lifecycle e2e agent"
create_codex_agent_toml "$LIFECYCLE_PROJECT" "$LIFECYCLE_PEER" "Codex lifecycle isolation peer"

curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$LIFECYCLE_AGENT\",\"runtime\":\"codex\",\"directory\":\"$LIFECYCLE_PROJECT\"}" >/dev/null
curl -s -X POST "$DAEMON_URL/agents/connect" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$LIFECYCLE_PEER\",\"runtime\":\"codex\",\"directory\":\"$LIFECYCLE_PROJECT\"}" >/dev/null
wait_until 10 "get_agent_field status '$LIFECYCLE_AGENT'" "standby" || true
wait_until 10 "get_agent_field status '$LIFECYCLE_PEER'" "standby" || true
assert "生命周期 Agent 初始待启动" "standby" "$(get_agent_field status "$LIFECYCLE_AGENT")"
assert "同机 Agent 初始待启动" "standby" "$(get_agent_field status "$LIFECYCLE_PEER")"

LIFECYCLE_AGENT_ID=$(curl -s "$E2E_SERVER/api/agents?all=true" | python3 -c "import json,sys;print(next((a.get('id','') for a in json.load(sys.stdin) if a.get('agent_name')=='$LIFECYCLE_AGENT'),''))")
LIFECYCLE_CONVERSATION=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations" -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$LIFECYCLE_AGENT_ID\"}")
LIFECYCLE_CONVERSATION_ID=$(echo "$LIFECYCLE_CONVERSATION" | python3 -c "import json,sys;print(json.load(sys.stdin).get('conversation',{}).get('id',''))")
assert "生命周期 conversation 已打开" "true" "$([ -n "$LIFECYCLE_CONVERSATION_ID" ] && echo true || echo false)"
wait_until 10 "get_agent_field status '$LIFECYCLE_AGENT'" "online" || true
assert "私有 app-server 存活才显示在线" "online" "$(get_agent_field status "$LIFECYCLE_AGENT")"

LOCAL_STOP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DAEMON_URL/agents/stop" -H 'Content-Type: application/json' \
  -d "{\"agent_name\":\"$LIFECYCLE_AGENT\",\"force\":true}")
assert "local-token 不能伪造 Server lifecycle 控制" "403" "$LOCAL_STOP_CODE"

curl -s -X POST "$E2E_SERVER/api/codex/conversations/$LIFECYCLE_CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' -d '{"input":"MAF_E2E_SLOW_TURN lifecycle stop conflict"}' >/dev/null
wait_until 10 "get_agent_field status '$LIFECYCLE_AGENT'" "busy" || true
NORMAL_STOP_FILE="/tmp/maf-e2e-lifecycle-normal-stop.json"
NORMAL_STOP_CODE=$(curl -s -o "$NORMAL_STOP_FILE" -w '%{http_code}' -X POST "$E2E_SERVER/api/agents/$LIFECYCLE_AGENT_ID/stop" \
  -H 'Content-Type: application/json' -d '{"force":false,"reason":"lifecycle e2e normal stop"}')
assert "活动 turn 时普通 stop 返回冲突" "409" "$NORMAL_STOP_CODE"
assert "普通 stop 返回活动 turn 明细" "turns" "$(cat "$NORMAL_STOP_FILE")"

FORCE_STOP=$(curl -s -X POST "$E2E_SERVER/api/agents/$LIFECYCLE_AGENT_ID/stop" -H 'Content-Type: application/json' \
  -d '{"force":true,"reason":"lifecycle e2e force stop"}')
assert "明确 force 后 stop 成功" '"status":"stopped"' "$FORCE_STOP"
wait_until 10 "get_agent_field status '$LIFECYCLE_AGENT'" "stopped" || true
assert "Agent 状态持久门禁为 stopped" "stopped" "$(get_agent_field status "$LIFECYCLE_AGENT")"
assert "停止一个 Agent 不影响同机其它 Agent" "standby" "$(get_agent_field status "$LIFECYCLE_PEER")"
assert "stopped 状态落盘" "$LIFECYCLE_AGENT" "$(cat "$E2E_USER_HOME/.meta-agent-framework/state/stopped-agents.json")"
LIFECYCLE_IDENTITY=$(curl -s "$E2E_SERVER/api/agents?all=true" | python3 -c "import json,sys;d=next(a for a in json.load(sys.stdin) if a.get('id')=='$LIFECYCLE_AGENT_ID');print(d.get('user_id','')+'|'+d.get('host_user',''))")
LIFECYCLE_USER_ID=${LIFECYCLE_IDENTITY%%|*}
LIFECYCLE_HOST_USER=${LIFECYCLE_IDENTITY#*|}
curl -s -X POST "$E2E_SERVER/api/clients/heartbeat" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$LIFECYCLE_USER_ID\",\"host_user\":\"$LIFECYCLE_HOST_USER\",\"agent_statuses\":{\"$LIFECYCLE_AGENT\":\"online\"}}" >/dev/null
assert "陈旧 online 心跳不能解除 stopped" "stopped" "$(get_agent_field status "$LIFECYCLE_AGENT")"

STOPPED_CONVERSATION_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$E2E_SERVER/api/codex/conversations" \
  -H 'Content-Type: application/json' -d "{\"agent_id\":\"$LIFECYCLE_AGENT_ID\"}")
assert "stopped Agent 不能打开 conversation" "409" "$STOPPED_CONVERSATION_CODE"
STOPPED_EXECUTE=$(server_signed_fetch "$DAEMON_URL/execute" POST \
  "{\"target_agent\":\"$LIFECYCLE_AGENT\",\"runtime\":\"codex\",\"prompt\":\"must reject\"}")
assert "Daemon 拒绝 stopped Agent 新任务" "HTTP:423" "$STOPPED_EXECUTE"
STOPPED_RECONNECT_CODE=$(curl -s -o /tmp/maf-e2e-lifecycle-reconnect.json -w '%{http_code}' -X POST "$DAEMON_URL/agents/connect" \
  -H 'Content-Type: application/json' -d "{\"agent_name\":\"$LIFECYCLE_AGENT\",\"runtime\":\"codex\",\"directory\":\"$LIFECYCLE_PROJECT\"}")
assert "Plugin/Hook 重连不能解除 stopped" "423" "$STOPPED_RECONNECT_CODE"
assert "重连响应明确 stopped" '"stopped":true' "$(cat /tmp/maf-e2e-lifecycle-reconnect.json)"

LIFECYCLE_DAEMON_PID=$(curl -s "$DAEMON_URL/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('pid',''))")
kill -9 "$LIFECYCLE_DAEMON_PID" 2>/dev/null || true
wait_until 20 "curl -s '$DAEMON_URL/health'" '"ok":true' || true
wait_until 10 "get_agent_field status '$LIFECYCLE_AGENT'" "stopped" || true
assert "Daemon 重启后仍保持 stopped" "stopped" "$(get_agent_field status "$LIFECYCLE_AGENT")"

LIFECYCLE_START=$(curl -s -X POST "$E2E_SERVER/api/agents/$LIFECYCLE_AGENT_ID/start" -H 'Content-Type: application/json' \
  -d '{"reason":"lifecycle e2e start"}')
assert "start 解除 stopped 门禁" '"status":"standby"' "$LIFECYCLE_START"
wait_until 10 "get_agent_field status '$LIFECYCLE_AGENT'" "standby" || true
assert "start 不伪报在线" "standby" "$(get_agent_field status "$LIFECYCLE_AGENT")"

LIFECYCLE_REOPEN=$(curl -s -X POST "$E2E_SERVER/api/codex/conversations" -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$LIFECYCLE_AGENT_ID\"}")
assert "start 后可恢复远端 conversation" "$LIFECYCLE_CONVERSATION_ID" "$LIFECYCLE_REOPEN"
wait_until 10 "get_agent_field status '$LIFECYCLE_AGENT'" "online" || true
assert "执行器重新存活后才恢复 online" "online" "$(get_agent_field status "$LIFECYCLE_AGENT")"
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
