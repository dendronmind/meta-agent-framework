#!/usr/bin/env node
/**
 * MAF Codex SessionStart hook.
 *
 * Runs at Codex session startup through the Codex plugin system or the launcher
 * wrapper. It always tries to keep the machine-level MAF Node Daemon running, and
 * only connects a Codex agent when explicit project metadata is available. It is
 * intentionally quiet: diagnostics go to ~/.meta-agent-framework/logs/codex-plugin.log so
 * Codex TUI startup is not polluted.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(__dirname);
const HOME = homedir();
const MAF_HOME = join(HOME, ".meta-agent-framework");
const LOG_DIR = join(MAF_HOME, "logs");
const LOG_FILE = join(LOG_DIR, "codex-plugin.log");
const DEFAULT_PORT = 4100;

function log(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [codex-hook] ${message}\n`);
  } catch {}
}

function isDir(path) {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path) {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
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

function validAgentName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(name);
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

function readMafConfig(projectPath) {
  const files = [
    join(MAF_HOME, "maf.config.json"),
    join(projectPath, "maf.config.json"),
  ];
  let cfg = {};
  for (const file of files) {
    try {
      if (isFile(file)) cfg = { ...cfg, ...JSON.parse(readFileSync(file, "utf-8")) };
    } catch {}
  }
  return cfg;
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

async function connectAgent({ agentName, projectPath, port }) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agents/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_name: agentName, runtime: "codex", directory: projectPath }),
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
  const startDir = findBestStartDir(hookEvent);
  if (!startDir) {
    log("skip: unable to determine Codex project directory");
    return;
  }

  const inferred = inferAgent(startDir);
  const hasAgent = validAgentName(inferred.agentName);
  const projectPath = inferred.projectPath || resolve(startDir);
  const cfg = readMafConfig(projectPath);
  const serverUrl = process.env.META_AGENT_SERVER || cfg.server?.url || "";
  const port = parseInt(process.env.MAF_NODE_PORT || process.env.MAF_DAEMON_PORT || String(cfg.daemon?.port || DEFAULT_PORT), 10) || DEFAULT_PORT;

  // The daemon is machine-level, not project-level.  Start it for any Codex
  // launch so Codex can be opened from arbitrary directories.  Agent
  // registration remains guarded by explicit metadata to avoid registering an
  // unrelated directory as a MAF agent project.
  const ok = await ensureDaemon({
    agentName: hasAgent ? inferred.agentName : "",
    projectPath,
    serverUrl,
    port,
  });
  if (!ok) return;

  if (!hasAgent) {
    log(`daemon ready without explicit MAF Codex agent metadata for ${startDir}`);
    return;
  }

  await connectAgent({ agentName: inferred.agentName, projectPath, port });
}

main().catch(err => log(`unexpected error: ${err?.stack || err?.message || err}`));
