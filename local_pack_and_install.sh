#!/usr/bin/env bash
# Local pack + reinstall helper for Meta-Agent-Framework.
#
# What it does:
#   1. Pack @maf/meta-agent-server and @maf/meta-agent-client into ./out
#   2. Back up critical runtime state and stop old processes
#   3. Install the freshly generated local tgz packages
#   4. Run maf-client install --auto to refresh daemon/plugins/wrappers
#
# Usage:
#   bash local_pack_and_install.sh
#
# Optional env:
#   OUT_DIR=/path/to/out        Override package output directory (default: ./out)
#   NPM_CONFIG_CACHE=/tmp/cache Override npm cache (default: /tmp/npm-cache)
#   RUNTIME_BACKUP_DIR=/path    Runtime backup root (default: ~/.meta-agent-framework-backups)
#   SKIP_INSTALL=1              Only pack, do not install
#   SKIP_E2E=0                  Run npm run test:e2e before packing (default: skip)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/out}"
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/npm-cache}"
export npm_config_cache="$NPM_CONFIG_CACHE"

SERVER_DIR="$ROOT_DIR/packages/server"
CLIENT_DIR="$ROOT_DIR/packages/client"
RUNTIME_BACKUP_DIR="${RUNTIME_BACKUP_DIR:-$HOME/.meta-agent-framework-backups}"

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

echo "▶ Backing up critical MAF runtime state..."
BACKUP_STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="$RUNTIME_BACKUP_DIR/$BACKUP_STAMP"
mkdir -p "$BACKUP_PATH"
for item in data/maf.db maf.config.json auth state/agent-inventory.json; do
  if [[ -e "$HOME/.meta-agent-framework/$item" ]]; then
    mkdir -p "$BACKUP_PATH/$(dirname "$item")"
    cp -a "$HOME/.meta-agent-framework/$item" "$BACKUP_PATH/$item"
  fi
done
echo "  runtime backup: $BACKUP_PATH"
echo ""

echo "▶ Stopping existing MAF processes without deleting runtime data..."
if command -v maf-server >/dev/null 2>&1; then
  maf-server stop || true
fi
pkill -f "MAF_Node_Daemon" 2>/dev/null || true
echo ""

echo "▶ Installing server package..."
npm install -g --force "$SERVER_TGZ"
echo ""

echo "▶ Installing client package..."
npm install -g --force "$CLIENT_TGZ"
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
