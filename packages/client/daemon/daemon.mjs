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
 *   MAF_CODEX_DELIVERY  — Codex 投递语义：detached（默认）| attached | auto
 */

import { createServer } from "node:http";
import { spawn, execSync, execFile, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync, readdirSync, statSync, renameSync, chmodSync, rmSync, createWriteStream } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { homedir, hostname, userInfo, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ============================================================
// 配置（maf.config.json 为权威源，环境变量仅作兼容兜底）
// ============================================================

/** 读取 maf.config.json（全局配置基础上允许项目级覆盖） */
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

/**
 * Agent 发布策略是本机隐私边界，只允许用户级配置定义。
 * 项目目录中的 maf.config.json 不能放宽该策略。
 */
function loadAgentPublicationPolicy() {
  const configPath = join(homedir(), ".meta-agent-framework", "maf.config.json");
  if (!existsSync(configPath)) {
    return { mode: "all", include: new Set(), localOnly: new Set(), clientNetwork: "always" };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // 配置存在但不可解析时 fail closed，避免误发布 Agent。
    return { mode: "explicit", include: new Set(), localOnly: new Set(), clientNetwork: "when-published" };
  }

  const raw = config?.client?.agent_publication;
  if (raw == null) {
    return { mode: "all", include: new Set(), localOnly: new Set(), clientNetwork: "always" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { mode: "explicit", include: new Set(), localOnly: new Set(), clientNetwork: "when-published" };
  }

  const names = values => new Set(
    (Array.isArray(values) ? values : [])
      .filter(value => typeof value === "string")
      .map(value => value.trim())
      .filter(Boolean),
  );
  const mode = raw.mode === "all" ? "all" : "explicit";
  const clientNetwork = raw.client_network === "always" ? "always" : "when-published";
  return {
    mode,
    include: names(raw.include),
    localOnly: names(raw.local_only),
    clientNetwork,
  };
}

const AGENT_PUBLICATION = loadAgentPublicationPolicy();

function resolveAgentVisibility(agentName) {
  const name = String(agentName || "").trim();
  if (AGENT_PUBLICATION.localOnly.has(name)) return "local-only";
  if (AGENT_PUBLICATION.mode === "explicit" && !AGENT_PUBLICATION.include.has(name)) return "local-only";
  return "published";
}
const STATE_DIR = process.env.MAF_HOME || join(homedir(), ".meta-agent-framework");
const AUTH_DIR = join(STATE_DIR, "auth");
const CLIENT_ID_FILE = join(AUTH_DIR, "client-id");
const CLIENT_PRIVATE_KEY_FILE = join(AUTH_DIR, "client-private.pem");
const CLIENT_PUBLIC_KEY_FILE = join(AUTH_DIR, "client-public.pem");
const LOCAL_TOKEN_FILE = join(AUTH_DIR, "local-token");
const SERVER_PUBLIC_KEY_FILE = join(AUTH_DIR, "server-public.pem");
const USER_ID_FILE = join(AUTH_DIR, "user-id");
const AGENT_INVENTORY_FILE = join(STATE_DIR, "state", "agent-inventory.json");

function readText(path) {
  try { return readFileSync(path, "utf-8").trim(); } catch { return ""; }
}

function writeSecret(path, value, mode = 0o600) {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode });
  try { chmodSync(path, mode); } catch {}
}

function detectInitialUserId() {
  const explicit = String(process.env.MAF_USER_ID || "").trim();
  if (explicit) return explicit;
  try {
    const email = execFileSync(
      "git",
      ["config", "--global", "user.email"],
      { encoding: "utf-8", timeout: 3000 },
    ).trim();
    if (email) return email.includes("@") ? email.split("@", 1)[0] : email;
  } catch {}
  return userInfo().username;
}

function ensureStableUserId() {
  const existing = readText(USER_ID_FILE);
  if (existing) return existing;
  const detected = detectInitialUserId();
  writeSecret(USER_ID_FILE, `${detected}\n`);
  return detected;
}

function ensureMachineIdentity() {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  let clientId = readText(CLIENT_ID_FILE);
  let privateKey = readText(CLIENT_PRIVATE_KEY_FILE);
  let publicKey = readText(CLIENT_PUBLIC_KEY_FILE);
  let localToken = readText(LOCAL_TOKEN_FILE);
  if (privateKey) {
    try {
      publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
      if (readText(CLIENT_PUBLIC_KEY_FILE) !== publicKey.trim()) {
        writeSecret(CLIENT_PUBLIC_KEY_FILE, publicKey, 0o644);
      }
    } catch {
      privateKey = "";
      publicKey = "";
    }
  }
  if (!privateKey) {
    // The private key is the machine identity. If it is lost, the old client_id
    // can no longer prove ownership, so create a fresh identity that can enroll.
    clientId = randomUUID();
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    writeSecret(CLIENT_ID_FILE, `${clientId}\n`);
    writeSecret(CLIENT_PRIVATE_KEY_FILE, privateKey);
    writeSecret(CLIENT_PUBLIC_KEY_FILE, publicKey, 0o644);
  } else if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientId)) {
    clientId = randomUUID();
    writeSecret(CLIENT_ID_FILE, `${clientId}\n`);
  }
  if (!localToken) {
    localToken = process.env.MAF_LOCAL_TOKEN || randomBytes(32).toString("base64url");
    writeSecret(LOCAL_TOKEN_FILE, `${localToken}\n`);
  }
  return { clientId, privateKey, publicKey, localToken, userId: ensureStableUserId() };
}

const MACHINE_IDENTITY = ensureMachineIdentity();

const NODE_PORT = parseInt(process.env.MAF_NODE_PORT || "0") || parseInt(process.env.MAF_DAEMON_PORT || "0") || _mafCfg.daemon?.port || 4100;
const DIRECTORY = process.env.MAF_DIRECTORY || process.cwd();
const DAEMON_FILE = fileURLToPath(import.meta.url);
const DAEMON_DIR = dirname(DAEMON_FILE);
const PLUGIN_DIR = process.env.MAF_PLUGIN_DIR || DAEMON_DIR;
const META_AGENT_SERVER = _mafCfg.server?.url || process.env.META_AGENT_SERVER || "";
const LOCAL_AUTH_TOKEN = String(
  process.env.MAF_LOCAL_TOKEN
  || readText(LOCAL_TOKEN_FILE)
  || "",
).trim();
if (!META_AGENT_SERVER) {
  console.error("[node-daemon] ❌ Server URL 未配置！运行 maf-client install http://<Server-IP>:3000");
}
if (!/^[A-Za-z0-9._~+/=-]{32,512}$/.test(LOCAL_AUTH_TOKEN)) {
  console.error("[node-daemon] ❌ 本机 Daemon 凭证初始化失败");
  process.exit(1);
}

function localAuthHeaders(headers = {}) {
  return { ...headers, Authorization: `Bearer ${LOCAL_AUTH_TOKEN}` };
}

function requestTarget(url) {
  const parsed = new URL(url, "http://maf.local");
  return `${parsed.pathname}${parsed.search}`;
}

function canonicalRequest(method, target, timestamp, nonce, body = "") {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "", "utf-8");
  const bodyHash = createHash("sha256").update(bytes).digest("hex");
  return Buffer.from([method.toUpperCase(), requestTarget(target), timestamp, nonce, bodyHash].join("\n"), "utf-8");
}

function clientAuthHeaders(method, url, body = "", headers = {}) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url");
  const signature = sign(
    null,
    canonicalRequest(method, url, timestamp, nonce, body),
    MACHINE_IDENTITY.privateKey,
  ).toString("base64url");
  return {
    ...headers,
    "X-MAF-Role": "client",
    "X-MAF-ID": MACHINE_IDENTITY.clientId,
    "X-MAF-Timestamp": timestamp,
    "X-MAF-Nonce": nonce,
    "X-MAF-Signature": signature,
  };
}

let enrollmentStatus = "unknown";
const serverNonces = new Map();

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return String(headers.get(name) || "");
  return String(headers?.[name.toLowerCase()] || headers?.[name] || "");
}

function serverMessageAuthorized(headers, method, target, body = Buffer.alloc(0)) {
  if (enrollmentStatus !== "active") return false;
  const publicKey = readText(SERVER_PUBLIC_KEY_FILE);
  if (!publicKey || headerValue(headers, "x-maf-role") !== "server"
      || headerValue(headers, "x-maf-id") !== "maf-server") return false;
  const timestamp = headerValue(headers, "x-maf-timestamp");
  const nonce = headerValue(headers, "x-maf-nonce");
  const signature = headerValue(headers, "x-maf-signature");
  const now = Date.now();
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 60_000) return false;
  for (const [key, expiresAt] of serverNonces) {
    if (expiresAt <= now) serverNonces.delete(key);
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || serverNonces.has(nonce)) return false;
  try {
    const ok = verify(
      null,
      canonicalRequest(method, target, timestamp, nonce, body),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    if (ok) serverNonces.set(nonce, timestampMs + 60_000);
    return ok;
  } catch {
    return false;
  }
}

function serverSignatureAuthorized(req, body = Buffer.alloc(0)) {
  return serverMessageAuthorized(req.headers, req.method, req.url, body);
}

function requestAuthorized(req, body = Buffer.alloc(0)) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (match) {
    const actual = Buffer.from(match[1]);
    const expected = Buffer.from(LOCAL_AUTH_TOKEN);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  }
  return serverSignatureAuthorized(req, body);
}
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

const CLIENT_VERSION = process.env.MAF_VERSION || readVersionFromPackageTree(DAEMON_DIR) || readVersionFromPackageTree(PLUGIN_DIR) || "0.0.0";
const HEARTBEAT_INTERVAL = 1_000;
const POLL_INTERVAL = 1_000;
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

const LOG_MAX_BYTES = parseInt(process.env.MAF_LOG_MAX_BYTES || "", 10) || 20 * 1024 * 1024;
const LOG_BACKUPS = parseInt(process.env.MAF_LOG_BACKUPS || "", 10) || 2;

function rotateLogIfNeeded(incomingBytes = 0) {
  try {
    if (statSync(LOG_FILE).size + incomingBytes <= LOG_MAX_BYTES) return;
  } catch { return; }
  for (let i = Math.max(0, LOG_BACKUPS); i >= 1; i--) {
    const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
    const dst = `${LOG_FILE}.${i}`;
    try { unlinkSync(dst); } catch {}
    try { renameSync(src, dst); } catch {}
  }
}

function appendLogLine(content) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    rotateLogIfNeeded(Buffer.byteLength(content));
    appendFileSync(LOG_FILE, content);
  } catch {}
}
mkdirSync(LOG_DIR, { recursive: true });
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} [node-daemon] ${msg}\n`;
  // 只写文件，不用 console.error（detached 进程 stderr 可能 EPIPE）
  appendLogLine(line);
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

function expandHomePath(path) {
  return resolve(String(path || "").replace(/^~(?=\/|$)/, homedir()));
}

function currentClientBundleHash() {
  const manifestPath = join(STATE_DIR, "ota-manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!/^[a-f0-9]{16}$/.test(String(manifest.bundle_hash || "")) || !Array.isArray(manifest.assets)) return "";
    const complete = manifest.assets.every(asset =>
      asset && typeof asset.path === "string" && /^[a-f0-9]{16}$/.test(String(asset.hash || ""))
      && fileHash(expandHomePath(asset.path)) === asset.hash
    );
    if (complete) return manifest.bundle_hash;
  } catch {}
  // Backward-compatible signal for Servers that still understand plugin_hash
  // as the OpenCode entry hash. A full OTA replaces it with the bundle hash.
  return fileHash(join(homedir(), ".config", "opencode", "plugins", "opencode-plugin-meta-agent-framework", "index.js"))
    || fileHash(join(PLUGIN_DIR, "index.js"));
}

const DAEMON_SELF_HASH = fileHash(DAEMON_FILE);
let CLIENT_BUNDLE_HASH = currentClientBundleHash();

// ============================================================
// Agent Manager — 管理本机所有 agent
// ============================================================
// agents Map: agent_name → { runtime, pluginPid, directory, registered, sessionId, lastSeen, visibility }
const agents = new Map();

function persistCodexAgentInventory() {
  const entries = [...agents.entries()]
    .filter(([agentName, info]) => info.runtime === "codex" && !isServerAgentName(agentName))
    .map(([agentName, info]) => ({
      agent_name: agentName,
      runtime: "codex",
      directory: String(info.directory || ""),
    }));
  const directory = dirname(AGENT_INVENTORY_FILE);
  const temporary = `${AGENT_INVENTORY_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ version: 1, agents: entries }, null, 2)}\n`, "utf-8");
    renameSync(temporary, AGENT_INVENTORY_FILE);
  } catch (err) {
    try { unlinkSync(temporary); } catch {}
    log(`⚠ Codex Agent 清单保存失败: ${err.message}`);
  }
}

function restoreCodexAgentInventory() {
  if (!existsSync(AGENT_INVENTORY_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(AGENT_INVENTORY_FILE, "utf-8"));
    const entries = Array.isArray(parsed?.agents) ? parsed.agents : [];
    let restored = 0;
    for (const entry of entries) {
      const name = String(entry?.agent_name || "").trim();
      const directory = String(entry?.directory || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || isServerAgentName(name) || !directory) continue;
      agents.set(name, {
        runtime: "codex",
        pluginPid: 0,
        directory,
        registered: false,
        sessionId: "",
        lastSeen: 0,
        visibility: resolveAgentVisibility(name),
      });
      restored++;
    }
    if (restored > 0) log(`📦 恢复 ${restored} 个可按需启动的 Codex Agent`);
  } catch (err) {
    log(`⚠ Codex Agent 清单读取失败: ${err.message}`);
  }
}

restoreCodexAgentInventory();

function publishedAgentEntries() {
  return [...agents.entries()].filter(([, info]) => info.visibility === "published");
}

function publishedAgentNames() {
  return publishedAgentEntries().map(([name]) => name);
}

function localOnlyAgentNames() {
  return [...agents.entries()]
    .filter(([, info]) => info.visibility === "local-only")
    .map(([name]) => name);
}

function isPublishedAgent(agentName) {
  return agents.get(agentName)?.visibility === "published";
}

function shouldContactServer() {
  return AGENT_PUBLICATION.clientNetwork === "always" || publishedAgentEntries().length > 0;
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function agentNamesForRequest(req) {
  return isLoopbackRequest(req) ? [...agents.keys()] : publishedAgentNames();
}

// 每个 agent 独立的任务队列
// taskQueues Map: agent_name → { pending, lastExecuted, waitingResponse, executingTaskId }
const taskQueues = new Map();

// Workflow 跟踪表：记录经过此 Daemon 的所有 workflow 任务状态
// workflowTracker Map: workflow_id → { title, agent_name, node_id, status, dispatched_at, completed_at, result }
const workflowTracker = new Map();

let userId = MACHINE_IDENTITY.userId;
let hostUser = userInfo().username;
let daemonUrl = "";
let lastInventoryFP = "";

// agent 存活检测：Plugin/Wait 通过 long-poll 或 connect 保持心跳
// 超过此时间未活跃视为 offline（Plugin 退出但 disconnect 没发出的情况）
const AGENT_ALIVE_TIMEOUT = 5_000;  // 5s（long-poll 2s 周期 × 2 + 裕量）

const MAX_QUEUE_SIZE = 10;
const RESULT_MAX_CHARS = parseInt(process.env.MAF_RESULT_MAX_CHARS || "0") || 200_000;
const EXECUTION_TASK_TIMEOUT_MS = parseInt(process.env.MAF_EXECUTION_TIMEOUT_MS || "0") || 60 * 60_000;
const WORKSPACE_WAIT_TIMEOUT_MS = parseInt(process.env.MAF_WORKSPACE_WAIT_TIMEOUT_MS || "0") || 23 * 60 * 60_000;
const DAEMON_INSTANCE_ID = randomUUID();
const CODEX_TASK_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_TIMEOUT_MS || "0") || 45 * 60_000;
const CODEX_SANDBOX = process.env.MAF_CODEX_SANDBOX || "danger-full-access";
const CODEX_APPROVAL = process.env.MAF_CODEX_APPROVAL || "never";
const CODEX_BYPASS_SANDBOX = process.env.MAF_CODEX_BYPASS_SANDBOX === "1" || process.env.MAF_CODEX_DANGEROUS_BYPASS === "1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODE = process.env.MAF_CODEX_MODE || "tui"; // tui（screen + Codex TUI）| exec（headless）
const CODEX_DELIVERY = normalizeCodexDelivery(process.env.MAF_CODEX_DELIVERY || "detached");
const codexQueueRunners = new Set();
const managedExecutionQueueRunners = new Set();
const codexTaskScreens = new Map(); // task_id → { agentName, screenName, startedAt, lastTaskAt }
const executionProcesses = new Map(); // execution_id/task_id → ChildProcess
const cancelledExecutions = new Map(); // execution_id/task_id → cancelled_at
const CANCELLED_EXECUTION_TTL_MS = 24 * 60 * 60 * 1000;
const CANCELLED_EXECUTION_MAX = 10_000;

function normalizeCodexDelivery(value) {
  const v = String(value || "detached").trim().toLowerCase();
  if (["detached", "screen", "tui", "daemon", "offline"].includes(v)) return "detached";
  if (["auto", "fallback"].includes(v)) return "auto";
  if (["attached", "current", "foreground"].includes(v)) return "attached";
  return "detached";
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

function safeExecutionPart(value, fallback = "execution") {
  const result = String(value || "").trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return result || fallback;
}

function safeArtifactPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) throw new Error(`非法 Artifact 路径: ${value}`);
  return parts.join("/");
}

function childPath(root, relativePath) {
  const target = resolve(root, relativePath);
  const absoluteRoot = resolve(root);
  if (!target.startsWith(absoluteRoot + sep)) throw new Error(`Artifact 路径越界: ${relativePath}`);
  return target;
}

function executionPaths(context) {
  const executionDir = join(STATE_DIR, "executions", safeExecutionPart(context.execution_id));
  return {
    executionDir,
    inputDir: join(executionDir, "input"),
    outputDir: join(executionDir, "output"),
    manifestPath: join(executionDir, "workspace.json"),
  };
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function gitOutputAsync(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf-8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim();
    throw new Error(`git ${args.join(" ")} 失败: ${detail.slice(0, 2000)}`);
  }
}

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return null; }
}

function agentRepositoryConfig(agentName, base) {
  const definition = codexAgentDefPaths(agentName, base)[0];
  if (!definition) return { definition: "", targetBranch: "", remoteName: "", definitionHash: "" };
  const raw = readFileSync(definition, "utf-8");
  return {
    definition,
    targetBranch: parseTomlString(raw, "target_branch"),
    remoteName: parseTomlString(raw, "remote_name"),
    definitionHash: createHash("sha256").update(raw).digest("hex"),
  };
}

async function resolveRepositoryRemote(base, targetBranch, configuredRemote) {
  const remotes = (await gitOutputAsync(base, ["remote"])).split("\n").map(item => item.trim()).filter(Boolean);
  if (configuredRemote) {
    if (!remotes.includes(configuredRemote)) throw new Error(`配置的 Git remote 不存在: ${configuredRemote}`);
    return configuredRemote;
  }
  try {
    const upstreamRemote = await gitOutputAsync(base, ["config", "--get", `branch.${targetBranch}.remote`]);
    if (upstreamRemote && upstreamRemote !== "." && remotes.includes(upstreamRemote)) return upstreamRemote;
  } catch {}
  const candidates = [];
  for (const remote of remotes) {
    try {
      await gitOutputAsync(base, ["rev-parse", "--verify", `refs/remotes/${remote}/${targetBranch}^{commit}`]);
      candidates.push(remote);
    } catch {}
  }
  if (candidates.length === 1) return candidates[0];
  if (remotes.length === 1) return remotes[0];
  if (candidates.length > 1) throw new Error(`目标分支 ${targetBranch} 同时存在于多个 remote: ${candidates.join(", ")}，请配置 remote_name`);
  throw new Error(`无法为目标分支 ${targetBranch} 唯一确定 Git remote，请配置 remote_name`);
}

function repositoryLockPaths(base) {
  const identity = createHash("sha256").update(resolve(base)).digest("hex").slice(0, 20);
  const directory = join(STATE_DIR, "repository-locks");
  return { workspaceDir: directory, lockPath: join(directory, `${identity}.lock`) };
}

function repositoryDirtyLines(raw) {
  return String(raw || "").split("\n").filter(Boolean);
}

async function restoreDirectRepository(paths) {
  if (!paths?.direct || !paths.writeAllowed) return;
  if (paths.originalBranch) await gitOutputAsync(paths.sourceDir, ["checkout", paths.originalBranch]);
  else await gitOutputAsync(paths.sourceDir, ["checkout", "--detach", paths.originalCommit]);
  try { await gitOutputAsync(paths.sourceDir, ["branch", "-D", paths.taskBranch]); } catch {}
}

async function acquireRepositoryLock(paths, context) {
  mkdirSync(paths.workspaceDir, { recursive: true, mode: 0o700 });
  const lock = {
    pid: process.pid,
    daemon_instance_id: DAEMON_INSTANCE_ID,
    execution_id: String(context.execution_id),
    acquired_at: new Date().toISOString(),
  };
  try {
    writeFileSync(paths.lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return;
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  const existing = readJsonFile(paths.lockPath) || {};
  if (existing.daemon_instance_id === DAEMON_INSTANCE_ID && existing.pid === process.pid) {
    throw new Error(`registered repository locked by execution ${existing.execution_id || "unknown"}`);
  }
  try { unlinkSync(paths.lockPath); } catch {}
  writeFileSync(paths.lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function releaseWorkspaceLock(paths, context) {
  const lock = readJsonFile(paths?.lockPath);
  if (!lock || String(lock.execution_id || "") === String(context?.execution_id || "")) {
    try { unlinkSync(paths.lockPath); } catch {}
  }
}

async function downloadExecutionArtifact(context, inputDir, relativePath) {
  const relativeName = safeArtifactPath(relativePath);
  const target = childPath(inputDir, relativeName);
  const temporary = `${target}.download-${process.pid}-${Date.now()}`;
  const encoded = relativeName.split("/").map(encodeURIComponent).join("/");
  const url = `${String(context.artifact_base_url || "").replace(/\/$/, "")}/artifacts/${encoded}`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    renameSync(temporary, target);
  } catch (err) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw new Error(`下载 Artifact ${relativeName} 失败: ${err.message}`);
  }
}

async function prepareExecutionWorkspace(context, baseRepo, agentName) {
  if (!context) return null;
  const local = executionPaths(context);
  mkdirSync(local.inputDir, { recursive: true, mode: 0o700 });
  mkdirSync(local.outputDir, { recursive: true, mode: 0o700 });
  const artifacts = [...new Set(Array.isArray(context.artifacts) ? context.artifacts.map(String) : [])];
  if (context.artifact_base_url) {
    for (const artifact of artifacts) await downloadExecutionArtifact(context, local.inputDir, artifact);
  }

  let base = resolve(String(baseRepo || ""));
  if (!existsSync(base)) throw new Error(`Agent 源码目录不存在: ${base}`);
  base = resolve(await gitOutputAsync(base, ["rev-parse", "--show-toplevel"]));
  const repository = agentRepositoryConfig(agentName, base);
  const lockPaths = repositoryLockPaths(base);
  await acquireRepositoryLock(lockPaths, context);
  try {
    const originalCommit = await gitOutputAsync(base, ["rev-parse", "HEAD"]);
    let originalBranch = "";
    try { originalBranch = await gitOutputAsync(base, ["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch {}
    const dirty = repositoryDirtyLines(await gitOutputAsync(base, ["status", "--porcelain", "--untracked-files=all"]));
    if (dirty.length || !repository.targetBranch) {
      const readOnlyReason = dirty.length
        ? `注册仓库存在本地修改：${dirty.slice(0, 20).join("; ")}`
        : "Agent 配置缺少 target_branch";
      return { ...local, ...lockPaths, sourceDir: base, managed: false, direct: true, writeAllowed: false,
        readOnlyReason, originalCommit, originalBranch, agentDefinition: repository.definition,
        agentDefinitionHash: repository.definitionHash, initialStatus: dirty.join("\n") };
    }

    let remoteName = "";
    try {
      remoteName = await resolveRepositoryRemote(base, repository.targetBranch, repository.remoteName);
      await execFileAsync("git", ["-C", base, "fetch", "--prune", remoteName, repository.targetBranch], {
        encoding: "utf-8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err) {
      return { ...local, ...lockPaths, sourceDir: base, managed: false, direct: true, writeAllowed: false,
        readOnlyReason: String(err?.message || err), originalCommit, originalBranch,
        agentDefinition: repository.definition, agentDefinitionHash: repository.definitionHash, initialStatus: "" };
    }

    const remoteRef = `refs/remotes/${remoteName}/${repository.targetBranch}`;
    const sourceCommit = await gitOutputAsync(base, ["rev-parse", `${remoteRef}^{commit}`]);
    const taskBranch = `maf/${safeExecutionPart(context.external_id || context.execution_id).slice(0, 80)}-${safeExecutionPart(context.execution_id).slice(0, 8)}`;
    try {
      await gitOutputAsync(base, ["show-ref", "--verify", "--quiet", `refs/heads/${taskBranch}`]);
      return { ...local, ...lockPaths, sourceDir: base, managed: false, direct: true, writeAllowed: false,
        readOnlyReason: `任务分支已存在：${taskBranch}，为保护上一次现场不覆盖该分支`, originalCommit, originalBranch,
        agentDefinition: repository.definition, agentDefinitionHash: repository.definitionHash, initialStatus: "" };
    } catch {}
    await gitOutputAsync(base, ["checkout", "-b", taskBranch, remoteRef]);
    const paths = { ...local, ...lockPaths, sourceDir: base, managed: false, direct: true, writeAllowed: true,
      sourceBranch: repository.targetBranch, sourceCommit, remoteName, remoteRef, taskBranch,
      originalCommit, originalBranch, agentDefinition: repository.definition, agentDefinitionHash: repository.definitionHash };
    writeFileSync(local.manifestPath, `${JSON.stringify({ execution_id: context.execution_id, repository: base,
      target_branch: repository.targetBranch, remote_name: remoteName, source_commit: sourceCommit,
      task_branch: taskBranch, original_branch: originalBranch, original_commit: originalCommit,
      created_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return paths;
  } catch (err) {
    releaseWorkspaceLock(lockPaths, context);
    throw err;
  }
}

function withExecutionRuntimeContext(prompt, projectPath, paths) {
  if (!paths) return String(prompt || "");
  return [String(prompt || ""), "", "---", "", "## MAF 运行时仓库契约", "",
    `- 注册源码目录：\`${projectPath}\``,
    `- 证据目录：\`${paths.inputDir}\``,
    `- 报告目录：\`${paths.outputDir}\``,
    `- 源码访问：\`${paths.writeAllowed ? "read_write" : "read_only"}\``,
    paths.sourceBranch ? `- Gerrit 目标分支：\`${paths.sourceBranch}\`` : "",
    paths.remoteName ? `- Git remote：\`${paths.remoteName}\`` : "",
    paths.sourceCommit ? `- 远程基线：\`${paths.sourceCommit}\`` : "",
    paths.readOnlyReason ? `- 只读原因：${paths.readOnlyReason}` : "",
    "- 使用 $MAF_SOURCE_DIR、$MAF_INPUT_DIR 和 $MAF_OUTPUT_DIR 定位上述目录。",
    paths.writeAllowed
      ? "- 允许修改和测试。完成修改后必须创建且只创建一个本地非 merge commit，提交信息必须包含 Gerrit Change-Id；不要自行 push，Daemon 校验后提交 Gerrit。"
      : "- 当前只允许读取和分析；不得修改源码、创建提交、切换分支或执行 push。仍需基于现有证据和源码输出完整中文分析报告。",
    "- 下载的日志、附件、解压文件和临时文件必须保存在证据目录，不得写入源码仓库。",
    "- 最终结果必须是完整 Markdown，并说明分析、修改、测试和未解决风险。",
  ].filter(Boolean).join("\n");
}

function workspaceErrorCode(error) {
  const message = String(error?.message || error || "");
  if (/not a git repository|不是 git 仓库|源码目录不存在|rev-parse --show-toplevel/i.test(message)) return "WORKSPACE_NOT_GIT";
  if (/locked by execution|workspace.+locked|repository locked/i.test(message)) return "QUEUE_FULL";
  return "DISPATCH_FAILED";
}

function waitMs(ms) { return new Promise(resolveWait => setTimeout(resolveWait, ms)); }

function executionKeys(task) {
  return [...new Set([task?.id, task?.execution_id, task?.run_context?.execution_id].map(String).filter(Boolean))];
}

function rememberCancelledExecution(key) {
  const now = Date.now();
  cancelledExecutions.set(String(key), now);
  for (const [candidate, cancelledAt] of cancelledExecutions) {
    if (cancelledExecutions.size <= CANCELLED_EXECUTION_MAX && now - cancelledAt <= CANCELLED_EXECUTION_TTL_MS) break;
    cancelledExecutions.delete(candidate);
  }
}

function isCancelledExecution(key) {
  const cancelledAt = cancelledExecutions.get(String(key));
  if (!cancelledAt) return false;
  if (Date.now() - cancelledAt <= CANCELLED_EXECUTION_TTL_MS) return true;
  cancelledExecutions.delete(String(key));
  return false;
}

function trackExecutionProcess(task, child) {
  for (const key of executionKeys(task)) executionProcesses.set(key, child);
  const clear = () => {
    for (const key of executionKeys(task)) {
      if (executionProcesses.get(key) === child) executionProcesses.delete(key);
    }
  };
  child.once("close", clear);
  child.once("error", clear);
}

function terminateExecutionProcess(child) {
  if (!child) return false;
  try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 5000).unref?.();
  return true;
}

async function cancelRunningTask(task, reason) {
  task._cancelled = true;
  for (const key of executionKeys(task)) rememberCancelledExecution(key);
  const child = executionKeys(task).map(key => executionProcesses.get(key)).find(Boolean);
  let terminationConfirmed = !child;
  if (child) {
    const closed = new Promise(resolveClose => child.once("close", () => resolveClose(true)));
    terminateExecutionProcess(child);
    terminationConfirmed = await Promise.race([closed, waitMs(7000).then(() => false)]);
  }
  const paths = task.run_paths;
  if (paths?.direct) {
    try {
      const dirty = repositoryDirtyLines(await gitOutputAsync(paths.sourceDir, ["status", "--porcelain", "--untracked-files=all"]));
      if (!dirty.length && paths.writeAllowed) await restoreDirectRepository(paths);
    } catch (err) {
      log(`⚠ 取消任务后恢复注册仓库失败，保留现场: ${err.message}`);
      terminationConfirmed = false;
    } finally {
      releaseWorkspaceLock(paths, task.run_context);
    }
  }
  log(`⛔ Execution 已取消: task=${task.id} reason=${reason}`);
  return terminationConfirmed;
}

async function prepareTaskWorkspace(task) {
  if (!task?.run_context || task._workspacePrepared) return task;
  const deadline = Date.now() + WORKSPACE_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      task.run_paths = await prepareExecutionWorkspace(task.run_context, task._base_project_path, task.target_agent);
      task.project_path = task.run_paths?.sourceDir || task._base_project_path;
      task.description = withExecutionRuntimeContext(task._raw_description || task.description, task.project_path, task.run_paths);
      task._workspacePrepared = true;
      return task;
    } catch (err) {
      if (!/locked by execution/.test(String(err?.message || err)) || Date.now() >= deadline) throw err;
      await waitMs(1000);
    }
  }
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

function getAgentStatuses(agentEntries = agents) {
  const now = Date.now();
  const statuses = {};
  for (const [name, info] of agentEntries) {
    const q = taskQueues.get(name);

    // Codex 会话退出后保留为 standby，正式任务到达时由 Daemon 按需启动。
    // 显式 attached 模式仍要求当前 TUI 接收器在线。
    if (info.runtime === "codex") {
      if (q?.executingTaskId || q?.pending.length > 0) {
        statuses[name] = "busy";
      } else {
        const directory = expandHomePath(info.directory);
        if (!info.directory || !existsSync(directory)) statuses[name] = "offline";
        else if (hasCodexAttachedReceiver(name)) statuses[name] = "online";
        else statuses[name] = CODEX_DELIVERY !== "attached" ? "standby" : "offline";
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
        // Plugin 进程已死，但任务没有完成 → 标记 offline（靠 Server 超时处理）。
        // 状态采样不能清掉 active task；否则同名实例切换或后台执行的正确回报会被严格关联校验拒绝。
        log(`⚠ ${name} 正在执行任务但 Plugin(pid=${info.pluginPid}) 已死`);
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

function taskQueueHasActiveWork(q) {
  return Boolean(q && (q.executingTaskId || q.lastExecuted || q.pending.length > 0));
}

function closeWaitingResponse(q, payload = { task: null }) {
  if (!q?.waitingResponse) return false;
  try {
    q.waitingResponse.writeHead(200, { "Content-Type": "application/json" });
    q.waitingResponse.end(JSON.stringify(payload));
  } catch {}
  q.waitingResponse = null;
  return true;
}

function closeServeScreen(agentName, reason = "") {
  const info = serveProcesses.get(agentName);
  if (!info) return false;
  log(`🗑 关闭旧 agent screen: ${agentName} (${info.screenName})${reason ? ` — ${reason}` : ""}`);
  try { execSync(`screen -S ${info.screenName} -X quit 2>/dev/null`, { stdio: "ignore" }); } catch {}
  serveProcesses.delete(agentName);
  return true;
}

function closeCodexTaskScreensForAgent(agentName, reason = "") {
  let closed = 0;
  for (const [taskId, info] of codexTaskScreens) {
    if (info.agentName !== agentName) continue;
    log(`🗑 关闭旧 Codex task screen: ${agentName} task=${taskId} (${info.screenName})${reason ? ` — ${reason}` : ""}`);
    try { execSync(`screen -S ${info.screenName} -X quit 2>/dev/null`, { stdio: "ignore" }); } catch {}
    codexTaskScreens.delete(taskId);
    closed++;
  }
  return closed;
}

function retireIdleSameAgentInstance(agentName, existing, incomingPid) {
  if (!existing || !incomingPid) return;
  const existingPid = existing.pluginPid || 0;
  if (existingPid === incomingPid) return;

  const q = taskQueues.get(agentName);
  if (closeWaitingResponse(q)) {
    log(`🔌 同名 agent 新实例接管，已唤醒旧 long-poll: ${agentName}`);
  }

  if (taskQueueHasActiveWork(q)) {
    log(`ℹ️ 同名 agent 新实例接管但已有任务上下文，保留队列/后台执行: ${agentName} oldPid=${existingPid || "?"} newPid=${incomingPid}`);
    return;
  }

  closeServeScreen(agentName, "same-agent reconnect");
  closeCodexTaskScreensForAgent(agentName, "same-agent reconnect");
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
let enrollmentPromise = null;
let lastEnrollmentAttempt = 0;

async function ensureEnrollment(force = false) {
  if (!META_AGENT_SERVER || !daemonUrl || !shouldContactServer()) return false;
  if (!force && enrollmentStatus === "active" && readText(SERVER_PUBLIC_KEY_FILE)) return true;
  if (!force && Date.now() - lastEnrollmentAttempt < 5_000) return false;
  if (enrollmentPromise) return enrollmentPromise;

  lastEnrollmentAttempt = Date.now();
  enrollmentPromise = (async () => {
    const url = `${META_AGENT_SERVER.replace(/\/+$/, "")}/api/auth/enroll`;
    const body = JSON.stringify({
      client_id: MACHINE_IDENTITY.clientId,
      public_key: MACHINE_IDENTITY.publicKey,
      client_endpoint: daemonUrl,
      hostname: hostname(),
      user_id: userId,
      host_user: hostUser,
    });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: clientAuthHeaders("POST", url, body, { "Content-Type": "application/json" }),
        body,
        signal: AbortSignal.timeout(5_000),
      });
      const data = await res.json().catch(() => ({}));
      if ((res.ok || res.status === 202) && data.server_public_key) {
        writeSecret(SERVER_PUBLIC_KEY_FILE, String(data.server_public_key), 0o644);
      }
      enrollmentStatus = String(data.status || (res.ok ? "active" : "unknown"));
      if (enrollmentStatus === "active") {
        log(`🔐 Client 机器身份已准入: ${MACHINE_IDENTITY.clientId}`);
        return true;
      }
      if (enrollmentStatus === "pending") {
        log(`⏳ Client 机器身份等待 Server 批准: ${MACHINE_IDENTITY.clientId}`);
        return false;
      }
      log(`⚠ Client 自动注册失败: HTTP ${res.status} ${data.error || ""}`.trim());
      return false;
    } catch (err) {
      enrollmentStatus = "unknown";
      log(`⚠ Client 自动注册暂不可用: ${err.message}`);
      return false;
    } finally {
      enrollmentPromise = null;
    }
  })();
  return enrollmentPromise;
}

async function registerToServer() {
  // 先清理已死的 agent（Plugin 死了 + lastSeen 超时 + 无 screen）
  pruneDeadAgents();

  const published = publishedAgentEntries();
  if (published.length === 0) return;
  if (!await ensureEnrollment()) return;
  const agentDefs = [];
  for (const [name, info] of published) {
    agentDefs.push(findAgentDef(name, info.runtime, info.directory));
  }

  try {
    const url = `${META_AGENT_SERVER}/api/clients/register`;
    const body = JSON.stringify({
      client_id: MACHINE_IDENTITY.clientId,
      user_id: userId,
      host_user: hostUser,
      client_endpoint: daemonUrl,
      agents: agentDefs,
      agent_statuses: getAgentStatuses(published),
      client_version: CLIENT_VERSION,
      plugin_hash: CLIENT_BUNDLE_HASH,
      daemon_port: parseInt(daemonUrl.split(":").pop()),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: clientAuthHeaders("POST", url, body, { "Content-Type": "application/json" }),
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const names = published.map(([name]) => name);
      log(`✅ 注册成功: [${names.join(", ")}] (${agentDefs[0]?.skills?.length || 0} skills, ${agentDefs[0]?.mcps?.length || 0} mcps)`);
      for (const [, info] of published) info.registered = true;
      lastInventoryFP = inventoryFP(agentDefs[0]?.skills || [], agentDefs[0]?.mcps || []);
    } else {
      log(`❌ 注册失败: HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) {
        enrollmentStatus = "unknown";
        await ensureEnrollment(true);
      }
    }
  } catch (err) {
    log(`⚠ Server 不可达: ${err.message}`);
  }
}

async function heartbeat() {
  const published = publishedAgentEntries();
  if (published.length === 0) return;

  // 只有首次连接、拓扑变化或 Server 明确表示缺少 Agent 时才完整注册。
  // 常态只走 heartbeat，避免把周期性保活误显示为 client_registered。
  const anyUnregistered = published.some(([, info]) => !info.registered);
  if (anyUnregistered) {
    await registerToServer();
    return;
  }

  try {
    const body = {
      user_id: userId,
      host_user: hostUser,
      agent_statuses: getAgentStatuses(published),
      client_version: CLIENT_VERSION,
      plugin_hash: CLIENT_BUNDLE_HASH,
      daemon_port: parseInt(daemonUrl.split(":").pop()),
    };

    // inventory 变化检测
    const skills = scanSkills();
    const mcps = scanMcps();
    const fp = inventoryFP(skills, mcps);
    if (fp !== lastInventoryFP) {
      log(`📦 inventory 变化 (${skills.length} skills, ${mcps.length} mcps)`);
      const inv = {};
      for (const [name] of published) inv[name] = { skills, mcps };
      body.agent_inventory = inv;
      lastInventoryFP = fp;
    }

    body.client_id = MACHINE_IDENTITY.clientId;
    const url = `${META_AGENT_SERVER}/api/clients/heartbeat`;
    const payload = JSON.stringify(body);
    const res = await fetch(url, {
      method: "POST",
      headers: clientAuthHeaders("POST", url, payload, { "Content-Type": "application/json" }),
      body: payload,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      for (const [, info] of published) info.registered = false;
      return;
    }
    const result = await res.json().catch(() => ({}));
    const missingAgents = Array.isArray(result?.missing_agents) ? result.missing_agents : [];
    if (missingAgents.length > 0) {
      for (const [name, info] of published) {
        if (missingAgents.includes(name)) info.registered = false;
      }
      await registerToServer();
    }
  } catch {
    for (const [, info] of published) info.registered = false;
  }
}

async function reportAgentStatusToServer(agentName, status) {
  if (!META_AGENT_SERVER || !agentName || !userId || !isPublishedAgent(agentName)) return false;
  try {
    const url = `${META_AGENT_SERVER}/api/clients/heartbeat`;
    const body = JSON.stringify({
      client_id: MACHINE_IDENTITY.clientId,
      user_id: userId,
      host_user: hostUser,
      agent_statuses: { [agentName]: status },
      client_version: CLIENT_VERSION,
      plugin_hash: CLIENT_BUNDLE_HASH,
      daemon_port: parseInt(daemonUrl.split(":").pop()),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: clientAuthHeaders("POST", url, body, { "Content-Type": "application/json" }),
      body,
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
        void reportTaskStarted(nextTask);
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
      void reportTaskStarted(nextTask);
      try {
        waiter.writeHead(200, { "Content-Type": "application/json" });
        waiter.end(JSON.stringify({ task: nextTask }));
      } catch {}
    }
  }
  return true;
}

async function reportTaskStarted(task) {
  if (!task?.workflow_id || !task?.node_id || task._mafStartedReported || !isPublishedAgent(task.target_agent)) return true;
  try {
    const url = `${META_AGENT_SERVER}/api/workflows/${task.workflow_id}/nodes/${task.node_id}/started`;
    const body = JSON.stringify({ execution_id: task.execution_id || task.id, agent_name: task.target_agent || "" });
    const res = await fetch(url, {
      method: "POST",
      headers: clientAuthHeaders("POST", url, body, { "Content-Type": "application/json" }),
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    task._mafStartedReported = true;
    if (task.workflow_id && workflowTracker.has(task.workflow_id)) workflowTracker.get(task.workflow_id).status = "running";
    return true;
  } catch (err) {
    log(`⚠ workflow started 回报失败: ${err.message}`);
    return false;
  }
}

function gerritUrlFromPush(output) {
  const matches = String(output || "").match(/https?:\/\/[^\s)]+/g) || [];
  return matches.find(value => /\/\+\/\d+/.test(value)) || matches[0] || "";
}

async function finalizeDirectRepository(task, status) {
  const paths = task?.run_paths;
  if (!task?.run_context || !paths?.direct) return { status, suffix: "" };
  try {
    const rawStatus = await gitOutputAsync(paths.sourceDir, ["status", "--porcelain", "--untracked-files=all"]);
    const dirty = repositoryDirtyLines(rawStatus);
    if (!paths.writeAllowed) {
      const current = dirty.join("\n");
      if (current !== String(paths.initialStatus || "")) {
        return { status: "failed", suffix: "\n\n## 源码处理\n\n只读执行期间仓库状态发生变化，已停止交付并保留现场。" };
      }
      return { status, suffix: `\n\n## 源码处理\n\n本次为只读分析：${paths.readOnlyReason || "仓库不满足安全修改条件"}` };
    }
    if (paths.agentDefinition && paths.agentDefinitionHash) {
      const currentHash = createHash("sha256").update(readFileSync(paths.agentDefinition, "utf-8")).digest("hex");
      if (currentHash !== paths.agentDefinitionHash) {
        return { status: "failed", suffix: "\n\n## Gerrit 交付\n\nAgent 配置在执行期间发生变化，未提交 Gerrit，已保留现场。" };
      }
    }
    if (status !== "completed") {
      if (!dirty.length && await gitOutputAsync(paths.sourceDir, ["rev-parse", "HEAD"]) === paths.sourceCommit) {
        await restoreDirectRepository(paths);
      }
      return { status, suffix: dirty.length ? "\n\n## Gerrit 交付\n\nAgent 执行失败且仓库存在修改，未提交 Gerrit，已保留现场。" : "" };
    }
    if (dirty.length) {
      return { status: "failed", suffix: `\n\n## Gerrit 交付\n\n仓库仍有未提交修改，未提交 Gerrit，已保留现场：\n\n${dirty.map(line => `- \`${line}\``).join("\n")}` };
    }
    const head = await gitOutputAsync(paths.sourceDir, ["rev-parse", "HEAD"]);
    const count = Number(await gitOutputAsync(paths.sourceDir, ["rev-list", "--count", `${paths.remoteRef}..HEAD`]));
    if (count === 0 && head === paths.sourceCommit) {
      await restoreDirectRepository(paths);
      return { status, suffix: "\n\n## Gerrit 交付\n\n本次未产生源码修改，无需提交 Gerrit。" };
    }
    if (count !== 1) {
      return { status: "failed", suffix: `\n\n## Gerrit 交付\n\n提交门禁拒绝交付：当前相对目标分支领先 ${count} 个提交，必须恰好为 1。已保留现场。` };
    }
    await gitOutputAsync(paths.sourceDir, ["merge-base", "--is-ancestor", paths.remoteRef, "HEAD"]);
    const parents = (await gitOutputAsync(paths.sourceDir, ["show", "-s", "--format=%P", "HEAD"])).split(/\s+/).filter(Boolean);
    if (parents.length !== 1) return { status: "failed", suffix: "\n\n## Gerrit 交付\n\n提交门禁拒绝 merge commit，已保留现场。" };
    const message = await gitOutputAsync(paths.sourceDir, ["log", "-1", "--format=%B"]);
    if (!/^Change-Id:\s+I[0-9a-f]+\s*$/im.test(message)) {
      return { status: "failed", suffix: "\n\n## Gerrit 交付\n\n提交信息缺少有效 Change-Id，未提交 Gerrit，已保留现场。" };
    }
    await execFileAsync("git", ["-C", paths.sourceDir, "fetch", "--prune", paths.remoteName, paths.sourceBranch], {
      encoding: "utf-8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    const latest = await gitOutputAsync(paths.sourceDir, ["rev-parse", `${paths.remoteRef}^{commit}`]);
    if (latest !== paths.sourceCommit) {
      return { status: "failed", suffix: "\n\n## Gerrit 交付\n\n执行期间远程目标分支已前进，未自动 rebase 或提交，已保留现场。" };
    }
    const pushed = await execFileAsync("git", ["-C", paths.sourceDir, "push", paths.remoteName, `HEAD:refs/for/${paths.sourceBranch}`], {
      encoding: "utf-8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    const pushOutput = `${pushed.stdout || ""}\n${pushed.stderr || ""}`;
    const gerritUrl = gerritUrlFromPush(pushOutput);
    await restoreDirectRepository(paths);
    return { status, suffix: `\n\n## Gerrit 交付\n\n- 提交：\`${head}\`\n- 目标：\`${paths.remoteName}/${paths.sourceBranch}\`${gerritUrl ? `\n- Gerrit：${gerritUrl}` : "\n- Gerrit Push 已成功，远端未返回可解析链接。"}` };
  } catch (err) {
    return { status: "failed", suffix: `\n\n## Gerrit 交付\n\n提交或恢复失败，未继续自动处理并保留现场：${err.message}` };
  } finally {
    releaseWorkspaceLock(paths, task.run_context);
  }
}

async function reportTaskResult(task, status, result, durationMs) {
  if (task?._cancelled || executionKeys(task).some(isCancelledExecution)) {
    log(`ℹ️ 忽略已取消任务的迟到结果: task=${task?.id || "unknown"}`);
    return { ok: true, workflow_reported: false, cancelled: true };
  }
  if (!isPublishedAgent(task?.target_agent)) {
    return { ok: false, workflow_reported: false, error: "agent is local-only" };
  }

  if (task?._mafResultReported) {
    log(`ℹ️ 忽略任务重复终态回报: task=${task.id} status=${status}`);
    return { ok: true, workflow_reported: true, duplicate: true };
  }

  if (task?._mafResultReporting) {
    const previous = await task._mafResultReporting;
    if (previous?.ok) {
      log(`ℹ️ 忽略任务并发重复终态回报: task=${task.id} status=${status}`);
      return { ok: true, workflow_reported: true, duplicate: true };
    }
  }

  const operation = performTaskResultReport(task, status, result, durationMs);
  task._mafResultReporting = operation;
  try {
    const outcome = await operation;
    if (outcome?.ok) task._mafResultReported = true;
    return outcome;
  } finally {
    if (task._mafResultReporting === operation) task._mafResultReporting = null;
  }
}

async function performTaskResultReport(task, status, result, durationMs) {

  // 更新 workflow 跟踪表
  // Strip ANSI escape codes from result（远端 agent 输出可能带终端颜色码）
  let cleanResult = (result || "").replace(/\x1b\[[0-9;]*m/g, "");
  let repositoryFinalized = true;

  if (task.run_context && task.run_paths) {
    try {
      mkdirSync(task.run_paths.outputDir, { recursive: true, mode: 0o700 });
      const finalized = await finalizeDirectRepository(task, status);
      status = finalized.status;
      cleanResult = `${cleanResult}${finalized.suffix || ""}`.trim();
      writeFileSync(join(task.run_paths.outputDir, "result.md"), `${cleanResult}\n`, { mode: 0o600 });
    } catch (err) {
      repositoryFinalized = false;
      status = "failed";
      cleanResult = `${cleanResult}\n\n[DISPATCH_FAILED] 注册仓库收尾失败: ${err.message}`.trim();
    }
  }

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
      const body = JSON.stringify({
        execution_id: task.execution_id || task.id,
        agent_name: task.target_agent || "",
        status,
        result: cleanResult.substring(0, RESULT_MAX_CHARS),
        duration_ms: durationMs,
        session_id: task.session_id || "",
      });
      const res = await fetch(url, {
        method: "POST",
        headers: clientAuthHeaders("POST", url, body, { "Content-Type": "application/json" }),
        body,
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
    const url = `${META_AGENT_SERVER}/api/tasks/${task.id}/result`;
    const body = JSON.stringify({ status, result: cleanResult.substring(0, RESULT_MAX_CHARS), duration_ms: durationMs });
    const res = await fetch(url, {
      method: "POST",
      headers: clientAuthHeaders("POST", url, body, { "Content-Type": "application/json" }),
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, workflow_reported: false, error: `HTTP ${res.status}` };
    if (!repositoryFinalized) log(`⚠ 注册仓库收尾未完成: task=${task.id}`);
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
    reportScript
      ? `- 不要直接调用 MAF Server workflow API；完成或失败后必须按下方 MAF 回报要求执行本机回报脚本。`
      : `- 本任务由 Daemon 以 Headless 模式托管，最终回答会自动回传；不要调用 /tasks/done 或任何 MAF API，也不要创建额外回报脚本。`,
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

function buildCodexArgs(cwd, outputFile, runPaths = null) {
  const args = [];
  const sandboxMode = runPaths?.writeAllowed === false ? "read-only" : CODEX_SANDBOX;
  if (process.env.MAF_CODEX_MODEL) args.push("-m", process.env.MAF_CODEX_MODEL);
  if (CODEX_BYPASS_SANDBOX) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", sandboxMode, "-a", CODEX_APPROVAL);
  }
  if (process.env.MAF_CODEX_PROFILE) args.push("--profile", process.env.MAF_CODEX_PROFILE);
  args.push("exec");
  args.push("-C", cwd);
  for (const dir of [runPaths?.gitMetaDir, runPaths?.inputDir, runPaths?.outputDir].filter(Boolean)) args.push("--add-dir", dir);
  args.push("--skip-git-repo-check", "--color", "never", "-o", outputFile, "-");
  return args;
}

function buildCodexTuiArgs(cwd, promptFile) {
  const args = [];
  if (process.env.MAF_CODEX_MODEL) args.push("-m", process.env.MAF_CODEX_MODEL);
  if (CODEX_BYPASS_SANDBOX) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", CODEX_SANDBOX, "-a", CODEX_APPROVAL);
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
    headers: ${JSON.stringify({ "Content-Type": "application/json", Authorization: `Bearer ${LOCAL_AUTH_TOKEN}` })},
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
  await reportTaskStarted(task);
  const cwd = (projectPath || agents.get(agentName)?.directory || DIRECTORY).replace(/^~/, homedir());
  const outFile = join(STATE_DIR, `codex-${safeFilePart(agentName)}-${safeFilePart(task.id)}-${Date.now()}.txt`);

  if (!existsSync(cwd)) {
    const msg = `Codex 工作目录不存在: ${cwd}`;
    log(`❌ ${msg}`);
    await reportTaskResult(task, "failed", msg, Date.now() - started);
    return;
  }

  const prompt = buildCodexPrompt(agentName, task, cwd);
  const args = buildCodexArgs(cwd, outFile, task.run_paths);
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
      detached: true,
      env: {
        ...process.env,
        MAF_SOURCE_DIR: cwd,
        MAF_INPUT_DIR: task.run_paths?.inputDir || "",
        MAF_OUTPUT_DIR: task.run_paths?.outputDir || "",
      },
    });
    trackExecutionProcess(task, child);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateExecutionProcess(child);
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

async function executeManagedExecutionTask(agentName, task, runtime, projectPath) {
  if (runtime === "codex") {
    await executeCodexExecTask(agentName, task, projectPath);
    return;
  }
  const started = Date.now();
  await reportTaskStarted(task);
  const cwd = resolve(projectPath || DIRECTORY);
  const prompt = String(task.description || task.title || "");
  let executable;
  let args;
  if (runtime === "claude-code") {
    executable = process.env.CLAUDE_BIN || "claude";
    args = ["--print", "--output-format", "text", "--permission-mode", "dontAsk", "--no-session-persistence", "--setting-sources", "user"];
    const extraDirs = [task.run_paths?.gitMetaDir, task.run_paths?.inputDir, task.run_paths?.outputDir].filter(Boolean);
    if (extraDirs.length) args.push("--add-dir", ...extraDirs);
    if (agentName) args.push("--agent", agentName);
    args.push(prompt);
  } else {
    executable = process.env.OPENCODE_BIN || "opencode";
    args = ["run"];
    if (agentName) args.push("--agent", agentName);
    args.push(prompt);
  }
  const result = await new Promise(resolveResult => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    const finish = (status, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveResult({ status, result: status === "completed" ? (stdout.trim() || stderr.trim() || "Execution completed with no output") : message });
    };
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        MAF_SOURCE_DIR: cwd,
        MAF_INPUT_DIR: task.run_paths?.inputDir || "",
        MAF_OUTPUT_DIR: task.run_paths?.outputDir || "",
      },
    });
    trackExecutionProcess(task, child);
    const timer = setTimeout(() => {
      timedOut = true;
      terminateExecutionProcess(child);
    }, EXECUTION_TASK_TIMEOUT_MS);
    child.stdout.on("data", data => { stdout += data.toString(); });
    child.stderr.on("data", data => { stderr += data.toString(); });
    child.on("error", err => finish("failed", `${runtime} 启动失败: ${err.message}`));
    child.on("close", (code, signal) => {
      if (timedOut) finish("failed", `${runtime} 执行超时 (${EXECUTION_TASK_TIMEOUT_MS}ms)`);
      else if (code === 0) finish("completed", "");
      else finish("failed", `${runtime} 执行失败: exit=${code ?? ""}${signal ? ` signal=${signal}` : ""}\n${stderr.trim() || stdout.trim()}`);
    });
  });
  await reportTaskResult(task, result.status, result.result, Date.now() - started);
}

function enqueueManagedExecutionTask(agentName, task) {
  const q = getAgentQueue(agentName);
  if (q.pending.length >= MAX_QUEUE_SIZE) return false;
  q.pending.push(task);
  return true;
}

async function runManagedExecutionQueue(agentName, runtime) {
  const q = getAgentQueue(agentName);
  try {
    while (q.pending.some(task => task?.run_context)) {
      if (q.executingTaskId) { await waitMs(1000); continue; }
      const index = q.pending.findIndex(task => task?.run_context);
      if (index < 0) break;
      const [task] = q.pending.splice(index, 1);
      q.lastExecuted = task;
      q.executingTaskId = task.id;
      try {
        await prepareTaskWorkspace(task);
        await executeManagedExecutionTask(agentName, task, runtime, task.project_path || task._base_project_path || DIRECTORY);
      } catch (err) {
        await reportTaskResult(task, "failed", `[${workspaceErrorCode(err)}] 准备或执行 managed Execution 失败: ${err.message}`, 0);
      } finally {
        q.executingTaskId = null;
        q.lastExecuted = null;
      }
    }
  } finally {
    managedExecutionQueueRunners.delete(agentName);
    if (q.pending.some(task => task?.run_context)) scheduleManagedExecutionQueue(agentName, runtime);
  }
}

function scheduleManagedExecutionQueue(agentName, runtime) {
  if (managedExecutionQueueRunners.has(agentName)) return;
  managedExecutionQueueRunners.add(agentName);
  setImmediate(() => runManagedExecutionQueue(agentName, runtime).catch(err => {
    managedExecutionQueueRunners.delete(agentName);
    log(`❌ managed Execution queue 失败: ${agentName} ${err.message}`);
  }));
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
        await reportTaskStarted(task);
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
  const published = publishedAgentEntries();
  if (published.length === 0) return;
  for (const [name] of published) {
    const q = getAgentQueue(name);
    if (q.pending.length > 0) continue;
    try {
      const url = `${META_AGENT_SERVER}/api/tasks/poll?agent_name=${encodeURIComponent(name)}&user_id=${encodeURIComponent(userId)}`;
      const res = await fetch(url, { headers: clientAuthHeaders("GET", url), signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const responseBody = await res.text();
      if (!serverMessageAuthorized(res.headers, "GET", url, responseBody)) {
        log(`⛔ 拒绝未签名的 Server 轮询响应: ${name}`);
        continue;
      }
      const data = JSON.parse(responseBody);
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
function pathInside(target, base) {
  const absoluteTarget = resolve(target);
  const absoluteBase = resolve(base);
  return absoluteTarget === absoluteBase || absoluteTarget.startsWith(`${absoluteBase}${sep}`);
}

function otaPathAllowed(target) {
  const home = homedir();
  const allowed = [
    join(home, ".config", "opencode"),
    join(home, ".opencode"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".agents"),
    join(home, ".meta-agent-framework"),
    join(home, "plugins", "maf"),
    DAEMON_DIR,
  ];
  return allowed.some(base => pathInside(target, base));
}

function resolveOtaTarget(path) {
  if (String(path || "").startsWith("plugin/")) {
    const relName = String(path).slice(7);
    return resolve(relName === "daemon.mjs" ? DAEMON_FILE : join(PLUGIN_DIR, relName));
  }
  return expandHomePath(path);
}

function safeOtaRelativePath(path) {
  const value = String(path || "");
  if (!value || value.startsWith("/") || value.split(/[\\/]+/).includes("..")) return "";
  return value;
}

function claudeActivePluginDirs() {
  const cacheRoot = join(homedir(), ".claude", "plugins", "cache");
  try {
    const installed = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf-8"));
    const entries = installed?.plugins?.["maf@maf-plugins"];
    if (!Array.isArray(entries)) return [];
    return entries
      .map(entry => resolve(String(entry?.installPath || "")))
      .filter(path => pathInside(path, cacheRoot));
  } catch {
    return [];
  }
}

function otaTargets(file) {
  const targets = [resolveOtaTarget(file.path)];
  const relativePath = safeOtaRelativePath(file.relative_path);
  if (file.runtime === "claude-code" && relativePath) {
    for (const installDir of claudeActivePluginDirs()) targets.push(resolve(installDir, relativePath));
  }
  if (file.runtime === "codex" && relativePath) {
    targets.push(resolve(homedir(), ".codex", "plugins", "cache", "personal", "maf", "local", relativePath));
  }
  return [...new Set(targets)];
}

function writeOtaTarget(target, file) {
  if (!otaPathAllowed(target)) throw new Error(`白名单外: ${target}`);
  if (file.hash && fileHash(target) === file.hash) return false;

  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.maf-ota-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, file.content, "utf-8");
    if (file.hash && fileHash(temp) !== file.hash) throw new Error(`hash 不匹配: ${file.path}`);
    renameSync(temp, target);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
  return true;
}

function performOTA(payload) {
  const { files = [] } = payload;
  let applied = 0, failed = 0;
  const errors = [];
  let daemonUpdated = false;

  for (const f of files) {
    if (String(f.path || "").endsWith("/ota-manifest.json") && failed > 0) {
      errors.push("前序文件失败，未更新 ota-manifest.json");
      failed++;
      continue;
    }
    try {
      let changed = false;
      const targets = otaTargets(f);
      for (const target of targets) {
        const targetChanged = writeOtaTarget(target, f);
        changed = changed || targetChanged;
        log(`✅ OTA: ${f.path} → ${target}${targetChanged ? "" : " (unchanged)"}`);
      }
      applied++;
      if (changed && (f.runtime === "daemon" && f.relative_path === "daemon.mjs"
          || f.path === "plugin/daemon.mjs"
          || targets.includes(DAEMON_FILE))) daemonUpdated = true;
    } catch (err) { errors.push(`${f.path}: ${err.message}`); failed++; }
  }
  if (failed === 0) CLIENT_BUNDLE_HASH = currentClientBundleHash();
  return {
    applied,
    failed,
    restarted: daemonUpdated ? 1 : 0,
    daemon_updated: daemonUpdated,
    bundle_hash: CLIENT_BUNDLE_HASH,
    errors,
  };
}

function restartDaemonAfterOTA() {
  let restarted = false;
  const launch = () => {
    if (restarted) return;
    restarted = true;
    try {
      const child = spawn(process.execPath, [DAEMON_FILE], {
        env: { ...process.env },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (err) {
      log(`❌ OTA Daemon 重新拉起失败: ${err.message}`);
    }
    process.exit(0);
  };

  setTimeout(() => {
    const force = setTimeout(launch, 5_000);
    force.unref?.();
    httpServer.close(() => {
      clearTimeout(force);
      launch();
    });
    httpServer.closeAllConnections?.();
  }, 1_000).unref?.();
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
  let rawBodyPromise = null;
  const readRawBody = () => {
    if (!rawBodyPromise) {
      rawBodyPromise = new Promise(resolve => {
        const chunks = [];
        req.on("data", chunk => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
    }
    return rawBodyPromise;
  };
  const readBody = async () => {
    const raw = await readRawBody();
    try { return JSON.parse(raw.toString("utf-8")); } catch { return {}; }
  };
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const urlObj = new URL(req.url, "http://localhost");
  const pathname = urlObj.pathname;

  // GET /health
  if (req.method === "GET" && pathname === "/health") {
    const localRequest = isLoopbackRequest(req);
    const health = {
      ok: true,
      pid: process.pid,
      agents: agentNamesForRequest(req),
      daemon_hash: DAEMON_SELF_HASH,
      uptime: process.uptime(),
      version: CLIENT_VERSION,
    };
    if (localRequest) {
      health.server = META_AGENT_SERVER;
      health.enrollment_status = enrollmentStatus;
      health.client_id = MACHINE_IDENTITY.clientId;
      health.user_id = userId;
      health.host_user = hostUser;
      health.local_only_agents = localOnlyAgentNames();
      health.agent_publication = {
        mode: AGENT_PUBLICATION.mode,
        client_network: AGENT_PUBLICATION.clientNetwork,
      };
    }
    json(200, health);
    return;
  }

  const signedBody = String(req.headers["x-maf-role"] || "") === "server"
    ? await readRawBody()
    : Buffer.alloc(0);
  const authorized = req.method === "POST" && pathname === "/execute"
    ? (serverSignatureAuthorized(req, signedBody)
      || (process.env.MAF_TEST_ALLOW_LOCAL_EXECUTE === "1" && requestAuthorized(req, signedBody)))
    : requestAuthorized(req, signedBody);
  if (!authorized) {
    json(401, { error: "Unauthorized" });
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
      json(200, { ok: true, ignored: true, kind: "server", agents: agentNamesForRequest(req) });
      return;
    }

    const existing = agents.get(name);
    const incomingPid = body.plugin_pid || 0;
    retireIdleSameAgentInstance(name, existing, incomingPid);
    const visibility = resolveAgentVisibility(name);
    const info = {
      runtime: body.runtime || existing?.runtime || "opencode",
      pluginPid: incomingPid || existing?.pluginPid || 0,
      directory: body.directory || existing?.directory || DIRECTORY,
      registered: false,
      sessionId: body.session_id || existing?.sessionId || "",
      lastSeen: Date.now(),
      visibility,
    };
    agents.set(name, info);
    if (info.runtime === "codex") persistCodexAgentInventory();

    if (visibility === "published") {
      if (body.user_id && body.user_id !== userId) {
        log(`ℹ️ 忽略 Agent 提交的 user_id=${body.user_id}，使用稳定机器身份 ${userId}`);
      }
      if (body.host_user && body.host_user !== hostUser) {
        log(`ℹ️ 忽略 Agent 提交的 host_user=${body.host_user}，使用 Daemon 宿主用户 ${hostUser}`);
      }
    }

    log(`🔗 agent 连接: ${name} (runtime=${info.runtime}, visibility=${visibility}, agents=[${[...agents.keys()].join(", ")}])`);

    // local-only 连接不得引发任何 Server 通信。
    if (visibility === "published") await registerToServer();
    json(200, { ok: true, local_only: visibility === "local-only", agents: agentNamesForRequest(req) });
    return;
  }

  // POST /agents/disconnect — Codex 保留为可按需启动，其他 runtime 注销
  if (req.method === "POST" && pathname === "/agents/disconnect") {
    const body = await readBody();
    const name = body.agent_name;
    if (isServerAgentName(name)) {
      log(`ℹ️ 忽略 Server 控制面断开，不按 Agent 注销: ${name}`);
      json(200, { ok: true, ignored: true, kind: "server", agents: agentNamesForRequest(req) });
      return;
    }
    if (name && agents.has(name)) {
      // 防竞态：如果 disconnect 的 PID 和当前 agent 的 pluginPid 不同，说明是旧 Plugin 发的
      const info = agents.get(name);
      const reqPid = body.plugin_pid || 0;
      if (reqPid > 0 && info.pluginPid > 0 && reqPid !== info.pluginPid) {
        log(`⚠ disconnect ${name} 被忽略（pid ${reqPid} ≠ 当前 ${info.pluginPid}）`);
        json(200, { ok: true, ignored: true, agents: agentNamesForRequest(req) });
        return;
      }
      const q = taskQueues.get(name);
      if (taskQueueHasActiveWork(q)) {
        // 前台同名实例退出时，后台 screen/exec 可能仍在执行并依赖 lastExecuted/workflow 元数据回报。
        // 这时不能删除 taskQueue，否则 /tasks/done 会丢失 workflow_id/node_id 上下文。
        closeWaitingResponse(q);
        agents.set(name, {
          ...info,
          pluginPid: 0,
          lastSeen: Date.now(),
        });
        log(`🔌 agent 接收端断开但任务仍在，保留队列上下文: ${name} (executing=${q?.executingTaskId || "none"}, pending=${q?.pending.length || 0})`);
        if (info.runtime === "codex" && q?.pending.length > 0) scheduleCodexQueue(name);
        json(200, { ok: true, deferred: true, active_task: q?.executingTaskId || "", pending: q?.pending.length || 0, agents: agentNamesForRequest(req) });
        return;
      }
      if (info.runtime === "codex") {
        closeWaitingResponse(q);
        agents.set(name, {
          ...info,
          pluginPid: 0,
          registered: true,
          sessionId: "",
          lastSeen: Date.now(),
        });
        persistCodexAgentInventory();
        const status = getAgentStatuses()[name] || "offline";
        if (info.visibility === "published") await reportAgentStatusToServer(name, status);
        log(`🔌 Codex 会话断开，Agent 定义已保留: ${name} (status=${status})`);
        json(200, { ok: true, retained: true, status, agents: agentNamesForRequest(req) });
        return;
      }
      if (info.visibility === "published") await reportAgentStatusToServer(name, "offline");
      agents.delete(name);
      // 清理任务队列
      if (q?.waitingResponse) {
        try { q.waitingResponse.writeHead(200, { "Content-Type": "application/json" }); q.waitingResponse.end('{"task":null}'); } catch {}
      }
      taskQueues.delete(name);
      log(`🔌 agent 断开: ${name} (剩余=[${[...agents.keys()].join(", ")}])`);
    }
    json(200, { ok: true, agents: agentNamesForRequest(req) });
    return;
  }

  // GET /agents — 列出当前管理的所有 agent
  if (req.method === "GET" && pathname === "/agents") {
    const list = [];
    const entries = String(req.headers["x-maf-role"] || "") === "server" ? publishedAgentEntries() : agents;
    const statuses = getAgentStatuses(entries);
    for (const [name, info] of entries) {
      list.push({ agent_name: name, ...info, status: statuses[name] || "offline" });
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
      const visibility = resolveAgentVisibility(body.agent_name);
      const info = {
        runtime: body.runtime || "opencode",
        pluginPid: 0,
        directory: DIRECTORY,
        registered: false,
        sessionId: "",
        lastSeen: Date.now(),
        visibility,
      };
      agents.set(body.agent_name, info);
      if (visibility === "published") {
        if (body.user_id && body.user_id !== userId) {
          log(`ℹ️ 忽略兼容接口提交的 user_id=${body.user_id}，使用稳定机器身份 ${userId}`);
        }
        if (body.host_user && body.host_user !== hostUser) {
          log(`ℹ️ 忽略兼容接口提交的 host_user=${body.host_user}，使用 Daemon 宿主用户 ${hostUser}`);
        }
        await registerToServer();
      }
      log(`🔗 agent 连接(兼容): ${body.agent_name} (visibility=${visibility})`);
    }
    json(200, { ok: true, local_only: body.agent_name ? resolveAgentVisibility(body.agent_name) === "local-only" : false });
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

  // POST /cancel — Server 取消正式 Execution，并等待本地进程终止回执。
  if (req.method === "POST" && pathname === "/cancel") {
    const body = await readBody();
    const keys = new Set([body.execution_id, body.framework_execution_id].map(String).filter(Boolean));
    if (!keys.size) {
      json(400, { error: "execution_id required" });
      return;
    }
    let activeTask = null;
    let removedPending = 0;
    for (const [, queue] of taskQueues) {
      const before = queue.pending.length;
      queue.pending = queue.pending.filter(task => {
        const match = executionKeys(task).some(key => keys.has(key));
        if (match) {
          task._cancelled = true;
          for (const key of executionKeys(task)) rememberCancelledExecution(key);
        }
        return !match;
      });
      removedPending += before - queue.pending.length;
      if (queue.lastExecuted && executionKeys(queue.lastExecuted).some(key => keys.has(key))) activeTask = queue.lastExecuted;
    }
    const terminationConfirmed = activeTask
      ? await cancelRunningTask(activeTask, String(body.reason || "Execution cancelled"))
      : true;
    json(200, {
      accepted: true,
      execution_id: String(body.execution_id || body.framework_execution_id),
      status: "cancelled",
      removed_pending: removedPending,
      termination_confirmed: terminationConfirmed,
      completed_at: new Date().toISOString(),
    });
    return;
  }

  // POST /execute — Server 推送任务 → 按 agent_name 路由入队（无 Plugin 时自动拉起 serve）
  if (req.method === "POST" && pathname === "/execute") {
    const body = await readBody();
    const targetAgent = body.target_agent || body.agent_name;
    const projectPath = body.project_path || "";
    const runtime = body.runtime || "opencode";

    if (!targetAgent) {
      json(400, { error: "agent_name required" });
      return;
    }
    if (resolveAgentVisibility(targetAgent) !== "published") {
      json(404, { error: "not found" });
      return;
    }

    log(`📥 收到任务: "${body.title || body.prompt}" → ${targetAgent}${body.workflow_id ? ` (workflow=${body.workflow_id})` : ""}`);

    const baseProjectPath = projectPath || agents.get(targetAgent)?.directory || DIRECTORY;
    const rawDescription = body.description || body.prompt || "";
    const task = {
      id: body.task_id || body.execution_id || `push-${Date.now()}`,
      type: body.type || body.intent || "custom",
      title: body.title || body.prompt?.substring(0, 80) || "任务",
      description: rawDescription,
      target_agent: targetAgent,
      workflow_id: body.workflow_id || "",
      node_id: body.node_id || "",
      execution_id: body.execution_id || "",
      detached: body.detached,
      delivery_mode: body.delivery_mode || body.deliveryMode || body.execution_mode || body.executionMode || "",
      metadata: body.metadata || {},
      workspace_id: body.workspace_id || targetAgent,
      run_context: body.run_context || null,
      run_paths: null,
      _base_project_path: baseProjectPath,
      _raw_description: rawDescription,
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

    // Framework Execution 固定走 Daemon 托管的串行 headless 队列；轮到任务时
    // 再锁定注册仓库，避免与前台会话或同仓库其它 Execution 混用。
    if (task.run_context) {
      if (!enqueueManagedExecutionTask(targetAgent, task)) {
        json(409, { accepted: false, agent: targetAgent, error_code: "QUEUE_FULL", error: "queue full" });
        return;
      }
      json(202, { accepted: true, agent: targetAgent, mode: `${runtime}-managed-execution`, delivery_mode: "detached" });
      scheduleManagedExecutionQueue(targetAgent, runtime);
      return;
    }

    // Codex runtime：默认 detached，由 Daemon screen/exec 托管执行；attached/auto 需要任务或环境显式选择。
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
        visibility: "published",
      });
      if (!existing?.registered) registerToServer();

      const delivery = codexEffectiveDelivery(targetAgent, task);
      if (delivery === "attached" && !hasCodexAttachedReceiver(targetAgent)) {
        const msg = codexAttachedUnavailableMessage(targetAgent, task);
        log(`⚠ ${msg}`);
        await reportTaskResult(task, "failed", msg, 0);
        json(409, { accepted: false, agent: targetAgent, error_code: "AGENT_START_FAILED", error: msg, delivery_mode: codexDeliveryForTask(task) });
        return;
      }

      const ok = enqueueTask(targetAgent, task);
      if (ok) {
        const mode = delivery === "attached" ? "codex-attached" : (CODEX_MODE === "exec" ? "codex-exec" : "codex-tui");
        json(202, { accepted: true, agent: targetAgent, mode, delivery_mode: delivery });
        if (delivery === "detached") scheduleCodexQueue(targetAgent);
      } else {
        json(409, { error_code: "QUEUE_FULL", error: "queue full" });
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
        json(409, { error_code: "QUEUE_FULL", error: "queue full" });
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
        q.executingTaskId = task.id;
        await reportTaskStarted(task);
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
          q.executingTaskId = found.id;
          await reportTaskStarted(found);
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
          await reportTaskStarted(task);
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
        await reportTaskStarted(task);
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
    if (!agentName || !taskId) {
      json(400, { error: "agent_name and task_id required" });
      return;
    }
    const q = taskQueues.get(agentName);
    if (!q?.lastExecuted || q.lastExecuted.id !== taskId || q.executingTaskId !== taskId) {
      json(409, {
        error: "task_id does not match the active task",
        reported_task_id: taskId,
        last_task_id: q?.lastExecuted?.id || null,
        active_task_id: q?.executingTaskId || null,
      });
      return;
    }
    touchAgent(agentName);
    log(`🔧 ${agentName} 开始执行任务: ${taskId}`);
    json(200, { ok: true });
    return;
  }

  // POST /tasks/done — Plugin 回报任务执行结果
  if (req.method === "POST" && pathname === "/tasks/done") {
    const body = await readBody();
    const agentName = body.agent_name;
    const taskId = body.task_id;
    const status = body.status;
    log(`📬 Plugin 回报: task=${body.task_id} status=${body.status} (${body.duration_ms}ms)`);

    if (!agentName || !taskId || !status) {
      json(400, { error: "agent_name, task_id, and status required" });
      return;
    }
    if (status !== "completed" && status !== "failed") {
      json(422, { error: "status must be completed or failed" });
      return;
    }
    const q = taskQueues.get(agentName);
    if (!q?.lastExecuted || q.lastExecuted.id !== taskId || q.executingTaskId !== taskId) {
      json(409, {
        error: "task_id does not match the active task",
        reported_task_id: taskId,
        last_task_id: q?.lastExecuted?.id || null,
        active_task_id: q?.executingTaskId || null,
      });
      return;
    }
    const task = q.lastExecuted;
    q.executingTaskId = null;
    q.lastExecuted = null;

    const reportAck = await reportTaskResult(task, status, body.result || "", body.duration_ms || 0);

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
        await reportTaskStarted(nextTask);
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
    if (!isPublishedAgent(body.from_agent)) {
      json(404, { error: "not found" });
      return;
    }
    // 附上 user_id
    body.user_id = body.user_id || userId;
    try {
      const url = `${META_AGENT_SERVER}/api/proposals`;
      const payload = JSON.stringify(body);
      const srvRes = await fetch(url, {
        method: "POST",
        headers: clientAuthHeaders("POST", url, payload, { "Content-Type": "application/json" }),
        body: payload,
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
      const url = `${META_AGENT_SERVER}/api/proposals${qs}`;
      const srvRes = await fetch(url, {
        headers: clientAuthHeaders("GET", url),
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
    for (const [, info] of publishedAgentEntries()) info.registered = false;
    registerToServer();
    json(200, { ok: true, agents: publishedAgentNames() });
    return;
  }

  // GET /status
  if (req.method === "GET" && pathname === "/status") {
    json(200, {
      agents: String(req.headers["x-maf-role"] || "") === "server" ? publishedAgentNames() : [...agents.keys()],
      local_only_agents: String(req.headers["x-maf-role"] || "") === "server" ? [] : localOnlyAgentNames(),
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
      log("🔄 daemon.mjs 已更新，1 秒后重新拉起...");
      restartDaemonAfterOTA();
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
      const url = `${META_AGENT_SERVER}/api/evolve/${evolveId}/result`;
      const body = JSON.stringify(evolveResult);
      fetch(url, {
        method: "POST",
        headers: clientAuthHeaders("POST", url, body, { "Content-Type": "application/json" }),
        body,
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
    json(200, {
      ok: true,
      agents: String(req.headers["x-maf-role"] || "") === "server" ? publishedAgentNames() : [...agents.keys()],
    });
    return;
  }

  json(404, { error: "not found" });
});

// ============================================================
// 启动
// ============================================================
httpServer.listen(NODE_PORT, "0.0.0.0", async () => {
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

  // 如果有初始 agent（Claude Code --daemon 模式传入），立即注册
  const initAgent = process.env.MAF_AGENT_NAME;
  const initRuntime = process.env.MAF_RUNTIME || "opencode";
  if (initAgent && !isServerAgentName(initAgent)) {
    const visibility = resolveAgentVisibility(initAgent);
    agents.set(initAgent, {
      runtime: initRuntime,
      pluginPid: 0,
      directory: DIRECTORY,
      registered: false,
      sessionId: "",
      lastSeen: Date.now(),
      visibility,
    });
    log(`  初始 agent: ${initAgent} (runtime=${initRuntime}, visibility=${visibility})`);
    if (initRuntime === "codex") persistCodexAgentInventory();
    if (visibility === "published") registerToServer();
  } else if (initAgent) {
    log(`  忽略 Server 控制面初始身份: ${initAgent}`);
  } else if (shouldContactServer()) {
    await ensureEnrollment();
  }

  // 启动心跳 + 任务轮询 + agent 存活清理 + serve 空闲清理
  setInterval(heartbeat, HEARTBEAT_INTERVAL);
  setInterval(pollTasks, POLL_INTERVAL);
  setInterval(() => { if (enrollmentStatus !== "active" && shouldContactServer()) ensureEnrollment(); }, 10_000);
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
  appendLogLine(`${new Date().toISOString().slice(11, 23)} [node-daemon] 异常: ${err.message}\n`);
});
