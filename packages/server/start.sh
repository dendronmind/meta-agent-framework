#!/usr/bin/env bash
#
# Meta-Agent-Server 一键启动（兼容旧方式）
#
# 实际由 bin/maf-server.mjs 管理。
# 此脚本是 npm start 的入口，等效于 maf-server start + 进入 TUI。
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 确保依赖
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  echo "[Meta-Agent] 首次运行，安装依赖..."
  npm install --prefix "$SCRIPT_DIR"
fi

# 启动 Server（通过 CLI，幂等）；CLI 会同步 agent 资产到 MAF_HOME，
# 并在 MAF_HOME 中启动所选 runtime 的 Meta-Agent-Server TUI。
node "$SCRIPT_DIR/bin/maf-server.mjs" start
