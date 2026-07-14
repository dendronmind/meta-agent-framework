#!/usr/bin/env node
/**
 * MAF Codex app-server autostart helper.
 *
 * Called by the Codex launcher wrapper before the real interactive Codex TUI is
 * exec'd.  It is intentionally quiet: stdout is reserved for the selected
 * websocket URL; diagnostics go to ~/.meta-agent-framework/logs/codex-plugin.log.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const HOME = homedir();
const MAF_HOME = join(HOME, ".meta-agent-framework");
const LOG_DIR = join(MAF_HOME, "logs");
const LOG_FILE = join(LOG_DIR, "codex-plugin.log");
const STATE_DIR = join(MAF_HOME, "state");
const DEFAULT_PORT_START = 47891;
const DEFAULT_PORT_END = 47920;

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
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [codex-app-server] ${message}\n`);
  } catch {}
}

function isDir(path) { try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; } }
function isFile(path) { try { return existsSync(path) && statSync(path).isFile(); } catch { return false; } }
function validAgentName(name) { return typeof name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(name); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

function parentDirs(start) {
  const dirs = [];
  let cur = resolve(start);
  const root = parsePath(cur).root;
  while (cur && cur !== root) {
    dirs.push(cur);
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  dirs.push(root);
  return dirs;
}

function parseAgentFromAgentsMd(projectDir) {
  const file = join(projectDir, "AGENTS.md");
  if (!isFile(file)) return "";
  try {
    const raw = readFileSync(file, "utf-8");
    const m = raw.match(/^#\s*Codex project agent:\s*([A-Za-z0-9_.-]+)\s*$/mi);
    if (m && validAgentName(m[1])) return m[1];
  } catch {}
  return "";
}

function singleAgentFileName(dir) {
  try {
    if (!isDir(dir)) return "";
    const files = readdirSync(dir).filter(f => f.endsWith(".md") && validAgentName(f.slice(0, -3)));
    if (files.length === 1) return files[0].slice(0, -3);
  } catch {}
  return "";
}

function inferAgent(startDir) {
  if (validAgentName(process.env.MAF_AGENT_NAME)) {
    return { agentName: process.env.MAF_AGENT_NAME, projectPath: resolve(startDir) };
  }
  for (const dir of parentDirs(startDir)) {
    const codexAgent = singleAgentFileName(join(dir, ".codex", "agents"));
    if (codexAgent) return { agentName: codexAgent, projectPath: dir };
    const agentsMdAgent = parseAgentFromAgentsMd(dir);
    if (agentsMdAgent) return { agentName: agentsMdAgent, projectPath: dir };
  }
  return { agentName: "", projectPath: resolve(startDir) };
}

function safeName(name) { return String(name || "codex").replace(/[^A-Za-z0-9_.-]/g, "_"); }
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

function processAlive(pid) {
  const n = Number(pid || 0);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
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
  return 0;
}

async function startAppServer({ realCodex, agentName, projectPath }) {
  const port = await choosePort();
  if (!port) {
    log(`no free Codex app-server port in range ${parsePortRange().join("-")}`);
    return "";
  }
  const url = `ws://127.0.0.1:${port}`;
  let fd = "ignore";
  try {
    mkdirSync(LOG_DIR, { recursive: true });
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
      started_at: new Date().toISOString(),
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
    log(`auto remote skipped: no MAF Codex agent metadata for ${cwd}`);
    return;
  }

  const existing = readState(inferred.agentName);
  if (existing?.url && processAlive(existing.pid) && await appServerReady(existing.url)) {
    log(`reuse app-server: pid=${existing.pid} agent=${inferred.agentName} url=${existing.url}`);
    process.stdout.write(existing.url);
    return;
  }

  const url = await startAppServer({ realCodex, agentName: inferred.agentName, projectPath: inferred.projectPath });
  if (url) process.stdout.write(url);
}

main().catch(err => log(`unexpected error: ${err?.stack || err?.message || err}`));
