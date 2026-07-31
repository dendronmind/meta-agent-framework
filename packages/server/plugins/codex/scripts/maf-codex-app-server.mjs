#!/usr/bin/env node
/**
 * MAF Codex app-server autostart helper.
 *
 * Called by the Codex launcher wrapper before the real interactive Codex TUI is
 * exec'd.  It is intentionally quiet: stdout is reserved for the selected
 * websocket URL; diagnostics go to ~/.meta-agent-framework/logs/codex-plugin.log.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, openSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { HOME, MAF_HOME, inferAgent, isFile, processAlive, safeName, sleep, validAgentName } from "./maf-codex-common.mjs";

const LOG_DIR = join(MAF_HOME, "logs");
const LOG_FILE = join(LOG_DIR, "codex-plugin.log");

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
const STATE_DIR = join(MAF_HOME, "state");
const DEFAULT_PORT_START = 47891;
const DEFAULT_PORT_END = 47990;

const OPTIONS_WITH_VALUE = new Set([
  "-c", "--config", "-i", "--image", "-m", "--model", "-p", "--profile",
  "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
  "--remote", "--remote-auth-token-env", "--color",
]);
const NON_TUI_COMMANDS = new Set([
  "exec", "e", "review", "apply", "a", "plugin", "mcp", "login", "logout",
  "completion", "update", "doctor", "debug", "features", "sandbox", "app-server",
  "remote-control", "mcp-server", "exec-server", "cloud", "help", "archive", "delete",
  "unarchive",
]);

function log(message) {
  appendLogLine(`${new Date().toISOString()} [codex-app-server] ${message}\n`);
}

function shellArgs() {
  const args = process.argv.slice(2);
  const sep = args.indexOf("--");
  const helperArgs = sep >= 0 ? args.slice(0, sep) : args;
  const codexArgs = sep >= 0 ? args.slice(sep + 1) : [];
  let realCodex = process.env.MAF_CODEX_REAL_BIN || process.env.REAL_CODEX || "codex";
  let cwd = process.env.CODEX_CWD || process.cwd();
  for (let i = 0; i < helperArgs.length; i++) {
    if (helperArgs[i] === "--real" && helperArgs[i + 1]) { realCodex = helperArgs[++i]; continue; }
    if (helperArgs[i] === "--cwd" && helperArgs[i + 1]) { cwd = helperArgs[++i]; continue; }
  }
  return { realCodex, cwd: resolve(String(cwd).replace(/^~/, HOME)), codexArgs };
}

function firstNonOption(args) {
  let skip = false;
  for (const arg of args) {
    if (skip) { skip = false; continue; }
    if (arg === "--") return "";
    if (OPTIONS_WITH_VALUE.has(arg)) { skip = true; continue; }
    if ([...OPTIONS_WITH_VALUE].some(opt => arg.startsWith(`${opt}=`))) continue;
    if (arg.startsWith("--")) continue;
    if (arg.startsWith("-") && arg !== "-") continue;
    return arg;
  }
  return "";
}

function hasRemoteArg(args) {
  return args.some(arg => arg === "--remote" || String(arg).startsWith("--remote="));
}

function shouldSkipForArgs(args) {
  if (args.some(arg => arg === "-h" || arg === "--help" || arg === "-V" || arg === "--version")) return "help/version";
  const cmd = firstNonOption(args);
  if (cmd && NON_TUI_COMMANDS.has(cmd)) return `non-tui command ${cmd}`;
  return "";
}

function stateFile(agentName) { return join(STATE_DIR, `codex-app-server-${safeName(agentName)}.json`); }

function readState(agentName) {
  try { return JSON.parse(readFileSync(stateFile(agentName), "utf-8")); } catch { return null; }
}

function writeState(agentName, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(stateFile(agentName), JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    log(`state write failed: ${err.message}`);
  }
}

function removeState(agentName) {
  try { unlinkSync(stateFile(agentName)); } catch {}
}

function parseWsPort(url) {
  try {
    const port = parseInt(new URL(url).port || "0", 10);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.hostname === ub.hostname && ua.port === ub.port;
  } catch {
    return a === b;
  }
}

function argValue(args, name) {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const prefix = `${name}=`;
  const found = args.find(a => String(a).startsWith(prefix));
  return found ? String(found).slice(prefix.length) : "";
}

function findListeningPids(port) {
  const pids = new Set();
  try {
    const out = execFileSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", timeout: 1500 });
    for (const line of out.split(/\s+/)) {
      const pid = parseInt(line, 10);
      if (pid) pids.add(pid);
    }
  } catch {}
  try {
    const out = execFileSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf-8", timeout: 1500 });
    for (const match of out.matchAll(/pid=(\d+)/g)) {
      const pid = parseInt(match[1], 10);
      if (pid) pids.add(pid);
    }
  } catch {}
  return [...pids];
}

function pidCommand(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim(); } catch { return ""; }
}

function pidAgeMs(pid) {
  try {
    const raw = execFileSync("ps", ["-o", "etimes=", "-p", String(pid)], { encoding: "utf-8", timeout: 1500 }).trim();
    const seconds = parseInt(raw, 10);
    return Number.isInteger(seconds) && seconds >= 0 ? seconds * 1000 : 0;
  } catch {
    return 0;
  }
}

function isCodexAppServerPid(pid, port) {
  const cmd = pidCommand(pid);
  return cmd.includes("codex") && cmd.includes("app-server") && cmd.includes(`127.0.0.1:${port}`);
}

async function waitPortFree(port, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortFree(port)) return true;
    await sleep(100);
  }
  return await isPortFree(port);
}

function signalPidGroup(pid, signal) {
  const n = Number(pid || 0);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  let ok = false;
  // app-server is spawned with detached=true, so the spawned pid is normally
  // also the process-group id.  Killing the group handles CLIs that fork the
  // actual listener under the initial codex app-server process.
  try { process.kill(-n, signal); ok = true; } catch {}
  try { process.kill(n, signal); ok = true; } catch {}
  return ok;
}

function normalizePids(values) {
  const out = [];
  for (const value of values || []) {
    const pid = Number(value || 0);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !out.includes(pid)) out.push(pid);
  }
  return out;
}

async function appServerRequest(url, method, params = {}, timeoutMs = 1500) {
  if (typeof WebSocket !== "function") throw new Error("WebSocket global unavailable");
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(url);
  const send = obj => ws.send(JSON.stringify(obj));
  ws.onmessage = event => {
    for (const line of String(event.data || "").split("\n").map(s => s.trim()).filter(Boolean)) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const item = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else item.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        try { send({ jsonrpc: "2.0", id: msg.id, result: {} }); } catch {}
      }
    }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connect timeout: ${url}`)), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`websocket error: ${url}`)); };
  });
  const request = (m, p = {}, t = timeoutMs) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`request timeout: ${m}`));
      }, t);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method: m, params: p });
    });
  };
  try {
    try {
      await request("initialize", {
        clientInfo: { name: "maf-codex-app-server-gc", title: "MAF Codex App Server GC", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, timeoutMs);
      send({ jsonrpc: "2.0", method: "initialized" });
    } catch {}
    return await request(method, params, timeoutMs);
  } finally {
    try { ws.close(); } catch {}
  }
}

async function appServerLoadedThreads(url, timeoutMs = 1500) {
  try {
    const result = await appServerRequest(url, "thread/loaded/list", {}, timeoutMs);
    if (Array.isArray(result?.data)) return result.data;
    if (Array.isArray(result?.threads)) return result.threads;
    if (Array.isArray(result)) return result;
    return [];
  } catch (err) {
    log(`loaded thread probe failed: url=${url} ${err.message}`);
    return null;
  }
}

async function protocolKillAppServer(url, port) {
  try {
    const shell = [
      "parent=$PPID",
      `cmd=$(tr '\\0' ' ' < /proc/$parent/cmdline 2>/dev/null || true)`,
      `case "$cmd" in *"codex app-server --listen ws://127.0.0.1:${port}"*) kill -TERM "$parent" 2>/dev/null || true; sleep 0.4; kill -KILL "$parent" 2>/dev/null || true;; *) exit 3;; esac`,
    ].join("\n");
    await appServerRequest(url, "command/exec", {
      command: ["/bin/sh", "-lc", shell],
      sandboxPolicy: { type: "dangerFullAccess" },
      disableOutputCap: true,
      timeoutMs: 3000,
    }, 4000);
    return true;
  } catch (err) {
    // 成功 kill 自身时 websocket 可能提前断开；只要端口释放即可。
    await sleep(500);
    return await isPortFree(port);
  }
}

async function stopCodexAppServerUrl(url, { requireNoLoaded = true, minAgeMs = 0, reason = "cleanup", candidatePids = [] } = {}) {
  const port = parseWsPort(url);
  if (!port) return false;
  if (requireNoLoaded) {
    const loaded = await appServerLoadedThreads(url, 1500);
    if (loaded === null) return false;
    if (loaded.length > 0) {
      log(`skip app-server stop: loaded threads present (${loaded.length}) url=${url} reason=${reason}`);
      return false;
    }
  }

  const pids = normalizePids([
    ...candidatePids,
    ...findListeningPids(port).filter(pid => isCodexAppServerPid(pid, port)),
  ]);
  log(`stop app-server candidates: port=${port} reason=${reason} pids=${pids.join(",") || "-"} url=${url}`);
  if (minAgeMs > 0 && pids.length > 0) {
    const youngest = Math.min(...pids.map(pidAgeMs).filter(Boolean));
    if (youngest && youngest < minAgeMs) {
      log(`skip young app-server: port=${port} ageMs=${youngest} minAgeMs=${minAgeMs}`);
      return false;
    }
  }

  for (const pid of pids) {
    log(`stop app-server: pid=${pid} port=${port} reason=${reason}`);
    signalPidGroup(pid, "SIGTERM");
  }
  if (pids.length > 0 && await waitPortFree(port, 1500)) return true;
  for (const pid of pids) signalPidGroup(pid, "SIGKILL");
  if (pids.length > 0 && await waitPortFree(port, 1500)) return true;

  // 在受限命名空间或 lsof/ss 不可见时，用 app-server 自身的 command/exec 兜底。
  log(`stop app-server protocol fallback: port=${port} reason=${reason} url=${url}`);
  return await protocolKillAppServer(url, port);
}

async function gcStaleAppServers({ aggressive = false, preserveUrl = "" } = {}) {
  if (process.env.MAF_CODEX_APP_SERVER_GC === "0") return 0;
  const [start, end] = parsePortRange();
  const minAgeMs = aggressive ? 0 : (parseInt(process.env.MAF_CODEX_APP_SERVER_GC_MIN_AGE_MS || "0", 10) || 30_000);
  let killed = 0;
  for (let port = start; port <= end; port++) {
    const url = `ws://127.0.0.1:${port}`;
    if (sameUrl(url, preserveUrl)) continue;
    if (await isPortFree(port)) continue;
    const ok = await stopCodexAppServerUrl(url, {
      requireNoLoaded: true,
      minAgeMs,
      reason: aggressive ? "port-exhausted-gc" : "startup-gc",
    });
    if (ok) killed++;
  }
  if (killed) log(`gc stale app-servers: killed=${killed} range=${start}-${end} aggressive=${aggressive}`);
  return killed;
}

function httpBaseForWs(url) {
  try {
    const u = new URL(url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch { return ""; }
}

async function appServerReady(url, timeoutMs = 800) {
  const base = httpBaseForWs(url);
  if (!base) return false;
  for (const path of ["/readyz", "/healthz"]) {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

async function waitReady(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await appServerReady(url, 500)) return true;
    await sleep(200);
  }
  return false;
}

function parsePortRange() {
  const single = parseInt(process.env.MAF_CODEX_APP_SERVER_PORT || process.env.MAF_CODEX_AUTO_REMOTE_PORT || "0", 10);
  if (single > 0) return [single, single];
  const raw = process.env.MAF_CODEX_APP_SERVER_PORT_RANGE || `${DEFAULT_PORT_START}-${DEFAULT_PORT_END}`;
  const m = String(raw).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return [DEFAULT_PORT_START, DEFAULT_PORT_END];
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2] || m[1], 10);
  return [Math.min(a, b), Math.max(a, b)];
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ host: "127.0.0.1", port });
  });
}

async function choosePort() {
  const [start, end] = parsePortRange();
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  await gcStaleAppServers({ aggressive: true });
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  return 0;
}

async function startAppServer({ realCodex, agentName, projectPath, sessionPid }) {
  const port = await choosePort();
  if (!port) {
    log(`no free Codex app-server port in range ${parsePortRange().join("-")}`);
    return "";
  }
  const url = `ws://127.0.0.1:${port}`;
  let fd = "ignore";
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    rotateLogIfNeeded(0);
    fd = openSync(LOG_FILE, "a");
  } catch {}

  try {
    const child = spawn(realCodex, ["app-server", "--listen", url], {
      cwd: projectPath,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, MAF_CODEX_WRAPPER_DISABLE: "1" },
    });
    child.unref();
    writeState(agentName, {
      agent_name: agentName,
      project_path: projectPath,
      url,
      pid: child.pid || 0,
      session_pid: sessionPid || "",
      started_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    });
    log(`spawn app-server: pid=${child.pid || "?"} agent=${agentName} project=${projectPath} url=${url}`);
  } catch (err) {
    log(`app-server spawn failed: ${err.message}`);
    return "";
  }

  const timeoutMs = parseInt(process.env.MAF_CODEX_APP_SERVER_START_TIMEOUT_MS || "0", 10) || 8000;
  if (await waitReady(url, timeoutMs)) return url;
  log(`app-server not ready before timeout: ${url}`);
  return "";
}

async function main() {
  const { realCodex, cwd, codexArgs } = shellArgs();
  const sessionPid = String(process.env.MAF_CODEX_SESSION_PID || process.ppid || "").trim();

  if (process.env.MAF_CODEX_AUTO_REMOTE === "0" || process.env.MAF_CODEX_AUTO_REMOTE_DISABLE === "1") {
    log("auto remote disabled");
    return;
  }
  if (hasRemoteArg(codexArgs)) return;

  const skip = shouldSkipForArgs(codexArgs);
  if (skip) {
    log(`auto remote skipped: ${skip}`);
    return;
  }

  const delivery = String(process.env.MAF_CODEX_DELIVERY || "attached").toLowerCase();
  const force = process.env.MAF_CODEX_AUTO_REMOTE === "1";
  if (!force && ["detached", "screen", "tui", "daemon", "offline"].includes(delivery)) {
    log(`auto remote skipped: delivery=${delivery}`);
    return;
  }

  const inferred = inferAgent(cwd);
  if (!validAgentName(inferred.agentName)) {
    log(`auto remote skipped: no valid MAF Codex agent for ${cwd}`);
    return;
  }

  const existing = readState(inferred.agentName);
  if (existing?.url && await appServerReady(existing.url)) {
    const loaded = await appServerLoadedThreads(existing.url, 1500);
    const existingSessionAlive = processAlive(existing.session_pid);
    if (loaded === null || loaded.length === 0 || !existingSessionAlive || String(existing.session_pid || "") === sessionPid) {
      writeState(inferred.agentName, {
        ...existing,
        agent_name: inferred.agentName,
        project_path: inferred.projectPath,
        session_pid: sessionPid,
        last_used_at: new Date().toISOString(),
      });
      log(`reuse app-server: pid=${existing.pid || "?"} agent=${inferred.agentName} url=${existing.url} loaded=${loaded?.length ?? "unknown"}`);
      process.stdout.write(existing.url);
      return;
    }
    log(`existing app-server is active; start a new one: agent=${inferred.agentName} url=${existing.url} loaded=${loaded.length} session=${existing.session_pid || "-"}`);
  } else if (existing?.url) {
    await stopCodexAppServerUrl(existing.url, { requireNoLoaded: true, reason: "stale-state" });
  }

  await gcStaleAppServers();

  const url = await startAppServer({ realCodex, agentName: inferred.agentName, projectPath: inferred.projectPath, sessionPid });
  if (url) process.stdout.write(url);
}

async function cleanupMain() {
  const args = process.argv.slice(2);
  let agentName = argValue(args, "--agent") || process.env.MAF_AGENT_NAME || "";
  if (!validAgentName(agentName)) {
    const inferred = inferAgent(process.env.CODEX_CWD || process.cwd());
    if (validAgentName(inferred.agentName)) {
      agentName = inferred.agentName;
      log(`cleanup inferred agent=${agentName} cwd=${process.env.CODEX_CWD || process.cwd()}`);
    }
  }
  const sessionPid = String(argValue(args, "--session-pid") || process.env.MAF_CODEX_SESSION_PID || "").trim();
  let url = argValue(args, "--url") || process.env.MAF_CODEX_APP_SERVER_URL || "";
  const existing = validAgentName(agentName) ? readState(agentName) : null;
  if (!url && existing?.url) url = existing.url;
  if (!url) {
    log(`cleanup skipped: no app-server url agent=${agentName || "-"}`);
    return;
  }

  if (existing?.url && sameUrl(existing.url, url) && sessionPid && existing.session_pid && String(existing.session_pid) !== sessionPid) {
    log(`cleanup skipped: app-server ownership changed agent=${agentName} url=${url} session=${sessionPid} current=${existing.session_pid}`);
    return;
  }

  const ownedByEndingSession = Boolean(
    existing?.url
    && sameUrl(existing.url, url)
    && sessionPid
    && existing.session_pid
    && String(existing.session_pid) === sessionPid
  );

  if (!ownedByEndingSession) {
    // TUI 退出后 loaded thread 从 app-server 摘除可能有一点延迟，先短暂等待。
    for (let i = 0; i < 10; i++) {
      const loaded = await appServerLoadedThreads(url, 1000);
      if (loaded !== null && loaded.length === 0) break;
      await sleep(250);
    }
  } else {
    log(`cleanup owns app-server session; forcing stop even if Codex still reports loaded threads agent=${agentName || "-"} url=${url} session=${sessionPid}`);
  }

  const stopped = await stopCodexAppServerUrl(url, {
    requireNoLoaded: !ownedByEndingSession,
    reason: ownedByEndingSession ? "wrapper-end-owned-session" : "wrapper-end",
    candidatePids: ownedByEndingSession ? [existing?.pid] : [],
  });
  if (stopped && existing?.url && sameUrl(existing.url, url) && validAgentName(agentName)) {
    removeState(agentName);
  }
  log(`cleanup app-server done: stopped=${stopped} agent=${agentName || "-"} url=${url}`);
}

function installCleanupRuntimeGuards() {
  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
    try {
      process.on(signal, () => log(`cleanup ignored signal: ${signal}`));
    } catch {}
  }
  const timeoutMs = parseInt(process.env.MAF_CODEX_APP_SERVER_CLEANUP_HARD_TIMEOUT_MS || "0", 10) || 20_000;
  return setTimeout(() => {
    log(`cleanup hard timeout; exiting after ${timeoutMs}ms`);
    process.exit(124);
  }, timeoutMs);
}

if (process.argv.includes("--cleanup")) {
  const cleanupGuard = installCleanupRuntimeGuards();
  cleanupMain()
    .catch(err => log(`cleanup unexpected error: ${err?.stack || err?.message || err}`))
    .finally(() => clearTimeout(cleanupGuard));
} else {
  main().catch(err => log(`unexpected error: ${err?.stack || err?.message || err}`));
}
