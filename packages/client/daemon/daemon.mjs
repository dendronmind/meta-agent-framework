#!/usr/bin/env node
/**
 * Meta-Agent-Framework Node Daemon（驻地代理）
 *
 * 一台机器一个常驻进程，管理本机所有 agent。
 * 支持 opencode Plugin、Claude Code hook，以及 Codex attached/detached 两种投递语义。
 *
 * 职责：
 *   1. 管理本机所有 agent（注册/心跳/状态跟踪）
 *   2. 扫描 skills/mcps 上报（机器级别，所有 agent 共享）
 *   3. 按 agent_name 路由任务（Server → Daemon → 对应 Plugin/Hook）
 *   4. 接收 OTA → 更新自身 → 自重启
 *   5. HTTP server 供 Server 和 Plugin/Hook 通信
 *
 * 环境变量：
 *   MAF_NODE_PORT      — HTTP 端口（默认 4100）
 *   MAF_AGENT_NAME     — 初始 agent 名称（可选，Claude Code --daemon 传入）
 *   MAF_RUNTIME        — 初始 agent 的运行时：opencode（默认）| claude-code | codex
 *   MAF_DIRECTORY      — 工作目录
 *   MAF_PLUGIN_DIR     — Plugin 安装目录
 *   MAF_PARENT_PID     — 仅 Claude Code 首次拉起时使用（不再跟随退出）
 *   MAF_CODEX_DELIVERY  — Codex 投递语义：attached（默认）| detached | auto
 */

import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, userInfo, networkInterfaces } from "node:os";
import { createHash } from "node:crypto";

// ============================================================
// 配置（从 maf.config.json / 环境变量读取）
// ============================================================

/** 读取 maf.config.json（全局 > 项目级），环境变量优先 */
function loadMafConfig() {
  const paths = [
    join(homedir(), ".meta-agent-framework", "maf.config.json"),
    join(process.cwd(), "maf.config.json"),
  ];
  let cfg = {};
  for (const p of paths) {
    try { if (existsSync(p)) cfg = { ...cfg, ...JSON.parse(readFileSync(p, "utf-8")) }; } catch {}
  }
  return cfg;
}
const _mafCfg = loadMafConfig();

const NODE_PORT = parseInt(process.env.MAF_NODE_PORT || "0") || parseInt(process.env.MAF_DAEMON_PORT || "0") || _mafCfg.daemon?.port || 4100;
const DIRECTORY = process.env.MAF_DIRECTORY || process.cwd();
const PLUGIN_DIR = process.env.MAF_PLUGIN_DIR || dirname(new URL(import.meta.url).pathname);
const META_AGENT_SERVER = process.env.META_AGENT_SERVER || _mafCfg.server?.url || "";
if (!META_AGENT_SERVER) {
  console.error("[node-daemon] ❌ META_AGENT_SERVER 未配置！运行 npm run init 或设置环境变量 META_AGENT_SERVER");
}
const CLIENT_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf-8")).version || "0.0.0"; }
  catch { return "0.0.0"; }
})();
const HEARTBEAT_INTERVAL = 1_000;
const POLL_INTERVAL = 1_000;
const STATE_DIR = join(homedir(), ".meta-agent-framework");
const SERVER_AGENT_NAME = "Meta-Agent-Server";

function isServerAgentName(name) {
  return String(name || "").trim() === SERVER_AGENT_NAME;
}

process.title = "MAF_Node_Daemon";
mkdirSync(STATE_DIR, { recursive: true });

// ============================================================
// 日志
// ============================================================
const LOG_DIR = join(STATE_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "client-daemon.log");
mkdirSync(LOG_DIR, { recursive: true });
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} [node-daemon] ${msg}`;
  // 只写文件，不用 console.error（detached 进程 stderr 可能 EPIPE）
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
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

function fileHash(path) {
  try { return createHash("sha256").update(readFileSync(path, "utf-8")).digest("hex").substring(0, 16); } catch { return ""; }
}

function detectUserId() {
  if (process.env.MAF_USER_ID) return process.env.MAF_USER_ID;
  try {
    return execSync("git config user.email", { encoding: "utf-8" }).trim().split("@")[0];
  } catch { return userInfo().username; }
}

const DAEMON_SELF_HASH = fileHash(join(PLUGIN_DIR, "daemon.mjs"));

// ============================================================
// Agent Manager — 管理本机所有 agent
// ============================================================
// agents Map: agent_name → { runtime, pluginPid, directory, registered, sessionId, lastSeen }
const agents = new Map();

// 每个 agent 独立的任务队列
// taskQueues Map: agent_name → { pending, lastExecuted, waitingResponse, executingTaskId }
const taskQueues = new Map();

// Workflow 跟踪表：记录经过此 Daemon 的所有 workflow 任务状态
// workflowTracker Map: workflow_id → { title, agent_name, node_id, status, dispatched_at, completed_at, result }
const workflowTracker = new Map();

let userId = "";
let hostUser = userInfo().username;
let daemonUrl = "";
let lastInventoryFP = "";

// agent 存活检测：Plugin/Wait 通过 long-poll 或 connect 保持心跳
// 超过此时间未活跃视为 offline（Plugin 退出但 disconnect 没发出的情况）
const AGENT_ALIVE_TIMEOUT = 5_000;  // 5s（long-poll 2s 周期 × 2 + 裕量）

const MAX_QUEUE_SIZE = 10;
const CODEX_TASK_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_TIMEOUT_MS || "0") || 330_000;
const CODEX_SANDBOX = process.env.MAF_CODEX_SANDBOX || "workspace-write";
const CODEX_BYPASS_SANDBOX = process.env.MAF_CODEX_BYPASS_SANDBOX === "1" || process.env.MAF_CODEX_DANGEROUS_BYPASS === "1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODE = process.env.MAF_CODEX_MODE || "tui"; // tui（screen + Codex TUI）| exec（headless）
const CODEX_DELIVERY = normalizeCodexDelivery(process.env.MAF_CODEX_DELIVERY || "attached");
const codexQueueRunners = new Set();
const codexTaskScreens = new Map(); // task_id → { agentName, screenName, startedAt, lastTaskAt }

function normalizeCodexDelivery(value) {
  const v = String(value || "attached").trim().toLowerCase();
  if (["detached", "screen", "tui", "daemon", "offline"].includes(v)) return "detached";
  if (["auto", "fallback"].includes(v)) return "auto";
  return "attached";
}

function codexDeliveryForTask(task = {}) {
  if (task.detached === true) return "detached";
  if (task.detached === false) return "attached";

  const direct = task.delivery_mode ?? task.deliveryMode ?? task.execution_mode ?? task.executionMode;
  if (direct) return normalizeCodexDelivery(direct);

  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : null;
  if (metadata) {
    if (metadata.detached === true) return "detached";
    if (metadata.detached === false) return "attached";
    const metaDelivery = metadata.delivery_mode ?? metadata.deliveryMode ?? metadata.execution_mode ?? metadata.executionMode;
    if (metaDelivery) return normalizeCodexDelivery(metaDelivery);
  }

  return CODEX_DELIVERY;
}

function hasCodexAttachedReceiver(agentName) {
  const q = taskQueues.get(agentName);
  if (q?.waitingResponse) return true;
  const info = agents.get(agentName);
  return Boolean(info?.pluginPid && isProcessAlive(info.pluginPid));
}

function codexEffectiveDelivery(agentName, task = {}) {
  const requested = codexDeliveryForTask(task);
  if (requested === "auto") return hasCodexAttachedReceiver(agentName) ? "attached" : "detached";
  return requested;
}

function codexShouldRunDetached(agentName, task = {}) {
  return codexEffectiveDelivery(agentName, task) === "detached";
}

function codexAttachedUnavailableMessage(agentName, task = {}) {
  const requested = codexDeliveryForTask(task);
  return `Codex attached delivery 当前不可用：agent=${agentName}, requested=${requested}。当前 Codex 尚无可被 Daemon 主动注入任务的附着 TUI 接收器；如需离线 screen+TUI 执行，请设置 MAF_CODEX_DELIVERY=detached/auto 或在任务中传 detached=true。`;
}

function getAgentQueue(agentName) {
  if (!taskQueues.has(agentName)) {
    taskQueues.set(agentName, { pending: [], lastExecuted: null, waitingResponse: null, executingTaskId: null });
  }
  return taskQueues.get(agentName);
}

/** 更新 agent 最后活跃时间 */
function touchAgent(agentName) {
  const info = agents.get(agentName);
  if (info) info.lastSeen = Date.now();
}

/** 检查 Plugin 进程是否存活（通过 /proc/{pid}） */
function isProcessAlive(pid) {
  if (!pid) return false;
  try { return existsSync(`/proc/${pid}`); } catch { return false; }
}

/**
 * 清理已死的 agent：Plugin 进程死了 + lastSeen 超时 + 没在执行任务 + 没有 screen 在跑
 * 从 agents Map 移除，不再上报给 Server，让 Server 自然心跳超时降级
 */
function pruneDeadAgents() {
  const now = Date.now();
  for (const [name, info] of agents) {
    const q = taskQueues.get(name);
    if (q?.executingTaskId) continue;  // 正在执行任务，不清理

    // Codex 注册信息需要保留；是否 online 由 getAgentStatuses 根据 delivery/receiver 判定。
    if (info.runtime === "codex") continue;

    // Plugin 进程还活着，不清理
    if (info.pluginPid && isProcessAlive(info.pluginPid)) continue;

    // claude-code 模式：--wait 每 10s poll 刷新 lastSeen，15s 无刷新 = 死了
    const timeout = info.runtime === "claude-code" ? 15_000 : AGENT_ALIVE_TIMEOUT;
    if (info.lastSeen && now - info.lastSeen <= timeout) continue;

    // 有 screen 在跑（按需拉起的 TUI），不清理
    const screenName = `maf-${name}`;
    try {
      const check = execSync(`screen -ls ${screenName} 2>/dev/null`, { encoding: "utf-8", timeout: 2000 });
      if (check.includes(screenName)) continue;
    } catch {}

    // 确认死了，移除
    agents.delete(name);
    if (q?.waitingResponse) {
      try { q.waitingResponse.writeHead(200, { "Content-Type": "application/json" }); q.waitingResponse.end('{"task":null}'); } catch {}
    }
    taskQueues.delete(name);
    log(`🗑 agent ${name} 已移除（Plugin 进程死亡 + 无 screen）`);
  }
}

function getAgentStatuses() {
  const now = Date.now();
  const statuses = {};
  for (const [name, info] of agents) {
    const q = taskQueues.get(name);

    // Codex：默认 attached 语义下，只有当前 TUI 接收器存在才 online；
    // detached/auto 是显式允许 Daemon 通过 screen/exec 兜底执行。
    if (info.runtime === "codex") {
      if (q?.executingTaskId) {
        statuses[name] = "busy";
      } else {
        statuses[name] = (CODEX_DELIVERY !== "attached" || hasCodexAttachedReceiver(name)) ? "online" : "offline";
      }
      continue;
    }

    // claude-code 模式：--wait 进程每 10s poll 一次刷新 lastSeen
    // lastSeen 在 15s 内 → 在线（--wait 活着）；超过 → 离线（--wait 死了）
    if (info.runtime === "claude-code") {
      if (q?.executingTaskId) {
        statuses[name] = "busy";
      } else if (info.pluginPid && isProcessAlive(info.pluginPid)) {
        statuses[name] = "online";
      } else if (info.lastSeen && now - info.lastSeen <= 15_000) {
        statuses[name] = "online";
      } else {
        // lastSeen 超时，检查是否有 screen 在跑（按需拉起的）
        const screenName = `maf-${name}`;
        let hasScreen = false;
        try {
          const check = execSync(`screen -ls ${screenName} 2>/dev/null`, { encoding: "utf-8", timeout: 2000 });
          hasScreen = check.includes(screenName);
        } catch {}
        statuses[name] = hasScreen ? "online" : "offline";
      }
      continue;
    }

    // opencode 模式：优先看任务执行状态
    if (q?.executingTaskId) {
      // 正在执行任务 → busy（即使 long-poll 暂时停了也不影响）
      // 兜底：检查 Plugin 进程是否还活着
      if (isProcessAlive(info.pluginPid)) {
        statuses[name] = "busy";
      } else {
        // Plugin 进程已死，但任务没有完成 → 标记 offline（靠 Server 超时处理）
        log(`⚠ ${name} 正在执行任务但 Plugin(pid=${info.pluginPid}) 已死`);
        q.executingTaskId = null;
        statuses[name] = "offline";
      }
    } else if (info.lastSeen && now - info.lastSeen > AGENT_ALIVE_TIMEOUT) {
      // 没在执行任务 + lastSeen 超时
      // 兜底：检查 Plugin 进程是否还活着（进程在但事件循环忙 → online）
      if (isProcessAlive(info.pluginPid)) {
        statuses[name] = "online";
      } else {
        statuses[name] = "offline";
      }
    } else {
      statuses[name] = "online";
    }
  }
  return statuses;
}

// ============================================================
// Serve 进程管理 — 按需拉起 opencode serve 执行任务
// ============================================================
// serveProcesses Map: agent_name → { proc, port, startedAt, lastTaskAt }
const serveProcesses = new Map();
const SERVE_IDLE_TIMEOUT = 10 * 60_000; // 10 分钟无任务自动退出

/**
 * 按需拉起 opencode TUI（通过 screen 运行在虚拟终端中）
 * opencode TUI 加载 Plugin → Plugin connect Daemon → long-poll 接任务
 * 用户可通过 screen -r maf-{agent} 附上去查看/操作
 * 返回 true=拉起成功, false=失败
 */
async function spawnAgent(agentName, projectPath, agentRuntime) {
  const screenName = `maf-${agentName}`;

  // 已有 screen 在跑，直接复用
  const existing = serveProcesses.get(agentName);
  if (existing) {
    try {
      const check = execSync(`screen -ls ${screenName} 2>/dev/null`, { encoding: "utf-8" });
      if (check.includes(screenName)) {
        existing.lastTaskAt = Date.now();
        return true;
      }
    } catch {}
    // screen 不在了，清理
    serveProcesses.delete(agentName);
  }

  const rawCwd = projectPath || DIRECTORY;
  const cwd = rawCwd.startsWith("~") ? rawCwd.replace(/^~/, homedir()) : rawCwd;
  const agentInfo = agents.get(agentName);
  const runtime = agentRuntime || agentInfo?.runtime || "opencode";

  if (runtime === "codex") {
    log(`ℹ️ codex runtime 由 Daemon 任务队列通过 screen + Codex TUI 执行: ${agentName}`);
    return true;
  }

  // 预检查
  try { execSync("which screen", { stdio: "ignore", timeout: 2000 }); } catch {
    log(`❌ screen 未安装，无法拉起 agent`);
    return false;
  }

  const cli = runtime === "claude-code" ? "claude" : "opencode";
  try { execSync(`which ${cli}`, { stdio: "ignore", timeout: 2000 }); } catch {
    log(`❌ ${cli} 未安装，无法拉起 ${runtime} agent`);
    return false;
  }

  if (!existsSync(cwd)) {
    log(`❌ 目录不存在: ${cwd}`);
    return false;
  }

  // 根据 runtime 构建拉起命令
  let cmd;
  if (runtime === "claude-code") {
    cmd = `screen -dmS ${screenName} bash -c 'cd "${cwd}" && claude --agent ${agentName}'`;
    log(`🚀 拉起 claude TUI (screen): agent=${agentName} cwd=${cwd} session=${screenName}`);
  } else {
    cmd = `screen -dmS ${screenName} bash -c 'cd "${cwd}" && export MAF_INITIAL_AGENT=${agentName} && opencode --agent ${agentName} --hostname localhost'`;
    log(`🚀 拉起 opencode TUI (screen): agent=${agentName} cwd=${cwd} session=${screenName}`);
  }

  try {
    execSync(cmd, { timeout: 5000, stdio: "ignore" });
  } catch (err) {
    log(`❌ screen 拉起失败: ${err.message}`);
    return false;
  }

  serveProcesses.set(agentName, {
    proc: null,  // screen 管理进程，不需要直接引用
    screenName,
    startedAt: Date.now(),
    lastTaskAt: Date.now(),
  });

  log(`✅ screen session 已创建: ${screenName}`);

  // 等 Plugin connect + long-poll 就绪
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (agents.has(agentName)) {
      const q = taskQueues.get(agentName);
      if (q?.waitingResponse) {
        log(`✅ agent 就绪: ${agentName} (${i + 1}s)`);
        return true;
      }
    }
  }
  log(`⚠ agent 未就绪（任务仍在队列等待）: ${agentName}`);
  return true; // screen 在跑，Plugin 可能稍后就绪
}

/** 清理空闲的 screen 进程 */
function cleanIdleServes() {
  const now = Date.now();
  for (const [name, info] of serveProcesses) {
    if (agents.get(name)?.runtime === "codex") continue;
    if (now - info.lastTaskAt > SERVE_IDLE_TIMEOUT) {
      log(`🗑 agent 空闲超时，关闭 screen: ${name} (${info.screenName})`);
      try { execSync(`screen -S ${info.screenName} -X quit 2>/dev/null`, { stdio: "ignore" }); } catch {}
      serveProcesses.delete(name);
    }
  }
  for (const [taskId, info] of codexTaskScreens) {
    if (now - info.lastTaskAt > SERVE_IDLE_TIMEOUT) {
      log(`🗑 Codex screen 空闲超时，关闭: ${info.screenName}`);
      try { execSync(`screen -S ${info.screenName} -X quit 2>/dev/null`, { stdio: "ignore" }); } catch {}
      codexTaskScreens.delete(taskId);
    }
  }
}

/** 清理所有 screen 进程（Daemon 退出时） */
function cleanAllServes() {
  for (const [name, info] of serveProcesses) {
    try { execSync(`screen -S ${info.screenName} -X quit 2>/dev/null`, { stdio: "ignore" }); } catch {}
  }
  serveProcesses.clear();
  for (const [, info] of codexTaskScreens) {
    try { execSync(`screen -S ${info.screenName} -X quit 2>/dev/null`, { stdio: "ignore" }); } catch {}
  }
  codexTaskScreens.clear();
}

/** 定期清理长期不活跃的 agent（1 小时无活跃则移除，仅清理真正被遗忘的残留） */
function cleanDeadAgents() {
  const now = Date.now();
  const DEAD_TIMEOUT = 60 * 60_000;
  for (const [name, info] of agents) {
    if (info.runtime === "codex") continue;
    if (now - (info.lastSeen || 0) > DEAD_TIMEOUT) {
      agents.delete(name);
      const q = taskQueues.get(name);
      if (q?.waitingResponse) {
        try { q.waitingResponse.writeHead(200, { "Content-Type": "application/json" }); q.waitingResponse.end('{"task":null}'); } catch {}
      }
      taskQueues.delete(name);
      log(`🗑 agent ${name} 长期不活跃，已移除`);
    }
  }
}

// ============================================================
// Skills / MCPs 扫描（机器级别，所有 agent 共享）
// ============================================================
function readSkillDescription(skillMdPath) {
  try {
    const content = readFileSync(skillMdPath, "utf-8");

    // Prefer YAML frontmatter description for Codex/Claude/opencode skill files.
    if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
      const endIdx = content.indexOf("\n---", 3);
      if (endIdx !== -1) {
        const fm = content.slice(4, endIdx);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        if (descMatch?.[1]?.trim()) {
          const desc = descMatch[1].trim().replace(/^['"]|['"]$/g, "");
          if (desc) return desc.substring(0, 200);
        }
      }
    }

    // Fallback for older skill files without frontmatter.
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#") && t !== "---") return t.substring(0, 200);
    }
  } catch {}
  return undefined;
}

function scanSkills() {
  const dirs = [
    join(DIRECTORY, ".opencode", "skills"),
    join(DIRECTORY, ".claude", "skills"),
    join(DIRECTORY, ".codex", "skills"),
    join(DIRECTORY, ".agents", "skills"),
    join(homedir(), ".config", "opencode", "skills"),
    join(homedir(), ".opencode", "skills"),
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".agents", "skills"),
  ];
  const seen = new Set();
  const skills = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory() || seen.has(e.name) || e.name.startsWith("_") || e.name.startsWith(".")) continue;
        seen.add(e.name);
        const skill = { name: e.name };
        const md = join(d, e.name, "SKILL.md");
        if (existsSync(md)) {
          const description = readSkillDescription(md);
          if (description) skill.description = description;
        }
        skills.push(skill);
      }
    } catch {}
  }
  return skills;
}

function scanMcps() {
  const opencodePaths = [
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".opencode", "opencode.json"),
    join(DIRECTORY, "opencode.json"),
    join(DIRECTORY, ".opencode", "opencode.json"),
  ];
  const claudePaths = [
    join(DIRECTORY, ".mcp.json"),
    join(homedir(), ".claude", ".mcp.json"),
    join(homedir(), ".claude", "claude_desktop_config.json"),
  ];
  const codexPaths = [
    join(homedir(), ".codex", "config.toml"),
    join(DIRECTORY, ".codex", "config.toml"),
  ];
  const seen = new Set();
  const mcps = [];
  for (const p of opencodePaths) {
    if (!existsSync(p)) continue;
    try {
      const c = JSON.parse(readFileSync(p, "utf-8"));
      for (const [name, mcp] of Object.entries(c.mcp || {})) {
        if (seen.has(name)) continue;
        seen.add(name);
        mcps.push({
          name,
          type: mcp.type || (mcp.command ? "local" : mcp.url ? "remote" : "unknown"),
          enabled: mcp.enabled !== false,
        });
      }
    } catch {}
  }
  for (const p of claudePaths) {
    if (!existsSync(p)) continue;
    try {
      const c = JSON.parse(readFileSync(p, "utf-8"));
      for (const [name, mcp] of Object.entries(c.mcpServers || {})) {
        if (seen.has(name)) continue;
        seen.add(name);
        mcps.push({
          name,
          type: mcp.command ? "local" : mcp.url ? "remote" : "unknown",
          enabled: mcp.disabled !== true,
        });
      }
    } catch {}
  }
  for (const p of codexPaths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      const re = /^\s*\[mcp_servers\.(?:"([^"]+)"|([^\]\s]+))\]\s*$/gm;
      let m;
      while ((m = re.exec(raw))) {
        const name = (m[1] || m[2] || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        mcps.push({ name, type: "unknown", enabled: true });
      }
    } catch {}
  }
  return mcps;
}

function inventoryFP(skills, mcps) {
  return JSON.stringify({ s: skills.map(s => s.name).sort(), m: mcps.map(m => m.name).sort() });
}

// ============================================================
// Agent 定义读取
// ============================================================
function unescapeTomlBasicString(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }
}

function parseTomlString(raw, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*(?:\"\"\"([\\s\\S]*?)\"\"\"|'''([\\s\\S]*?)'''|\"((?:\\\\.|[^\"\\\\])*)\"|'([^']*)'|([^\\n#]+))`, "m");
  const m = raw.match(re);
  if (!m) return "";
  if (m[1] != null) return m[1].replace(/^\n/, "").trim();
  if (m[2] != null) return m[2].replace(/^\n/, "").trim();
  if (m[3] != null) return unescapeTomlBasicString(m[3]).trim();
  if (m[4] != null) return m[4].trim();
  return String(m[5] || "").trim().replace(/\s+#.*$/, "");
}

function readAgentMeta(filePath) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    if (filePath.endsWith(".toml")) {
      return {
        capabilities: parseTomlString(raw, "description") || "",
        mode: "subagent",
        runtime: "codex",
      };
    }

    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const meta = {};
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)/);
      if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return { capabilities: meta.description || "", mode: meta.mode || "subagent", runtime: meta.runtime || "opencode" };
  } catch { return null; }
}

function codexAgentDefPaths(name, agentDirectory) {
  const dir = agentDirectory || DIRECTORY;
  const agentsDir = join(dir, ".codex", "agents");
  const exact = join(agentsDir, `${name}.toml`);
  const paths = [];
  if (existsSync(exact)) paths.push(exact);
  try {
    for (const file of readdirSync(agentsDir).filter(f => f.endsWith(".toml") && !f.startsWith(".")).sort()) {
      const path = join(agentsDir, file);
      if (path === exact) continue;
      const raw = readFileSync(path, "utf-8");
      if (parseTomlString(raw, "name") === name) paths.push(path);
    }
  } catch {}
  return paths;
}

function agentDefPaths(name, runtime, agentDirectory) {
  const dir = agentDirectory || DIRECTORY;
  if (runtime === "codex") {
    return codexAgentDefPaths(name, dir);
  }
  return [
    join(dir, ".opencode", "agents", `${name}.md`),
    join(homedir(), ".config", "opencode", "agents", `${name}.md`),
    join(dir, ".claude", "agents", `${name}.md`),
    join(homedir(), ".claude", "agents", `${name}.md`),
  ];
}

function findAgentDef(name, runtime, agentDirectory) {
  // agentDirectory: 该 agent 自己的项目目录（来自 /agents/connect 传入）
  const dir = agentDirectory || DIRECTORY;
  let base = { agent_name: name, project_path: dir, capabilities: "", mode: "subagent", runtime: runtime || "opencode" };
  for (const p of agentDefPaths(name, runtime, dir)) {
    if (existsSync(p)) {
      const meta = readAgentMeta(p);
      if (meta) { base = { ...base, ...meta, runtime: runtime || meta.runtime || "opencode" }; break; }
    }
  }
  base.skills = scanSkills();
  base.mcps = scanMcps();
  return base;
}

function readAgentInstruction(name, runtime, agentDirectory) {
  const dir = agentDirectory || DIRECTORY;
  const paths = agentDefPaths(name, runtime, dir);
  for (const p of paths) {
    if (existsSync(p)) {
      try { return { path: p, content: readFileSync(p, "utf-8") }; } catch {}
    }
  }
  return null;
}

// ============================================================
// Server 通信：注册 / 心跳
// ============================================================
async function registerToServer() {
  // 先清理已死的 agent（Plugin 死了 + lastSeen 超时 + 无 screen）
  pruneDeadAgents();

  if (agents.size === 0) return;
  const agentDefs = [];
  for (const [name, info] of agents) {
    agentDefs.push(findAgentDef(name, info.runtime, info.directory));
  }

  try {
    const res = await fetch(`${META_AGENT_SERVER}/api/clients/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        host_user: hostUser,
        client_endpoint: daemonUrl,
        agents: agentDefs,
        agent_statuses: getAgentStatuses(),
        client_version: CLIENT_VERSION,
        plugin_hash: fileHash(join(PLUGIN_DIR, "index.js")),
        daemon_port: parseInt(daemonUrl.split(":").pop()),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const names = [...agents.keys()];
      log(`✅ 注册成功: [${names.join(", ")}] (${agentDefs[0]?.skills?.length || 0} skills, ${agentDefs[0]?.mcps?.length || 0} mcps)`);
      for (const [, info] of agents) info.registered = true;
      lastInventoryFP = inventoryFP(agentDefs[0]?.skills || [], agentDefs[0]?.mcps || []);
    } else {
      log(`❌ 注册失败: HTTP ${res.status}`);
    }
  } catch (err) {
    log(`⚠ Server 不可达: ${err.message}`);
  }
}

let lastFullRegister = 0;
const FULL_REGISTER_INTERVAL = 3_000; // 每 3s 强制重新注册（防 Server 重启后状态丢失）

async function heartbeat() {
  if (agents.size === 0) return;

  // 检查是否有 agent 还没注册成功，或者距离上次完整注册超过 60s
  const anyUnregistered = [...agents.values()].some(a => !a.registered);
  const needFullRegister = Date.now() - lastFullRegister > FULL_REGISTER_INTERVAL;
  if (anyUnregistered || needFullRegister) {
    await registerToServer();
    if ([...agents.values()].every(a => a.registered)) lastFullRegister = Date.now();
    return;
  }

  try {
    const body = {
      user_id: userId,
      host_user: hostUser,
      agent_statuses: getAgentStatuses(),
      client_version: CLIENT_VERSION,
      plugin_hash: fileHash(join(PLUGIN_DIR, "index.js")),
      daemon_port: parseInt(daemonUrl.split(":").pop()),
    };

    // inventory 变化检测
    const skills = scanSkills();
    const mcps = scanMcps();
    const fp = inventoryFP(skills, mcps);
    if (fp !== lastInventoryFP) {
      log(`📦 inventory 变化 (${skills.length} skills, ${mcps.length} mcps)`);
      const inv = {};
      for (const [name] of agents) inv[name] = { skills, mcps };
      body.agent_inventory = inv;
      lastInventoryFP = fp;
    }

    const res = await fetch(`${META_AGENT_SERVER}/api/clients/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      for (const [, info] of agents) info.registered = false;
    }
  } catch {
    for (const [, info] of agents) info.registered = false;
  }
}

async function reportAgentStatusToServer(agentName, status) {
  if (!META_AGENT_SERVER || !agentName || !userId) return false;
  try {
    const res = await fetch(`${META_AGENT_SERVER}/api/clients/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        host_user: hostUser,
        agent_statuses: { [agentName]: status },
        client_version: CLIENT_VERSION,
        plugin_hash: fileHash(join(PLUGIN_DIR, "index.js")),
        daemon_port: parseInt(daemonUrl.split(":").pop()),
      }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch (err) {
    log(`⚠ 上报 agent 状态失败: ${agentName}=${status} ${err.message}`);
    return false;
  }
}

// ============================================================
// 任务队列：按 agent_name 路由
// ============================================================
function enqueueTask(agentName, task) {
  const q = getAgentQueue(agentName);
  if (q.pending.length >= MAX_QUEUE_SIZE) {
    log(`⚠ ${agentName} 队列已满 (${MAX_QUEUE_SIZE})，拒绝: "${task.title}"`);
    return false;
  }
  q.pending.push(task);
  log(`📋 ${agentName} 任务入队: "${task.title}" (队列: ${q.pending.length})`);

  // 如果该 agent 有 long-poll 在等待 且 当前没在执行任务，立即唤醒取第一个任务
  if (q.waitingResponse && !q.executingTaskId) {
    const waiter = q.waitingResponse;
    q.waitingResponse = null;
    const agentInfo = agents.get(agentName);
    const runtime = agentInfo?.runtime || "opencode";
    const nextTask = q.pending.shift();

    if (runtime === "claude-code") {
      // Claude Code 模式：只通知有任务（不取走）
      q.pending.unshift(nextTask);  // 放回去，CC 自己取
      try {
        waiter.writeHead(200, { "Content-Type": "application/json" });
        waiter.end(JSON.stringify({ task: { id: nextTask.id, title: nextTask.title, _notify: true } }));
      } catch {}
    } else if (runtime === "codex") {
      const requested = codexDeliveryForTask(nextTask);
      if (requested !== "detached") {
        // attached/auto：当前 long-poll 请求就是附着接收器，直接交给它。
        q.lastExecuted = nextTask;
        q.executingTaskId = nextTask.id;
        try {
          waiter.writeHead(200, { "Content-Type": "application/json" });
          waiter.end(JSON.stringify({ task: nextTask, delivery_mode: "attached" }));
        } catch {}
      } else {
        // detached：显式要求 Daemon 托管执行，不交给 attached receiver。
        q.pending.unshift(nextTask);
        try {
          waiter.writeHead(200, { "Content-Type": "application/json" });
          waiter.end(JSON.stringify({ task: null, delivery_mode: "detached" }));
        } catch {}
        scheduleCodexQueue(agentName);
      }
    } else {
      // opencode 模式：直接取走任务给 Plugin 执行
      q.lastExecuted = nextTask;
      q.executingTaskId = nextTask.id;  // 分发时立即标记（防竞态）
      try {
        waiter.writeHead(200, { "Content-Type": "application/json" });
        waiter.end(JSON.stringify({ task: nextTask }));
      } catch {}
    }
  }
  return true;
}

async function reportTaskResult(task, status, result, durationMs) {
  // 更新 workflow 跟踪表
  // Strip ANSI escape codes from result（远端 agent 输出可能带终端颜色码）
  const cleanResult = (result || "").replace(/\x1b\[[0-9;]*m/g, "");

  if (task.workflow_id && workflowTracker.has(task.workflow_id)) {
    const entry = workflowTracker.get(task.workflow_id);
    entry.status = status;
    entry.completed_at = new Date().toISOString();
    entry.result = cleanResult.substring(0, 2000);
  }

  if (task.workflow_id && task.node_id) {
    try {
      const url = `${META_AGENT_SERVER}/api/workflows/${task.workflow_id}/nodes/${task.node_id}/result`;
      log(`📤 回报 workflow: ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          execution_id: task.execution_id || task.id,
          status,
          result: cleanResult.substring(0, 5000),
          duration_ms: durationMs,
          session_id: task.session_id || "",
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        let detail = "";
        try { detail = await res.text(); } catch {}
        log(`⚠ workflow 回报 HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
        return { ok: false, workflow_reported: false, error: `HTTP ${res.status}` };
      }
      log(`✅ workflow 回报成功: workflow=${task.workflow_id} node=${task.node_id}`);
      return { ok: true, workflow_reported: true };
    } catch (err) {
      log(`⚠ workflow 回报失败: ${err.message}`);
      return { ok: false, workflow_reported: false, error: err.message };
    }
  }
  try {
    const res = await fetch(`${META_AGENT_SERVER}/api/tasks/${task.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, result: result.substring(0, 5000), duration_ms: durationMs }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, workflow_reported: false, error: `HTTP ${res.status}` };
    return { ok: true, workflow_reported: true };
  } catch (err) {
    log(`⚠ 回报失败: ${err.message}`);
    return { ok: false, workflow_reported: false, error: err.message };
  }
}

// ============================================================
// Codex executor — detached screen+TUI / headless exec 兜底
// ============================================================
function truncateText(text, max = 4000) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) + `\n...<truncated ${s.length - max} chars>` : s;
}

function safeFilePart(value) {
  return String(value || "task").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "task";
}

function buildCodexPrompt(agentName, task, cwd, reportScript = "") {
  const agentInfo = agents.get(agentName);
  const def = readAgentInstruction(agentName, "codex", agentInfo?.directory || cwd);
  const parts = [
    `# MAF Codex Runtime Task`,
    ``,
    `你正在作为 MAF agent "${agentName}" 执行由 Meta-Agent-Framework Server 下发的任务。`,
    `工作目录: ${cwd}`,
    ``,
    `## 执行要求`,
    `- 直接完成任务并在最终回答中给出结果摘要、关键改动/发现、验证情况。`,
    `- 不要直接调用 MAF Server workflow API；完成或失败后必须按下方 MAF 回报要求执行本机回报脚本。`,
    `- 如果需要修改文件，遵守仓库内 AGENTS.md 和相关规则。`,
    `- 如果任务无法完成，说明阻塞原因和建议下一步。`,
  ];
  if (reportScript) {
    parts.push(
      ``,
      `## MAF 回报要求`,
      `本任务运行在 screen + Codex TUI 中，适合长期交互。任务完成或失败后，必须用下面脚本回报 MAF Daemon：`,
      ``,
      `1. 先把最终总结写到一个 Markdown 文件，例如 /tmp/maf-codex-result-${safeFilePart(task.id)}.md`,
      `2. 然后执行：`,
      ``,
      `\`\`\`bash`,
      `node "${reportScript}" completed /tmp/maf-codex-result-${safeFilePart(task.id)}.md`,
      `# 如果失败：node "${reportScript}" failed /tmp/maf-codex-result-${safeFilePart(task.id)}.md`,
      `\`\`\``,
      ``,
      `不要直接调用 Server workflow API；这个脚本会回报到本机 Daemon。`
    );
  }
  if (def?.content) {
    parts.push(``, `## Agent 定义 (${def.path})`, def.content.trim());
  }
  parts.push(
    ``,
    `## 任务元数据`,
    `- task_id: ${task.id || ""}`,
    `- workflow_id: ${task.workflow_id || ""}`,
    `- node_id: ${task.node_id || ""}`,
    `- type: ${task.type || "custom"}`,
    `- title: ${task.title || "任务"}`,
    ``,
    `## 任务内容`,
    task.description || task.title || ""
  );
  return parts.join("\n");
}

function buildCodexArgs(cwd, outputFile) {
  const args = [];
  if (!CODEX_BYPASS_SANDBOX) {
    args.push("-c", `approval_policy="${process.env.MAF_CODEX_APPROVAL || "never"}"`);
  }
  if (process.env.MAF_CODEX_MODEL) args.push("-m", process.env.MAF_CODEX_MODEL);
  args.push("exec");
  if (CODEX_BYPASS_SANDBOX) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", CODEX_SANDBOX);
  }
  if (process.env.MAF_CODEX_PROFILE) args.push("--profile", process.env.MAF_CODEX_PROFILE);
  args.push("-C", cwd, "--skip-git-repo-check", "--color", "never", "-o", outputFile, "-");
  return args;
}

function buildCodexTuiArgs(cwd, promptFile) {
  const args = [];
  if (!CODEX_BYPASS_SANDBOX) {
    args.push("-c", `approval_policy="${process.env.MAF_CODEX_APPROVAL || "never"}"`);
  }
  if (process.env.MAF_CODEX_MODEL) args.push("-m", process.env.MAF_CODEX_MODEL);
  if (CODEX_BYPASS_SANDBOX) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", CODEX_SANDBOX);
  }
  if (process.env.MAF_CODEX_PROFILE) args.push("--profile", process.env.MAF_CODEX_PROFILE);
  args.push("-C", cwd);
  return args;
}

function writeCodexReportScript(agentName, task) {
  const reportScript = join(STATE_DIR, `maf-codex-report-${safeFilePart(agentName)}-${safeFilePart(task.id)}.mjs`);
  const markerFile = `${reportScript}.sent`;
  const content = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const status = process.argv[2] || "completed";
const resultFile = process.argv[3] || "";
let result = process.argv.slice(3).join(" ");
if (resultFile) {
  try { result = readFileSync(resultFile, "utf-8"); } catch {}
}
const payload = {
  agent_name: ${JSON.stringify(agentName)},
  task_id: ${JSON.stringify(task.id)},
  status,
  result,
  duration_ms: 0,
};
let res;
try {
  res = await fetch(${JSON.stringify(`http://127.0.0.1:${NODE_PORT}/tasks/done`)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
} catch (err) {
  console.error(\`MAF report failed: \${err.message}\`);
  process.exit(1);
}
if (!res.ok) {
  console.error(\`MAF report failed: HTTP \${res.status}\`);
  process.exit(1);
}
try { writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ status, at: new Date().toISOString() }) + "\\n"); } catch {}
console.log("MAF report sent");
`;
  writeFileSync(reportScript, content, { mode: 0o700 });
  return reportScript;
}

async function spawnCodexTuiTask(agentName, task, projectPath) {
  const started = Date.now();
  const cwd = (projectPath || agents.get(agentName)?.directory || DIRECTORY).replace(/^~/, homedir());
  if (!existsSync(cwd)) {
    const msg = `Codex 工作目录不存在: ${cwd}`;
    log(`❌ ${msg}`);
    await reportTaskResult(task, "failed", msg, Date.now() - started);
    return false;
  }

  try { execSync("which screen", { stdio: "ignore", timeout: 2000 }); } catch {
    const msg = "screen 未安装，无法拉起 Codex TUI";
    log(`❌ ${msg}`);
    await reportTaskResult(task, "failed", msg, Date.now() - started);
    return false;
  }
  try { execSync(`which ${CODEX_BIN}`, { stdio: "ignore", timeout: 2000 }); } catch {
    const msg = `${CODEX_BIN} 未安装，无法拉起 Codex TUI`;
    log(`❌ ${msg}`);
    await reportTaskResult(task, "failed", msg, Date.now() - started);
    return false;
  }

  const screenName = `maf-codex-${safeFilePart(agentName)}-${safeFilePart(task.id).slice(0, 24)}`;
  const promptFile = join(STATE_DIR, `${screenName}.prompt.md`);
  const launchScript = join(STATE_DIR, `${screenName}.launch.mjs`);
  const reportScript = writeCodexReportScript(agentName, task);
  const resultFile = join("/tmp", `maf-codex-result-${safeFilePart(task.id)}.md`);
  const markerFile = `${reportScript}.sent`;
  const prompt = buildCodexPrompt(agentName, task, cwd, reportScript);
  writeFileSync(promptFile, prompt, "utf-8");
  const codexArgs = buildCodexTuiArgs(cwd, promptFile);
  const launcher = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const prompt = readFileSync(${JSON.stringify(promptFile)}, "utf-8");
const args = ${JSON.stringify(codexArgs)};
const resultFile = ${JSON.stringify(resultFile)};
const reportScript = ${JSON.stringify(reportScript)};
const markerFile = ${JSON.stringify(markerFile)};
let finished = false;

function runReport(status, resultPath) {
  return new Promise((resolve) => {
    const reporter = spawn(process.execPath, [reportScript, status, resultPath], { stdio: "inherit", env: process.env });
    reporter.on("error", (err) => { console.error(\`MAF report launcher failed: \${err.message}\`); resolve(1); });
    reporter.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function finish(status, exitCode, signal, fallbackMessage = "") {
  if (finished) return;
  finished = true;
  let finalStatus = status;
  if (!existsSync(markerFile)) {
    if (!existsSync(resultFile)) {
      finalStatus = "failed";
      const reason = fallbackMessage || (exitCode === 0
        ? "Codex exited without writing result file or calling MAF report script"
        : "Codex exited before MAF report: exit=" + (exitCode ?? "") + (signal ? " signal=" + signal : ""));
      try { writeFileSync(resultFile, reason + "\\n"); } catch (err) { console.error(\`write result fallback failed: \${err.message}\`); }
    }
    const reportCode = await runReport(finalStatus, resultFile);
    if (reportCode !== 0) process.exit(reportCode);
  }
  process.exit(exitCode ?? (signal ? 1 : 0));
}

args.push(prompt);
const child = spawn(${JSON.stringify(CODEX_BIN)}, args, { cwd: ${JSON.stringify(cwd)}, stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  finish(exitCode === 0 ? "completed" : "failed", exitCode, signal);
});
child.on("error", (err) => {
  finish("failed", 1, null, \`Codex 启动失败: \${err.message}\`);
});
`;
  writeFileSync(launchScript, launcher, { mode: 0o700 });

  log(`🚀 拉起 Codex TUI (screen): agent=${agentName} task=${task.id} cwd=${cwd} session=${screenName}`);
  const ok = await new Promise((resolve) => {
    const child = spawn("screen", ["-dmS", screenName, process.execPath, launchScript], {
      cwd,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    child.on("error", err => { log(`❌ Codex screen 拉起失败: ${err.message}`); resolve(false); });
    child.on("close", code => resolve(code === 0));
    child.unref();
  });
  if (!ok) {
    await reportTaskResult(task, "failed", `Codex screen 拉起失败: ${screenName}`, Date.now() - started);
    return false;
  }

  task.session_id = screenName;
  codexTaskScreens.set(task.id, { agentName, screenName, startedAt: Date.now(), lastTaskAt: Date.now() });
  log(`✅ Codex TUI screen 已创建: ${screenName}`);
  return true;
}

async function executeCodexExecTask(agentName, task, projectPath) {
  const started = Date.now();
  const cwd = (projectPath || agents.get(agentName)?.directory || DIRECTORY).replace(/^~/, homedir());
  const outFile = join(STATE_DIR, `codex-${safeFilePart(agentName)}-${safeFilePart(task.id)}-${Date.now()}.txt`);

  if (!existsSync(cwd)) {
    const msg = `Codex 工作目录不存在: ${cwd}`;
    log(`❌ ${msg}`);
    await reportTaskResult(task, "failed", msg, Date.now() - started);
    return;
  }

  const prompt = buildCodexPrompt(agentName, task, cwd);
  const args = buildCodexArgs(cwd, outFile);
  log(`🤖 Codex exec 开始: agent=${agentName} task=${task.id} cwd=${cwd} sandbox=${CODEX_BYPASS_SANDBOX ? "bypass" : CODEX_SANDBOX}`);

  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const finish = (status, message, code = null, signal = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let finalMessage = "";
      try { if (existsSync(outFile)) finalMessage = readFileSync(outFile, "utf-8").trim(); } catch {}
      try { if (existsSync(outFile)) unlinkSync(outFile); } catch {}

      if (status === "completed") {
        resolve({ status, result: finalMessage || truncateText(stdout.trim() || stderr.trim() || "Codex completed with no output") });
        return;
      }

      const chunks = [message];
      if (code !== null || signal) chunks.push(`exit=${code ?? ""}${signal ? ` signal=${signal}` : ""}`);
      if (finalMessage) chunks.push(`final:\n${truncateText(finalMessage)}`);
      if (stderr.trim()) chunks.push(`stderr:\n${truncateText(stderr.trim())}`);
      if (stdout.trim()) chunks.push(`stdout:\n${truncateText(stdout.trim())}`);
      resolve({ status: "failed", result: chunks.filter(Boolean).join("\n\n") });
    };

    const child = spawn(CODEX_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
    }, CODEX_TASK_TIMEOUT_MS);

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", err => finish("failed", `Codex 启动失败: ${err.message}`));
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish("failed", `Codex 执行超时 (${CODEX_TASK_TIMEOUT_MS}ms)`, code, signal);
      } else if (code === 0) {
        finish("completed", "");
      } else {
        finish("failed", `Codex 执行失败`, code, signal);
      }
    });

    try { child.stdin.write(prompt); child.stdin.end(); } catch (err) { finish("failed", `Codex stdin 写入失败: ${err.message}`); }
  });

  const duration = Date.now() - started;
  log(`${result.status === "completed" ? "✅" : "❌"} Codex exec 结束: agent=${agentName} task=${task.id} status=${result.status} (${duration}ms)`);
  await reportTaskResult(task, result.status, result.result, duration);
}

async function runCodexQueue(agentName) {
  const q = getAgentQueue(agentName);
  try {
    if (CODEX_MODE === "exec") {
      while (q.pending.length > 0) {
        const task = q.pending[0];
        if (!task) { q.pending.shift(); continue; }
        const agentInfo = agents.get(agentName);
        if (!codexShouldRunDetached(agentName, task)) {
          q.pending.shift();
          const msg = codexAttachedUnavailableMessage(agentName, task);
          q.lastExecuted = task;
          q.executingTaskId = task.id;
          log(`⚠ ${msg}`);
          await reportTaskResult(task, "failed", msg, 0);
          q.executingTaskId = null;
          q.lastExecuted = null;
          continue;
        }
        q.pending.shift();
        if (agentInfo) agentInfo.lastSeen = Date.now();
        q.lastExecuted = task;
        q.executingTaskId = task.id;
        await executeCodexExecTask(agentName, task, task.project_path || agentInfo?.directory || DIRECTORY);
        q.executingTaskId = null;
        q.lastExecuted = null;
        if (agentInfo) agentInfo.lastSeen = Date.now();
      }
    } else {
      if (!q.executingTaskId && q.pending.length > 0) {
        const task = q.pending[0];
        const agentInfo = agents.get(agentName);
        if (!codexShouldRunDetached(agentName, task)) {
          q.pending.shift();
          const msg = codexAttachedUnavailableMessage(agentName, task);
          q.lastExecuted = task;
          q.executingTaskId = task.id;
          log(`⚠ ${msg}`);
          await reportTaskResult(task, "failed", msg, 0);
          q.executingTaskId = null;
          q.lastExecuted = null;
          return;
        }
        q.pending.shift();
        if (agentInfo) agentInfo.lastSeen = Date.now();
        q.lastExecuted = task;
        q.executingTaskId = task.id;
        const ok = await spawnCodexTuiTask(agentName, task, task.project_path || agentInfo?.directory || DIRECTORY);
        if (!ok) {
          q.executingTaskId = null;
          q.lastExecuted = null;
        }
      }
    }
  } finally {
    codexQueueRunners.delete(agentName);
    if (q.pending.length > 0 && codexShouldRunDetached(agentName, q.pending[0]) && (CODEX_MODE === "exec" || !q.executingTaskId)) {
      scheduleCodexQueue(agentName);
    }
  }
}

function scheduleCodexQueue(agentName) {
  const agentInfo = agents.get(agentName);
  if (agentInfo?.runtime !== "codex") return;
  const q = getAgentQueue(agentName);
  if (q.pending.length === 0) return;
  if (!codexShouldRunDetached(agentName, q.pending[0])) return;
  if (codexQueueRunners.has(agentName)) return;
  codexQueueRunners.add(agentName);
  setImmediate(() => {
    runCodexQueue(agentName).catch(err => {
      codexQueueRunners.delete(agentName);
      log(`❌ Codex queue 失败: ${agentName} ${err.message}`);
    });
  });
}

// 任务轮询（降级）
async function pollTasks() {
  if (agents.size === 0) return;
  for (const [name] of agents) {
    const q = getAgentQueue(name);
    if (q.pending.length > 0) continue;
    try {
      const url = `${META_AGENT_SERVER}/api/tasks/poll?agent_name=${encodeURIComponent(name)}&user_id=${encodeURIComponent(userId)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.has_task) continue;
      log(`📥 轮询到任务: "${data.task.title}" → ${name}`);
      const task = {
        id: data.task.id,
        type: data.task.type || "custom",
        title: data.task.title,
        description: data.task.description || "",
        target_agent: name,
      };
      enqueueTask(name, task);
      if ((agents.get(name)?.runtime || "opencode") === "codex") scheduleCodexQueue(name);
    } catch {}
  }
}

// ============================================================
// OTA
// ============================================================
function performOTA(payload) {
  const { files = [] } = payload;
  let applied = 0, failed = 0;
  const errors = [];
  let daemonUpdated = false;

  for (const f of files) {
    try {
      let target = f.path;
      if (target.startsWith("plugin/")) {
        const relName = target.slice(7);
        if (relName === "daemon.mjs") {
          target = join(dirname(new URL(import.meta.url).pathname), relName);
        } else {
          target = join(PLUGIN_DIR, relName);
        }
      } else {
        target = target.replace(/^~/, homedir());
      }
      const selfDir = dirname(new URL(import.meta.url).pathname);
      const allowed = [
        join(homedir(), ".config", "opencode"),
        join(homedir(), ".opencode"),
        join(homedir(), ".claude"),
        join(homedir(), ".codex"),
        join(homedir(), ".agents"),
        join(homedir(), ".meta-agent-framework"),
        selfDir,
      ];
      if (!allowed.some(d => target.startsWith(d))) { errors.push(`白名单外: ${target}`); failed++; continue; }

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, "utf-8");
      if (f.hash && fileHash(target) !== f.hash) { errors.push(`hash 不匹配: ${f.path}`); failed++; continue; }
      log(`✅ OTA: ${f.path} → ${target}`);
      applied++;
      if (f.path === "plugin/daemon.mjs" || target.endsWith("daemon.mjs")) daemonUpdated = true;
    } catch (err) { errors.push(`${f.path}: ${err.message}`); failed++; }
  }
  return { applied, failed, restarted: daemonUpdated ? 1 : 0, daemon_updated: daemonUpdated, errors };
}

// ============================================================
// Evolve — 进化指令执行（push_files / run_command）
// ============================================================

/**
 * 根据 target 和 runtime 解析实际写入目录
 *
 * Server 只声明逻辑目标（skill / agent / mcp_config），
 * Daemon 根据 runtime 映射到正确的物理路径。
 */
function resolveEvolveTargetDir(target, runtime, action) {
  const home = homedir();
  switch (target) {
    case "skill":
      return runtime === "claude-code"
        ? join(home, ".claude", "skills")
        : runtime === "codex"
          ? join(home, ".codex", "skills")
          : join(home, ".config", "opencode", "skills");
    case "agent":
      return runtime === "claude-code"
        ? join(home, ".claude", "agents")
        : runtime === "codex"
          ? join(home, ".codex", "agents")
          : join(home, ".config", "opencode", "agents");
    case "project_agent": {
      const projPath = action.project_path || DIRECTORY;
      return runtime === "claude-code"
        ? join(projPath, ".claude")
        : runtime === "codex"
          ? join(projPath, ".codex", "agents")
          : join(projPath, ".opencode", "agents");
    }
    case "mcp_config": {
      const projPath = action.project_path || DIRECTORY;
      return runtime === "claude-code"
        ? projPath  // claude: .mcp.json 在项目根目录
        : runtime === "codex"
          ? join(projPath, ".codex") // codex: .codex/config.toml
          : projPath; // opencode: opencode.json 在项目根目录
    }
    case "global_rules":
      return runtime === "claude-code"
        ? join(home, ".claude")
        : runtime === "codex"
          ? join(home, ".codex")
          : join(home, ".config", "opencode");
    case "custom":
      return (action.target_path || "").replace(/^~/, home);
    default:
      return "";
  }
}

/** Evolve 写入白名单（与 OTA 一致 + 项目目录） */
function isEvolvePathAllowed(target) {
  const home = homedir();
  const allowed = [
    join(home, ".config", "opencode"),
    join(home, ".opencode"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".agents"),
    join(home, ".meta-agent-framework"),
  ];
  // 项目目录下的 .opencode/ .claude/ .codex/ 也允许
  if (target.includes("/.opencode/") || target.includes("/.claude/") || target.includes("/.codex/")) return true;
  // 项目根目录的配置文件（opencode.json / .mcp.json / AGENTS.md）
  if (target.endsWith("/opencode.json") || target.endsWith("/.mcp.json") || target.endsWith("/AGENTS.md")) return true;
  return allowed.some(d => target.startsWith(d));
}

/**
 * 校验 SKILL.md 的 YAML frontmatter（runtime skill 要求 name + description 才能稳定发现）
 *
 * 规则：
 *   1. 必须以 "---\n" 开头
 *   2. 必须包含 name: 全小写字母数字+连字符，匹配 ^[a-z0-9]+(-[a-z0-9]+)*$
 *   3. 必须包含 description: 1-1024 字符
 */
function validateSkillFrontmatter(content, relativePath) {
  if (typeof content !== "string") return null;  // binary，不校验
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return `SKILL.md 缺少 YAML frontmatter（必须以 --- 开头）: ${relativePath}`;
  }
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    return `SKILL.md frontmatter 未闭合（缺少结束 ---）: ${relativePath}`;
  }
  const fm = content.slice(4, endIdx);
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (!nameMatch) {
    return `SKILL.md frontmatter 缺少 name 字段: ${relativePath}`;
  }
  const name = nameMatch[1].trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return `SKILL.md name 格式非法（需全小写+连字符）: "${name}" in ${relativePath}`;
  }
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  if (!descMatch || descMatch[1].trim().length === 0) {
    return `SKILL.md frontmatter 缺少 description 字段: ${relativePath}`;
  }
  if (descMatch[1].trim().length > 1024) {
    return `SKILL.md description 超过 1024 字符: ${relativePath}`;
  }
  return null;  // 校验通过
}

/** 执行 push_files 动作 */
function executeEvolvePushFiles(action, runtime) {
  const files = action.files || [];
  const target = action.target || "custom";
  const baseDir = resolveEvolveTargetDir(target, runtime, action);

  if (!baseDir) {
    return { type: "push_files", status: "failed", message: `无法解析目标目录: target=${target}` };
  }

  let written = 0;
  const errors = [];

  for (const f of files) {
    try {
      const fullPath = join(baseDir, f.relative_path);
      if (!isEvolvePathAllowed(fullPath)) {
        errors.push(`白名单外: ${fullPath}`);
        continue;
      }
      const content = f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content;

      // skill 推送时校验 SKILL.md 的 YAML frontmatter（仅警告，不阻止写入）
      if (target === "skill" && f.relative_path.endsWith("/SKILL.md")) {
        const fmError = validateSkillFrontmatter(content, f.relative_path);
        if (fmError) {
          log(`  ⚠️ ${fmError}（runtime skills 可能不显示）`);
        }
      }

      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, f.encoding === "base64" ? undefined : "utf-8");
      log(`  ✅ Evolve push: ${f.relative_path} → ${fullPath}`);
      written++;
    } catch (err) {
      errors.push(`${f.relative_path}: ${err.message}`);
    }
  }

  if (errors.length > 0 && written === 0) {
    return { type: "push_files", status: "failed", message: errors.join("; ") };
  }
  return {
    type: "push_files", status: "ok",
    message: `${written}/${files.length} files written${errors.length > 0 ? `, errors: ${errors.join("; ")}` : ""}`,
  };
}

/** 执行 run_command 动作 */
function executeEvolveRunCommand(action) {
  const cmd = action.command;
  if (!cmd) return { type: "run_command", status: "failed", message: "no command specified" };

  const cwd = (action.cwd || DIRECTORY).replace(/^~/, homedir());
  const timeout = action.timeout_ms || 60_000;

  try {
    const output = execSync(cmd, {
      cwd,
      timeout,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    log(`  ✅ Evolve cmd: ${cmd} (cwd=${cwd})`);
    return { type: "run_command", status: "ok", message: (output || "").substring(0, 500) };
  } catch (err) {
    return { type: "run_command", status: "failed", message: err.message.substring(0, 500) };
  }
}

// ============================================================
// HTTP Server
// ============================================================
const httpServer = createServer(async (req, res) => {
  const readBody = () => new Promise(r => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => { try { r(JSON.parse(d)); } catch { r({}); } });
  });
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const urlObj = new URL(req.url, "http://localhost");
  const pathname = urlObj.pathname;

  // GET /health
  if (req.method === "GET" && pathname === "/health") {
    json(200, {
      ok: true,
      pid: process.pid,
      agents: [...agents.keys()],
      daemon_hash: DAEMON_SELF_HASH,
      uptime: process.uptime(),
      version: CLIENT_VERSION,
      server: META_AGENT_SERVER,
    });
    return;
  }

  // POST /agents/connect — Plugin/Hook 连接：注册一个 agent
  if (req.method === "POST" && pathname === "/agents/connect") {
    const body = await readBody();
    const name = body.agent_name;
    if (!name) { json(400, { error: "agent_name required" }); return; }
    const kind = String(body.kind || body.role || "").trim().toLowerCase();
    if (kind === "server" || isServerAgentName(name)) {
      log(`ℹ️ 忽略 Server 控制面连接，不注册为 Agent: ${name}`);
      json(200, { ok: true, ignored: true, kind: "server", agents: [...agents.keys()] });
      return;
    }

    const existing = agents.get(name);
    const info = {
      runtime: body.runtime || existing?.runtime || "opencode",
      pluginPid: body.plugin_pid || existing?.pluginPid || 0,
      directory: body.directory || existing?.directory || DIRECTORY,
      registered: false,
      sessionId: body.session_id || existing?.sessionId || "",
      lastSeen: Date.now(),
    };
    agents.set(name, info);

    if (body.user_id) userId = body.user_id;
    if (body.host_user) hostUser = body.host_user;

    log(`🔗 agent 连接: ${name} (runtime=${info.runtime}, agents=[${[...agents.keys()].join(", ")}])`);

    // 触发注册
    await registerToServer();
    json(200, { ok: true, agents: [...agents.keys()] });
    return;
  }

  // POST /agents/disconnect — Plugin/Hook 断开：注销一个 agent
  if (req.method === "POST" && pathname === "/agents/disconnect") {
    const body = await readBody();
    const name = body.agent_name;
    if (isServerAgentName(name)) {
      log(`ℹ️ 忽略 Server 控制面断开，不按 Agent 注销: ${name}`);
      json(200, { ok: true, ignored: true, kind: "server", agents: [...agents.keys()] });
      return;
    }
    if (name && agents.has(name)) {
      // 防竞态：如果 disconnect 的 PID 和当前 agent 的 pluginPid 不同，说明是旧 Plugin 发的
      const info = agents.get(name);
      const reqPid = body.plugin_pid || 0;
      if (reqPid > 0 && info.pluginPid > 0 && reqPid !== info.pluginPid) {
        log(`⚠ disconnect ${name} 被忽略（pid ${reqPid} ≠ 当前 ${info.pluginPid}）`);
        json(200, { ok: true, ignored: true, agents: [...agents.keys()] });
        return;
      }
      await reportAgentStatusToServer(name, "offline");
      agents.delete(name);
      // 清理任务队列
      const q = taskQueues.get(name);
      if (q?.waitingResponse) {
        try { q.waitingResponse.writeHead(200, { "Content-Type": "application/json" }); q.waitingResponse.end('{"task":null}'); } catch {}
      }
      taskQueues.delete(name);
      log(`🔌 agent 断开: ${name} (剩余=[${[...agents.keys()].join(", ")}])`);
    }
    json(200, { ok: true, agents: [...agents.keys()] });
    return;
  }

  // GET /agents — 列出当前管理的所有 agent
  if (req.method === "GET" && pathname === "/agents") {
    const list = [];
    for (const [name, info] of agents) {
      list.push({ agent_name: name, ...info });
    }
    json(200, { agents: list });
    return;
  }

  // GET /workflows/pending — 查询正在执行中的 workflow 任务
  if (req.method === "GET" && pathname === "/workflows/pending") {
    const pending = [];
    for (const [wfId, entry] of workflowTracker) {
      if (entry.status === "pending") {
        pending.push({ workflow_id: wfId, ...entry });
      }
    }
    json(200, pending);
    return;
  }

  // GET /workflows/completed — 查询已完成的 workflow 任务
  // 参数：?limit=N（默认10）、?since=ISO时间戳
  if (req.method === "GET" && pathname === "/workflows/completed") {
    const since = urlObj.searchParams.get("since") || "";
    const limit = parseInt(urlObj.searchParams.get("limit") || "10") || 10;
    const sinceTs = since ? new Date(since).getTime() : 0;
    const completed = [];
    for (const [wfId, entry] of workflowTracker) {
      if (entry.status === "completed" || entry.status === "failed") {
        if (!sinceTs || (entry.completed_at && new Date(entry.completed_at).getTime() > sinceTs)) {
          completed.push({ workflow_id: wfId, ...entry });
        }
      }
    }
    // 按完成时间倒序，取最近 limit 条
    completed.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    json(200, completed.slice(0, limit));
    return;
  }

  // === 兼容旧接口 ===

  // POST /agent — 兼容旧版 Plugin 通知 agent 切换 → 转发到 /agents/connect
  if (req.method === "POST" && pathname === "/agent") {
    const body = await readBody();
    if (body.agent_name) {
      const info = {
        runtime: body.runtime || "opencode",
        pluginPid: 0,
        directory: DIRECTORY,
        registered: false,
        sessionId: "",
        lastSeen: Date.now(),
      };
      agents.set(body.agent_name, info);
      if (body.user_id) userId = body.user_id;
      if (body.host_user) hostUser = body.host_user;
      log(`🔗 agent 连接(兼容): ${body.agent_name}`);
      await registerToServer();
    }
    json(200, { ok: true });
    return;
  }

  // POST /session — Plugin 通知 session 更新
  if (req.method === "POST" && pathname === "/session") {
    const body = await readBody();
    if (body.agent_name && agents.has(body.agent_name)) {
      agents.get(body.agent_name).sessionId = body.session_id || "";
    }
    json(200, { ok: true });
    return;
  }

  // POST /execute — Server 推送任务 → 按 agent_name 路由入队（无 Plugin 时自动拉起 serve）
  if (req.method === "POST" && pathname === "/execute") {
    const body = await readBody();
    const targetAgent = body.target_agent || body.agent_name;
    const projectPath = body.project_path || "";
    const runtime = body.runtime || "opencode";
    log(`📥 收到任务: "${body.title || body.prompt}" → ${targetAgent}${body.workflow_id ? ` (workflow=${body.workflow_id})` : ""}`);

    if (!targetAgent) {
      json(400, { error: "agent_name required" });
      return;
    }

    const task = {
      id: body.task_id || body.execution_id || `push-${Date.now()}`,
      type: body.type || body.intent || "custom",
      title: body.title || body.prompt?.substring(0, 80) || "任务",
      description: body.description || body.prompt || "",
      target_agent: targetAgent,
      workflow_id: body.workflow_id || "",
      node_id: body.node_id || "",
      execution_id: body.execution_id || "",
      detached: body.detached,
      delivery_mode: body.delivery_mode || body.deliveryMode || body.execution_mode || body.executionMode || "",
      metadata: body.metadata || {},
    };

    // 记录到 workflow 跟踪表
    if (task.workflow_id) {
      workflowTracker.set(task.workflow_id, {
        title: task.title,
        agent_name: targetAgent,
        node_id: task.node_id,
        status: "pending",
        dispatched_at: new Date().toISOString(),
        completed_at: null,
        result: null,
      });
    }

    // Codex runtime：默认只接受 attached 当前 TUI；detached/auto 才由 Daemon screen/exec 托管执行。
    if (runtime === "codex") {
      const existing = agents.get(targetAgent);
      const directory = projectPath || existing?.directory || DIRECTORY;
      task.project_path = directory;
      agents.set(targetAgent, {
        runtime: "codex",
        pluginPid: existing?.pluginPid || 0,
        directory,
        registered: existing?.registered || false,
        sessionId: existing?.sessionId || "",
        lastSeen: Date.now(),
      });
      if (!existing?.registered) registerToServer();

      const delivery = codexEffectiveDelivery(targetAgent, task);
      if (delivery === "attached" && !hasCodexAttachedReceiver(targetAgent)) {
        const msg = codexAttachedUnavailableMessage(targetAgent, task);
        log(`⚠ ${msg}`);
        await reportTaskResult(task, "failed", msg, 0);
        json(409, { accepted: false, agent: targetAgent, error: msg, delivery_mode: codexDeliveryForTask(task) });
        return;
      }

      const ok = enqueueTask(targetAgent, task);
      if (ok) {
        const mode = delivery === "attached" ? "codex-attached" : (CODEX_MODE === "exec" ? "codex-exec" : "codex-tui");
        json(202, { accepted: true, agent: targetAgent, mode, delivery_mode: delivery });
        if (delivery === "detached") scheduleCodexQueue(targetAgent);
      } else {
        json(409, { error: "queue full" });
      }
      return;
    }

    // 检查是否有 Plugin 在线（long-poll 存活 或 进程存活）
    const q = getAgentQueue(targetAgent);
    const agentInfo = agents.get(targetAgent);
    const hasPlugin = q.waitingResponse
      || (agentInfo && agentInfo.lastSeen && Date.now() - agentInfo.lastSeen < AGENT_ALIVE_TIMEOUT)
      || (agentInfo && isProcessAlive(agentInfo.pluginPid));

    if (hasPlugin) {
      // 有 Plugin 在线，正常入队
      const ok = enqueueTask(targetAgent, task);
      if (ok) {
        json(202, { accepted: true, agent: targetAgent, mode: "plugin-bridge" });
      } else {
        json(409, { error: "queue full" });
      }
    } else {
        // 无 Plugin 在线 → 按需拉起（opencode: screen TUI, claude-code: screen TUI + hooks）
      log(`🔄 ${targetAgent} 无 Plugin 在线，按需拉起 (runtime=${runtime})...`);

      // 先入队（拉起后 Plugin/Wait 会取走）；入队失败时不能继续返回 accepted，
      // 否则 Server 会等待一个实际上不存在的任务直到超时。
      const queued = enqueueTask(targetAgent, task);
      if (!queued) {
        json(409, { accepted: false, agent: targetAgent, error: "queue full" });
        return;
      }
      json(202, { accepted: true, agent: targetAgent, mode: "auto-launch" });

      // 异步拉起（不阻塞 HTTP 响应）
      const agentDir = projectPath || agents.get(targetAgent)?.directory || DIRECTORY;
      const spawnStartedAt = Date.now();
      spawnAgent(targetAgent, agentDir, runtime).then(ok => {
        if (ok) {
          const info = serveProcesses.get(targetAgent);
          if (info) info.lastTaskAt = Date.now();
        } else {
          const msg = `按需拉起失败: ${targetAgent} runtime=${runtime}`;
          const pending = getAgentQueue(targetAgent).pending;
          const idx = pending.findIndex(t => t.id === task.id);
          if (idx >= 0) pending.splice(idx, 1);
          log(`❌ ${msg}`);
          reportTaskResult(task, "failed", msg, Date.now() - spawnStartedAt).catch(err => {
            log(`⚠ 按需拉起失败回报异常: ${err.message}`);
          });
        }
      }).catch(err => {
        const msg = `按需拉起失败: ${targetAgent} ${err.message}`;
        const pending = getAgentQueue(targetAgent).pending;
        const idx = pending.findIndex(t => t.id === task.id);
        if (idx >= 0) pending.splice(idx, 1);
        log(`❌ ${msg}`);
        reportTaskResult(task, "failed", msg, Date.now() - spawnStartedAt).catch(reportErr => {
          log(`⚠ 按需拉起失败回报异常: ${reportErr.message}`);
        });
      });
    }
    return;
  }

  // GET /tasks/pending — 查看待执行任务
  if (req.method === "GET" && pathname === "/tasks/pending") {
    const agent = urlObj.searchParams.get("agent");
    if (agent) {
      const q = taskQueues.get(agent);
      json(200, { task: q?.pending || null });
    } else {
      // 兼容旧版：返回任意一个 pending task
      let found = null;
      for (const [, q] of taskQueues) { if (q.pending.length > 0) { found = q.pending[0]; break; } }
      json(200, { task: found });
    }
    return;
  }

  // GET|POST /tasks/take — 取走任务（Claude Code: wait 通知后 take 取走）
  if ((req.method === "GET" || req.method === "POST") && pathname === "/tasks/take") {
    const agent = urlObj.searchParams.get("agent");
    // 按 agent 取
    if (agent) {
      const q = taskQueues.get(agent);
      if (q?.pending.length > 0) {
        const task = q.pending.shift();
        q.lastExecuted = task;
        json(200, { task });
      } else {
        json(200, { task: null });
      }
    } else {
      // 兼容旧版：取任意一个
      let found = null;
      for (const [, q] of taskQueues) {
        if (q.pending.length > 0) {
          found = q.pending.shift();
          q.lastExecuted = found;
          break;
        }
      }
      json(200, { task: found });
    }
    return;
  }

  // GET /tasks/wait — long-poll 等待任务通知（按 agent 隔离）
  // 每次 long-poll 请求本身就是 agent 存活心跳
  // Plugin 解耦后：执行期间 long-poll 继续运行，但不分发新任务
  if (req.method === "GET" && pathname === "/tasks/wait") {
    const agent = urlObj.searchParams.get("agent");
    // 确定目标 agent
    let targetAgent = agent;
    if (!targetAgent) {
      // 兼容旧版：如果只有一个 agent，用那个
      if (agents.size === 1) targetAgent = [...agents.keys()][0];
    }

    if (!targetAgent) {
      json(400, { error: "agent param required" });
      return;
    }

    // long-poll 请求 = agent 存活信号
    touchAgent(targetAgent);

    const q = getAgentQueue(targetAgent);
    const bindWaitingResponse = () => {
      q.waitingResponse = res;
      req.on("close", () => {
        if (q.waitingResponse === res) {
          q.waitingResponse = null;
          log(`🔌 ${targetAgent} long-poll 断开`);
        }
      });
    };
    const agentInfo = agents.get(targetAgent);
    const runtime = agentInfo?.runtime || "opencode";

    // 正在执行任务时不分发新任务（留在 pending 等执行完）
    if (q.executingTaskId) {
      // 仍然挂起 long-poll（保持连接心跳），但不取 pending
      if (q.waitingResponse) {
        try { q.waitingResponse.writeHead(200, { "Content-Type": "application/json" }); q.waitingResponse.end('{"task":null}'); } catch {}
      }
      bindWaitingResponse();
      setTimeout(() => {
        if (q.waitingResponse === res) {
          q.waitingResponse = null;
          try { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"task":null}'); } catch {}
        }
      }, 2_000);
      return;
    }

    if (q.pending.length > 0) {
      if (runtime === "claude-code") {
        json(200, { task: { id: q.pending[0].id, title: q.pending[0].title, _notify: true } });
      } else if (runtime === "codex") {
        const task = q.pending[0];
        const requested = codexDeliveryForTask(task);
        if (requested !== "detached") {
          q.pending.shift();
          q.lastExecuted = task;
          q.executingTaskId = task.id;
          json(200, { task, delivery_mode: "attached" });
        } else {
          json(200, { task: null, delivery_mode: "detached" });
          scheduleCodexQueue(targetAgent);
        }
      } else {
        const task = q.pending.shift();
        q.lastExecuted = task;
        // 分发时立即标记 executing（不等 Plugin 的 /tasks/executing 通知，防止竞态重复分发）
        q.executingTaskId = task.id;
        json(200, { task });
      }
    } else {
      // long-poll：挂起连接
      if (q.waitingResponse) {
        try { q.waitingResponse.writeHead(200, { "Content-Type": "application/json" }); q.waitingResponse.end('{"task":null}'); } catch {}
      }
      bindWaitingResponse();
      setTimeout(() => {
        if (q.waitingResponse === res) {
          q.waitingResponse = null;
          try { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"task":null}'); } catch {}
        }
      }, 2_000);
    }
    return;
  }

  // POST /tasks/executing — Plugin 通知开始执行任务（状态 → busy）
  if (req.method === "POST" && pathname === "/tasks/executing") {
    const body = await readBody();
    const agentName = body.agent_name;
    const taskId = body.task_id;
    if (agentName) {
      const q = getAgentQueue(agentName);
      q.executingTaskId = taskId || "unknown";
      touchAgent(agentName);
      log(`🔧 ${agentName} 开始执行任务: ${taskId}`);
    }
    json(200, { ok: true });
    return;
  }

  // POST /tasks/done — Plugin 回报任务执行结果
  if (req.method === "POST" && pathname === "/tasks/done") {
    const body = await readBody();
    const agentName = body.agent_name;
    log(`📬 Plugin 回报: task=${body.task_id} status=${body.status} (${body.duration_ms}ms)`);

    // 清除 executing 标记
    if (agentName && taskQueues.has(agentName)) {
      taskQueues.get(agentName).executingTaskId = null;
    }

    // 找到对应的 lastExecuted task
    let task = null;
    if (agentName && taskQueues.has(agentName)) {
      task = taskQueues.get(agentName).lastExecuted;
      taskQueues.get(agentName).lastExecuted = null;
    }
    if (!task) {
      // 兼容：遍历所有队列找 lastExecuted
      for (const [, q] of taskQueues) {
        if (q.lastExecuted) { task = q.lastExecuted; q.lastExecuted = null; break; }
      }
    }
    if (!task) task = { id: body.task_id };

    const reportAck = await reportTaskResult(task, body.status, body.result || "", body.duration_ms || 0);

    if (body.task_id && codexTaskScreens.has(body.task_id)) {
      const info = codexTaskScreens.get(body.task_id);
      info.lastTaskAt = Date.now();
    }

    // Claude Code 模式：检查队列是否有下一个任务（续传，避免等 asyncRewake）
    // Codex detached 模式：完成后再拉起下一个 screen + TUI/exec 任务（attached 不会被 scheduleCodexQueue 调度）
    // opencode 模式不续传（它用 long-poll 自己取）
    let nextTask = null;
    const agentInfo = agentName ? agents.get(agentName) : null;
    if (agentInfo?.runtime === "codex" && agentName && taskQueues.has(agentName)) {
      if (taskQueues.get(agentName).pending.length > 0) scheduleCodexQueue(agentName);
    }
    if (agentInfo?.runtime === "claude-code" && agentName && taskQueues.has(agentName)) {
      const q = taskQueues.get(agentName);
      if (q.pending.length > 0) {
        nextTask = q.pending.shift();
        q.lastExecuted = nextTask;
        q.executingTaskId = nextTask.id;
        log(`📋 ${agentName} 续传下一个任务: "${nextTask.title}"`);
      }
    }
    json(200, { ok: true, workflow_reported: reportAck?.workflow_reported !== false, workflow_error: reportAck?.error || "", next_task: nextTask });
    return;
  }

  // POST /proposals/submit — Agent 提交提议（转发到 Server）
  if (req.method === "POST" && pathname === "/proposals/submit") {
    const body = await readBody();
    if (!body.from_agent || !body.title || !body.type) {
      json(400, { error: "from_agent, type, and title required" });
      return;
    }
    // 附上 user_id
    body.user_id = body.user_id || userId;
    try {
      const srvRes = await fetch(`${META_AGENT_SERVER}/api/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await srvRes.json();
      log(`📨 proposal 转发: "${body.title}" → Server (${srvRes.status})`);
      json(srvRes.status, data);
    } catch (err) {
      log(`⚠ proposal 转发失败: ${err.message}`);
      json(502, { error: `Server 不可达: ${err.message}` });
    }
    return;
  }

  // GET /proposals — 查询提议（从 Server 拉取）
  if (req.method === "GET" && pathname === "/proposals") {
    const qs = urlObj.search || "";
    try {
      const srvRes = await fetch(`${META_AGENT_SERVER}/api/proposals${qs}`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await srvRes.json();
      json(srvRes.status, data);
    } catch (err) {
      json(502, { error: `Server 不可达: ${err.message}` });
    }
    return;
  }

  // POST /ping — Server 广播重连
  if (req.method === "POST" && pathname === "/ping") {
    log("📡 收到 ping，重新注册");
    for (const [, info] of agents) info.registered = false;
    registerToServer();
    json(200, { ok: true, agents: [...agents.keys()] });
    return;
  }

  // GET /status
  if (req.method === "GET" && pathname === "/status") {
    json(200, {
      agents: [...agents.keys()],
      user_id: userId,
      directory: DIRECTORY,
      pid: process.pid,
      version: CLIENT_VERSION,
    });
    return;
  }

  // POST /ota
  if (req.method === "POST" && pathname === "/ota") {
    const body = await readBody();
    log(`📦 OTA: ${(body.files || []).length} 个文件`);
    const result = performOTA(body);
    log(`📦 OTA 结果: applied=${result.applied} failed=${result.failed} daemon_updated=${result.daemon_updated}`);
    json(200, result);
    if (result.daemon_updated) {
      log("🔄 daemon.mjs 已更新，1 秒后自重启...");
      setTimeout(() => process.exit(0), 1000);
    }
    return;
  }

  // POST /evolve — Server 推送进化指令（skill/agent-config/mcp 文件推送 + 命令执行）
  if (req.method === "POST" && pathname === "/evolve") {
    const body = await readBody();
    const evolveId = body.evolve_id || "unknown";
    const actions = body.actions || [];
    const runtime = body.target_runtime || "opencode";
    log(`🧬 Evolve: "${body.title}" (${evolveId}), ${actions.length} actions, runtime=${runtime}`);

    const start = Date.now();
    const results = [];

    for (const action of actions) {
      try {
        if (action.type === "push_files") {
          const r = executeEvolvePushFiles(action, runtime);
          results.push(r);
          if (r.status === "failed") break; // 前一个失败则后续跳过
        } else if (action.type === "run_command") {
          const r = executeEvolveRunCommand(action);
          results.push(r);
          if (r.status === "failed") break;
        } else if (action.type === "restart_agent") {
          results.push({ type: "restart_agent", status: "failed", message: "restart_agent not implemented" });
          break;
        } else if (action.type === "reload_config") {
          results.push({ type: "reload_config", status: "failed", message: "reload_config not implemented" });
          break;
        } else {
          results.push({ type: action.type, status: "failed", message: `unknown action type: ${action.type}` });
        }
      } catch (err) {
        results.push({ type: action.type, status: "failed", message: err.message });
        break;
      }
    }

    const allOk = results.every(r => r.status === "ok");
    const evolveResult = {
      evolve_id: evolveId,
      status: allOk ? "completed" : (results.some(r => r.status === "ok") ? "partial" : "failed"),
      actions: results,
      duration_ms: Date.now() - start,
    };

    log(`🧬 Evolve 结果: ${evolveResult.status} (${evolveResult.duration_ms}ms)`);
    json(200, { accepted: true, result: evolveResult });

    // 异步回报结果到 Server
    if (META_AGENT_SERVER) {
      fetch(`${META_AGENT_SERVER}/api/evolve/${evolveId}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(evolveResult),
        signal: AbortSignal.timeout(10_000),
      }).catch(err => log(`⚠ Evolve 回报失败: ${err.message}`));
    }
    return;
  }

  // POST /shutdown — daemon=true 时退出 Daemon；否则兼容旧版：清理指定 agent
  if (req.method === "POST" && pathname === "/shutdown") {
    const body = await readBody();
    const agent = body.agent_name;
    if (body.daemon === true || !agent) {
      log(`📴 shutdown: Daemon 退出${body.reason ? ` (${body.reason})` : ""}`);
      json(200, { ok: true, shutdown: true });
      setTimeout(() => process.exit(0), 100).unref?.();
      return;
    }
    if (agent && agents.has(agent)) {
      agents.delete(agent);
      const q = taskQueues.get(agent);
      if (q?.waitingResponse) {
        try { q.waitingResponse.writeHead(200, { "Content-Type": "application/json" }); q.waitingResponse.end('{"task":null}'); } catch {}
      }
      taskQueues.delete(agent);
      log(`📴 shutdown: 清理 agent ${agent} (剩余=[${[...agents.keys()].join(", ")}])`);
    }
    // Node Daemon 常驻——即使没有 agent 也不退出，等待新连接或 Server 推任务
    json(200, { ok: true, agents: [...agents.keys()] });
    return;
  }

  json(404, { error: "not found" });
});

// ============================================================
// 启动
// ============================================================
httpServer.listen(NODE_PORT, "0.0.0.0", () => {
  const addr = httpServer.address();
  const port = addr.port;
  daemonUrl = `http://${getLocalIP()}:${port}`;

  // 通过 stdout 告诉 Plugin 实际端口，然后关闭 stdout/stderr 防 EPIPE
  try { process.stdout.write(`PORT:${port}\n`); } catch {}
  try { process.stdout.end(); } catch {}
  try { process.stderr.end(); } catch {}

  // 写端口文件（统一一个文件，不再按 agent 分文件）
  try { writeFileSync(join(STATE_DIR, "daemon-port"), String(port)); } catch {}

  log(`Node Daemon 启动: pid=${process.pid} port=${port}`);
  log(`  对外地址: ${daemonUrl}`);
  log(`  Plugin 目录: ${PLUGIN_DIR}`);

  // 初始化用户标识
  if (!userId) userId = detectUserId();

  // 如果有初始 agent（Claude Code --daemon 模式传入），立即注册
  const initAgent = process.env.MAF_AGENT_NAME;
  const initRuntime = process.env.MAF_RUNTIME || "opencode";
  if (initAgent) {
    agents.set(initAgent, {
      runtime: initRuntime,
      pluginPid: 0,
      directory: DIRECTORY,
      registered: false,
      sessionId: "",
      lastSeen: Date.now(),
    });
    log(`  初始 agent: ${initAgent} (runtime=${initRuntime})`);
    registerToServer();
  }

  // 启动心跳 + 任务轮询 + agent 存活清理 + serve 空闲清理
  setInterval(heartbeat, HEARTBEAT_INTERVAL);
  setInterval(pollTasks, POLL_INTERVAL);
  setInterval(cleanDeadAgents, 60_000);
  setInterval(cleanIdleServes, 60_000);
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // 端口已被占用——说明已有 Node Daemon 在运行
    log(`端口 ${NODE_PORT} 已被占用，Node Daemon 可能已在运行`);
    // 通过 stdout 通知调用方已有实例
    try { process.stdout.write(`PORT:${NODE_PORT}\n`); } catch {}
    process.exit(0);
  }
  log(`HTTP error: ${err.message}`);
  process.exit(1);
});

process.on("SIGINT", () => { cleanAllServes(); process.exit(0); });
process.on("SIGTERM", () => { cleanAllServes(); process.exit(0); });
process.on("uncaughtException", (err) => {
  // 只写文件，绝不写 stdout/stderr（防 EPIPE 死循环）
  try { appendFileSync(LOG_FILE, `${new Date().toISOString().slice(11, 23)} [node-daemon] 异常: ${err.message}\n`); } catch {}
});
