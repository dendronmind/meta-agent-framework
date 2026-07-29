#!/usr/bin/env node
/**
 * maf-server — Meta-Agent-Framework Server CLI
 *
 * 全局命令，不依赖当前目录。
 *
 * 用法：
 *   maf-server init          配置 Server（交互式）
 *   maf-server start         启动 Server（后台常驻）
 *   maf-server stop          停止 Server
 *   maf-server restart       重启 Server
 *   maf-server status        查看运行状态
 *   maf-server logs          查看日志（tail -f）
 *   maf-server version       版本信息
 *
 * 数据目录：~/.meta-agent-framework/
 *   data/       SQLite 数据库
 *   state/      PID、运行状态
 *   logs/       日志
 *   maf.config.json  配置文件
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, cpSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ============================================================
// 路径常量
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");  // npm 包的根目录

function readVersionFromPackageTree(startDir) {
  let dir = startDir;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.version) return pkg.version;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

const PACKAGE_VERSION = process.env.MAF_VERSION || readVersionFromPackageTree(PACKAGE_ROOT) || "0.0.0";

const MAF_HOME = process.env.MAF_HOME || join(homedir(), ".meta-agent-framework");
const STATE_DIR = join(MAF_HOME, "state");
const PID_FILE = join(STATE_DIR, "server.pid");
const LOG_DIR = join(MAF_HOME, "logs");
const LOG_FILE = join(LOG_DIR, "server.log");
const CONFIG_FILE = join(MAF_HOME, "maf.config.json");
let stopServerOnTuiExit = false;

// 确保目录
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(join(MAF_HOME, "data"), { recursive: true });

// ============================================================
// 工作区同步：将 npm 包中的 agent/hook/scripts 同步到 MAF_HOME
//
// 源码包内使用非隐藏、按职责分层的目录：
//   common_agent/  通用 Meta-Agent-Server 协议、rules、server/client skill 模板
//   opencode/      opencode 运行时 agent/入口配置
//   claude/        Claude Code 运行时入口配置
//   codex/         Codex 运行时入口配置
//
// 安装/启动时再物化为各 runtime 原生布局：
//   common_agent/instructions   -> $MAF_HOME/common_agent/instructions
//   common_agent/rules          -> $MAF_HOME/common_agent/rules
//   common_agent/client_skills  -> $MAF_HOME/skills
//   common_agent/server_skills  -> $MAF_HOME/.{opencode,claude,codex}/skills
//   opencode/agents             -> $MAF_HOME/.opencode/agents
//   opencode/opencode.json      -> $MAF_HOME/opencode.json
//   claude/settings.local.json  -> $MAF_HOME/.claude/settings.local.json
//   claude/CLAUDE.md            -> $MAF_HOME/CLAUDE.md
//   codex/AGENTS.md             -> $MAF_HOME/AGENTS.md
//   codex/agents                -> $MAF_HOME/.codex/agents
// ============================================================

/** 需要覆盖同步的文件/目录（框架管理资产，升级必须用新版；用户内容放 user/） */
const SYNC_MANAGED = [
  ["common_agent/instructions", "common_agent/instructions"],  // 通用 Meta-Agent-Server 协议
  ["common_agent/rules", "common_agent/rules"],                // 通用规则
  ["common_agent/client_skills", "skills"],                    // 推送给远端 agent 的 client skill 模板
  ["common_agent/server_skills", ".opencode/skills"],          // Server agent skill（opencode 原生）
  ["common_agent/server_skills", ".claude/skills"],            // Server agent skill（Claude Code 原生）
  ["common_agent/server_skills", ".codex/skills"],             // Server agent skill（Codex 原生）
  ["opencode/agents", ".opencode/agents"],                    // opencode agent 定义
  ["opencode/opencode.json", "opencode.json"],                 // opencode 配置（instructions 引用 user/*.md）
  ["claude/settings.local.json", ".claude/settings.local.json"], // claude hooks 配置
  ["claude/CLAUDE.md", "CLAUDE.md"],                           // claude system prompt
  ["codex/AGENTS.md", "AGENTS.md"],                            // codex project instructions
  ["codex/agents", ".codex/agents"],                           // Codex standard custom agents
  ["scripts/maf-server-hook.mjs", "scripts/maf-server-hook.mjs"],   // claude asyncRewake hook
  ["scripts/check-write-path.mjs", "scripts/check-write-path.mjs"], // 文件写入保护 hook
  ["scripts/poll-workflow.sh", "scripts/poll-workflow.sh"],         // 工作流轮询脚本
  ["scripts/push-skill.sh", "scripts/push-skill.sh"],               // skill 推送脚本
];

/**
 * 同步工作区文件到 MAF_HOME。
 * - 框架管理资产：每次覆盖（确保升级后新版本生效）
 * - 用户长期知识：不要写入这些框架目录，应放在 $MAF_HOME/user/
 * 同时同步已安装的 opencode / Claude Code / Codex Plugin 代码。
 */
function syncWorkspace() {
  mkdirSync(join(MAF_HOME, "scripts"), { recursive: true });

  // 覆盖同步：框架管理资产（升级必须用新版）
  for (const [srcRel, dstRel] of SYNC_MANAGED) {
    const src = join(PACKAGE_ROOT, srcRel);
    const dst = join(MAF_HOME, dstRel);
    if (!existsSync(src)) continue;

    try {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true, force: true });
    } catch {}
  }

  // 同步 opencode Plugin（代码，覆盖）；Node Daemon 独立安装到 ~/.meta-agent-framework/daemon.mjs
  const pluginSrc = join(PACKAGE_ROOT, "plugins", "opencode-plugin-meta-agent-framework");
  const pluginDst = join(homedir(), ".config", "opencode", "plugins", "opencode-plugin-meta-agent-framework");
  if (existsSync(pluginSrc) && existsSync(pluginDst)) {
    try { cpSync(pluginSrc, pluginDst, { recursive: true, force: true }); } catch {}
  }

  // 同步 Claude Code Plugin（代码，覆盖）
  const ccMarketSrc = join(PACKAGE_ROOT, "plugins", ".claude-plugin");
  const ccMarketDst = join(homedir(), ".claude", "plugins", "marketplaces", "maf-plugins", ".claude-plugin");
  if (existsSync(ccMarketSrc) && existsSync(ccMarketDst)) {
    try { cpSync(ccMarketSrc, ccMarketDst, { recursive: true, force: true }); } catch {}
  }
  const ccPluginSrc = join(PACKAGE_ROOT, "plugins", "claude-code-plugin-maf");
  const ccPluginDst = join(homedir(), ".claude", "plugins", "marketplaces", "maf-plugins", "claude-code-plugin-maf");
  if (existsSync(ccPluginSrc) && existsSync(ccPluginDst)) {
    try { cpSync(ccPluginSrc, ccPluginDst, { recursive: true, force: true }); } catch {}
  }

  // 同步 Codex Plugin（仅当用户已安装 MAF Codex plugin source 时覆盖更新代码）
  const codexPluginSrc = join(PACKAGE_ROOT, "plugins", "codex");
  const codexPluginDst = join(homedir(), "plugins", "maf");
  if (existsSync(codexPluginSrc) && existsSync(codexPluginDst)) {
    try { cpSync(codexPluginSrc, codexPluginDst, { recursive: true, force: true }); } catch {}
  }
}

// ============================================================
// 工具函数
// ============================================================

function readConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  return null;
}

function getPort() {
  const cfg = readConfig();
  return parseInt(process.env.META_AGENT_PORT || process.env.PORT || "") || cfg?.server?.port || 3000;
}

function getServerPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0);  // 检查进程是否存在
    return pid;
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getProcessGroupId(pid) {
  try {
    const raw = execSync(`ps -o pgid= -p ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim();
    const pgid = parseInt(raw, 10);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : 0;
  } catch {
    return 0;
  }
}

function getCurrentProcessGroupId() {
  return getProcessGroupId(process.pid);
}

function signalProcessTree(pid, signal) {
  const pgid = getProcessGroupId(pid);
  const selfPgid = getCurrentProcessGroupId();
  if (pgid && pgid !== selfPgid) {
    try { process.kill(-pgid, signal); return true; } catch {}
  }
  try { process.kill(pid, signal); return true; } catch {}
  return false;
}

function findServerPidByPort(port) {
  try {
    const ssOut = execSync(`ss -ltnp 'sport = :${port}' 2>/dev/null`, { encoding: "utf-8", timeout: 3000 });
    const match = ssOut.match(/pid=(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch {}
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | head -n1`, { encoding: "utf-8", timeout: 3000 }).trim();
    const pid = parseInt(out, 10);
    if (pid) return pid;
  } catch {}
  return null;
}

function isServerRunning() {
  const port = getPort();
  try {
    execSync(`curl --max-time 1 -s -o /dev/null -w "%{http_code}" http://localhost:${port}/api/health`, { timeout: 2000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function stopServerProcessSync(pid, label) {
  if (!pid) return false;
  const port = getPort();
  const target = `${label || "PID"} ${pid}`;
  if (!pidAlive(pid)) return !isServerRunning();

  signalProcessTree(pid, "SIGTERM");
  for (let i = 0; i < 30; i++) {
    sleepSync(200);
    if (!isServerRunning()) {
      try { unlinkSync(PID_FILE); } catch {}
      console.log(`✅ Server 已停止 (${target})`);
      return true;
    }
  }

  console.warn(`⚠️  Server 未在 SIGTERM 后退出，发送 SIGKILL (${target})`);
  signalProcessTree(pid, "SIGKILL");
  for (let i = 0; i < 15; i++) {
    sleepSync(200);
    if (!isServerRunning() && !findServerPidByPort(port)) {
      try { unlinkSync(PID_FILE); } catch {}
      console.log(`✅ Server 已强制停止 (${target})`);
      return true;
    }
  }

  return false;
}

// ============================================================
// 子命令实现
// ============================================================

async function cmdInit() {
  // 复用现有的 maf-init.mjs，传入 server 参数
  const initScript = join(PACKAGE_ROOT, "scripts", "maf-init.mjs");
  if (!existsSync(initScript)) {
    console.error("❌ 初始化脚本不存在:", initScript);
    process.exit(1);
  }
  try {
    execSync(`node "${initScript}" server`, { stdio: "inherit" });
  } catch (e) {
    if (e.status) process.exit(e.status);
  }
}

async function cmdStart() {
  const port = getPort();

  // 检查是否已在运行
  if (isServerRunning()) {
    console.log(`✅ Server 已在运行 (port ${port})`);
    cmdStatus();
    cmdTui();
    return;
  }

  // 首次运行：检测不到配置 → 自动进入 init 流程。
  // 旧配置若没有 server.runtime，也必须补选；不再默认 opencode。
  let cfg = readConfig();
  if (!cfg || !cfg.server?.url) {
    console.log("🔧 首次运行，进入配置流程...\n");
    await cmdInit();
    // init 完成后重新读取配置
    cfg = readConfig();
    if (!cfg || !cfg.server?.url) {
      console.log("❌ 配置未完成，无法启动");
      process.exit(1);
    }
  }
  if (!normalizeRuntime(cfg?.server?.runtime)) {
    console.log("🔧 Server Runtime 未配置，请先选择 Runtime...\n");
    await cmdInit();
    cfg = readConfig();
    if (!normalizeRuntime(cfg?.server?.runtime)) {
      console.log("❌ Runtime 未配置，无法启动 TUI");
      process.exit(1);
    }
  }

  // 同步工作区文件到 MAF_HOME（每次启动覆盖，确保升级后生效）
  syncWorkspace();

  // 确保依赖已安装（首次运行 npm install）
  const nodeModules = join(PACKAGE_ROOT, "node_modules");
  if (!existsSync(nodeModules)) {
    console.log("📦 首次运行，安装依赖...");
    execSync("npm install --production", { cwd: PACKAGE_ROOT, stdio: "inherit" });
  }

  // 启动 Server（后台）
  console.log(`🚀 启动 Server (port ${port})...`);

  const tsxBin = join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
  const serverEntry = join(PACKAGE_ROOT, "src", "index.ts");

  if (!existsSync(tsxBin)) {
    console.error("❌ tsx 未安装，运行: cd", PACKAGE_ROOT, "&& npm install");
    process.exit(1);
  }

  // Server 自身的 console.log 已经写 LOG_FILE，这里 stdout/stderr 丢弃避免重复
  const devNull = openSync("/dev/null", "w");
  const child = spawn(tsxBin, [serverEntry], {
    cwd: PACKAGE_ROOT,
    detached: true,
    stdio: ["ignore", devNull, devNull],
    env: {
      ...process.env,
      MAF_HOME,
      PORT: String(port),
    },
  });
  child.unref();
  stopServerOnTuiExit = process.env.MAF_SERVER_KEEP_ALIVE_ON_TUI_EXIT !== "1";
  if (stopServerOnTuiExit) {
    const cleanupOwnedServer = (signal) => {
      if (!stopServerOnTuiExit) return;
      stopServerOnTuiExit = false;
      console.log(`\n🧹 收到 ${signal}，停止本次 maf-server start 拉起的后台 Server...`);
      cmdStop();
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once("SIGINT", () => cleanupOwnedServer("SIGINT"));
    process.once("SIGTERM", () => cleanupOwnedServer("SIGTERM"));
  }

  // 写 PID（先用 spawn PID，稍后从端口查真实 PID）
  writeFileSync(PID_FILE, String(child.pid));

  // 等待就绪
  process.stdout.write("   等待就绪");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write(".");
    if (isServerRunning()) {
      // 从端口查出真正监听的进程 PID
      try {
        const ssOut = execSync(`ss -tlnp 2>/dev/null | grep ":${port} "`, { encoding: "utf-8", timeout: 3000 });
        const match = ssOut.match(/pid=(\d+)/);
        if (match) writeFileSync(PID_FILE, match[1]);
      } catch {}
      console.log(` ✅ (${i + 1}s)`);
      console.log("");
      cmdStatus();
      cmdTui();
      return;
    }
  }

  console.log(" ❌ 超时");
  console.log("   查看日志: maf-server logs");
  process.exit(1);
}

function cmdStop() {
  const port = getPort();

  // 先尝试从 PID 文件杀
  const pid = getServerPid();
  if (pid) {
    if (stopServerProcessSync(pid, "PID")) return;
    console.warn(`⚠️  PID 文件中的 Server 未能停止，继续按端口 ${port} 查找`);
  }

  // PID 文件不靠谱，从端口查
  const portPid = findServerPidByPort(port);
  if (portPid && stopServerProcessSync(portPid, `port ${port} PID`)) return;

  console.log("ℹ️  Server 未在运行");
}

async function cmdRestart() {
  cmdStop();
  await new Promise(r => setTimeout(r, 1500));
  await cmdStart();
}

function cmdStatus() {
  const port = getPort();
  const pid = getServerPid();
  const running = isServerRunning();

  console.log("┌─────────────────────────────────────────┐");
  console.log("│       Meta-Agent-Server                  │");
  console.log("└─────────────────────────────────────────┘");
  console.log(`  状态:     ${running ? "🟢 运行中" : "🔴 未运行"}`);
  console.log(`  端口:     ${port}`);
  if (pid) console.log(`  PID:      ${pid}`);
  console.log(`  数据目录: ${MAF_HOME}`);
  console.log(`  日志:     ${LOG_FILE}`);
  console.log(`  配置:     ${CONFIG_FILE}`);

  if (running) {
    try {
      const health = JSON.parse(execSync(`curl -s http://localhost:${port}/api/health`, { encoding: "utf-8", timeout: 3000 }));
      console.log(`  版本:     ${health.server_version || "?"}`);
      console.log(`  运行时间: ${Math.round(health.uptime / 60)}min`);
    } catch {}
    try {
      const agents = JSON.parse(execSync(`curl -s http://localhost:${port}/api/agents`, { encoding: "utf-8", timeout: 3000 }));
      const online = agents.filter(a => a.status === "online").length;
      console.log(`  Agents:   ${agents.length} 注册, ${online} 在线`);
    } catch {}
  }
  console.log("");
}

function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("ℹ️  暂无日志");
    return;
  }
  // tail -f 是永久阻塞的，用户 Ctrl+C 退出
  try {
    execSync(`tail -f "${LOG_FILE}"`, { stdio: "inherit" });
  } catch {
    // Ctrl+C 退出
  }
  process.exit(0);  // 直接退出，不走 main().then()
}

const RUNTIME_ALIASES = {
  opencode: "opencode",
  claude: "claude",
  "claude-code": "claude",
  cc: "claude",
  codex: "codex",
};

function normalizeRuntime(runtime) {
  if (!runtime) return "";
  return RUNTIME_ALIASES[String(runtime).trim()] || "";
}

function detectRuntime() {
  // 优先级：命令行参数（opencode/claude/codex）> 配置文件。
  // 不再根据已安装 CLI 自动选择，也不默认 opencode；首次运行必须显式选择。
  const argRuntime = normalizeRuntime(process.argv[3]);
  if (argRuntime) {
    saveRuntime(argRuntime);
    return argRuntime;
  }

  const cfg = readConfig();
  const cfgRuntime = normalizeRuntime(cfg?.server?.runtime);
  if (cfgRuntime) return cfgRuntime;

  return "";
}

function printRuntimeRequiredError() {
  console.error("❌ Server Runtime 未配置。");
  console.error("   Runtime 是首次运行必须明确选择的选项，不会默认使用 runtime。");
  console.error("");
  console.error("   请选择一种方式配置：");
  console.error("     maf-server init");
  console.error("     maf-server tui opencode");
  console.error("     maf-server tui claude");
  console.error("     maf-server tui codex");
  console.error("");
}

/** 获取 tui/resume 命令后面的额外参数（排除 runtime 参数） */
function getTuiExtraArgs() {
  const args = process.argv.slice(3);
  if (args[0] && normalizeRuntime(args[0])) {
    return args.slice(1).join(" ");
  }
  return args.join(" ");
}

function saveRuntime(runtime) {
  try {
    const cfg = readConfig() || {};
    if (!cfg.server) cfg.server = {};
    cfg.server.runtime = runtime;
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  } catch {}
}

function codexMetaServerEnv() {
  return {
    ...process.env,
    MAF_AGENT_NAME: "Meta-Agent-Server",
    MAF_RUNTIME: "codex",
    MAF_DIRECTORY: MAF_HOME,
    CODEX_CWD: MAF_HOME,
    META_AGENT_SERVER: process.env.META_AGENT_SERVER || `http://127.0.0.1:${getPort()}`,
  };
}

/**
 * 从 opencode DB 查找指定 agent 在指定目录的最近 session ID
 */
function findLastSession(agent, directory) {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return null;

  // 优先按 agent + directory 精确匹配
  let query;
  if (agent && directory) {
    query = `SELECT id FROM session WHERE agent = '${agent}' AND directory = '${directory}' ORDER BY time_updated DESC LIMIT 1;`;
  } else if (agent) {
    query = `SELECT id FROM session WHERE agent = '${agent}' ORDER BY time_updated DESC LIMIT 1;`;
  } else if (directory) {
    query = `SELECT id FROM session WHERE directory = '${directory}' ORDER BY time_updated DESC LIMIT 1;`;
  } else {
    return null;
  }

  try {
    const result = execSync(`sqlite3 "${dbPath}" "${query}"`, { encoding: "utf-8", timeout: 3000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function cmdTui() {
  // 在包目录下启动 TUI agent（支持 opencode / claude / codex）
  if (!isServerRunning()) {
    console.log("⚠️  Server 未运行，先启动...");
    execSync(`node "${join(PACKAGE_ROOT, "bin", "maf-server.mjs")}" start`, { stdio: "inherit" });
    process.exit(0);
  }

  const runtime = detectRuntime();
  if (!runtime) {
    printRuntimeRequiredError();
    process.exit(1);
  }

  // 确保工作区已同步
  syncWorkspace();

  const extraArgs = getTuiExtraArgs();

  console.log(`📂 工作目录: ${MAF_HOME}`);
  console.log(`🤖 运行时:   ${runtime}`);

  let exitCode = 0;
  try {
    if (runtime === "opencode") {
      const cmd = `opencode --agent Meta-Agent-Server --hostname localhost ${extraArgs}`.trim();
      execSync(cmd, { cwd: MAF_HOME, stdio: "inherit" });
    } else if (runtime === "codex") {
      const cmd = `codex -C "${MAF_HOME}" ${extraArgs}`.trim();
      execSync(cmd, { cwd: MAF_HOME, stdio: "inherit", env: codexMetaServerEnv() });
    } else {
      const cmd = `claude ${extraArgs}`.trim();
      execSync(cmd, { cwd: MAF_HOME, stdio: "inherit" });
    }
  } catch (err) {
    // 用户退出 TUI
    exitCode = err?.signal === "SIGINT" ? 130 : (typeof err?.status === "number" ? err.status : 0);
  } finally {
    if (stopServerOnTuiExit) {
      stopServerOnTuiExit = false;
      console.log("\n🧹 TUI 已退出，停止本次 maf-server start 拉起的后台 Server...");
      cmdStop();
    }
  }

  process.exit(exitCode);
}

function cmdResume() {
  // 恢复上一个 session（自动查 DB，不依赖当前目录）
  if (!isServerRunning()) {
    console.log("⚠️  Server 未运行，先启动...");
    execSync(`node "${join(PACKAGE_ROOT, "bin", "maf-server.mjs")}" start`, { stdio: "inherit" });
  }

  const runtime = detectRuntime();
  if (!runtime) {
    printRuntimeRequiredError();
    process.exit(1);
  }

  // 确保工作区已同步
  syncWorkspace();

  const extraArgs = getTuiExtraArgs();

  if (runtime === "opencode") {
    // 从 opencode DB 按 agent 名查最近 session（不限目录，全局命令不依赖 cwd）
    const lastSession = findLastSession("Meta-Agent-Server", null);

    if (!lastSession) {
      console.log("ℹ️  没有找到上一个 session，启动新会话...\n");
      cmdTui();
      return;
    }

    // 查 session 详情（含 directory）
    const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
    let sessionDir = MAF_HOME;
    let title = "";
    let updated = "";
    try {
      const info = execSync(
        `sqlite3 "${dbPath}" "SELECT title, directory, datetime(time_updated/1000, 'unixepoch', 'localtime') FROM session WHERE id = '${lastSession}';"`,
        { encoding: "utf-8", timeout: 3000 }
      ).trim();
      const parts = info.split("|");
      title = parts[0] || "";
      sessionDir = parts[1] || MAF_HOME;
      updated = parts[2] || "";
    } catch {}

    console.log(`\n  🔄 恢复 Meta-Agent-Server session`);
    console.log(`  ────────────────────────────────────`);
    console.log(`  Session: ${lastSession}`);
    if (title) console.log(`  Title:   ${title}`);
    console.log(`  Dir:     ${sessionDir}`);
    if (updated) console.log(`  Updated: ${updated}`);
    console.log(`  ────────────────────────────────────\n`);

    const cmd = `opencode --agent Meta-Agent-Server --hostname localhost --session ${lastSession} ${extraArgs}`.trim();
    try {
      execSync(cmd, { cwd: sessionDir, stdio: "inherit" });
    } catch {
      // 用户退出 TUI
    }
  } else if (runtime === "codex") {
    // Codex: 恢复最近对话，cwd 切到 MAF_HOME
    console.log(`\n  🔄 恢复 Codex session (--last --all)\n`);
    const cmd = `codex resume --last --all -C "${MAF_HOME}" ${extraArgs}`.trim();
    try {
      execSync(cmd, { cwd: MAF_HOME, stdio: "inherit", env: codexMetaServerEnv() });
    } catch {
      // 用户退出
    }
  } else {
    // Claude Code: --continue 恢复最近对话，cwd 切到 MAF_HOME
    console.log(`\n  🔄 恢复 Claude Code session (--continue)\n`);
    const cmd = `claude --continue ${extraArgs}`.trim();
    try {
      execSync(cmd, { cwd: MAF_HOME, stdio: "inherit" });
    } catch {
      // 用户退出
    }
  }

  process.exit(0);
}

function cmdVersion() {
  console.log(`maf-server v${PACKAGE_VERSION}`);
}

function cmdUninstall() {
  console.log("🗑  卸载 Meta-Agent-Framework Server...\n");

  // 停止 Server
  if (isServerRunning()) {
    cmdStop();
  }

  // 清理数据目录
  try {
    execSync(`rm -rf "${MAF_HOME}"`, { stdio: "ignore" });
    console.log(`  ✅ 已删除数据目录: ${MAF_HOME}`);
  } catch {}

  console.log("\n✅ Server 卸载完成");
  console.log("  移除 npm 包: npm uninstall -g @maf/meta-agent-server\n");

  // 最后一步：卸载自己（执行后 maf-server 命令不再可用）
  try {
    execSync("npm uninstall -g @maf/meta-agent-server", { cwd: homedir(), stdio: "inherit" });
  } catch {}
}

function cmdHelp() {
  console.log(`
Meta-Agent-Framework Server

用法: maf-server <command> [runtime]

命令:
  init          交互式初始化 / 重写 Server 配置
  start         启动 Server（首次自动配置）
  stop          停止 Server
  restart       重启 Server
  resume        恢复上一个 session（自动查找最近对话）
  tui [runtime] 启动新交互界面（opencode / claude / codex）
  status        查看运行状态
  logs          查看日志（tail -f）
  version       版本信息
  uninstall     卸载 Server（停止 + 清数据 + 删包）
  help          显示此帮助

数据目录: ${MAF_HOME}

快速开始:
  1. maf-server init          # 交互式初始化 / 修改配置（首次必须选择 Runtime）
  2. maf-server start         # 启动 Server（未配置时会自动 init）
  3. maf-server resume        # 恢复上次对话（最常用！）
  4. maf-server tui           # 启动全新会话
  5. maf-server tui [claude/codex/opencode]    # 用 Claude/codex/opencode 启动新会话
`);
}

// ============================================================
// 入口
// ============================================================

const cmd = process.argv[2] || "help";

async function main() {
  switch (cmd) {
    case "init":    await cmdInit(); break;
    case "start":   await cmdStart(); break;
    case "stop":    cmdStop(); break;
    case "restart": await cmdRestart(); break;
    case "resume": case "r": cmdResume(); break;
    case "tui":     cmdTui(); break;
    case "status":  cmdStatus(); break;
    case "logs":    cmdLogs(); break;
    case "uninstall": cmdUninstall(); break;
    case "version": case "--version": case "-v": cmdVersion(); break;
    case "help": case "--help": case "-h": cmdHelp(); break;
    case "sync-plugins": syncWorkspace(); break;
    default:
      console.error(`未知命令: ${cmd}`);
      cmdHelp();
      process.exit(1);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error("❌", err.message);
  process.exit(1);
});
