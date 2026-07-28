import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, parse as parsePath } from "node:path";

export const HOME = homedir();
export const MAF_HOME = join(HOME, ".meta-agent-framework");

export function isDir(path) {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}

export function isFile(path) {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

export function validAgentName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(name);
}

export function safeName(name) {
  return String(name || "codex").replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function processAlive(pid) {
  const n = Number(pid || 0);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

export function parentDirs(start) {
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

export function isHomeDir(dir) {
  return resolve(dir) === resolve(HOME);
}

export function isGitRoot(dir) {
  const dotGit = join(dir, ".git");
  if (isDir(dotGit)) return isFile(join(dotGit, "HEAD"));
  if (!isFile(dotGit)) return false;
  try { return /^gitdir:\s*.+/i.test(readFileSync(dotGit, "utf-8")); } catch { return false; }
}

export function findGitRoot(startDir) {
  for (const dir of parentDirs(startDir)) {
    if (isHomeDir(dir)) break;
    if (isGitRoot(dir)) return dir;
  }
  return "";
}

export function findCodexAgentRoot(startDir) {
  for (const dir of parentDirs(startDir)) {
    if (isHomeDir(dir)) break;
    if (isDir(join(dir, ".codex", "agents"))) return dir;
  }
  return "";
}

export function inferProjectRoot(startDir) {
  const codexRoot = findCodexAgentRoot(startDir);
  if (codexRoot) return codexRoot;
  const gitRoot = findGitRoot(startDir);
  if (gitRoot) return gitRoot;
  return resolve(startDir);
}

function unescapeTomlBasicString(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }
}

export function parseTomlString(raw, key) {
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

export function readCodexAgentToml(file) {
  try {
    const raw = readFileSync(file, "utf-8");
    const fileName = basename(file, ".toml");
    const name = parseTomlString(raw, "name");
    const description = parseTomlString(raw, "description");
    return {
      path: file,
      fileName,
      name: validAgentName(name) ? name : "",
      description,
    };
  } catch {}
  return null;
}

export function listProjectCodexAgents(projectRoot) {
  const dir = join(projectRoot, ".codex", "agents");
  try {
    if (!isDir(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith(".toml") && !f.startsWith("."))
      .sort()
      .map(f => readCodexAgentToml(join(dir, f)))
      .filter(Boolean);
  } catch {}
  return [];
}

export function pickCodexAgent(projectRoot) {
  const projectName = basename(projectRoot);
  const agents = listProjectCodexAgents(projectRoot);

  const matching = agents.find(a => a.fileName === projectName || a.name === projectName);
  if (matching) return matching.name || (validAgentName(matching.fileName) ? matching.fileName : "");

  if (agents.length === 1) {
    const only = agents[0];
    return only.name || (validAgentName(only.fileName) ? only.fileName : "");
  }

  return validAgentName(projectName) ? projectName : "";
}

export function inferAgent(startDir) {
  const projectRoot = inferProjectRoot(startDir);
  if (isHomeDir(projectRoot)) return { agentName: "", projectPath: projectRoot };

  if (validAgentName(process.env.MAF_AGENT_NAME)) {
    return { agentName: process.env.MAF_AGENT_NAME, projectPath: projectRoot };
  }

  return { agentName: pickCodexAgent(projectRoot), projectPath: projectRoot };
}

export function readMafConfig(projectPath) {
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
