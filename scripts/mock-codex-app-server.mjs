#!/usr/bin/env node
/** Minimal JSON-RPC mock for maf-codex-attached-receiver e2e.
 * Supports line-delimited stdio and a tiny websocket listener used by Codex
 * wrapper auto-remote tests.
 */
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const THREAD_ID = process.env.MOCK_CODEX_THREAD_ID || "mock-thread-1";
const NO_TURN_COMPLETED = process.env.MOCK_CODEX_NO_TURN_COMPLETED === "1" || process.env.MOCK_CODEX_NO_TURN_COMPLETED === "true";
const NO_AGENT_DELTA = process.env.MOCK_CODEX_NO_AGENT_DELTA === "1" || process.env.MOCK_CODEX_NO_AGENT_DELTA === "true";
const TURN_STATUS_OBJECT = process.env.MOCK_CODEX_TURN_STATUS_OBJECT === "1" || process.env.MOCK_CODEX_TURN_STATUS_OBJECT === "true";
const REQUIRE_WORKSPACE_WRITE = process.env.MOCK_CODEX_REQUIRE_WORKSPACE_WRITE === "1" || process.env.MOCK_CODEX_REQUIRE_WORKSPACE_WRITE === "true";
const TURN_DELAY_MS = parseInt(process.env.MOCK_CODEX_TURN_DELAY_MS || "0", 10) || 50;
let nextTurn = 0;
const turns = [];

function normalizeTurnStatus(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return String(value.type || value.status || value.state || "");
  return String(value);
}

function turnStatus(value) {
  return TURN_STATUS_OBJECT ? { type: value } : value;
}

function mockThread() {
  return {
    id: THREAD_ID,
    sessionId: "mock-session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "mock codex app-server thread",
    ephemeral: false,
    modelProvider: "mock",
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    recencyAt: Date.now() / 1000,
    status: { type: turns.some(t => normalizeTurnStatus(t.status) === "inProgress") ? "active" : "idle", activeFlags: [] },
    path: null,
    cwd: process.cwd(),
    cliVersion: "mock",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "mock-thread",
    turns,
  };
}

function responseFor(msg, send) {
  const { id, method, params = {} } = msg;
  if (process.env.MOCK_CODEX_RPC_LOG && method) {
    try { appendFileSync(process.env.MOCK_CODEX_RPC_LOG, `${method}\n`); } catch {}
  }
  if (method === "initialize") {
    send({ id, result: { userAgent: "mock-codex-app-server/0", codexHome: "/tmp/mock-codex-home", platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (method === "initialized") return;
  if (method === "thread/start") {
    send({ id, result: {
      thread: mockThread(),
      model: params.model || "mock-model",
      modelProvider: "mock",
      serviceTier: null,
      cwd: params.cwd || process.cwd(),
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots || [],
      instructionSources: [],
      approvalPolicy: params.approvalPolicy || "never",
      approvalsReviewer: { type: "user" },
      sandbox: params.sandbox || { type: "dangerFullAccess" },
      activePermissionProfile: null,
      reasoningEffort: null,
      multiAgentMode: "explicitRequestOnly",
    } });
    return;
  }
  if (method === "thread/resume") {
    send({ id, result: {
      thread: mockThread(),
      model: params.model || "mock-model",
      modelProvider: "mock",
      serviceTier: null,
      cwd: params.cwd || process.cwd(),
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots || [],
      instructionSources: [],
      approvalPolicy: params.approvalPolicy || "never",
      approvalsReviewer: { type: "user" },
      sandbox: params.sandbox || { type: "dangerFullAccess" },
      activePermissionProfile: null,
      reasoningEffort: null,
      multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    } });
    return;
  }
  if (method === "thread/loaded/list") {
    send({ id, result: { data: [THREAD_ID], nextCursor: null } });
    return;
  }
  if (method === "thread/read") {
    send({ id, result: { thread: mockThread() } });
    return;
  }
  if (method === "turn/start") {
    const writableRoots = Array.isArray(params.sandboxPolicy?.writableRoots)
      ? params.sandboxPolicy.writableRoots
      : [];
    if (REQUIRE_WORKSPACE_WRITE && (
      params.approvalPolicy !== "never"
      || params.sandboxPolicy?.type !== "workspaceWrite"
      || params.sandboxPolicy?.networkAccess !== true
      || !writableRoots.includes(params.cwd)
    )) {
      send({ id, error: { code: -32602, message: "turn/start requires never + workspaceWrite/networkAccess for cwd" } });
      return;
    }
    const turnId = `mock-turn-${++nextTurn}`;
    const prompt = (params.input || []).map(i => i.text || "").join("\n");
    if (prompt.includes("MAF_E2E_MANAGED_EXECUTION") && process.env.MAF_SOURCE_DIR) {
      const sourceDir = process.env.MAF_SOURCE_DIR;
      writeFileSync(`${sourceDir}/source.txt`, "changed by generic managed execution\n");
      if (process.env.MAF_OUTPUT_DIR) {
        mkdirSync(process.env.MAF_OUTPUT_DIR, { recursive: true });
        writeFileSync(`${process.env.MAF_OUTPUT_DIR}/agent-output.txt`, "artifact consumed\n");
      }
      execFileSync("git", ["-C", sourceDir, "config", "user.name", "MAF E2E"]);
      execFileSync("git", ["-C", sourceDir, "config", "user.email", "maf-e2e@local"]);
      execFileSync("git", ["-C", sourceDir, "add", "source.txt"]);
      execFileSync("git", ["-C", sourceDir, "commit", "-m", "Managed app-server execution\n\nChange-Id: I1111111111111111111111111111111111111111"]);
    }
    if (process.env.MOCK_CODEX_TURN_LOG) {
      try {
        appendFileSync(process.env.MOCK_CODEX_TURN_LOG, `--- turn ${turnId} ---\n${prompt}\n`);
      } catch {}
    }
    const match = prompt.match(/Codex attached e2e task:[^\n]*/i);
    const notice = prompt.match(/\[(?:MAF 任务回报完成|MAF 后台任务结果通知)\][\s\S]*/);
    const text = notice ? notice[0] : `mock attached codex completed: ${match ? match[0] : "no prompt match"}`;
    const delayMs = prompt.includes("MAF_E2E_SLOW_TURN")
      ? (parseInt(process.env.MOCK_CODEX_SLOW_TURN_DELAY_MS || "0", 10) || 2000)
      : TURN_DELAY_MS;
    const startedAt = Date.now() / 1000;
    const turn = {
      id: turnId,
      items: [{ type: "userMessage", id: `user-${turnId}`, text: prompt }],
      itemsView: "all",
      status: turnStatus("inProgress"),
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    };
    turns.push(turn);
    send({ id, result: { turn: { ...turn } } });
    setTimeout(() => {
      if (normalizeTurnStatus(turn.status) !== "inProgress") return;
      const agentItem = { type: "agentMessage", id: `agent-${turnId}`, text, phase: null, memoryCitation: null };
      turn.items.push(agentItem);
      turn.status = turnStatus("completed");
      turn.completedAt = Date.now() / 1000;
      turn.durationMs = 10;
      if (!NO_AGENT_DELTA) {
        send({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId, itemId: "agent-1", delta: text } });
      }
      send({ method: "item/completed", params: { threadId: THREAD_ID, turnId, item: { ...agentItem } } });
      if (!NO_TURN_COMPLETED) {
        send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { ...turn, items: [...turn.items] } } });
      }
    }, delayMs);
    return;
  }
  if (method === "turn/interrupt") {
    const turn = turns.find(item => item.id === params.turnId);
    if (turn) {
      turn.status = turnStatus("interrupted");
      turn.completedAt = Date.now() / 1000;
      turn.durationMs = 10;
      send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { ...turn, items: [...turn.items] } } });
    }
    send({ id, result: {} });
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
}

function runStdio() {
  const rl = createInterface({ input: process.stdin });
  const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");
  rl.on("line", line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    responseFor(msg, send);
  });
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload]);
  if (len < 65536) {
    const head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([head, payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = Boolean(b1 & 0x80);
    let len = b1 & 0x7f;
    let header = 2;
    if (len === 126) {
      if (buffer.length - offset < 4) break;
      len = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (len === 127) {
      if (buffer.length - offset < 10) break;
      len = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    const maskBytes = masked ? 4 : 0;
    if (buffer.length - offset < header + maskBytes + len) break;
    let payload = buffer.subarray(offset + header + maskBytes, offset + header + maskBytes + len);
    if (masked) {
      const mask = buffer.subarray(offset + header, offset + header + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    }
    offset += header + maskBytes + len;
    if (opcode === 0x8) messages.push({ close: true });
    else if (opcode === 0x1) messages.push({ text: payload.toString("utf-8") });
  }
  return { messages, rest: buffer.subarray(offset) };
}

function runListen(url) {
  const u = new URL(url);
  const port = Number(u.port);
  const host = u.hostname || "127.0.0.1";
  const server = createServer((req, res) => {
    if (req.url === "/readyz" || req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mock: true }));
      return;
    }
    res.writeHead(404); res.end("not found");
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    const send = obj => socket.write(encodeFrame(JSON.stringify(obj)));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const msg of decoded.messages) {
        if (msg.close) { socket.end(); continue; }
        if (!msg.text?.trim()) continue;
        try { responseFor(JSON.parse(msg.text), send); } catch {}
      }
    });
  });
  server.listen(port, host, () => {
    process.stderr.write(`mock codex app-server listening on ${url}\n`);
  });
}

const args = process.argv.slice(2);
const listenIdx = args.indexOf("--listen");
if (listenIdx >= 0 && args[listenIdx + 1]) runListen(args[listenIdx + 1]);
else runStdio();
