#!/usr/bin/env bash
#
# 同步 Plugin 源文件到 Client npm 包目录
# 改完 packages/server/plugins/ 下的源码后运行此脚本
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SRC="$SCRIPT_DIR/packages/server/plugins"
DST="$SCRIPT_DIR/packages/client"

echo "同步 Plugin 源文件到 Client 包..."

# runtime-neutral daemon
mkdir -p "$DST/daemon"
cp "$SRC/node-daemon/daemon.mjs" "$DST/daemon/"
# opencode
cp "$SRC/opencode-plugin-meta-agent-framework/index.js" "$DST/opencode/"
cp "$SRC/opencode-plugin-meta-agent-framework/package.json" "$DST/opencode/"

# claude-code
cp -r "$SRC/claude-code-plugin-maf/.claude-plugin" "$DST/claude-code/"
cp -r "$SRC/claude-code-plugin-maf/hooks" "$DST/claude-code/"
cp -r "$SRC/claude-code-plugin-maf/scripts" "$DST/claude-code/"

# codex
rm -rf "$DST/codex"
cp -r "$SRC/codex" "$DST/codex"

echo "✅ 同步完成"
