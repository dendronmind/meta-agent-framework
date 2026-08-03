#!/usr/bin/env node
/**
 * MAF Codex SessionStart hook.
 *
 * Runs at Codex session startup through the Codex plugin system or the launcher
 * wrapper. It always tries to keep the machine-level MAF Node Daemon running, and
 * connects a Codex agent for non-home project roots using standard
 * .codex/agents/*.toml metadata when present, otherwise the project directory
 * name. It is
 * intentionally quiet: diagnostics go to ~/.meta-agent-framework/logs/codex-plugin.log so
 * Codex TUI startup is not polluted.
 */

import { mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync, statSync, renameSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME, MAF_HOME, inferAgent, isDir, isFile, processAlive, readMafConfig, safeName, sleep, validAgentName } from "./maf-codex-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(__dirname);
const LOG_DIR = join(MAF_HOME, "logs");
const LOG_FILE = join(LOG_DIR, "codex-plugin.log");
const LOCAL_TOKEN_FILE = join(MAF_HOME, "auth", "local-token");

function localAuthToken() {
  let token = "";
  try { token = readFileSync(LOCAL_TOKEN_FILE, "utf-8").trim(); } catch {}
  const cfg = readMafConfig(process.cwd());
  return token || process.env.MAF_LOCAL_TOKEN || "";
}

function authHeaders(headers = {}) {
  return { ...headers, Authorization: `Bearer ${localAuthToken()}` };
}

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
const DEFAULT_PORT = 4100;
const SERVER_AGENT_NAME = "Meta-Agent-Server";
const RECEIVER_TERM_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_RECEIVER_TERM_TIMEOUT_MS || "0", 10) || 3000;
const RECEIVER_KILL_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_RECEIVER_KILL_TIMEOUT_MS || "0", 10) || 2000;
const RECEIVER_LOCK_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_RECEIVER_LOCK_TIMEOUT_MS || "0", 10) || 5000;
const RECEIVER_LOCK_STALE_MS = parseInt(process.env.MAF_CODEX_RECEIVER_LOCK_STALE_MS || "0", 10) || 30_000;

function isServerAgentName(name) {
  return String(name || "").trim() === SERVER_AGENT_NAME;
}

function log(message) {
  appendLogLine(`${new Date().toISOString()} [codex-hook] ${message}\n`);
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

async function readHookInput(maxMs = 800) {
  let raw = "";
  try { process.stdin.setEncoding("utf-8"); } catch {}
  const done = new Promise((resolveDone) => {
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => resolveDone(raw));
    process.stdin.on("error", () => resolveDone(raw));
  });
  try { process.stdin.resume(); } catch {}
  return await Promise.race([
    done,
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout(raw), maxMs)),
  ]);
}

function looksLikePath(value) {
  return typeof value === "string" && value.startsWith("/") && value.length > 1;
}

function collectDirectoryCandidates(value, out = [], depth = 0, keyHint = "") {
  if (depth > 5 || value == null) return out;
  if (typeof value === "string") {
    const k = keyHint.toLowerCase();
    if (looksLikePath(value) && (k === "cwd" || k.endsWith("cwd") || k.includes("directory") || k.includes("project") || k.includes("workspace") || k === "root")) {
      out.push(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDirectoryCandidates(item, out, depth + 1, keyHint);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectDirectoryCandidates(v, out, depth + 1, k);
  }
  return out;
}

function isPluginInternalPath(path) {
  const p = resolve(path);
  return p === PLUGIN_ROOT
    || p.startsWith(`${PLUGIN_ROOT}/`)
    || p.includes("/.codex/plugins/cache/")
    || p.endsWith("/plugins/maf")
    || p.includes("/plugins/maf/");
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function findBestStartDir(hookEvent) {
  const candidates = [];
  if (hookEvent && typeof hookEvent === "object") {
    for (const key of ["cwd", "directory", "project_path", "projectPath", "workspace_root", "workspaceRoot", "root"]) {
      if (looksLikePath(hookEvent[key])) candidates.push(hookEvent[key]);
    }
    collectDirectoryCandidates(hookEvent, candidates);
  }
  candidates.push(process.env.MAF_DIRECTORY, process.env.CODEX_CWD, process.env.PWD, process.cwd());

  for (const raw of unique(candidates)) {
    const path = resolve(String(raw).replace(/^~/, HOME));
    if (isDir(path) && !isPluginInternalPath(path)) return path;
  }
  return "";
}

function receiverPidFile(agentName) {
  return join(MAF_HOME, `codex-attached-receiver-${safeName(agentName)}.pid`);
}

function receiverMetaFile(agentName) {
  return join(MAF_HOME, `codex-attached-receiver-${safeName(agentName)}.json`);
}

function receiverLockFile(agentName) {
  return join(MAF_HOME, `codex-attached-receiver-${safeName(agentName)}.lock`);
}

function readReceiverMeta(agentName) {
  try {
    const meta = safeJson(readFileSync(receiverMetaFile(agentName), "utf-8"));
    return meta && typeof meta === "object" ? meta : {};
  } catch { return {}; }
}

function writeReceiverMeta(agentName, meta) {
  try {
    mkdirSync(MAF_HOME, { recursive: true });
    writeFileSync(receiverMetaFile(agentName), JSON.stringify(meta, null, 2));
  } catch (err) {
    log(`attached receiver meta write failed: ${err.message}`);
  }
}

function removeReceiverMeta(agentName, expectedPid = 0) {
  const path = receiverMetaFile(agentName);
  try {
    if (expectedPid) {
      const meta = safeJson(readFileSync(path, "utf-8"));
      if (Number(meta?.pid || 0) !== Number(expectedPid)) return false;
    }
    unlinkSync(path);
    return true;
  } catch { return false; }
}

function readReceiverPid(agentName) {
  try { return Number(readFileSync(receiverPidFile(agentName), "utf-8").trim() || 0); } catch { return 0; }
}

function removeReceiverPidFile(agentName, expectedPid = 0) {
  const path = receiverPidFile(agentName);
  try {
    if (expectedPid && Number(readFileSync(path, "utf-8").trim() || 0) !== Number(expectedPid)) return false;
    unlinkSync(path);
    return true;
  } catch { return false; }
}

function inspectReceiverProcess(pid, { agentName, pidFile, receiverScript }) {
  const numericPid = Number(pid || 0);
  if (!processAlive(numericPid)) return { alive: false, verified: true, matches: false, env: {} };
  if (process.platform !== "linux") return { alive: true, verified: false, matches: false, env: {} };
  try {
    const args = readFileSync(`/proc/${numericPid}/cmdline`).toString("utf-8").split("\0").filter(Boolean);
    const env = {};
    for (const entry of readFileSync(`/proc/${numericPid}/environ`).toString("utf-8").split("\0")) {
      const idx = entry.indexOf("=");
      if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    const matches = args.some(arg => resolve(arg) === resolve(receiverScript))
      && String(env.MAF_AGENT_NAME || env.MAF_CODEX_AGENT || "") === String(agentName)
      && resolve(String(env.MAF_CODEX_RECEIVER_PID_FILE || "")) === resolve(pidFile);
    return { alive: true, verified: true, matches, env };
  } catch {
    return { alive: processAlive(numericPid), verified: false, matches: false, env: {} };
  }
}

function sameReceiverTarget(info, { projectPath, appServerUrl, appServerCmd, sessionPid }) {
  const env = info?.env || {};
  if (!sessionPid || String(env.MAF_CODEX_SESSION_PID || "") !== String(sessionPid)) return false;
  if (resolve(String(env.MAF_DIRECTORY || env.CODEX_CWD || "")) !== resolve(projectPath)) return false;
  if (appServerUrl && String(env.MAF_CODEX_APP_SERVER_URL || "") !== String(appServerUrl)) return false;
  if (appServerCmd && String(env.MAF_CODEX_APP_SERVER_CMD || "") !== String(appServerCmd)) return false;
  return true;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await sleep(50);
  return !processAlive(pid);
}

async function terminateReceiverProcess(pid, identity, reason) {
  if (!processAlive(pid)) return { stopped: true, staleReference: false };
  let info = inspectReceiverProcess(pid, identity);
  if (info.verified && !info.matches) {
    log(`refuse receiver signal for unrelated pid: pid=${pid} reason=${reason}`);
    return { stopped: false, staleReference: true };
  }
  if (!info.verified) {
    log(`refuse receiver signal without process identity: pid=${pid} reason=${reason}`);
    return { stopped: false, staleReference: false };
  }

  try {
    process.kill(pid, "SIGTERM");
    log(`sent SIGTERM to attached receiver: pid=${pid} reason=${reason}`);
  } catch {}
  if (await waitForProcessExit(pid, RECEIVER_TERM_TIMEOUT_MS)) return { stopped: true, staleReference: false };

  info = inspectReceiverProcess(pid, identity);
  if (!info.verified || !info.matches) {
    log(`refuse receiver SIGKILL after identity changed: pid=${pid} reason=${reason}`);
    return { stopped: false, staleReference: !info.matches };
  }
  try {
    process.kill(pid, "SIGKILL");
    log(`sent SIGKILL to attached receiver: pid=${pid} reason=${reason}`);
  } catch {}
  return { stopped: await waitForProcessExit(pid, RECEIVER_KILL_TIMEOUT_MS), staleReference: false };
}

async function acquireReceiverLock(agentName) {
  mkdirSync(MAF_HOME, { recursive: true });
  const path = receiverLockFile(agentName);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + RECEIVER_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, token);
      return { fd, path, token };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > RECEIVER_LOCK_STALE_MS) unlinkSync(path);
      } catch {}
      await sleep(50);
    }
  }
  throw new Error(`receiver lifecycle lock timeout: ${path}`);
}

function releaseReceiverLock(lock) {
  if (!lock) return;
  try { closeSync(lock.fd); } catch {}
  try {
    if (readFileSync(lock.path, "utf-8") === lock.token) unlinkSync(lock.path);
  } catch {}
}

function findCodexRemote(hookEvent) {
  if (process.env.MAF_CODEX_APP_SERVER_URL) return process.env.MAF_CODEX_APP_SERVER_URL;
  if (process.env.MAF_CODEX_REMOTE) return process.env.MAF_CODEX_REMOTE;

  const args = [];
  if (Array.isArray(hookEvent?.args)) args.push(...hookEvent.args);
  if (Array.isArray(hookEvent?.argv)) args.push(...hookEvent.argv);
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || "");
    if (arg === "--remote" && args[i + 1]) return String(args[i + 1]);
    if (arg.startsWith("--remote=")) return arg.slice("--remote=".length);
  }
  return "";
}

async function startAttachedReceiver({ agentName, projectPath, port, appServerUrl, appServerCmd, sessionPid = "" }) {
  if (process.env.MAF_CODEX_ATTACHED_RECEIVER_DISABLE === "1" || process.env.MAF_CODEX_AUTO_ATTACHED_RECEIVER === "0") {
    log("attached receiver autostart disabled");
    return false;
  }
  if (!agentName || (!appServerUrl && !appServerCmd)) return false;

  const receiverScript = join(PLUGIN_ROOT, "scripts", "maf-codex-attached-receiver.mjs");
  if (!isFile(receiverScript)) {
    log(`attached receiver script missing: ${receiverScript}`);
    return false;
  }

  const pidFile = receiverPidFile(agentName);
  const metaFile = receiverMetaFile(agentName);
  const identity = { agentName, pidFile, receiverScript };
  let lock = null;
  try {
    lock = await acquireReceiverLock(agentName);
    const oldMeta = readReceiverMeta(agentName);
    const oldPid = readReceiverPid(agentName) || Number(oldMeta.pid || 0);
    if (oldPid && processAlive(oldPid)) {
      const info = inspectReceiverProcess(oldPid, identity);
      if (info.verified && !info.matches) {
        log(`discard stale receiver state for unrelated pid: agent=${agentName} pid=${oldPid}`);
        removeReceiverPidFile(agentName, oldPid);
        removeReceiverMeta(agentName, oldPid);
      } else if (!info.verified) {
        log(`attached receiver identity unavailable; skip duplicate start: agent=${agentName} pid=${oldPid}`);
        return { ok: false, pid: oldPid, reused: false, error: "receiver identity unavailable" };
      } else {
        const reuse = !sessionPid
          || process.env.MAF_CODEX_REPLACE_ATTACHED_RECEIVER === "0"
          || sameReceiverTarget(info, { projectPath, appServerUrl, appServerCmd, sessionPid });
        if (reuse) {
          log(`attached receiver already running: agent=${agentName} pid=${oldPid}`);
          return { ok: true, pid: oldPid, reused: true, meta: oldMeta };
        }

        log(`replace stale/previous attached receiver: agent=${agentName} oldPid=${oldPid} sessionPid=${sessionPid}`);
        await disconnectAgent({ agentName, port, pluginPid: oldPid });
        const terminated = await terminateReceiverProcess(oldPid, identity, "replace");
        if (!terminated.stopped && !terminated.staleReference) {
          log(`attached receiver replacement blocked: agent=${agentName} pid=${oldPid}`);
          return { ok: false, pid: oldPid, reused: false, error: "previous receiver did not stop" };
        }
        removeReceiverPidFile(agentName, oldPid);
        removeReceiverMeta(agentName, oldPid);
      }
    } else if (oldPid) {
      removeReceiverPidFile(agentName, oldPid);
      removeReceiverMeta(agentName, oldPid);
    }

    const env = {
      ...process.env,
      MAF_NODE_PORT: String(port),
      MAF_DAEMON_URL: `http://127.0.0.1:${port}`,
      MAF_AGENT_NAME: agentName,
      MAF_RUNTIME: "codex",
      MAF_DIRECTORY: projectPath,
      MAF_CODEX_RECEIVER_PID_FILE: pidFile,
      MAF_CODEX_RECEIVER_META_FILE: metaFile,
    };
    if (sessionPid) env.MAF_CODEX_SESSION_PID = sessionPid;
    else delete env.MAF_CODEX_SESSION_PID;
    if (appServerUrl) env.MAF_CODEX_APP_SERVER_URL = appServerUrl;
    else delete env.MAF_CODEX_APP_SERVER_URL;
    if (appServerCmd) env.MAF_CODEX_APP_SERVER_CMD = appServerCmd;
    else delete env.MAF_CODEX_APP_SERVER_CMD;

    const child = spawn(process.execPath, [receiverScript], {
      cwd: projectPath,
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    const pid = child.pid || 0;
    writeFileSync(pidFile, `${pid || ""}\n`);
    writeReceiverMeta(agentName, {
      agent_name: agentName,
      pid,
      project_path: projectPath,
      app_server_url: appServerUrl || "",
      session_pid: sessionPid,
      started_at: new Date().toISOString(),
    });
    log(`spawn attached receiver: pid=${child.pid || "?"} agent=${agentName} project=${projectPath} appServer=${appServerUrl || "cmd"}`);
    return { ok: true, pid, reused: false, meta_file: metaFile };
  } catch (err) {
    log(`attached receiver spawn failed: ${err.message}`);
    return { ok: false, pid: 0 };
  } finally {
    releaseReceiverLock(lock);
  }
}

async function disconnectAgent({ agentName, port, pluginPid = 0 }) {
  try {
    const body = { agent_name: agentName, runtime: "codex" };
    if (pluginPid) body.plugin_pid = pluginPid;
    const res = await fetch(`http://127.0.0.1:${port}/agents/disconnect`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`disconnected: agent=${agentName} pluginPid=${pluginPid || "-"}`);
    return true;
  } catch (err) {
    log(`disconnect failed: agent=${agentName} ${err.message}`);
    return false;
  }
}

async function stopAttachedReceiver({ agentName, port, sessionPid = "" }) {
  let lock = null;
  try {
    lock = await acquireReceiverLock(agentName);
    const meta = readReceiverMeta(agentName);
    const metaSessionPid = String(meta.session_pid || "").trim();
    if (sessionPid && metaSessionPid && metaSessionPid !== String(sessionPid)) {
      log(`skip receiver stop: agent=${agentName} sessionPid=${sessionPid} currentSessionPid=${metaSessionPid}`);
      return false;
    }

    const pid = readReceiverPid(agentName) || Number(meta.pid || 0);
    if (!pid) {
      log(`skip receiver stop: agent=${agentName} no attached receiver pid`);
      return false;
    }

    const identity = {
      agentName,
      pidFile: receiverPidFile(agentName),
      receiverScript: join(PLUGIN_ROOT, "scripts", "maf-codex-attached-receiver.mjs"),
    };
    const info = inspectReceiverProcess(pid, identity);
    if (info.verified && !info.matches) {
      log(`discard stale receiver state without signaling unrelated pid: agent=${agentName} pid=${pid}`);
      removeReceiverPidFile(agentName, pid);
      removeReceiverMeta(agentName, pid);
      return true;
    }
    if (!info.verified) {
      log(`receiver stop blocked because process identity is unavailable: agent=${agentName} pid=${pid}`);
      return false;
    }

    await disconnectAgent({ agentName, port, pluginPid: pid });
    const terminated = await terminateReceiverProcess(pid, identity, "session-stop");
    if (!terminated.stopped && !terminated.staleReference) return false;
    removeReceiverPidFile(agentName, pid);
    removeReceiverMeta(agentName, pid);
    return true;
  } catch (err) {
    log(`receiver stop failed: agent=${agentName} ${err.message}`);
    return false;
  } finally {
    releaseReceiverLock(lock);
  }
}

async function stopOwnedAppServer({ agentName, appServerUrl, sessionPid = "" }) {
  if (!appServerUrl) return false;
  const helperScript = join(PLUGIN_ROOT, "scripts", "maf-codex-app-server.mjs");
  if (!isFile(helperScript)) {
    log(`app-server cleanup skipped: helper missing ${helperScript}`);
    return false;
  }
  return await new Promise(resolve => {
    const args = ["--cleanup", "--agent", agentName, "--url", appServerUrl];
    if (sessionPid) args.push("--session-pid", sessionPid);
    const child = spawn(process.execPath, [helperScript, ...args], {
      cwd: process.env.CODEX_CWD || process.cwd(),
      stdio: "ignore",
      env: {
        ...process.env,
        MAF_AGENT_NAME: agentName,
        MAF_CODEX_APP_SERVER_URL: appServerUrl,
        MAF_CODEX_SESSION_PID: sessionPid,
      },
    });
    const timeoutMs = parseInt(process.env.MAF_CODEX_APP_SERVER_CLEANUP_TIMEOUT_MS || "0", 10) || 8000;
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.on("close", code => {
      clearTimeout(timer);
      log(`app-server cleanup helper exited: agent=${agentName} url=${appServerUrl} code=${code}`);
      resolve(code === 0);
    });
    child.on("error", err => {
      clearTimeout(timer);
      log(`app-server cleanup helper failed: agent=${agentName} ${err.message}`);
      resolve(false);
    });
  });
}

function findDaemonScript() {
  const script = join(MAF_HOME, "daemon.mjs");
  return isFile(script) ? script : "";
}

async function checkDaemon(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

async function waitForDaemon(port, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const health = await checkDaemon(port);
    if (health) return health;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

async function ensureDaemon({ agentName, projectPath, serverUrl, port }) {
  const existing = await checkDaemon(port);
  if (existing) return true;

  const daemonScript = findDaemonScript();
  if (!daemonScript) {
    log("skip: daemon.mjs not found");
    return false;
  }

  const env = {
    ...process.env,
    MAF_NODE_PORT: String(port),
    MAF_AGENT_NAME: agentName,
    MAF_RUNTIME: "codex",
    MAF_DIRECTORY: projectPath,
    MAF_PLUGIN_DIR: dirname(daemonScript),
    META_AGENT_SERVER: serverUrl || process.env.META_AGENT_SERVER || "",
    MAF_LOCAL_TOKEN: localAuthToken(),
  };

  try {
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    log(`spawn daemon: pid=${child.pid || "?"} agent=${agentName} project=${projectPath}`);
  } catch (err) {
    log(`daemon spawn failed: ${err.message}`);
    return false;
  }

  return Boolean(await waitForDaemon(port));
}

async function connectAgent({ agentName, projectPath, port, pluginPid = 0 }) {
  try {
    const body = { agent_name: agentName, runtime: "codex", directory: projectPath };
    if (pluginPid) body.plugin_pid = pluginPid;
    const res = await fetch(`http://127.0.0.1:${port}/agents/connect`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    log(`connected: agent=${agentName} project=${projectPath} agents=[${(data.agents || []).join(",")}]`);
    return true;
  } catch (err) {
    log(`connect failed: agent=${agentName} ${err.message}`);
    return false;
  }
}

async function main() {
  const raw = await readHookInput();
  const hookEvent = raw ? safeJson(raw) : null;
  const eventName = String(hookEvent?.eventName || hookEvent?.hook_event_name || hookEvent?.hookEventName || "");
  const startDir = findBestStartDir(hookEvent);
  if (!startDir) {
    log("skip: unable to determine Codex project directory");
    return;
  }

  const inferred = inferAgent(startDir);
  const hasAgent = validAgentName(inferred.agentName);
  const isServerIdentity = isServerAgentName(inferred.agentName);
  const projectPath = inferred.projectPath || resolve(startDir);
  const cfg = readMafConfig(projectPath);
  const serverUrl = process.env.META_AGENT_SERVER || cfg.server?.url || "";
  const port = parseInt(process.env.MAF_NODE_PORT || process.env.MAF_DAEMON_PORT || String(cfg.daemon?.port || DEFAULT_PORT), 10) || DEFAULT_PORT;

  if (["WrapperEnd", "SessionEnd", "Stop"].includes(eventName)) {
    if (!hasAgent) {
      log(`cleanup skipped: no valid MAF Codex agent for ${startDir}`);
      return;
    }
    const sessionPid = String(hookEvent?.sessionPid || process.env.MAF_CODEX_SESSION_PID || "");
    const appServerUrl = findCodexRemote(hookEvent) || process.env.MAF_CODEX_APP_SERVER_URL || "";
    await stopAttachedReceiver({
      agentName: inferred.agentName,
      port,
      sessionPid,
    });
    await stopOwnedAppServer({ agentName: inferred.agentName, appServerUrl, sessionPid });
    return;
  }

  // The daemon is machine-level, not project-level. Start it for any Codex
  // launch so Codex can be opened from arbitrary directories. Agent
  // registration is automatic for non-home project roots with either
  // .codex/agents/*.toml metadata or a valid project directory name.
  const ok = await ensureDaemon({
    agentName: hasAgent ? inferred.agentName : "",
    projectPath,
    serverUrl,
    port,
  });
  if (!ok) return;

  if (!hasAgent) {
    log(`daemon ready without valid MAF Codex agent for ${startDir}`);
    return;
  }
  if (isServerIdentity) {
    log(`${SERVER_AGENT_NAME} 是 Server 控制面身份：保持 daemon/receiver 通知能力，但跳过 Client Agent 注册`);
  }

  const appServerUrl = findCodexRemote(hookEvent);
  const appServerCmd = process.env.MAF_CODEX_APP_SERVER_CMD || "";
  const startSessionPid = String(hookEvent?.sessionPid || (eventName === "WrapperStart" ? process.env.MAF_CODEX_SESSION_PID : "") || "").trim();
  const receiver = await startAttachedReceiver({
    agentName: inferred.agentName,
    projectPath,
    port,
    appServerUrl,
    appServerCmd,
    sessionPid: startSessionPid,
  });

  if (!isServerIdentity) {
    await connectAgent({ agentName: inferred.agentName, projectPath, port, pluginPid: receiver?.pid || 0 });
  }
}

main().catch(err => log(`unexpected error: ${err?.stack || err?.message || err}`));
