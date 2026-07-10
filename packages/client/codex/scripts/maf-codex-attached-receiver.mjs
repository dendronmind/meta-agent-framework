#!/usr/bin/env node
/**
 * MAF Codex attached receiver (experimental).
 *
 * Bridges MAF Node Daemon attached-task delivery to a Codex app-server thread.
 * This is not the detached screen executor. It only marks the Codex agent online
 * when this receiver is running and connected to a specific app-server thread.
 *
 * Required for real current-TUI usage:
 *   1. Start a Codex app-server endpoint, e.g. `codex app-server --listen ws://127.0.0.1:47891`.
 *   2. Start/attach the TUI to that app-server, e.g. `codex --remote ws://127.0.0.1:47891`.
 *   3. Run this receiver with MAF_CODEX_APP_SERVER_URL and optionally MAF_CODEX_THREAD_ID.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";

const HOME = homedir();
const NODE_PORT = parseInt(process.env.MAF_NODE_PORT || "4100", 10) || 4100;
const DAEMON_URL = process.env.MAF_DAEMON_URL || `http://127.0.0.1:${NODE_PORT}`;
const AGENT_NAME = process.env.MAF_AGENT_NAME || process.env.MAF_CODEX_AGENT || "";
const PROJECT_DIR = resolve((process.env.MAF_DIRECTORY || process.env.CODEX_CWD || process.cwd()).replace(/^~/, HOME));
const APP_SERVER_URL = process.env.MAF_CODEX_APP_SERVER_URL || "";
const APP_SERVER_CMD = process.env.MAF_CODEX_APP_SERVER_CMD || "";
const THREAD_ID_ENV = process.env.MAF_CODEX_THREAD_ID || "";
const TASK_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_ATTACHED_TASK_TIMEOUT_MS || "0", 10) || 10 * 60 * 1000;
const WAIT_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_ATTACHED_WAIT_TIMEOUT_MS || "0", 10) || 15_000;
const LOG_DIR = join(HOME, ".meta-agent-framework", "logs");
const LOG_FILE = join(LOG_DIR, "codex-plugin.log");
const PID_FILE = process.env.MAF_CODEX_RECEIVER_PID_FILE || "";
const THREAD_WAIT_MS = parseInt(process.env.MAF_CODEX_THREAD_WAIT_MS || "0", 10) || 120_000;
const THREAD_POLL_MS = parseInt(process.env.MAF_CODEX_THREAD_POLL_MS || "0", 10) || 1000;

function log(msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [codex-attached-receiver] ${msg}\n`);
  } catch {}
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function writePidFile() {
  if (!PID_FILE) return;
  try {
    mkdirSync(dirnameCompat(PID_FILE), { recursive: true });
    writeFileSync(PID_FILE, `${process.pid}\n`);
  } catch (err) {
    log(`pid file write failed: ${err.message}`);
  }
}

function removePidFile() {
  if (!PID_FILE) return;
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
}

function dirnameCompat(path) {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : ".";
}

async function readJsonSafe(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function postJson(url, body, timeoutMs = 10_000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

async function getJson(url, timeoutMs = WAIT_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

class CodexAppServerClient extends EventEmitter {
  constructor({ url, command }) {
    super();
    this.url = url;
    this.command = command;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.proc = null;
    this.ws = null;
    this.stdoutBuffer = "";
  }

  async connect() {
    if (this.url) return this.connectWebSocket(this.url);
    if (this.command) return this.connectCommand(this.command);
    throw new Error("MAF_CODEX_APP_SERVER_URL or MAF_CODEX_APP_SERVER_CMD is required");
  }

  async connectWebSocket(url) {
    if (typeof WebSocket !== "function") throw new Error("Node.js WebSocket global is unavailable");
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`connect timeout: ${url}`)), 10_000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`websocket error: ${url}`)); };
      ws.onmessage = event => this.handleWebSocketData(event.data).catch(err => log(`websocket message parse failed: ${err.message}`));
      ws.onclose = event => {
        this.closed = true;
        this.rejectAll(new Error(`app-server websocket closed: ${event.code} ${event.reason || ""}`.trim()));
      };
    });
  }

  async connectCommand(command) {
    const proc = spawn("/bin/sh", ["-lc", command], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc = proc;
    proc.stdout.on("data", chunk => {
      this.stdoutBuffer += chunk.toString();
      let idx;
      while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = this.stdoutBuffer.slice(0, idx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    proc.stderr.on("data", chunk => log(`app-server stderr: ${chunk.toString().trim()}`));
    proc.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`app-server command exited: ${code ?? ""}${signal ? ` signal=${signal}` : ""}`));
    });
    proc.on("error", err => this.rejectAll(err));
    await sleep(200);
  }

  async handleWebSocketData(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf-8");
    else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
    else if (data && typeof data.text === "function") text = await data.text();
    else text = String(data || "");

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) this.handleLine(trimmed);
    }
  }

  sendRaw(obj) {
    const line = JSON.stringify(obj);
    if (this.ws) {
      this.ws.send(line);
      return;
    }
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(line + "\n");
      return;
    }
    throw new Error("app-server transport is not connected");
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.sendRaw(payload); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = undefined) {
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.sendRaw(payload);
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      log(`ignore non-json app-server line: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.emit("notification", msg);
      // This receiver is non-interactive; approval/user-input requests should not happen when
      // approvalPolicy=never, but reply conservatively if the server sends a request anyway.
      if (msg.id !== undefined) {
        this.sendRaw({ jsonrpc: "2.0", id: msg.id, result: defaultServerRequestResult(msg.method) });
      }
    }
  }

  rejectAll(err) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "maf-codex-attached-receiver", title: "MAF Codex Attached Receiver", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    return result;
  }

  close() {
    try { this.ws?.close(); } catch {}
    try { this.proc?.kill(); } catch {}
  }
}

function defaultServerRequestResult(method) {
  if (method.includes("requestApproval") || method.includes("permissions")) {
    return { decision: "denied" };
  }
  if (method.includes("requestUserInput")) return { answers: [] };
  return {};
}

async function resolveThreadId(client) {
  if (THREAD_ID_ENV) return THREAD_ID_ENV;

  const started = Date.now();
  let lastIds = [];
  while (!stopping) {
    const loaded = await client.request("thread/loaded/list", {}, 10_000);
    lastIds = Array.isArray(loaded?.data) ? loaded.data.filter(Boolean) : [];
    if (lastIds.length === 1) return lastIds[0];
    if (lastIds.length > 1) throw new Error(`multiple loaded Codex threads (${lastIds.join(", ")}); set MAF_CODEX_THREAD_ID`);

    if (Date.now() - started >= THREAD_WAIT_MS) {
      throw new Error("no loaded Codex app-server thread; start Codex TUI with --remote and/or set MAF_CODEX_THREAD_ID");
    }
    log(`waiting for Codex app-server loaded thread (${Date.now() - started}ms/${THREAD_WAIT_MS}ms)`);
    await sleep(Math.min(THREAD_POLL_MS, Math.max(100, THREAD_WAIT_MS - (Date.now() - started))));
  }
  throw new Error(`receiver stopped before binding a Codex thread (last loaded=[${lastIds.join(", ")}])`);
}

function taskPrompt(task) {
  const parts = [
    `# MAF attached Codex task`,
    ``,
    `你正在当前 Codex attached receiver 中执行 Meta-Agent-Framework Server 派发的任务。`,
    `请直接完成任务；最终回答应包含结果摘要、关键改动/发现、验证情况。`,
    `receiver 会收集你的最终回答并回报 MAF Server，不要直接调用 MAF workflow API。`,
    ``,
    `## Metadata`,
    `- task_id: ${task.id || task.task_id || ""}`,
    `- workflow_id: ${task.workflow_id || ""}`,
    `- node_id: ${task.node_id || ""}`,
    `- agent: ${task.target_agent || AGENT_NAME}`,
    ``,
    `## Task`,
    task.description || task.prompt || task.title || "",
  ];
  return parts.join("\n");
}

function extractAgentTextFromTurn(turn, fallback) {
  const chunks = [];
  for (const item of turn?.items || []) {
    if (item?.type === "agentMessage" && item.text) chunks.push(item.text);
  }
  return chunks.join("\n\n").trim() || fallback.trim();
}

async function runTurn(client, threadId, task) {
  const inputText = taskPrompt(task);
  const result = await client.request("turn/start", {
    threadId,
    clientUserMessageId: `maf-${task.id || task.task_id || Date.now()}`,
    input: [{ type: "text", text: inputText, text_elements: [] }],
    cwd: task.project_path || PROJECT_DIR,
    approvalPolicy: "never",
  }, 30_000);

  const turnId = result?.turn?.id;
  if (!turnId) throw new Error("turn/start did not return a turn id");
  let text = extractAgentTextFromTurn(result.turn, "");
  if (result.turn?.status === "completed") return text || "Codex turn completed with no assistant text";

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Codex attached turn timeout (${TASK_TIMEOUT_MS}ms)`));
    }, TASK_TIMEOUT_MS);
    const onNotification = msg => {
      const p = msg.params || {};
      if (p.threadId && p.threadId !== threadId) return;
      if (p.turnId && p.turnId !== turnId) return;
      if (msg.method === "item/agentMessage/delta" && p.delta) {
        text += p.delta;
      } else if (msg.method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) {
        text = p.item.text;
      } else if (msg.method === "turn/completed") {
        cleanup();
        resolve(extractAgentTextFromTurn(p.turn, text) || "Codex turn completed with no assistant text");
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off("notification", onNotification);
    };
    client.on("notification", onNotification);
  });
}

async function registerAgent() {
  if (!AGENT_NAME) throw new Error("MAF_AGENT_NAME or MAF_CODEX_AGENT is required");
  await postJson(`${DAEMON_URL}/agents/connect`, {
    agent_name: AGENT_NAME,
    runtime: "codex",
    plugin_pid: process.pid,
    directory: PROJECT_DIR,
  });
  log(`attached receiver registered: agent=${AGENT_NAME} pid=${process.pid} project=${PROJECT_DIR}`);
}

async function disconnectAgent() {
  if (!AGENT_NAME) return;
  try {
    await postJson(`${DAEMON_URL}/agents/disconnect`, {
      agent_name: AGENT_NAME,
      plugin_pid: process.pid,
    }, 3000);
  } catch {}
}

async function reportDone(task, status, result, durationMs) {
  await postJson(`${DAEMON_URL}/tasks/done`, {
    agent_name: AGENT_NAME,
    task_id: task.id || task.task_id,
    status,
    result,
    duration_ms: durationMs,
  });
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.on("exit", () => removePidFile());

async function main() {
  writePidFile();
  const client = new CodexAppServerClient({ url: APP_SERVER_URL, command: APP_SERVER_CMD });
  await client.connect();
  const init = await client.initialize();
  log(`app-server initialized: ${JSON.stringify(init)}`);
  const threadId = await resolveThreadId(client);
  log(`attached receiver bound to thread=${threadId}`);
  await registerAgent();

  while (!stopping) {
    let data;
    try {
      data = await getJson(`${DAEMON_URL}/tasks/wait?agent=${encodeURIComponent(AGENT_NAME)}`, WAIT_TIMEOUT_MS + 5000);
    } catch (err) {
      log(`tasks/wait failed: ${err.message}`);
      await sleep(1000);
      continue;
    }
    const task = data?.task;
    if (!task) continue;

    const started = Date.now();
    try {
      log(`attached task received: ${task.id} ${task.title || ""}`);
      const output = await runTurn(client, threadId, task);
      await reportDone(task, "completed", output, Date.now() - started);
      log(`attached task completed: ${task.id}`);
    } catch (err) {
      const msg = `Codex attached receiver failed: ${err.message}`;
      log(`${msg}\n${err.stack || ""}`);
      try { await reportDone(task, "failed", msg, Date.now() - started); } catch (reportErr) { log(`report failed: ${reportErr.message}`); }
    }
  }

  await disconnectAgent();
  client.close();
}

main().catch(async err => {
  log(`fatal: ${err.message}\n${err.stack || ""}`);
  await disconnectAgent();
  process.exit(1);
});
