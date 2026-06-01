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
 *   state/      PID、日志
 *   maf.config.json  配置文件
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, cpSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ============================================================
// 路径常量
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");  // npm 包的根目录

const MAF_HOME = process.env.MAF_HOME || join(homedir(), ".meta-agent-framework");
const STATE_DIR = join(MAF_HOME, "state");
const PID_FILE = join(STATE_DIR, "server.pid");
const LOG_FILE = join(STATE_DIR, "server.log");
const CONFIG_FILE = join(MAF_HOME, "maf.config.json");

// 确保目录
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(MAF_HOME, "data"), { recursive: true });

// ============================================================
// 工作区同步：将 npm 包中的 agent/hook/scripts 同步到 MAF_HOME
// ============================================================

/** 需要覆盖同步的文件/目录（代码、脚本，升级必须用新版） */
const SYNC_OVERWRITE = [
  ".claude",                 // claude hooks 配置
  "CLAUDE.md",              // claude system prompt
  "opencode.json",           // opencode 配置（instructions 引用 user/*.md）
  "scripts/maf-server-hook.mjs",  // claude asyncRewake hook
  "scripts/check-write-path.mjs", // 文件写入保护 hook
  "scripts/poll-workflow.sh",     // 工作流轮询脚本
  "scripts/push-skill.sh",       // skill 推送脚本
];

/** 需要"只创建不覆盖"的目录（用户可能积累了修改） */
const SYNC_NO_CLOBBER = [
  ".opencode",               // opencode agent 定义 + rules + skills（用户会修改）
];

/**
 * 递归同步目录，但已存在的文件不覆盖。
 * 只创建目标中不存在的文件（新增文件能同步过去，已有文件保留用户修改）。
 */
function syncNoClobber(srcDir, dstDir) {
  if (!existsSync(srcDir)) return;
  mkdirSync(dstDir, { recursive: true });

  let entries;
  try { entries = readdirSync(srcDir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);

    if (entry.isDirectory()) {
      syncNoClobber(srcPath, dstPath);
    } else {
      // 只在目标不存在时才拷贝
      if (!existsSync(dstPath)) {
        try { copyFileSync(srcPath, dstPath); } catch {}
      }
    }
  }
}

/**
 * 同步工作区文件到 MAF_HOME。
 * - 代码/脚本：每次覆盖（确保升级后新版本生效）
 * - Agent 定义/规则(.opencode)：只创建不覆盖（保护用户积累的修改）
 * 同时同步 opencode Plugin 到 ~/.config/opencode/plugins/。
 */
function syncWorkspace() {
  mkdirSync(join(MAF_HOME, "scripts"), { recursive: true });

  // 覆盖同步：代码/脚本（升级必须用新版）
  for (const item of SYNC_OVERWRITE) {
    const src = join(PACKAGE_ROOT, item);
    const dst = join(MAF_HOME, item);
    if (!existsSync(src)) continue;

    try {
      cpSync(src, dst, { recursive: true, force: true });
    } catch {}
  }

  // 不覆盖同步：agent/rules/skills（保护用户修改）
  for (const item of SYNC_NO_CLOBBER) {
    const src = join(PACKAGE_ROOT, item);
    const dst = join(MAF_HOME, item);
    if (!existsSync(src)) continue;

    syncNoClobber(src, dst);
  }

  // 同步 opencode Plugin（代码，覆盖）
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
}

// ============================================================
// 工具函数
// ============================================================

function getLocalIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (!iface.internal && iface.family === "IPv4") return iface.address;
    }
  }
  return "127.0.0.1";
}

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

function isServerRunning() {
  const port = getPort();
  try {
    execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/api/health`, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
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

  // 首次运行：检测不到配置 → 自动进入 init 流程
  const cfg = readConfig();
  if (!cfg || !cfg.server?.url) {
    console.log("🔧 首次运行，进入配置流程...\n");
    await cmdInit();
    // init 完成后重新读取配置
    const newCfg = readConfig();
    if (!newCfg || !newCfg.server?.url) {
      console.log("❌ 配置未完成，无法启动");
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
    try {
      process.kill(pid, "SIGTERM");
      console.log(`✅ Server 已停止 (PID: ${pid})`);
      try { unlinkSync(PID_FILE); } catch {}
      return;
    } catch {}
  }

  // PID 文件不靠谱，从端口查
  try {
    const ssOut = execSync(`ss -tlnp 2>/dev/null | grep ":${port} "`, { encoding: "utf-8", timeout: 3000 });
    const match = ssOut.match(/pid=(\d+)/);
    if (match) {
      process.kill(parseInt(match[1]), "SIGTERM");
      console.log(`✅ Server 已停止 (PID: ${match[1]}, port ${port})`);
      try { unlinkSync(PID_FILE); } catch {}
      return;
    }
  } catch {}

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

function detectRuntime() {
  // 优先级：命令行参数（仅 opencode/claude）> 配置文件 > 默认 opencode
  const argRuntime = process.argv[3];
  if (argRuntime && ["opencode", "claude"].includes(argRuntime)) {
    saveRuntime(argRuntime);
    return argRuntime;
  }

  const cfg = readConfig();
  if (cfg?.server?.runtime) return cfg.server.runtime;

  return "opencode";
}

/** 获取 tui 命令后面的额外参数（排除 runtime 参数） */
function getTuiExtraArgs() {
  const args = process.argv.slice(3);
  if (args[0] && ["opencode", "claude"].includes(args[0])) {
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
  // 在包目录下启动 TUI agent（支持 opencode 和 claude）
  if (!isServerRunning()) {
    console.log("⚠️  Server 未运行，先启动...");
    execSync(`node "${join(PACKAGE_ROOT, "bin", "maf-server.mjs")}" start`, { stdio: "inherit" });
  }

  const runtime = detectRuntime();
  if (!runtime) {
    console.error("❌ 未检测到 opencode 或 claude，请先安装其中之一：");
    console.error("   opencode: https://opencode.ai");
    console.error("   claude:   npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  // 确保工作区已同步
  syncWorkspace();

  const extraArgs = getTuiExtraArgs();

  console.log(`📂 工作目录: ${MAF_HOME}`);
  console.log(`🤖 运行时:   ${runtime}`);

  try {
    if (runtime === "opencode") {
      const cmd = `opencode --agent Meta-Agent-Server --hostname localhost ${extraArgs}`.trim();
      execSync(cmd, { cwd: MAF_HOME, stdio: "inherit" });
    } else {
      const cmd = `claude ${extraArgs}`.trim();
      execSync(cmd, { cwd: MAF_HOME, stdio: "inherit" });
    }
  } catch {
    // 用户退出 TUI
  }

  process.exit(0);
}

function cmdResume() {
  // 恢复上一个 session（自动查 DB，不依赖当前目录）
  if (!isServerRunning()) {
    console.log("⚠️  Server 未运行，先启动...");
    execSync(`node "${join(PACKAGE_ROOT, "bin", "maf-server.mjs")}" start`, { stdio: "inherit" });
  }

  const runtime = detectRuntime();
  if (!runtime) {
    console.error("❌ 未检测到 opencode 或 claude");
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
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
    console.log(`maf-server v${pkg.version}`);
  } catch {
    console.log("maf-server (version unknown)");
  }
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
  start         启动 Server（首次自动配置）
  stop          停止 Server
  restart       重启 Server
  resume        恢复上一个 session（自动查找最近对话）
  tui [runtime] 启动新交互界面（opencode 或 claude）
  status        查看运行状态
  logs          查看日志（tail -f）
  version       版本信息
  uninstall     卸载 Server（停止 + 清数据 + 删包）
  help          显示此帮助

数据目录: ${MAF_HOME}

快速开始:
  1. maf-server start         # 首次自动配置 + 启动
  2. maf-server resume        # 恢复上次对话（最常用！）
  3. maf-server tui           # 启动全新会话
  4. maf-server tui claude    # 用 Claude Code 启动新会话
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
