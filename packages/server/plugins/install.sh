#!/usr/bin/env bash
#
# Meta-Agent Framework Client 一键安装 (v0.4.0 — Node Daemon)
#
# 自动检测 opencode / Claude Code / Codex，安装对应的 Plugin。
# 此脚本由 Server 动态注入地址，远端直接执行：
#   source <(curl -fsSL http://<server>:3000/install.sh)
#

set -uo pipefail

SERVER="__SERVER_URL__"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Meta-Agent Framework 安装           ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Server: ${SERVER}"
echo ""

# 检查 Server 地址是否已注入
if echo "$SERVER" | grep -q '__SERVER'; then
  echo "❌ 请从 Server 下载此脚本："
  echo "   source <(curl -fsSL http://<server-ip>:3000/install.sh)"
  return 1 2>/dev/null || exit 1
fi

# ---- 检测运行时 ----
HAS_OPENCODE=false
HAS_CLAUDE=false
HAS_CODEX=false
command -v opencode &>/dev/null && HAS_OPENCODE=true
command -v claude &>/dev/null && HAS_CLAUDE=true
command -v codex &>/dev/null && HAS_CODEX=true

if ! $HAS_OPENCODE && ! $HAS_CLAUDE && ! $HAS_CODEX; then
  echo "❌ 未检测到 opencode、Claude Code 或 Codex"
  echo "   安装 opencode:    curl -fsSL https://opencode.ai/install | bash"
  echo "   安装 Claude Code: npm install -g @anthropic-ai/claude-code"
  echo "   安装 Codex:       npm install -g @openai/codex"
  return 1 2>/dev/null || exit 1
fi

echo "  检测到运行时:"
$HAS_OPENCODE && echo "    ✅ opencode $(opencode --version 2>/dev/null || echo '')"
$HAS_CLAUDE && echo "    ✅ Claude Code $(claude --version 2>/dev/null || echo '')"
$HAS_CODEX && echo "    ✅ Codex $(codex --version 2>/dev/null || echo '')"
echo ""

# ---- 安装 runtime-neutral Node Daemon ----
echo "📥 安装 Node Daemon..."
MAF_HOME="${HOME}/.meta-agent-framework"
mkdir -p "${MAF_HOME}"
if curl -fsSL "${SERVER}/plugins/daemon.mjs" -o "${MAF_HOME}/daemon.mjs"; then
  echo "  ✅ daemon.mjs → ~/.meta-agent-framework/"
else
  echo "  ❌ daemon.mjs 下载失败（Node Daemon 将无法拉起）"
  return 1 2>/dev/null || exit 1
fi

# ---- 安装 opencode Plugin ----
if $HAS_OPENCODE; then
  echo "📥 安装 opencode Plugin..."
  PLUGIN_NAME="opencode-plugin-meta-agent-framework"
  PLUGIN_DIR="${HOME}/.config/opencode/plugins/${PLUGIN_NAME}"
  ENTRY_FILE="${HOME}/.config/opencode/plugins/meta-agent-framework.js"

  mkdir -p "${PLUGIN_DIR}"
  for f in index.js package.json; do
    if curl -fsSL "${SERVER}/plugins/${f}" -o "${PLUGIN_DIR}/${f}"; then
      echo "  ✅ ${f}"
    else
      echo "  ❌ ${f} 下载失败"
      return 1 2>/dev/null || exit 1
    fi
  done

  cat > "${ENTRY_FILE}" << 'EOF'
export { MetaAgentBridge as server } from "./opencode-plugin-meta-agent-framework/index.js";
EOF
  echo "  ✅ 入口文件"

  # opencode alias
  BASHRC="${HOME}/.bashrc"
  if ! grep -q "alias opencode=" "${BASHRC}" 2>/dev/null; then
    echo "alias opencode='opencode --hostname localhost'" >> "${BASHRC}"
    echo "  ✅ opencode alias 已写入 ~/.bashrc"
  fi
  alias opencode='opencode --hostname localhost' 2>/dev/null || true
  echo ""
fi

# ---- 安装 Claude Code Plugin ----
if $HAS_CLAUDE; then
  echo "📥 安装 Claude Code Plugin..."

  # 注册本地 marketplace（如果还没注册）
  MARKETPLACE_DIR="${HOME}/.meta-agent-framework/claude-plugin"
  MARKETPLACE_JSON="${MARKETPLACE_DIR}/.claude-plugin/marketplace.json"
  PLUGIN_SRC_DIR="${MARKETPLACE_DIR}/claude-code-plugin-maf"

  mkdir -p "${MARKETPLACE_DIR}/.claude-plugin"
  mkdir -p "${PLUGIN_SRC_DIR}/.claude-plugin"
  mkdir -p "${PLUGIN_SRC_DIR}/hooks"
  mkdir -p "${PLUGIN_SRC_DIR}/scripts"

  # 下载 Plugin 文件（3 个核心文件）
  for f in .claude-plugin/plugin.json hooks/hooks.json scripts/maf-agent.mjs; do
    if curl -fsSL "${SERVER}/cc-plugins/${f}" -o "${PLUGIN_SRC_DIR}/${f}"; then
      echo "  ✅ ${f}"
    else
      echo "  ❌ ${f} 下载失败"
      return 1 2>/dev/null || exit 1
    fi
  done

  # 写 marketplace.json
  cat > "${MARKETPLACE_JSON}" << 'MEOF'
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "maf-plugins",
  "description": "Meta-Agent Framework plugins",
  "owner": { "name": "Meta-Agent-Framework" },
  "plugins": [
    {
      "name": "maf",
      "description": "Meta-Agent Framework — 接入分布式 Agent 网络",
      "category": "productivity",
      "source": "./claude-code-plugin-maf"
    }
  ]
}
MEOF

  # 注册 marketplace + 安装 plugin
  if claude plugins marketplace list 2>/dev/null | grep -q "maf-plugins"; then
    echo "  ✅ marketplace 已注册"
  else
    claude plugins marketplace add "${MARKETPLACE_DIR}" --scope user 2>/dev/null && echo "  ✅ marketplace 已注册" || echo "  ⚠ marketplace 注册失败"
  fi

  if claude plugins list 2>/dev/null | grep -q "maf"; then
    echo "  ✅ plugin 已安装"
    # 更新到最新
    claude plugins update maf 2>/dev/null && echo "  ✅ plugin 已更新" || true
  else
    claude plugins install maf 2>/dev/null && echo "  ✅ plugin 已安装" || echo "  ⚠ plugin 安装失败"
  fi
  echo ""
fi

# ---- 安装 Codex Plugin ----
if $HAS_CODEX; then
  if command -v node &>/dev/null; then
    CODEX_INSTALLER="$(mktemp -t maf-codex-install.XXXXXX.mjs)"
    if curl -fsSL "${SERVER}/codex-install.mjs" -o "${CODEX_INSTALLER}"; then
      MAF_INSTALL_SERVER="${SERVER}" node "${CODEX_INSTALLER}" "${SERVER}" || echo "  ⚠ Codex plugin 安装失败"
      rm -f "${CODEX_INSTALLER}" 2>/dev/null || true
    else
      echo "  ⚠ Codex installer 下载失败"
    fi
  else
    echo "  ⚠ 未检测到 node，跳过 Codex plugin（Node Daemon/Codex hook 需要 Node.js）"
  fi
fi

# ---- 配置环境变量 ----
BASHRC="${HOME}/.bashrc"
if ! grep -q "META_AGENT_SERVER" "${BASHRC}" 2>/dev/null; then
  echo "" >> "${BASHRC}"
  echo "# Meta-Agent Framework" >> "${BASHRC}"
  echo "export META_AGENT_SERVER=${SERVER}" >> "${BASHRC}"
  echo "  ✅ META_AGENT_SERVER 已写入 ~/.bashrc"
else
  echo "  ✅ META_AGENT_SERVER 已配置"
fi
export META_AGENT_SERVER="${SERVER}"

# Node Daemon 端口（默认 4100，多实例部署时可改）
if ! grep -q "MAF_NODE_PORT" "${BASHRC}" 2>/dev/null; then
  echo "export MAF_NODE_PORT=4100" >> "${BASHRC}"
  echo "  ✅ MAF_NODE_PORT=4100 已写入 ~/.bashrc"
else
  echo "  ✅ MAF_NODE_PORT 已配置"
fi
export MAF_NODE_PORT="${MAF_NODE_PORT:-4100}"

echo ""
echo "══════════════════════════════════════"
echo "  ✅ 安装完成!"
echo "══════════════════════════════════════"
echo ""
echo "  架构: Node Daemon (固定端口 ${MAF_NODE_PORT:-4100}, 机器级别常驻)"
echo ""
echo "  下一步:"
$HAS_OPENCODE && echo "  [opencode] cd 项目目录 → 创建 .opencode/agents/<name>.md → opencode"
$HAS_CLAUDE && echo "  [claude]   cd 项目目录 → 创建 .claude/agents/<name>.md → claude"
$HAS_CODEX && echo "  [codex]    cd 项目目录 → 可创建 .codex/agents/<name>.toml；否则使用项目目录名 → codex"
echo ""
echo "  Agent 启动后自动拉起 Node Daemon → 注册到 Server: ${SERVER}"
echo ""
