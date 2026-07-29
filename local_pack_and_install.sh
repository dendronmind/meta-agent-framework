#!/usr/bin/env bash
# Local pack + reinstall helper for Meta-Agent-Framework.
#
# What it does:
#   1. Pack @maf/meta-agent-server and @maf/meta-agent-client into ./out
#   2. Stop/uninstall old global installs
#   3. Install the freshly generated local tgz packages
#   4. Run maf-client install --auto to refresh daemon/plugins/wrappers
#
# Usage:
#   bash local_pack_and_install.sh
#
# Optional env:
#   OUT_DIR=/path/to/out        Override package output directory (default: ./out)
#   NPM_CONFIG_CACHE=/tmp/cache Override npm cache (default: /tmp/npm-cache)
#   SKIP_UNINSTALL=1            Do not uninstall existing global packages first
#   SKIP_INSTALL=1              Only pack, do not install
#   SKIP_E2E=0                  Run npm run test:e2e before packing (default: skip)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/out}"
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/npm-cache}"
export npm_config_cache="$NPM_CONFIG_CACHE"

SERVER_DIR="$ROOT_DIR/packages/server"
CLIENT_DIR="$ROOT_DIR/packages/client"

echo "╔════════════════════════════════════════════╗"
echo "║  MAF local pack + reinstall               ║"
echo "╚════════════════════════════════════════════╝"
echo "ROOT_DIR: $ROOT_DIR"
echo "OUT_DIR:  $OUT_DIR"
echo "npm cache: $NPM_CONFIG_CACHE"
echo ""

mkdir -p "$OUT_DIR" "$NPM_CONFIG_CACHE"

cd "$ROOT_DIR"

if [[ "${SKIP_E2E:-1}" == "0" ]]; then
  echo "▶ Running e2e before packaging..."
  npm run test:e2e
  echo ""
fi

echo "▶ Syncing runtime files into client package..."
bash "$ROOT_DIR/scripts/sync-client-pkg.sh"
echo ""

echo "▶ Cleaning old local tgz packages in $OUT_DIR..."
rm -f "$OUT_DIR"/maf-meta-agent-server-*.tgz
rm -f "$OUT_DIR"/maf-meta-agent-client-*.tgz
echo ""

echo "▶ Packing server..."
cd "$ROOT_DIR"
node "$ROOT_DIR/scripts/pack-package.mjs" server --pack-destination "$OUT_DIR"
SERVER_TGZ="$(ls -t "$OUT_DIR"/maf-meta-agent-server-*.tgz | head -n 1)"
if [[ -z "${SERVER_TGZ:-}" || ! -f "$SERVER_TGZ" ]]; then
  echo "❌ Server package was not generated" >&2
  exit 1
fi
echo "  server package: $SERVER_TGZ"
echo ""

echo "▶ Packing client..."
cd "$ROOT_DIR"
node "$ROOT_DIR/scripts/pack-package.mjs" client --pack-destination "$OUT_DIR"
CLIENT_TGZ="$(ls -t "$OUT_DIR"/maf-meta-agent-client-*.tgz | head -n 1)"
if [[ -z "${CLIENT_TGZ:-}" || ! -f "$CLIENT_TGZ" ]]; then
  echo "❌ Client package was not generated" >&2
  exit 1
fi
echo "  client package: $CLIENT_TGZ"
echo ""

if [[ "${SKIP_INSTALL:-0}" == "1" ]]; then
  echo "✅ Pack only complete. Generated packages:"
  ls -lh "$SERVER_TGZ" "$CLIENT_TGZ"
  exit 0
fi

if [[ "${SKIP_UNINSTALL:-0}" != "1" ]]; then
  echo "▶ Stopping existing MAF server if present..."
  if command -v maf-server >/dev/null 2>&1; then
    maf-server stop || true
  else
    echo "  maf-server not found, skip stop"
  fi
  echo ""

  echo "▶ Uninstalling existing MAF client plugins/wrappers if present..."
  if command -v maf-client >/dev/null 2>&1; then
    # maf-client uninstall also removes the old daemon/plugins/wrappers and npm package.
    maf-client uninstall || true
  else
    echo "  maf-client not found, skip maf-client uninstall"
  fi
  echo ""

  echo "▶ Removing old global npm packages if present..."
  npm uninstall -g @maf/meta-agent-server @maf/meta-agent-client || true
  echo ""
else
  echo "▶ SKIP_UNINSTALL=1, keeping existing global installs before npm install"
  echo ""
fi

echo "▶ Installing server package..."
npm install -g "$SERVER_TGZ"
echo ""

echo "▶ Installing client package..."
npm install -g "$CLIENT_TGZ"
echo ""

echo "▶ Refreshing client runtime installation..."
maf-client install --auto
echo ""

echo "✅ Local pack + reinstall complete"
echo ""
echo "Generated packages:"
ls -lh "$SERVER_TGZ" "$CLIENT_TGZ"
echo ""
echo "Quick checks:"
command -v maf-server || true
command -v maf-client || true
command -v codex || true
