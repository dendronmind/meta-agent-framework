#!/usr/bin/env bash
#
# 校验 packages/client 中的分发副本是否与 packages/server/plugins 源一致。
# 这些文件不能改成 symlink，因为 client npm 包必须是自包含的真实文件。
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$PROJECT_ROOT/packages/server/plugins"
DST="$PROJECT_ROOT/packages/client"

FAILURES=0

ok() {
  echo "  ✅ $*"
}

bad() {
  echo "  ❌ $*" >&2
  FAILURES=$((FAILURES + 1))
}

check_file() {
  local label="$1"
  local src="$2"
  local dst="$3"

  if [[ ! -f "$src" ]]; then
    bad "$label: source missing: ${src#$PROJECT_ROOT/}"
    return
  fi
  if [[ ! -f "$dst" ]]; then
    bad "$label: client copy missing: ${dst#$PROJECT_ROOT/}"
    return
  fi
  if cmp -s "$src" "$dst"; then
    ok "$label"
    return
  fi

  bad "$label: differs"
  diff -u "$src" "$dst" | sed 's/^/    /' >&2 || true
}

check_dir() {
  local label="$1"
  local src="$2"
  local dst="$3"

  if [[ ! -d "$src" ]]; then
    bad "$label: source missing: ${src#$PROJECT_ROOT/}"
    return
  fi
  if [[ ! -d "$dst" ]]; then
    bad "$label: client copy missing: ${dst#$PROJECT_ROOT/}"
    return
  fi

  local diff_output
  diff_output="$(diff -qr "$src" "$dst" 2>&1 || true)"
  if [[ -z "$diff_output" ]]; then
    ok "$label"
    return
  fi

  bad "$label: differs"
  echo "$diff_output" | sed 's/^/    /' >&2
}

echo "校验 Client 分发副本与 Server plugin 源..."

check_file "daemon/daemon.mjs" \
  "$SRC/node-daemon/daemon.mjs" \
  "$DST/daemon/daemon.mjs"

check_file "opencode/index.js" \
  "$SRC/opencode-plugin-meta-agent-framework/index.js" \
  "$DST/opencode/index.js"

check_file "opencode/package.json" \
  "$SRC/opencode-plugin-meta-agent-framework/package.json" \
  "$DST/opencode/package.json"

check_dir "claude-code/.claude-plugin" \
  "$SRC/claude-code-plugin-maf/.claude-plugin" \
  "$DST/claude-code/.claude-plugin"

check_dir "claude-code/hooks" \
  "$SRC/claude-code-plugin-maf/hooks" \
  "$DST/claude-code/hooks"

check_dir "claude-code/scripts" \
  "$SRC/claude-code-plugin-maf/scripts" \
  "$DST/claude-code/scripts"

check_dir "codex" \
  "$SRC/codex" \
  "$DST/codex"

if [[ "$FAILURES" -ne 0 ]]; then
  echo "" >&2
  echo "Client 分发副本不一致，请先运行: bash scripts/sync-client-pkg.sh" >&2
  exit 1
fi

echo "✅ Client 分发副本已同步"
