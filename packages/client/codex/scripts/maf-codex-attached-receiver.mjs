#!/usr/bin/env node
/**
 * MAF Codex attached receiver (experimental).
 *
 * Bridges MAF Node Daemon attached-task delivery to a Codex app-server thread.
 * This is not the detached screen executor. It only marks a client Codex agent
 * online when this receiver is running and connected to a specific app-server
 * thread. Meta-Agent-Server is a Server control-plane identity and uses this
 * receiver only for workflow result notifications, not Client Agent registration.
 *
 * Required for real current-TUI usage:
 *   1. Start a Codex app-server endpoint, e.g. `codex app-server --listen ws://127.0.0.1:47891`.
 *   2. Start/attach the TUI to that app-server, e.g. `codex --remote ws://127.0.0.1:47891`.
 *   3. Run this receiver with MAF_CODEX_APP_SERVER_URL and optionally MAF_CODEX_THREAD_ID.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { HOME, MAF_HOME, processAlive, sleep } from "./maf-codex-common.mjs";

const NODE_PORT = parseInt(process.env.MAF_NODE_PORT || "4100", 10) || 4100;
const DAEMON_URL = process.env.MAF_DAEMON_URL || `http://127.0.0.1:${NODE_PORT}`;
const AGENT_NAME = process.env.MAF_AGENT_NAME || process.env.MAF_CODEX_AGENT || "";
const PROJECT_DIR = resolve((process.env.MAF_DIRECTORY || process.env.CODEX_CWD || process.cwd()).replace(/^~/, HOME));
const APP_SERVER_URL = process.env.MAF_CODEX_APP_SERVER_URL || "";
const APP_SERVER_CMD = process.env.MAF_CODEX_APP_SERVER_CMD || "";
const THREAD_ID_ENV = process.env.MAF_CODEX_THREAD_ID || "";
const TASK_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_ATTACHED_TASK_TIMEOUT_MS || "0", 10) || 10 * 60 * 1000;
const WAIT_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_ATTACHED_WAIT_TIMEOUT_MS || "0", 10) || 15_000;
const LOG_DIR = join(MAF_HOME, "logs");
const LOG_FILE = join(LOG_DIR, "codex-plugin.log");
const PID_FILE = process.env.MAF_CODEX_RECEIVER_PID_FILE || "";
const THREAD_WAIT_MS = parseInt(process.env.MAF_CODEX_THREAD_WAIT_MS || "0", 10) || 120_000;
const THREAD_POLL_MS = parseInt(process.env.MAF_CODEX_THREAD_POLL_MS || "0", 10) || 1000;
const TURN_POLL_MS = parseInt(process.env.MAF_CODEX_TURN_POLL_MS || "0", 10) || 1000;
const TURN_READ_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_TURN_READ_TIMEOUT_MS || "0", 10) || 10_000;
const NOTIFY_TURN_TIMEOUT_MS = parseInt(process.env.MAF_CODEX_NOTIFY_TURN_TIMEOUT_MS || "0", 10) || 10_000;
const SESSION_PID = parseInt(process.env.MAF_CODEX_SESSION_PID || "0", 10) || 0;
const NOTIFY_ACK = process.env.MAF_CODEX_NOTIFY_ACK === "1";
const NOTIFY_WORKFLOWS = process.env.MAF_CODEX_NOTIFY_WORKFLOWS !== "0";
const NOTIFY_WAIT = process.env.MAF_CODEX_NOTIFY_WAIT === "1";
const SERVER_AGENT_NAME = "Meta-Agent-Server";
const IS_SERVER_IDENTITY = AGENT_NAME === SERVER_AGENT_NAME;

function log(msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [codex-attached-receiver] ${msg}\n`);
  } catch {}
}

function sessionStillAlive() {
  return !SESSION_PID || processAlive(SESSION_PID);
}

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

const pendingNotifications = [];
const recentCompletedTasks = new Map(); // workflow_id → { task_id, node_id, status, at }
const ackedWorkflowIds = new Set();
const notifiedWorkflowIds = new Set();
let currentTaskExecuting = false;
let injectingNotification = false;
let sseAbortController = null;

function rememberCompletedTask(task, status) {
  const workflowId = task?.workflow_id || "";
  if (!workflowId) return;
  const now = Date.now();
  recentCompletedTasks.set(workflowId, {
    task_id: task.id || task.task_id || "",
    workflow_id: workflowId,
    node_id: task.node_id || "",
    status,
    at: now,
  });
  for (const [id, info] of recentCompletedTasks) {
    if (now - info.at > 10 * 60_000) recentCompletedTasks.delete(id);
  }
}

function buildTaskAckNotification(task, status, reportAck = {}) {
  const reported = reportAck?.workflow_reported !== false;
  const footer = reported
    ? "结果已成功回传 MAF Server。"
    : `结果已提交给本机 Daemon，但 Daemon 回传 MAF Server 未确认${reportAck?.workflow_error ? `：${reportAck.workflow_error}` : "。"}`
  return [
    "[MAF 任务回报完成]",
    "",
    `task_id: ${task.id || task.task_id || ""}`,
    `workflow_id: ${task.workflow_id || ""}`,
    `node_id: ${task.node_id || ""}`,
    `status: ${status}`,
    `workflow_reported: ${reported ? "true" : "false"}`,
    "",
    footer,
  ].join("\n");
}

function payloadFromSseEvent(evt) {
  return evt?.data?.data || evt?.data || {};
}

function buildWorkflowNotification(payload) {
  const title = payload.title || payload.workflow_title || payload.workflow_id || "MAF Workflow";
  const status = payload.status || "completed";
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const parts = [
    "[MAF 后台任务结果通知]",
    "",
    `Workflow: ${title}`,
    `状态: ${status}`,
  ];
  if (payload.workflow_id) parts.push(`workflow_id: ${payload.workflow_id}`);
  parts.push("", "节点结果：");
  if (nodes.length === 0) {
    parts.push("", payload.reason ? `失败原因: ${payload.reason}` : "无节点结果");
  } else {
    for (const node of nodes) {
      parts.push("");
      parts.push(`## ${node.agent_name || "-"} / ${node.id || "-"}`);
      parts.push(`状态: ${node.status || "-"}`);
      parts.push("");
      parts.push(node.result || "无输出");
    }
  }
  return parts.join("\n");
}

function shouldNotifyWorkflow(payload, threadId) {
  if (!NOTIFY_WORKFLOWS) return false;
  const workflowId = payload?.workflow_id || "";
  if (!workflowId || notifiedWorkflowIds.has(workflowId)) return false;
  if (recentCompletedTasks.has(workflowId)) return false; // 执行方已通过 ACK 通知

  const origin = payload.origin || {};
  if (origin.agent_name === AGENT_NAME) {
    const originThread = origin.thread_id || origin.threadId || "";
    if (!originThread || originThread === threadId) return true;
  }

  // 与 opencode 保持一致：管理者会话接收完整后台 workflow 结果。
  return IS_SERVER_IDENTITY;
}

function buildNotificationTurnPrompt(text) {
  const prefix = process.env.MAF_CODEX_NOTIFY_PROMPT_PREFIX;
  const effectivePrefix = prefix == null ? "MAF 通知，请原样回显：" : String(prefix);
  return [effectivePrefix.trim(), "", text].filter(Boolean).join("\n");
}

function enqueueNotification(text, key = "") {
  if (!text) return;
  if (key) {
    if (notifiedWorkflowIds.has(key)) return;
    notifiedWorkflowIds.add(key);
  }
  pendingNotifications.push(text);
}

async function injectPendingNotifications(client, threadId) {
  if (currentTaskExecuting || injectingNotification || pendingNotifications.length === 0) return;
  injectingNotification = true;
  const items = pendingNotifications.splice(0, pendingNotifications.length);
  let turnStarted = false;
  try {
    const text = items.join("\n\n---\n\n");
    log(`injecting ${items.length} MAF notification(s) into Codex thread=${threadId}`);
    const started = await client.request("turn/start", {
      threadId,
      clientUserMessageId: `maf-notify-${Date.now()}`,
      input: [{
        type: "text",
        text: buildNotificationTurnPrompt(text),
        text_elements: [],
      }],
      cwd: PROJECT_DIR,
      approvalPolicy: "never",
    }, 30_000);
    turnStarted = true;
    const turnId = started?.turn?.id || "";
    const status = started?.turn?.status || "";
    log(`notification turn/start returned: turn=${turnId || "unknown"} status=${status || "unknown"}`);
    if (NOTIFY_WAIT && turnId && status !== "completed") {
      await waitForNotificationTurn(client, threadId, turnId, text, NOTIFY_TURN_TIMEOUT_MS);
    } else if (turnId && status !== "completed") {
      log(`notification turn fire-and-forget: turn=${turnId} wait=${NOTIFY_WAIT ? "1" : "0"}`);
    }
  } catch (err) {
    log(`notification injection failed: ${err.message}`);
    // 如果 turn 已经启动，就不要 requeue，否则会重复向 TUI 注入通知并造成连续 working。
    if (!turnStarted) pendingNotifications.unshift(...items);
  } finally {
    injectingNotification = false;
  }
}

async function waitForNotificationTurn(client, threadId, turnId, fallbackText, timeoutMs) {
  return await new Promise((resolve) => {
    let done = false;
    let text = fallbackText || "";
    let pollTimer = null;
    let lastPollStatus = "";
    let lastPollError = "";

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      client.off("notification", onNotification);
    };

    const finish = (source, status = "completed") => {
      if (done) return;
      done = true;
      cleanup();
      log(`notification turn ${status}: source=${source} turn=${turnId} chars=${String(text || "").length}`);
      resolve({ status, text });
    };

    const timer = setTimeout(() => {
      finish("timeout", "timeout");
    }, timeoutMs);

    const onNotification = msg => {
      const p = msg.params || {};
      if (p.threadId && p.threadId !== threadId) return;
      const msgTurnId = p.turnId || p.turn?.id || "";
      if (msgTurnId && msgTurnId !== turnId) return;
      if (msg.method === "item/agentMessage/delta" && p.delta) {
        text += p.delta;
      } else if (msg.method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) {
        text = p.item.text;
      } else if (msg.method === "turn/completed") {
        if (isTerminalFailedTurn(p.turn)) {
          text = turnErrorMessage(p.turn) || text;
          finish("notification", turnStatusValue(p.turn) || "failed");
        } else {
          text = extractAgentTextFromTurn(p.turn, text);
          finish("notification", "completed");
        }
      }
    };

    const poll = async () => {
      if (done) return;
      try {
        const readResult = await client.request("thread/read", { threadId, includeTurns: true }, TURN_READ_TIMEOUT_MS);
        const observed = observeThreadTurn(readResult, turnId, text);
        if (observed.text) text = observed.text;
        const statusForLog = observed.found
          ? `${observed.status || "unknown"} chars=${String(text || "").length}`
          : `missing threadStatus=${observed.threadStatus || "unknown"}`;
        if (statusForLog !== lastPollStatus) {
          lastPollStatus = statusForLog;
          log(`notification turn poll observed: turn=${turnId} ${statusForLog}`);
        }
        if (isCompletedTurn(observed.turn)) {
          finish("poll", "completed");
          return;
        }
        if (isTerminalFailedTurn(observed.turn)) {
          finish("poll", turnStatusValue(observed.turn) || "failed");
          return;
        }
      } catch (err) {
        if (err.message !== lastPollError) {
          lastPollError = err.message;
          log(`notification turn poll read failed: turn=${turnId} ${err.message}`);
        }
      }
      if (!done) pollTimer = setTimeout(poll, TURN_POLL_MS);
    };

    client.on("notification", onNotification);
    pollTimer = setTimeout(poll, TURN_POLL_MS);
  });
}

async function getMafServerUrl() {
  if (process.env.META_AGENT_SERVER) return process.env.META_AGENT_SERVER.replace(/\/$/, "");
  try {
    const data = await getJson(`${DAEMON_URL}/health`, 3000);
    if (data?.server) return String(data.server).replace(/\/$/, "");
  } catch {}
  return "";
}

function parseSseEvent(raw) {
  const lines = String(raw || "").split("\n");
  let type = "";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) type = line.slice(7);
    if (line.startsWith("data: ")) data += line.slice(6);
  }
  try { return { type, data: data ? JSON.parse(data) : null }; }
  catch { return { type, data: null }; }
}

async function handleWorkflowEvent(evt, client, threadId) {
  if (!evt?.type || !evt?.data) return;
  if (evt.type !== "workflow_completed" && evt.type !== "workflow_failed") return;
  const payload = payloadFromSseEvent(evt);
  const workflowId = payload.workflow_id || "";
  if (!workflowId || !shouldNotifyWorkflow(payload, threadId)) return;
  enqueueNotification(buildWorkflowNotification(payload), workflowId);
  await injectPendingNotifications(client, threadId);
}

async function subscribeWorkflowEvents(client, threadId) {
  const serverUrl = await getMafServerUrl();
  if (!serverUrl) {
    log("workflow SSE skipped: MAF Server URL unknown");
    return;
  }
  if (sseAbortController) return;
  sseAbortController = new AbortController();
  log(`subscribing workflow SSE: ${serverUrl}/api/events`);
  try {
    const res = await fetch(`${serverUrl}/api/events`, {
      signal: sseAbortController.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!stopping) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const raw of chunks) {
        const evt = parseSseEvent(raw);
        await handleWorkflowEvent(evt, client, threadId);
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") log(`workflow SSE disconnected: ${err.message}`);
  } finally {
    sseAbortController = null;
    if (!stopping) setTimeout(() => subscribeWorkflowEvents(client, threadId).catch(e => log(`workflow SSE restart failed: ${e.message}`)), 10_000);
  }
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

function turnErrorMessage(turn) {
  const err = turn?.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function normalizeTurnStatus(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const candidate = value.type ?? value.status ?? value.state ?? value.kind ?? value.value;
    return candidate == null ? "" : String(candidate).trim();
  }
  return String(value).trim();
}

function turnStatusValue(turn) {
  return normalizeTurnStatus(turn?.status);
}

function isCompletedTurn(turn) {
  return turnStatusValue(turn) === "completed" || turn?.completedAt != null;
}

function isTerminalFailedTurn(turn) {
  const status = turnStatusValue(turn);
  return status === "failed" || status === "interrupted" || status === "cancelled" || status === "canceled";
}

function observeThreadTurn(readResult, turnId, fallbackText) {
  const thread = readResult?.thread || readResult;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const turn = turns.find(t => t?.id === turnId);
  if (!turn) {
    return {
      found: false,
      status: "",
      text: fallbackText.trim(),
      turn: null,
      threadStatus: normalizeTurnStatus(thread?.status),
    };
  }
  return {
    found: true,
    status: turnStatusValue(turn),
    text: extractAgentTextFromTurn(turn, fallbackText),
    turn,
    threadStatus: normalizeTurnStatus(thread?.status),
  };
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
  const startStatus = turnStatusValue(result.turn);
  log(`turn/start returned: task=${task.id || task.task_id || ""} turn=${turnId} status=${startStatus || "unknown"}`);
  if (isCompletedTurn(result.turn)) {
    log(`turn already completed from start response: turn=${turnId} chars=${text.length}`);
    return text || "Codex turn completed with no assistant text";
  }
  if (isTerminalFailedTurn(result.turn)) {
    throw new Error(`Codex turn ${startStatus || "unknown"}: ${turnErrorMessage(result.turn) || "no error detail"}`);
  }

  return await new Promise((resolve, reject) => {
    let done = false;
    let lastPollStatus = "";
    let lastPollError = "";
    let pollTimer = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Codex attached turn timeout (${TASK_TIMEOUT_MS}ms)`));
    }, TASK_TIMEOUT_MS);

    const finishOk = (source, output) => {
      if (done) return;
      done = true;
      const finalText = (output || "").trim() || "Codex turn completed with no assistant text";
      cleanup();
      log(`turn ${source} completed: turn=${turnId} chars=${finalText.length}`);
      resolve(finalText);
    };

    const finishErr = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const onNotification = msg => {
      const p = msg.params || {};
      if (p.threadId && p.threadId !== threadId) return;
      const msgTurnId = p.turnId || p.turn?.id || "";
      if (msgTurnId && msgTurnId !== turnId) return;
      if (msg.method === "item/agentMessage/delta" && p.delta) {
        text += p.delta;
      } else if (msg.method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) {
        text = p.item.text;
      } else if (msg.method === "turn/completed") {
        if (isTerminalFailedTurn(p.turn)) {
          finishErr(new Error(`Codex turn ${turnStatusValue(p.turn) || "unknown"}: ${turnErrorMessage(p.turn) || "no error detail"}`));
        } else {
          finishOk("notification", extractAgentTextFromTurn(p.turn, text));
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      client.off("notification", onNotification);
    };

    const poll = async () => {
      if (done) return;
      try {
        const readResult = await client.request("thread/read", { threadId, includeTurns: true }, TURN_READ_TIMEOUT_MS);
        const observed = observeThreadTurn(readResult, turnId, text);
        if (observed.text) text = observed.text;
        const statusForLog = observed.found
          ? `${observed.status || "unknown"} chars=${text.length}`
          : `missing threadStatus=${observed.threadStatus || "unknown"}`;
        if (statusForLog !== lastPollStatus) {
          lastPollStatus = statusForLog;
          log(`turn poll observed: turn=${turnId} ${statusForLog}`);
        }
        if (isCompletedTurn(observed.turn)) {
          finishOk("poll", observed.text);
          return;
        }
        if (isTerminalFailedTurn(observed.turn)) {
          finishErr(new Error(`Codex turn ${turnStatusValue(observed.turn) || "unknown"}: ${turnErrorMessage(observed.turn) || "no error detail"}`));
          return;
        }
      } catch (err) {
        if (err.message !== lastPollError) {
          lastPollError = err.message;
          log(`turn poll read failed: turn=${turnId} ${err.message}`);
        }
      }
      if (!done) pollTimer = setTimeout(poll, TURN_POLL_MS);
    };

    client.on("notification", onNotification);
    pollTimer = setTimeout(poll, TURN_POLL_MS);
  });
}

async function registerAgent() {
  if (!AGENT_NAME) throw new Error("MAF_AGENT_NAME or MAF_CODEX_AGENT is required");
  if (IS_SERVER_IDENTITY) {
    log(`${SERVER_AGENT_NAME} is a Server control-plane identity; skip Client Agent registration`);
    return;
  }
  await postJson(`${DAEMON_URL}/agents/connect`, {
    agent_name: AGENT_NAME,
    runtime: "codex",
    plugin_pid: process.pid,
    directory: PROJECT_DIR,
  });
  log(`attached receiver registered: agent=${AGENT_NAME} pid=${process.pid} project=${PROJECT_DIR}`);
}

let registered = false;
let lastRegisterAt = 0;

async function ensureRegistered(force = false) {
  const now = Date.now();
  if (IS_SERVER_IDENTITY && registered) return;
  if (!force && registered && now - lastRegisterAt < 5_000) return;
  await registerAgent();
  registered = true;
  lastRegisterAt = now;
}

async function disconnectAgent() {
  if (IS_SERVER_IDENTITY) return;
  if (!AGENT_NAME) return;
  try {
    await postJson(`${DAEMON_URL}/agents/disconnect`, {
      agent_name: AGENT_NAME,
      plugin_pid: process.pid,
    }, 3000);
    registered = false;
  } catch {}
}

async function reportDone(task, status, result, durationMs) {
  log(`reporting task result: task=${task.id || task.task_id || ""} status=${status} chars=${String(result || "").length} duration=${durationMs}ms`);
  const data = await postJson(`${DAEMON_URL}/tasks/done`, {
    agent_name: AGENT_NAME,
    task_id: task.id || task.task_id,
    status,
    result,
    duration_ms: durationMs,
  });
  log(`tasks/done ack: task=${task.id || task.task_id || ""} status=${status} ack=${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.on("exit", () => removePidFile());

async function main() {
  writePidFile();
  const client = new CodexAppServerClient({ url: APP_SERVER_URL, command: APP_SERVER_CMD });
  let sessionTimer = null;
  await client.connect();
  const init = await client.initialize();
  log(`app-server initialized: ${JSON.stringify(init)}`);
  const threadId = await resolveThreadId(client);
  log(`attached receiver bound to thread=${threadId}`);
  await ensureRegistered(true);
  if (IS_SERVER_IDENTITY) {
    log(`${SERVER_AGENT_NAME} notification-only mode: skip /tasks/wait and Agent board presence`);
  }
  subscribeWorkflowEvents(client, threadId).catch(err => log(`workflow SSE start failed: ${err.message}`));
  if (SESSION_PID) {
    log(`attached receiver follows Codex session pid=${SESSION_PID}`);
    sessionTimer = setInterval(() => {
      if (!sessionStillAlive()) {
        log(`Codex session pid=${SESSION_PID} exited; stopping attached receiver`);
        stopping = true;
      }
    }, 1000);
    sessionTimer.unref?.();
  }

  while (!stopping && !client.closed) {
    if (!sessionStillAlive()) {
      log(`Codex session pid=${SESSION_PID} exited; stopping attached receiver`);
      break;
    }
    try { await ensureRegistered(); } catch (err) { log(`receiver re-register failed: ${err.message}`); }
    await injectPendingNotifications(client, threadId);
    if (IS_SERVER_IDENTITY) {
      await sleep(1000);
      continue;
    }
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
    currentTaskExecuting = true;
    try {
      log(`attached task received: ${task.id} ${task.title || ""}`);
      const output = await runTurn(client, threadId, task);
      const reportAck = await reportDone(task, "completed", output, Date.now() - started);
      rememberCompletedTask(task, "completed");
      if (NOTIFY_ACK && task.workflow_id && !ackedWorkflowIds.has(task.workflow_id)) {
        ackedWorkflowIds.add(task.workflow_id);
        enqueueNotification(buildTaskAckNotification(task, "completed", reportAck));
      }
      log(`attached task completed: ${task.id}`);
    } catch (err) {
      const msg = `Codex attached receiver failed: ${err.message}`;
      log(`${msg}\n${err.stack || ""}`);
      try {
        const reportAck = await reportDone(task, "failed", msg, Date.now() - started);
        rememberCompletedTask(task, "failed");
        if (NOTIFY_ACK && task.workflow_id && !ackedWorkflowIds.has(task.workflow_id)) {
          ackedWorkflowIds.add(task.workflow_id);
          enqueueNotification(buildTaskAckNotification(task, "failed", reportAck));
        }
      } catch (reportErr) { log(`report failed: ${reportErr.message}`); }
    } finally {
      currentTaskExecuting = false;
      await injectPendingNotifications(client, threadId);
    }
  }

  if (sessionTimer) clearInterval(sessionTimer);
  try { sseAbortController?.abort(); } catch {}
  await disconnectAgent();
  client.close();
}

main().catch(async err => {
  log(`fatal: ${err.message}\n${err.stack || ""}`);
  await disconnectAgent();
  process.exit(1);
});
