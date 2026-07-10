#!/usr/bin/env node
/** Minimal line-delimited JSON-RPC mock for maf-codex-attached-receiver e2e. */
import { createInterface } from "node:readline";

const THREAD_ID = process.env.MOCK_CODEX_THREAD_ID || "mock-thread-1";
const rl = createInterface({ input: process.stdin });
let nextTurn = 0;

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

rl.on("line", line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === "initialize") {
    send({ id, result: { userAgent: "mock-codex-app-server/0", codexHome: "/tmp/mock-codex-home", platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (method === "initialized") return;
  if (method === "thread/loaded/list") {
    send({ id, result: { data: [THREAD_ID], nextCursor: null } });
    return;
  }
  if (method === "turn/start") {
    const turnId = `mock-turn-${++nextTurn}`;
    const prompt = (params.input || []).map(i => i.text || "").join("\n");
    const match = prompt.match(/Codex attached e2e task:[^\n]*/i);
    const text = `mock attached codex completed: ${match ? match[0] : "no prompt match"}`;
    send({ id, result: { turn: { id: turnId, items: [], itemsView: "all", status: "inProgress", error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null } } });
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId, itemId: "agent-1", delta: text } });
      send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: turnId, items: [{ type: "agentMessage", id: "agent-1", text, phase: null, memoryCitation: null }], itemsView: "all", status: "completed", error: null, startedAt: Date.now() / 1000, completedAt: Date.now() / 1000, durationMs: 10 } } });
    }, 50);
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});
