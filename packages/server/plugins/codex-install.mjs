#!/usr/bin/env node
/**
 * Server-served Codex client installer.
 *
 * install.sh downloads and runs this script when Codex is available on the
 * target machine. It mirrors packages/client/bin/maf-install.mjs Codex setup,
 * but fetches plugin assets from the current MAF Server instead of a local npm
 * package install.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync, execSync } from "node:child_process";

const SERVER = String(process.argv[2] || process.env.MAF_INSTALL_SERVER || "").replace(/\/+$/, "");
const HOME = homedir();
const BASHRC = join(HOME, ".bashrc");
const CODEX_PLUGIN_NAME = "maf";
const CODEX_PLUGIN_SOURCE_DIR = join(HOME, "plugins", CODEX_PLUGIN_NAME);
const CODEX_MARKETPLACE_JSON = join(HOME, ".agents", "plugins", "marketplace.json");
const CODEX_WRAPPER = join(HOME, ".local", "bin", "codex");

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }

function hasCommand(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; }
}

function bashrcHas(pattern) {
  try { return readFileSync(BASHRC, "utf-8").includes(pattern); } catch { return false; }
}

function bashrcAppend(line) {
  try { writeFileSync(BASHRC, `${existsSync(BASHRC) ? readFileSync(BASHRC, "utf-8") : ""}${line}\n`); } catch {}
}

function download(relPath, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  const url = `${SERVER}/codex-plugins/${relPath}`;
  execFileSync("curl", ["-fsSL", url, "-o", dst], { stdio: "pipe" });
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function codexPluginVersion(base = "0.0.0") {
  const cleanBase = String(base || "0.0.0").split("+")[0] || "0.0.0";
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${cleanBase}+server-${stamp}`;
}

function writeCodexPluginManifestVersion(pluginDir) {
  const manifestPath = join(pluginDir, ".codex-plugin", "plugin.json");
  try {
    const manifest = safeJson(readFileSync(manifestPath, "utf-8"), null);
    if (!manifest) return;
    manifest.version = codexPluginVersion(manifest.version);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch (err) {
    warn(`Codex plugin manifest 版本更新失败: ${err.message}`);
  }
}

function upsertCodexMarketplace() {
  mkdirSync(dirname(CODEX_MARKETPLACE_JSON), { recursive: true });
  let marketplace = null;
  if (existsSync(CODEX_MARKETPLACE_JSON)) {
    try { marketplace = JSON.parse(readFileSync(CODEX_MARKETPLACE_JSON, "utf-8")); }
    catch (err) {
      const backup = `${CODEX_MARKETPLACE_JSON}.bak.${Date.now()}`;
      try { execFileSync("cp", [CODEX_MARKETPLACE_JSON, backup]); warn(`旧 marketplace.json 解析失败，已备份: ${backup}`); } catch {}
    }
  }
  if (!marketplace || typeof marketplace !== "object") {
    marketplace = {
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [],
    };
  }
  marketplace.name = marketplace.name || "personal";
  marketplace.interface = marketplace.interface || { displayName: "Personal" };
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];

  const entry = {
    name: CODEX_PLUGIN_NAME,
    source: { source: "local", path: `./plugins/${CODEX_PLUGIN_NAME}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
  const idx = marketplace.plugins.findIndex(p => p && p.name === CODEX_PLUGIN_NAME);
  if (idx >= 0) marketplace.plugins[idx] = { ...marketplace.plugins[idx], ...entry };
  else marketplace.plugins.push(entry);

  writeFileSync(CODEX_MARKETPLACE_JSON, JSON.stringify(marketplace, null, 2) + "\n");
  return marketplace.name;
}

function findRealCodexBin() {
  const candidates = [];
  try {
    const out = execSync("which -a codex 2>/dev/null", { encoding: "utf-8" });
    candidates.push(...out.split("\n").map(s => s.trim()).filter(Boolean));
  } catch {}
  return candidates.find(path => path && path !== CODEX_WRAPPER && existsSync(path)) || "";
}

function installCodexWrapper() {
  if (!hasCommand("codex")) return;
  const realCodex = findRealCodexBin();
  if (!realCodex) {
    warn("未找到真实 codex 可执行文件，跳过 Codex wrapper");
    return;
  }

  mkdirSync(dirname(CODEX_WRAPPER), { recursive: true });
  const wrapper = `#!/usr/bin/env bash
# Meta-Agent Framework Codex launcher wrapper.
# Auto-starts/connects the local MAF Node Daemon before launching real Codex.
set -euo pipefail
REAL_CODEX=${JSON.stringify(realCodex)}
HOOK="$HOME/plugins/maf/scripts/maf-codex-hook.mjs"
APP_SERVER_HELPER="$HOME/plugins/maf/scripts/maf-codex-app-server.mjs"
LOG="$HOME/.meta-agent-framework/logs/codex-plugin.log"
mkdir -p "$HOME/.meta-agent-framework/logs" 2>/dev/null || true

first_non_option=""
skip_next=0
for arg in "$@"; do
  if [[ $skip_next -eq 1 ]]; then skip_next=0; continue; fi
  case "$arg" in
    -c|--config|-i|--image|-m|--model|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval|--remote|--remote-auth-token-env)
      skip_next=1
      continue
      ;;
    --*) continue ;;
    -*) continue ;;
    *) first_non_option="$arg"; break ;;
  esac
done

case "$first_non_option" in
  exec|e|review|apply|a|plugin|mcp|login|logout|completion|update|doctor|debug|features|sandbox|app-server|remote-control|mcp-server|exec-server|cloud|help|archive|delete|unarchive)
    exec "$REAL_CODEX" "$@"
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    -h|--help|-V|--version)
      exec "$REAL_CODEX" "$@"
      ;;
  esac
done

maf_exec_args=("$@")
maf_hook_cwd="$PWD"
maf_remote="\${MAF_CODEX_APP_SERVER_URL:-}"
maf_has_remote_arg=0
maf_session_pid="$$"
maf_cleanup_enabled=0
maf_cleanup_done=0
maf_spawn_app_server_cleanup() {
  if [[ -z "$maf_remote" || ! -f "$APP_SERVER_HELPER" ]]; then
    return 0
  fi
  printf '%s [codex-wrapper] spawn app-server cleanup cwd=%s hook_cwd=%s remote=%s\n' "$(date -Is)" "$PWD" "$maf_hook_cwd" "$maf_remote" >> "$LOG"
  if command -v setsid >/dev/null 2>&1; then
    MAF_CODEX_WRAPPER_ACTIVE=1 CODEX_CWD="$maf_hook_cwd" MAF_CODEX_APP_SERVER_URL="$maf_remote" MAF_CODEX_SESSION_PID="$maf_session_pid" setsid node "$APP_SERVER_HELPER" --cleanup </dev/null >/dev/null 2>>"$LOG" &
  else
    (
      trap '' INT TERM HUP
      MAF_CODEX_WRAPPER_ACTIVE=1 CODEX_CWD="$maf_hook_cwd" MAF_CODEX_APP_SERVER_URL="$maf_remote" MAF_CODEX_SESSION_PID="$maf_session_pid" node "$APP_SERVER_HELPER" --cleanup </dev/null >/dev/null 2>>"$LOG"
    ) &
  fi
  maf_cleanup_pid=$!
  disown "$maf_cleanup_pid" 2>/dev/null || true
  printf '%s [codex-wrapper] app-server cleanup pid=%s remote=%s\n' "$(date -Is)" "$maf_cleanup_pid" "$maf_remote" >> "$LOG"
}
maf_cleanup() {
  if [[ "$maf_cleanup_enabled" != "1" || "$maf_cleanup_done" == "1" ]]; then
    return 0
  fi
  maf_cleanup_done=1
  # Once cleanup starts, do not let repeated Ctrl-C/TERM/HUP kill the cleanup
  # hook itself.  Children inherit ignored signals, so the hook can still
  # disconnect the receiver and stop the owned app-server.
  trap '' INT TERM HUP
  trap - EXIT
  maf_spawn_app_server_cleanup
  if [[ ! -f "$HOOK" ]]; then
    return 0
  fi
  {
    printf '%s [codex-wrapper] cleanup cwd=%s hook_cwd=%s remote=%s\n' "$(date -Is)" "$PWD" "$maf_hook_cwd" "$maf_remote" >> "$LOG"
    MAF_CODEX_WRAPPER_ACTIVE=1 CODEX_CWD="$maf_hook_cwd" MAF_CODEX_APP_SERVER_URL="$maf_remote" MAF_CODEX_SESSION_PID="$maf_session_pid" node "$HOOK" <<JSON
{"cwd":"$maf_hook_cwd","launchCwd":"$PWD","eventName":"WrapperEnd","remote":"$maf_remote","sessionPid":$maf_session_pid}
JSON
  } >/dev/null 2>>"$LOG" || true
}
trap 'maf_status=130; maf_cleanup; exit "$maf_status"' INT
trap 'maf_status=129; maf_cleanup; exit "$maf_status"' HUP
trap 'maf_status=143; maf_cleanup; exit "$maf_status"' TERM
trap 'maf_status=$?; maf_cleanup; exit "$maf_status"' EXIT

if [[ "\${MAF_CODEX_WRAPPER_DISABLE:-}" != "1" && "\${MAF_CODEX_WRAPPER_ACTIVE:-}" != "1" && -f "$HOOK" ]]; then
  maf_args=("$@")
  for ((i=0; i<\${#maf_args[@]}; i++)); do
    case "\${maf_args[$i]}" in
      -C|--cd)
        if (( i + 1 < \${#maf_args[@]} )); then maf_hook_cwd="\${maf_args[$((i + 1))]}"; fi
        ;;
      -C=*|--cd=*)
        maf_hook_cwd="\${maf_args[$i]#*=}"
        ;;
      --remote)
        maf_has_remote_arg=1
        if (( i + 1 < \${#maf_args[@]} )); then maf_remote="\${maf_args[$((i + 1))]}"; fi
        ;;
      --remote=*)
        maf_has_remote_arg=1
        maf_remote="\${maf_args[$i]#*=}"
        ;;
    esac
  done
  if [[ "$maf_hook_cwd" != /* ]]; then
    maf_hook_cwd="$(cd "$maf_hook_cwd" 2>/dev/null && pwd -P || printf '%s/%s' "$PWD" "$maf_hook_cwd")"
  fi
  {
    if [[ -z "$maf_remote" && -f "$APP_SERVER_HELPER" ]]; then
      maf_auto_remote="$(MAF_CODEX_REAL_BIN="$REAL_CODEX" CODEX_CWD="$maf_hook_cwd" MAF_CODEX_SESSION_PID="$maf_session_pid" node "$APP_SERVER_HELPER" --real "$REAL_CODEX" --cwd "$maf_hook_cwd" -- "$@" 2>>"$LOG" || true)"
      if [[ -n "$maf_auto_remote" ]]; then
        maf_remote="$maf_auto_remote"
        printf '%s [codex-wrapper] auto remote url=%s cwd=%s\n' "$(date -Is)" "$maf_remote" "$maf_hook_cwd" >> "$LOG"
      fi
    fi
    if [[ -n "$maf_remote" && "$maf_has_remote_arg" != "1" ]]; then
      maf_exec_args=("--remote" "$maf_remote" "$@")
    fi
    printf '%s [codex-wrapper] start cwd=%s hook_cwd=%s remote=%s args=%q\n' "$(date -Is)" "$PWD" "$maf_hook_cwd" "$maf_remote" "$*" >> "$LOG"
    maf_cleanup_enabled=1
    MAF_CODEX_WRAPPER_ACTIVE=1 CODEX_CWD="$maf_hook_cwd" MAF_CODEX_APP_SERVER_URL="$maf_remote" MAF_CODEX_SESSION_PID="$maf_session_pid" node "$HOOK" <<JSON
{"cwd":"$maf_hook_cwd","launchCwd":"$PWD","eventName":"WrapperStart","remote":"$maf_remote","sessionPid":$maf_session_pid}
JSON
    printf '%s [codex-wrapper] hook done cwd=%s hook_cwd=%s remote=%s\n' "$(date -Is)" "$PWD" "$maf_hook_cwd" "$maf_remote" >> "$LOG"
  } >/dev/null 2>>"$LOG" || true
fi

set +e
"$REAL_CODEX" "\${maf_exec_args[@]}"
maf_status=$?
set -e
maf_cleanup
exit "$maf_status"
`;
  writeFileSync(CODEX_WRAPPER, wrapper);
  try { execFileSync("chmod", ["+x", CODEX_WRAPPER]); } catch {}
  ok(`Codex launcher wrapper → ${CODEX_WRAPPER}`);

  if (!bashrcHas("$HOME/.local/bin")) {
    bashrcAppend('export PATH="$HOME/.local/bin:$PATH"');
    ok("PATH prepend ~/.local/bin → ~/.bashrc");
  } else {
    ok("PATH 已包含 ~/.local/bin");
  }
}

function installCodex() {
  if (!SERVER) {
    fail("缺少 MAF Server 地址，无法下载 Codex plugin");
    process.exit(1);
  }
  if (!hasCommand("codex")) {
    warn("未检测到 codex，跳过 Codex plugin");
    return;
  }

  console.log("📥 安装 Codex Plugin...");
  const files = [
    ".codex-plugin/plugin.json",
    "hooks.json",
    "README.md",
    "scripts/maf-codex-hook.mjs",
    "scripts/maf-codex-attached-receiver.mjs",
    "scripts/maf-codex-app-server.mjs",
  ];
  for (const file of files) {
    try {
      download(file, join(CODEX_PLUGIN_SOURCE_DIR, file));
      ok(file);
    } catch (err) {
      fail(`${file} 下载失败: ${err.message}`);
      process.exit(1);
    }
  }

  writeFileSync(join(CODEX_PLUGIN_SOURCE_DIR, "package.json"), JSON.stringify({
    name: "@maf/codex-plugin",
    version: "0.0.0-server",
    type: "module",
  }, null, 2) + "\n");
  writeCodexPluginManifestVersion(CODEX_PLUGIN_SOURCE_DIR);
  ok("Codex plugin source → ~/plugins/maf");

  const marketplaceName = upsertCodexMarketplace();
  ok(`Codex personal marketplace → ${CODEX_MARKETPLACE_JSON}`);

  try {
    execSync(`codex plugin add ${CODEX_PLUGIN_NAME}@${marketplaceName} --json`, { stdio: "pipe", timeout: 15000 });
    ok(`Codex plugin 已安装/启用: ${CODEX_PLUGIN_NAME}@${marketplaceName}`);
  } catch (err) {
    const stderr = String(err.stderr || err.message || "").trim().split("\n").slice(-2).join(" ");
    warn(`Codex plugin 启用失败，可稍后手动执行: codex plugin add ${CODEX_PLUGIN_NAME}@${marketplaceName}${stderr ? ` (${stderr})` : ""}`);
  }

  installCodexWrapper();
  console.log("");
}

installCodex();
