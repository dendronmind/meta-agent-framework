#!/usr/bin/env node
/**
 * Meta-Agent Framework Client 安装器
 *
 * 用法：
 *   maf-client init        # 配置 Server 地址 + 安装 Plugin
 *   maf-client status      # 查看安装状态
 *   maf-client uninstall   # 卸载程序，保留运行数据
 *   maf-client uninstall --purge-data  # 卸载并删除运行数据
 *
 * npm install -g 时会自动执行 postinstall → --auto 模式
 *
 * 安装内容：
 *   daemon:       daemon.mjs（runtime-neutral Node Daemon）
 *   opencode:     index.js（Plugin 主体）+ package.json
 *   Claude Code:  plugin.json + hooks.json + maf-agent.mjs + marketplace 注册
 *   Codex:        Codex plugin + SessionStart hook（自动拉起 Node Daemon + 注册当前 agent）
 *   环境变量:     META_AGENT_SERVER + MAF_NODE_PORT → ~/.bashrc
 */

import { existsSync, mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, appendFileSync, unlinkSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const HOME = homedir();
const BASHRC = join(HOME, ".bashrc");
const MAF_HOME = join(HOME, ".meta-agent-framework");
const MAF_LOG_DIR = join(MAF_HOME, "logs");
const STANDALONE_DAEMON = join(MAF_HOME, "daemon.mjs");
const DAEMON_SRC = join(PKG_ROOT, "daemon", "daemon.mjs");
const CODEX_PLUGIN_NAME = "maf";
const CODEX_PLUGIN_SOURCE_DIR = join(HOME, "plugins", CODEX_PLUGIN_NAME);
const CODEX_MARKETPLACE_JSON = join(HOME, ".agents", "plugins", "marketplace.json");
const CODEX_WRAPPER = join(HOME, ".local", "bin", "codex");

function readPackageInfo(dir = PKG_ROOT) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")); } catch { return {}; }
}

function readVersionFromPackageTree(startDir) {
  let dir = startDir;
  for (;;) {
    const pkg = readPackageInfo(dir);
    if (pkg.version) return pkg.version;
    const parent = dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

const CLIENT_PKG = readPackageInfo();
const CLIENT_VERSION = process.env.MAF_VERSION || readVersionFromPackageTree(PKG_ROOT) || "0.0.0";

// ============================================================
// 工具函数
// ============================================================
function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }

function hasCommand(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; }
}

function copyFile(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function bashrcHas(pattern) {
  try { return readFileSync(BASHRC, "utf-8").includes(pattern); } catch { return false; }
}

function bashrcAppend(line) {
  try { appendFileSync(BASHRC, line + "\n"); } catch {}
}

// ============================================================
// 检测环境
// ============================================================
function detectEnv() {
  const hasOpencode = hasCommand("opencode");
  const hasClaude = hasCommand("claude");
  const hasCodex = hasCommand("codex");
  const serverUrl = process.env.META_AGENT_SERVER || "";
  return { hasOpencode, hasClaude, hasCodex, serverUrl };
}

// ============================================================
// 安装 runtime-neutral Node Daemon
// ============================================================
function installStandaloneDaemon() {
  console.log("\n📥 安装 Node Daemon...");
  mkdirSync(MAF_LOG_DIR, { recursive: true });
  copyFile(DAEMON_SRC, STANDALONE_DAEMON);
  writeFileSync(join(MAF_HOME, "package.json"), JSON.stringify({
    name: "@maf/meta-agent-daemon",
    version: CLIENT_VERSION,
    type: "module",
  }, null, 2) + "\n");
  ok("daemon.mjs → ~/.meta-agent-framework/（runtime-neutral）");
}

// ============================================================
// 安装 opencode Plugin
// ============================================================
function installOpencode() {
  console.log("\n📥 安装 opencode Plugin...");

  const pluginDir = join(HOME, ".config", "opencode", "plugins", "opencode-plugin-meta-agent-framework");
  const entryFile = join(HOME, ".config", "opencode", "plugins", "meta-agent-framework.js");
  const srcDir = join(PKG_ROOT, "opencode");

  // 拷贝 2 个核心文件
  // index.js — Plugin 主体，运行在 opencode 进程内，负责连接 Node Daemon + long-poll 任务 + 驱动 opencode 执行
  copyFile(join(srcDir, "index.js"), join(pluginDir, "index.js"));
  ok("index.js — opencode Plugin（任务执行桥梁）");

  // package.json — Plugin 的 npm 包描述（opencode 加载时需要）；安装态注入当前 Client 版本
  const opencodePkg = readPackageInfo(srcDir);
  opencodePkg.version = CLIENT_VERSION;
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify(opencodePkg, null, 2) + "\n");
  ok("package.json");

  // 入口 re-export — opencode 只扫描 plugins/*.js，这个文件转发到子目录
  writeFileSync(entryFile,
    'export { MetaAgentBridge as server } from "./opencode-plugin-meta-agent-framework/index.js";\n'
  );
  ok("入口文件 meta-agent-framework.js");

  // alias — opencode 需要 --hostname localhost 才会启动 HTTP API（Plugin 通过 HTTP 驱动执行）
  if (!bashrcHas("alias opencode=")) {
    bashrcAppend("alias opencode='opencode --hostname localhost'");
    ok("alias opencode='opencode --hostname localhost' → ~/.bashrc");
  }
}

// ============================================================
// 安装 Claude Code Plugin
// ============================================================
function installClaudeCode() {
  console.log("\n📥 安装 Claude Code Plugin...");

  const marketplaceDir = join(HOME, ".claude", "plugins", "marketplaces", "maf-plugins");
  const pluginSrcDir = join(marketplaceDir, "claude-code-plugin-maf");
  const ccSrcDir = join(PKG_ROOT, "claude-code");

  // plugin.json — Plugin 元信息（名称、版本、描述），Claude Code plugin 体系需要；安装态注入当前 Client 版本
  const claudeManifest = JSON.parse(readFileSync(join(ccSrcDir, ".claude-plugin", "plugin.json"), "utf-8"));
  claudeManifest.version = CLIENT_VERSION;
  mkdirSync(join(pluginSrcDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginSrcDir, ".claude-plugin", "plugin.json"), JSON.stringify(claudeManifest, null, 2) + "\n");
  ok("plugin.json — Plugin 元信息");

  // hooks.json — 两个 SessionStart hook：--daemon（拉起 Node Daemon）+ --wait（asyncRewake 等任务）
  copyFile(join(ccSrcDir, "hooks", "hooks.json"), join(pluginSrcDir, "hooks", "hooks.json"));
  ok("hooks.json — SessionStart hooks（--daemon + --wait）");

  // maf-agent.mjs — Claude Code 任务通知管道：long-poll 等任务 → exit(2) + stderr 传递给 Claude
  copyFile(join(ccSrcDir, "scripts", "maf-agent.mjs"), join(pluginSrcDir, "scripts", "maf-agent.mjs"));
  ok("maf-agent.mjs — 任务通知管道（asyncRewake）");

  // marketplace.json — 让 claude plugins 命令能发现这个 plugin
  const marketplaceJson = join(marketplaceDir, ".claude-plugin", "marketplace.json");
  mkdirSync(dirname(marketplaceJson), { recursive: true });
  writeFileSync(marketplaceJson, JSON.stringify({
    "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
    "name": "maf-plugins",
    "description": "Meta-Agent Framework plugins",
    "owner": { "name": "Meta-Agent-Framework" },
    "plugins": [{
      "name": "maf",
      "description": "Meta-Agent Framework — 接入分布式 Agent 网络",
      "category": "productivity",
      "source": "./claude-code-plugin-maf"
    }]
  }, null, 2) + "\n");
  ok("marketplace.json");

  // 注册 marketplace + 安装 plugin
  try {
    const mpList = execSync("claude plugins marketplace list 2>/dev/null", { encoding: "utf-8" });
    if (!mpList.includes("maf-plugins")) {
      execSync(`claude plugins marketplace add "${marketplaceDir}" --scope user 2>/dev/null`);
      ok("marketplace 已注册");
    } else {
      ok("marketplace 已注册（已存在）");
    }
  } catch {
    warn("marketplace 注册失败（claude 命令不可用？）");
  }

  try {
    const plList = execSync("claude plugins list 2>/dev/null", { encoding: "utf-8" });
    if (plList.includes("maf")) {
      execSync("claude plugins update maf 2>/dev/null");
      ok("plugin 已更新");
    } else {
      execSync("claude plugins install maf 2>/dev/null");
      ok("plugin 已安装");
    }
  } catch {
    warn("plugin 安装失败（后续 claude 启动时会自动重试）");
  }
}


// ============================================================
// 安装 Codex Plugin
// ============================================================
function codexPluginVersion() {
  const base = CLIENT_VERSION;
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${base}+codex.local-${stamp}`;
}

function writeCodexPluginManifestVersion(pluginDir) {
  const manifestPath = join(pluginDir, ".codex-plugin", "plugin.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.version = codexPluginVersion();
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
      try { copyFileSync(CODEX_MARKETPLACE_JSON, backup); warn(`旧 marketplace.json 解析失败，已备份: ${backup}`); } catch {}
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

function installCodex() {
  console.log("\n📥 安装 Codex Plugin...");

  const srcDir = join(PKG_ROOT, "codex");
  const manifest = join(srcDir, ".codex-plugin", "plugin.json");
  if (!existsSync(manifest)) {
    warn("Codex plugin 源文件缺失，跳过安装");
    return;
  }

  cpSync(srcDir, CODEX_PLUGIN_SOURCE_DIR, { recursive: true, force: true });
  writeFileSync(join(CODEX_PLUGIN_SOURCE_DIR, "package.json"), JSON.stringify({
    name: "@maf/codex-plugin",
    version: CLIENT_VERSION,
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
}

function codexPluginStatus() {
  const sourceInstalled = existsSync(join(CODEX_PLUGIN_SOURCE_DIR, ".codex-plugin", "plugin.json"));
  let enabled = false;
  try {
    const cfg = readFileSync(join(HOME, ".codex", "config.toml"), "utf-8");
    enabled = /\[plugins\."maf@[^"\]]+"\][\s\S]*?enabled\s*=\s*true/.test(cfg);
  } catch {}
  if (sourceInstalled && enabled) return "✅ 已安装/已启用";
  if (sourceInstalled) return "⚠ 已安装但未启用";
  return "❌ 未安装";
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
  try { execSync(`chmod +x "${CODEX_WRAPPER}"`); } catch {}
  ok(`Codex launcher wrapper → ${CODEX_WRAPPER}`);

  if (!bashrcHas("$HOME/.local/bin")) {
    bashrcAppend('export PATH="$HOME/.local/bin:$PATH"');
    ok("PATH prepend ~/.local/bin → ~/.bashrc");
  } else {
    ok("PATH 已包含 ~/.local/bin");
  }
}

function codexWrapperStatus() {
  if (!existsSync(CODEX_WRAPPER)) return "❌ 未安装";
  try {
    const content = readFileSync(CODEX_WRAPPER, "utf-8");
    if (!content.includes("Meta-Agent Framework Codex launcher wrapper")) return "⚠ 被其它文件占用";
  } catch { return "⚠ 状态未知"; }
  let first = "";
  try { first = execSync("which codex 2>/dev/null", { encoding: "utf-8" }).trim(); } catch {}
  if (first === CODEX_WRAPPER) return "✅ 已安装/已生效";
  return `⚠ 已安装但 PATH 未优先 (${first || "not found"})`;
}

// ============================================================
// 配置环境变量
// ============================================================
function configureEnv(serverUrl) {
  console.log("\n🔧 配置环境变量...");

  // META_AGENT_SERVER — Node Daemon 注册/心跳/回报的 Server 地址
  if (serverUrl) {
    if (!bashrcHas("META_AGENT_SERVER")) {
      bashrcAppend("");
      bashrcAppend("# Meta-Agent Framework");
      bashrcAppend(`export META_AGENT_SERVER=${serverUrl}`);
      ok(`META_AGENT_SERVER=${serverUrl} → ~/.bashrc`);
    } else {
      ok("META_AGENT_SERVER 已配置");
    }
  } else {
    warn("META_AGENT_SERVER 未设置（安装后请手动配置：export META_AGENT_SERVER=http://<server>:3000）");
  }

  // MAF_NODE_PORT — Node Daemon 固定监听端口（默认 4100）
  if (!bashrcHas("MAF_NODE_PORT")) {
    bashrcAppend("export MAF_NODE_PORT=4100");
    ok("MAF_NODE_PORT=4100 → ~/.bashrc");
  } else {
    ok("MAF_NODE_PORT 已配置");
  }
}

// ============================================================
// 卸载
// ============================================================
function uninstall({ purgeData = false } = {}) {
  console.log("\n🗑  卸载 Meta-Agent Framework Client...\n");

  // 杀 Node Daemon
  try { execSync('pkill -f "MAF_Node_Daemon" 2>/dev/null'); ok("停止 Node Daemon"); } catch { log("- Node Daemon 未运行"); }
  try { execSync('pkill -f "MAF_Client_Daemon" 2>/dev/null'); } catch {}

  // 删 opencode Plugin
  const ocDir = join(HOME, ".config", "opencode", "plugins", "opencode-plugin-meta-agent-framework");
  const ocEntry = join(HOME, ".config", "opencode", "plugins", "meta-agent-framework.js");
  if (existsSync(ocDir)) {
    execSync(`rm -rf "${ocDir}"`);
    ok("删除 opencode Plugin 目录");
  }
  if (existsSync(ocEntry)) {
    unlinkSync(ocEntry);
    ok("删除 opencode 入口文件");
  }

  // 卸载 Claude Code Plugin
  try { execSync("claude plugins uninstall maf 2>/dev/null"); ok("卸载 Claude Code plugin"); } catch {}
  try { execSync("claude plugins marketplace remove maf-plugins 2>/dev/null"); ok("移除 marketplace"); } catch {}

  // 清理 bashrc
  try {
    let content = readFileSync(BASHRC, "utf-8");
    const before = content.length;
    content = content.replace(/^.*META_AGENT_SERVER.*\n?/gm, "");
    content = content.replace(/^.*MAF_AUTH_TOKEN.*\n?/gm, "");
    content = content.replace(/^.*MAF_NODE_PORT.*\n?/gm, "");
    content = content.replace(/^.*# Meta-Agent Framework.*\n?/gm, "");
    content = content.replace(/^.*alias opencode=.*hostname localhost.*\n?/gm, "");
    if (content.length < before) {
      writeFileSync(BASHRC, content);
      ok("清理 ~/.bashrc");
    }
  } catch {}

  // 清理 Codex plugin（不删除用户其它 Codex 配置）
  try { execSync(`codex plugin remove ${CODEX_PLUGIN_NAME}@personal 2>/dev/null`, { stdio: "ignore" }); ok("卸载 Codex plugin"); } catch {}
  try { execSync(`rm -rf "${CODEX_PLUGIN_SOURCE_DIR}"`); ok("删除 Codex plugin source ~/plugins/maf"); } catch {}
  try {
    if (existsSync(CODEX_WRAPPER) && readFileSync(CODEX_WRAPPER, "utf-8").includes("Meta-Agent Framework Codex launcher wrapper")) {
      unlinkSync(CODEX_WRAPPER);
      ok("删除 Codex launcher wrapper");
    }
  } catch {}

  // MAF_HOME 同时保存 Server DB、Execution 工件和 Client 身份。普通卸载
  // 只移除 Client runtime，避免同机部署时误删 Server 运行数据。
  if (purgeData && existsSync(MAF_HOME)) {
    execSync(`rm -rf "${MAF_HOME}"`);
    ok("删除运行数据目录 ~/.meta-agent-framework");
  } else {
    try { if (existsSync(STANDALONE_DAEMON)) unlinkSync(STANDALONE_DAEMON); } catch {}
    try { if (existsSync(join(MAF_HOME, "package.json"))) unlinkSync(join(MAF_HOME, "package.json")); } catch {}
    ok("保留运行数据 ~/.meta-agent-framework（需要删除时使用 --purge-data）");
  }

  console.log("\n✅ Client 卸载完成");
  console.log("  移除 npm 包: npm uninstall -g @maf/meta-agent-client\n");

  // 最后一步：卸载自己（执行后 maf-client 命令不再可用）
  try { execSync("npm uninstall -g @maf/meta-agent-client", { cwd: HOME, stdio: "inherit" }); } catch {}
}

// ============================================================
// 状态查看
// ============================================================
function status() {
  console.log("\n📋 Meta-Agent Framework Client 状态\n");

  const ocPlugin = join(HOME, ".config", "opencode", "plugins", "opencode-plugin-meta-agent-framework", "index.js");
  log(`opencode Plugin: ${existsSync(ocPlugin) ? "✅ 已安装" : "❌ 未安装"}`);
  log(`Node Daemon:     ${existsSync(STANDALONE_DAEMON) ? "✅ 已安装" : "❌ 未安装"}`);

  try {
    const plList = execSync("claude plugins list 2>/dev/null", { encoding: "utf-8" });
    log(`Claude Code:     ${plList.includes("maf") ? "✅ 已安装" : "❌ 未安装"}`);
  } catch {
    log("Claude Code:     - (claude 命令不可用)");
  }

  log(`Codex CLI:       ${hasCommand("codex") ? "✅ 可用" : "- (codex 命令不可用)"}`);
  log(`Codex Plugin:    ${codexPluginStatus()}`);
  log(`Codex Wrapper:   ${codexWrapperStatus()}`);

  log(`META_AGENT_SERVER: ${process.env.META_AGENT_SERVER || "(未设置)"}`);
  log(`MAF_NODE_PORT:     ${process.env.MAF_NODE_PORT || "4100 (默认)"}`);

  // 检测 Node Daemon 是否在运行
  const port = process.env.MAF_NODE_PORT || "4100";
  try {
    execSync(`curl -s --max-time 1 http://127.0.0.1:${port}/health > /dev/null 2>&1`);
    log(`Node Daemon:     🟢 运行中 (port ${port})`);
  } catch {
    log(`Node Daemon:     ⚪ 未运行 (port ${port})`);
  }
  console.log("");
}

// ============================================================
// Resume（恢复上一个 session）
// ============================================================
function resume(agentArg, runtimeArg) {
  // 解析参数
  let agent = agentArg || null;
  let runtime = runtimeArg || null; // "opencode" | "claude"

  const env = detectEnv();

  // 自动检测 runtime
  if (!runtime) {
    if (env.hasOpencode && env.hasClaude) {
      // 两个都有，看有没有 agent 参数来决定
      runtime = "opencode"; // 默认 opencode
    } else if (env.hasOpencode) {
      runtime = "opencode";
    } else if (env.hasClaude) {
      runtime = "claude";
    } else if (env.hasCodex) {
      runtime = "codex";
    } else {
      fail("未检测到 opencode / Claude Code / Codex");
      process.exit(1);
    }
  }

  if (runtime === "codex") {
    const parts = ["codex", "resume", "--last", "--all"];
    const cmd = parts.join(" ");
    console.log(`\n  🔄 恢复 Codex session...\n  $ ${cmd}\n`);
    try {
      execSync(cmd, { stdio: "inherit" });
    } catch (e) {
      if (e.status) process.exit(e.status);
    }
    return;
  }

  if (runtime === "claude" || runtime === "claude-code" || runtime === "cc") {
    // Claude Code: --continue 自动恢复最近 session
    const parts = ["claude", "--continue"];
    if (agent) parts.push("--agent", agent);
    const cmd = parts.join(" ");
    console.log(`\n  🔄 恢复 Claude Code session...\n  $ ${cmd}\n`);
    try {
      execSync(cmd, { stdio: "inherit" });
    } catch (e) {
      if (e.status) process.exit(e.status);
    }
    return;
  }

  // opencode: 查 DB 找最近 session
  const dbPath = join(HOME, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    fail("未找到 opencode 数据库: " + dbPath);
    log("  请确认 opencode 已正常使用过至少一次");
    process.exit(1);
  }

  // 构建查询
  let query;
  if (agent) {
    // 按 agent 名称查最近 session
    query = `SELECT id, agent, title, directory, datetime(time_updated/1000, 'unixepoch', 'localtime') as updated FROM session WHERE agent = '${agent}' ORDER BY time_updated DESC LIMIT 1;`;
  } else {
    // 查当前目录的最近 session
    const cwd = process.cwd();
    query = `SELECT id, agent, title, directory, datetime(time_updated/1000, 'unixepoch', 'localtime') as updated FROM session WHERE directory = '${cwd}' ORDER BY time_updated DESC LIMIT 1;`;
  }

  let result;
  try {
    result = execSync(`sqlite3 "${dbPath}" "${query}"`, { encoding: "utf-8" }).trim();
  } catch {
    fail("查询 session 数据库失败");
    process.exit(1);
  }

  if (!result) {
    // 没找到，尝试更宽松的搜索
    if (agent) {
      // 模糊匹配 agent
      const fuzzyQuery = `SELECT id, agent, title, directory, datetime(time_updated/1000, 'unixepoch', 'localtime') as updated FROM session WHERE agent LIKE '%${agent}%' ORDER BY time_updated DESC LIMIT 5;`;
      try {
        const fuzzyResult = execSync(`sqlite3 "${dbPath}" "${fuzzyQuery}"`, { encoding: "utf-8" }).trim();
        if (fuzzyResult) {
          console.log(`\n  ⚠ 未找到 agent="${agent}" 的精确匹配，相近结果:\n`);
          for (const line of fuzzyResult.split("\n")) {
            const [id, ag, title, dir, updated] = line.split("|");
            log(`  ${ag} | ${title} | ${dir} | ${updated}`);
          }
          console.log("");
        } else {
          fail(`未找到 agent "${agent}" 的任何 session`);
        }
      } catch {}
    } else {
      fail(`当前目录 (${process.cwd()}) 没有找到历史 session`);
      log("  提示: 使用 --agent <name> 按 agent 名称搜索");
    }
    process.exit(1);
  }

  const [sessionId, sessionAgent, title, directory, updated] = result.split("|");

  console.log(`\n  🔄 恢复 opencode session`);
  console.log(`  ────────────────────────────────────`);
  log(`Session: ${sessionId}`);
  log(`Agent:   ${sessionAgent || "(default)"}`);
  log(`Title:   ${title}`);
  log(`Dir:     ${directory}`);
  log(`Updated: ${updated}`);
  console.log(`  ────────────────────────────────────\n`);

  // 构建启动命令
  const parts = ["opencode", "--session", sessionId];
  if (sessionAgent) parts.push("--agent", sessionAgent);
  const launchCmd = parts.join(" ");
  log(`$ cd ${directory} && ${launchCmd}\n`);

  try {
    execSync(launchCmd, { stdio: "inherit", cwd: directory });
  } catch (e) {
    if (e.status) process.exit(e.status);
  }
}

// ============================================================
// List sessions（列出最近的 sessions）
// ============================================================
function listSessions(agentFilter, limit = 10) {
  const dbPath = join(HOME, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    fail("未找到 opencode 数据库: " + dbPath);
    process.exit(1);
  }

  let query;
  if (agentFilter) {
    query = `SELECT id, agent, title, directory, datetime(time_updated/1000, 'unixepoch', 'localtime') as updated FROM session WHERE agent LIKE '%${agentFilter}%' ORDER BY time_updated DESC LIMIT ${limit};`;
  } else {
    query = `SELECT id, agent, title, directory, datetime(time_updated/1000, 'unixepoch', 'localtime') as updated FROM session ORDER BY time_updated DESC LIMIT ${limit};`;
  }

  let result;
  try {
    result = execSync(`sqlite3 "${dbPath}" "${query}"`, { encoding: "utf-8" }).trim();
  } catch {
    fail("查询失败");
    process.exit(1);
  }

  if (!result) {
    log("没有找到 session");
    process.exit(0);
  }

  console.log(`\n  📋 最近 sessions${agentFilter ? ` (agent~${agentFilter})` : ""}\n`);
  console.log("  ID                              │ Agent              │ Title                         │ Updated");
  console.log("  ────────────────────────────────┼────────────────────┼───────────────────────────────┼────────────────────");

  for (const line of result.split("\n")) {
    const [id, ag, title, dir, updated] = line.split("|");
    const shortId = id?.substring(0, 32) || "";
    const agentCol = (ag || "(default)").padEnd(18).substring(0, 18);
    const titleCol = (title || "").padEnd(29).substring(0, 29);
    const updatedCol = updated || "";
    console.log(`  ${shortId} │ ${agentCol} │ ${titleCol} │ ${updatedCol}`);
  }
  console.log("");
}

// ============================================================
// Codex / Daemon connect
// ============================================================
function normalizeClientRuntime(runtime) {
  const r = String(runtime || "codex").trim();
  if (r === "claude" || r === "cc") return "claude-code";
  if (r === "codex" || r === "opencode" || r === "claude-code") return r;
  return r;
}

function findDaemonScript() {
  const paths = [
    STANDALONE_DAEMON,
    DAEMON_SRC,
  ];
  return paths.find(p => existsSync(p)) || "";
}

async function checkDaemon(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

async function spawnDaemonForAgent(agentName, runtime, projectPath, serverUrl, port) {
  if (!existsSync(STANDALONE_DAEMON) && existsSync(DAEMON_SRC)) {
    installStandaloneDaemon();
  }
  const script = findDaemonScript();
  if (!script) { fail("daemon.mjs 未找到，请先运行 maf-client init"); return false; }
  const child = spawn(process.execPath, [script], {
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      MAF_NODE_PORT: String(port),
      MAF_AGENT_NAME: agentName,
      MAF_RUNTIME: runtime,
      MAF_DIRECTORY: projectPath,
      MAF_PLUGIN_DIR: dirname(script),
      META_AGENT_SERVER: serverUrl || process.env.META_AGENT_SERVER || "",
      MAF_LOCAL_TOKEN: readLocalToken(),
    },
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkDaemon(port)) return true;
  }
  return false;
}

async function connectAgentCommand({ agent, runtime = "codex", project }) {
  if (!agent) { fail("缺少 --agent <name>"); process.exit(1); }
  runtime = normalizeClientRuntime(runtime);
  const projectPath = (project || process.cwd()).replace(/^~/, HOME);
  const cfg = readMafConfig() || {};
  const serverUrl = process.env.META_AGENT_SERVER || cfg.server?.url || "";
  const port = process.env.MAF_NODE_PORT || String(cfg.daemon?.port || 4100);
  let health = await checkDaemon(port);
  if (!health) {
    log(`Node Daemon 未运行，正在拉起 (${runtime})...`);
    const ok = await spawnDaemonForAgent(agent, runtime, projectPath, serverUrl, port);
    if (!ok) { fail("Node Daemon 拉起失败"); process.exit(1); }
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/agents/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readLocalToken()}`,
      },
      body: JSON.stringify({ agent_name: agent, runtime, directory: projectPath }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    ok(`agent 已连接: ${agent} (runtime=${runtime}, project=${projectPath})`);
    log(`agents=[${data.agents?.join(", ") || agent}]`);
  } catch (err) {
    fail(`连接 Daemon 失败: ${err.message}`);
    process.exit(1);
  }
}

// ============================================================
// 主入口
// ============================================================
const args = process.argv.slice(2);
const cmd = args[0] || "--auto";

if (cmd === "--version" || cmd === "version" || cmd === "-v") {
  console.log(`maf-client v${CLIENT_VERSION}`);
  process.exit(0);
}

if (cmd === "uninstall") {
  uninstall({ purgeData: args.includes("--purge-data") });
  process.exit(0);
}

if (cmd === "status") {
  status();
  process.exit(0);
}

if (cmd === "connect" || cmd === "daemon") {
  let agent = null;
  let runtime = "codex";
  let project = process.cwd();
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === "--agent" || args[i] === "-a") && args[i + 1]) agent = args[++i];
    else if ((args[i] === "--runtime" || args[i] === "-r") && args[i + 1]) runtime = args[++i];
    else if ((args[i] === "--project" || args[i] === "--cwd" || args[i] === "-C") && args[i + 1]) project = args[++i];
    else if (!args[i].startsWith("-") && !agent) agent = args[i];
  }
  await connectAgentCommand({ agent, runtime, project });
  process.exit(0);
}

if (cmd === "resume" || cmd === "r") {
  // maf-client resume [--agent <name>] [--runtime opencode|claude|codex]
  let agent = null;
  let runtime = null;
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === "--agent" || args[i] === "-a") && args[i + 1]) {
      agent = args[++i];
    } else if ((args[i] === "--runtime" || args[i] === "-r") && args[i + 1]) {
      runtime = args[++i];
    } else if (!args[i].startsWith("-")) {
      // 位置参数当 agent 名
      agent = args[i];
    }
  }
  resume(agent, runtime);
  process.exit(0);
}

if (cmd === "sessions" || cmd === "ls") {
  // maf-client sessions [--agent <name>] [--limit N]
  let agent = null;
  let limit = 10;
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === "--agent" || args[i] === "-a") && args[i + 1]) {
      agent = args[++i];
    } else if ((args[i] === "--limit" || args[i] === "-n") && args[i + 1]) {
      limit = parseInt(args[++i]) || 10;
    } else if (!args[i].startsWith("-")) {
      agent = args[i];
    }
  }
  listSessions(agent, limit);
  process.exit(0);
}

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`
Meta-Agent-Framework Client

用法: maf-client <command>

命令:
  init        配置 Server 地址 + 安装 Plugin/Daemon
  connect     注册/连接一个 Daemon 托管 agent（Codex 常用）
  resume [agent]  恢复上一个 session（支持 --agent / --runtime）
  sessions [agent]  列出最近的 sessions（支持 --limit N）
  status      查看安装状态
  uninstall   卸载程序并保留运行数据（--purge-data 才删除数据）
  help        显示此帮助

Resume 用法:
  maf-client resume                    # 恢复当前目录的最近 session
  maf-client resume MAF-developer      # 恢复指定 agent 的最近 session
  maf-client resume --runtime claude   # 用 Claude Code 恢复（claude --continue）
  maf-client resume --runtime codex    # 用 Codex 恢复（codex resume --last --all）
  maf-client r a2b-booster             # 简写

Connect 用法:
  maf-client connect --runtime codex --agent MAF-developer --project ~/project

Sessions 用法:
  maf-client sessions                  # 列出所有最近 session
  maf-client sessions MAF-developer    # 按 agent 过滤
  maf-client ls -n 20                  # 列出最近 20 条
`);
  process.exit(0);
}

// ============================================================
// 交互式输入（用于首次配置）
// ============================================================
import { createInterface } from "node:readline";

function ask(question, defaultVal) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` [${defaultVal}]` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

/** 读取 maf.config.json */
function readMafConfig() {
  const configPath = join(HOME, ".meta-agent-framework", "maf.config.json");
  try { if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  return null;
}

/** 写入 maf.config.json */
function writeMafConfig(cfg) {
  const dir = join(HOME, ".meta-agent-framework");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "maf.config.json");
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

function readLocalToken() {
  const tokenFile = join(HOME, ".meta-agent-framework", "auth", "local-token");
  try { return readFileSync(tokenFile, "utf-8").trim(); } catch { return process.env.MAF_LOCAL_TOKEN || ""; }
}

// ============================================================
// 主安装流程
// ============================================================

// install 或 --auto（postinstall）
console.log("");
console.log("╔══════════════════════════════════════╗");
console.log(`║  Meta-Agent Framework Client v${CLIENT_VERSION}  ║`);
console.log("╚══════════════════════════════════════╝");
console.log("");

const env = detectEnv();

if (!env.hasOpencode && !env.hasClaude && !env.hasCodex) {
  warn("未检测到 opencode / Claude Code / Codex");
  log("  安装 opencode:    curl -fsSL https://opencode.ai/install | bash");
  log("  安装 Claude Code: npm install -g @anthropic-ai/claude-code");
  log("  安装 Codex:       npm install -g @openai/codex");
  if (cmd === "--auto") {
    // postinstall: 如果 Plugin 已安装过，整个目录覆盖更新
    const pluginDir = join(HOME, ".config", "opencode", "plugins", "opencode-plugin-meta-agent-framework");
    if (existsSync(pluginDir)) {
      const srcDir = join(PKG_ROOT, "opencode");
      try { cpSync(srcDir, pluginDir, { recursive: true, force: true }); } catch {}
    }
    const ccPluginDir = join(HOME, ".claude", "plugins", "marketplaces", "maf-plugins", "claude-code-plugin-maf");
    if (existsSync(ccPluginDir)) {
      const ccSrcDir = join(PKG_ROOT, "claude-code");
      try { cpSync(ccSrcDir, ccPluginDir, { recursive: true, force: true }); } catch {}
    }
    if (existsSync(CODEX_PLUGIN_SOURCE_DIR)) {
      try {
        cpSync(join(PKG_ROOT, "codex"), CODEX_PLUGIN_SOURCE_DIR, { recursive: true, force: true });
        writeCodexPluginManifestVersion(CODEX_PLUGIN_SOURCE_DIR);
      } catch {}
    }
    if (existsSync(STANDALONE_DAEMON)) {
      try { copyFileSync(DAEMON_SRC, STANDALONE_DAEMON); } catch {}
    }
    process.exit(0);
  }
  process.exit(1);
}

log("检测到运行时:");
if (env.hasOpencode) ok("opencode");
if (env.hasClaude) ok("Claude Code");
if (env.hasCodex) ok("Codex");

// 检测已有的 Server URL（环境变量 > maf.config.json）
let serverUrl = env.serverUrl;
const existingCfg = readMafConfig();
if (!serverUrl) {
  if (existingCfg?.server?.url) {
    serverUrl = existingCfg.server.url;
  }
}

// --auto 是 npm postinstall 路径，即使继承了调用终端也不能等待用户输入。
// 显式 init/install 才在 TTY 中确认 Server URL。
if (cmd !== "--auto" && process.stdin.isTTY) {
  // 有 TTY：始终让用户确认（有默认值显示，没有则必填不可跳过）
  console.log("");
  log("配置 Server 地址（运行 maf-server 的机器，例如 http://10.0.0.1:3000）");
  console.log("");
  const inputUrl = await ask("Server URL", serverUrl);
  if (inputUrl) {
    serverUrl = inputUrl;
  }
  while (!serverUrl) {
    warn("Server URL 不能为空（格式: http://<ip>:<port>）");
    serverUrl = await ask("Server URL", "");
  }
} else if (!serverUrl) {
  // 无 TTY（npm postinstall）且无已有配置 → 跳过，提示手动配置
  console.log("");
  warn("未检测到 Server 地址，安装后请运行:");
  log("  maf-client install");
  console.log("");
}

installStandaloneDaemon();
if (env.hasOpencode) installOpencode();
if (env.hasClaude) installClaudeCode();
if (env.hasCodex) installCodex();
configureEnv(serverUrl);

// 生成 maf.config.json（Client 角色）；机器身份由 Daemon 首次启动时自动生成。
if (serverUrl) {
  const cfg = readMafConfig() || {};
  cfg.role = cfg.role || "client";
  delete cfg.auth;
  cfg.server = cfg.server || {};
  cfg.server.url = serverUrl;
  cfg.daemon = cfg.daemon || { port: parseInt(process.env.MAF_NODE_PORT || "4100") };
  writeMafConfig(cfg);
  ok(`maf.config.json → ~/.meta-agent-framework/`);
}

// 检查 git user.email
try {
  execSync("git config user.email", { stdio: "pipe", timeout: 3000 });
} catch {
  console.log("");
  warn("未检测到 git user.email（Agent 将使用系统用户名作为身份标识）");
  log("  建议配置: git config --global user.email \"your@email.com\"");
}

console.log("");
console.log("══════════════════════════════════════");
console.log("  ✅ 安装完成!");
console.log("══════════════════════════════════════");
console.log("");
console.log(`  架构: Node Daemon (固定端口 ${process.env.MAF_NODE_PORT || "4100"}, 机器级别常驻)`);
if (serverUrl) console.log(`  Server: ${serverUrl}`);
console.log("");
console.log("  下一步:");
if (env.hasOpencode) console.log("  [opencode] cd 项目目录 → 创建 .opencode/agents/<name>.md → opencode");
if (env.hasClaude) console.log("  [claude]   cd 项目目录 → 创建 .claude/agents/<name>.md → claude");
if (env.hasCodex) console.log("  [codex]    cd 项目目录 → 可创建 .codex/agents/<name>.toml；否则使用项目目录名 → codex（wrapper 先拉起 MAF，SessionStart hook 作为补充）");
console.log("");
console.log("  Agent 启动后自动拉起 Node Daemon → 注册到 Server");
console.log("");
