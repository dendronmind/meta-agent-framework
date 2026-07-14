#!/usr/bin/env bash
#
# Meta-Agent Framework Client 卸载
#
# 用法：
#   source <(curl -fsSL http://<server>:3000/uninstall.sh)
#   或本地执行：bash uninstall.sh
#

set -uo pipefail

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Meta-Agent Framework 卸载           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ---- 停止后台进程 ----
echo "🔧 停止后台进程..."
pkill -f "MAF_Node_Daemon" 2>/dev/null && echo "  ✅ 停止 Node Daemon" || echo "  - Node Daemon 未运行"
pkill -f "MAF_Client_Daemon" 2>/dev/null && echo "  ✅ 停止旧版 Daemon" || true
pkill -f "maf-agent.mjs" 2>/dev/null && echo "  ✅ 停止 Claude Code hooks" || true
pkill -f "maf-codex-attached-receiver.mjs" 2>/dev/null && echo "  ✅ 停止 Codex receiver" || true

# ---- 卸载 opencode Plugin ----
OC_PLUGIN_DIR="${HOME}/.config/opencode/plugins/opencode-plugin-meta-agent-framework"
OC_ENTRY="${HOME}/.config/opencode/plugins/meta-agent-framework.js"
if [ -d "$OC_PLUGIN_DIR" ] || [ -f "$OC_ENTRY" ]; then
  echo ""
  echo "🗑  卸载 opencode Plugin..."
  rm -rf "$OC_PLUGIN_DIR" && echo "  ✅ 删除 Plugin 目录"
  rm -f "$OC_ENTRY" && echo "  ✅ 删除入口文件"
fi

# ---- 卸载 Claude Code Plugin ----
if command -v claude &>/dev/null; then
  echo ""
  echo "🗑  卸载 Claude Code Plugin..."
  if claude plugins list 2>/dev/null | grep -q "maf"; then
    claude plugins uninstall maf 2>/dev/null && echo "  ✅ 卸载 maf plugin" || echo "  ⚠ 卸载 maf plugin 失败"
  fi
  if claude plugins marketplace list 2>/dev/null | grep -q "maf-plugins"; then
    claude plugins marketplace remove maf-plugins 2>/dev/null && echo "  ✅ 移除 marketplace" || echo "  ⚠ 移除 marketplace 失败"
  fi
fi

# ---- 清理本地 marketplace 缓存 ----
CC_MARKETPLACE="${HOME}/.meta-agent-framework/claude-plugin"
if [ -d "$CC_MARKETPLACE" ]; then
  rm -rf "$CC_MARKETPLACE" && echo "  ✅ 清理 marketplace 缓存"
fi

# ---- 卸载 Codex Plugin ----
CODEX_PLUGIN_DIR="${HOME}/plugins/maf"
CODEX_WRAPPER="${HOME}/.local/bin/codex"
if command -v codex &>/dev/null; then
  echo ""
  echo "🗑  卸载 Codex Plugin..."
  codex plugin remove maf@personal 2>/dev/null && echo "  ✅ 卸载 maf@personal" || true
fi
if [ -d "$CODEX_PLUGIN_DIR" ]; then
  rm -rf "$CODEX_PLUGIN_DIR" && echo "  ✅ 删除 Codex plugin source"
fi
if [ -f "$CODEX_WRAPPER" ] && grep -q "Meta-Agent Framework Codex launcher wrapper" "$CODEX_WRAPPER" 2>/dev/null; then
  rm -f "$CODEX_WRAPPER" && echo "  ✅ 删除 Codex launcher wrapper"
fi

# ---- 清理状态文件 ----
echo ""
echo "🗑  清理状态文件..."
STATE_DIR="${HOME}/.meta-agent-framework"
rm -f "${STATE_DIR}"/daemon-port* 2>/dev/null
rm -f "${STATE_DIR}"/daemon-instances.json 2>/dev/null
rm -f "${STATE_DIR}"/session-*.json 2>/dev/null
rm -f "${STATE_DIR}"/last-instance.json 2>/dev/null
rm -f "${STATE_DIR}"/codex-attached-receiver-*.pid 2>/dev/null
rm -f "${STATE_DIR}"/codex-attached-receiver-*.json 2>/dev/null
rm -f "${STATE_DIR}"/state/codex-app-server-*.json 2>/dev/null
echo "  ✅ 端口文件和会话文件已清理"
echo "  ℹ  日志文件保留在 ${STATE_DIR}/ （可手动删除）"

# ---- 清理 .bashrc ----
BASHRC="${HOME}/.bashrc"
if grep -q "META_AGENT_SERVER\|MAF_NODE_PORT\|# Meta-Agent Framework\|alias opencode=" "${BASHRC}" 2>/dev/null; then
  echo ""
  echo "🗑  清理 ~/.bashrc..."
  sed -i '/# Meta-Agent Framework/d' "${BASHRC}"
  sed -i '/META_AGENT_SERVER/d' "${BASHRC}"
  sed -i '/MAF_NODE_PORT/d' "${BASHRC}"
  sed -i "/alias opencode='opencode --hostname localhost'/d" "${BASHRC}"
  echo "  ✅ 已移除 META_AGENT_SERVER / MAF_NODE_PORT / opencode alias"
fi

unset META_AGENT_SERVER MAF_NODE_PORT 2>/dev/null || true
unalias opencode 2>/dev/null || true

echo ""
echo "══════════════════════════════════════"
echo "  ✅ 卸载完成!"
echo "══════════════════════════════════════"
echo ""
