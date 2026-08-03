#!/usr/bin/env node
/**
 * Mock Opencode — 模拟 opencode 加载 Plugin 的行为
 *
 * 用法：node scripts/mock-opencode.mjs [agent_name]
 *
 * 行为：
 *   1. 启动 mini HTTP server（模拟 opencode HTTP API，端口 4096）
 *   2. 加载 Plugin（调用 MetaAgentBridge）
 *   3. 触发 chat.message hook（模拟用户选择 agent）
 *   4. 保持运行（Plugin 定时器持续检查 Daemon）
 *   5. Ctrl+C 退出
 */

import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const AGENT_NAME = process.argv[2] || "mock-agent";
const MOCK_PORT = parseInt(process.env.MOCK_OPENCODE_PORT || "4096");
const PLUGIN_DIR = process.env.MOCK_PLUGIN_DIR ||
  join(homedir(), ".config", "opencode", "plugins", "opencode-plugin-meta-agent-framework");

console.log(`[mock-opencode] agent=${AGENT_NAME} port=${MOCK_PORT}`);
console.log(`[mock-opencode] plugin=${PLUGIN_DIR}`);

// ============================================================
// 模拟 opencode HTTP API（mini server）
// ============================================================
const sessions = new Map();
let sessionCounter = 0;
let messageMode = process.env.MOCK_OPENCODE_MESSAGE_MODE || "success";
let pluginHooks = null;

const apiServer = createServer(async (req, res) => {
  const json = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // POST /session — 创建 session
  if (req.method === "POST" && req.url === "/session") {
    const id = `ses_mock_${++sessionCounter}`;
    const messages = messageMode === "stale"
      ? [{ id: `old-${id}`, role: "assistant", parts: [{ type: "text", text: "stale assistant result" }] }]
      : [];
    sessions.set(id, { id, messages });
    json(200, { id });
    console.log(`[mock-opencode] 创建 session: ${id}`);
    return;
  }

  // POST /session/:id/message — 发送消息
  const msgMatch = req.url?.match(/^\/session\/([^/]+)\/message$/);
  if (req.method === "POST" && msgMatch) {
    const sid = msgMatch[1];
    const session = sessions.get(sid);
    if (!session) { json(404, { error: "session not found" }); return; }

    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    const content = payload.content || (payload.parts || []).filter(p => p.type === "text").map(p => p.text).join("");

    if (messageMode === "error") {
      json(500, { error: "mock message failure" });
      return;
    }

    // 模拟 assistant 回复
    session.messages.push({ id: `user-${Date.now()}`, role: "user", parts: [{ type: "text", text: content }] });
    if (messageMode === "success") {
      session.messages.push({ id: `assistant-${Date.now()}`, role: "assistant", parts: [{ type: "text", text: `[mock] 已收到: ${(content || "").substring(0, 50)}` }] });
    }
    json(200, { ok: true });
    console.log(`[mock-opencode] session ${sid} 收到消息: ${(content || "").substring(0, 60)}`);
    if (messageMode !== "timeout") {
      setTimeout(() => {
        pluginHooks?.event?.({ event: { type: "session.idle", properties: { sessionID: sid } } });
      }, 20);
    }
    return;
  }

  // GET /session/:id/message(s) — 读取消息
  const msgsMatch = req.url?.match(/^\/session\/([^/]+)\/messages?$/);
  if (req.method === "GET" && msgsMatch) {
    const sid = msgsMatch[1];
    const session = sessions.get(sid);
    if (!session) { json(404, { error: "session not found" }); return; }
    json(200, { data: session.messages });
    return;
  }

  if (req.method === "POST" && req.url === "/__mock/mode") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body || "{}");
    messageMode = String(data.mode || "success");
    if (messageMode === "stale") {
      for (const session of sessions.values()) {
        session.messages.push({
          id: `stale-${Date.now()}`,
          role: "assistant",
          parts: [{ type: "text", text: "stale assistant result" }],
        });
      }
    }
    json(200, { mode: messageMode });
    return;
  }

  // GET /session — 列出 sessions
  if (req.method === "GET" && req.url === "/session") {
    json(200, { data: Array.from(sessions.values()) });
    return;
  }

  json(404, { error: "not found" });
});

await new Promise((resolve) => {
  apiServer.listen(MOCK_PORT, "0.0.0.0", () => {
    console.log(`[mock-opencode] HTTP API 启动: http://0.0.0.0:${MOCK_PORT}`);
    resolve();
  });
});

// ============================================================
// 加载 Plugin
// ============================================================
const pluginPath = join(PLUGIN_DIR, "index.js");
const pluginUrl = pathToFileURL(pluginPath).href;
console.log(`[mock-opencode] 加载 Plugin: ${pluginPath}`);

const { MetaAgentBridge } = await import(pluginUrl);

// 模拟 opencode 传给 Plugin 的 context
// 使用一个非 meta-agent-framework 的目录，避免 Plugin 检测到 isMetaAgentServer 跳过
const mockDirectory = process.env.MOCK_DIRECTORY || "/tmp/mock-project";
import { mkdirSync } from "node:fs";
try { mkdirSync(mockDirectory, { recursive: true }); } catch {}

const hooks = await MetaAgentBridge({
  client: {
    _client: {
      getConfig: () => ({ baseUrl: `http://127.0.0.1:${MOCK_PORT}`, headers: {} }),
    },
    session: {
      list: async () => ({ data: Array.from(sessions.values()) }),
      get: async ({ path }) => ({ data: sessions.get(path.id) }),
      messages: async ({ path }) => ({ data: sessions.get(path.id)?.messages || [] }),
      create: async () => {
        const id = `ses_mock_${++sessionCounter}`;
        sessions.set(id, { id, messages: [] });
        return { data: { id } };
      },
    },
    app: { log: async () => {} },
  },
  serverUrl: new URL(`http://0.0.0.0:${MOCK_PORT}`),
  project: { id: "mock-project" },
  directory: mockDirectory,
});
pluginHooks = hooks;

console.log(`[mock-opencode] Plugin 加载完成，触发 hooks`);

// 触发 config hook
if (hooks.config) {
  const cfg = { server: {} };
  await hooks.config(cfg);
  console.log(`[mock-opencode] config hook: hostname=${cfg.server.hostname}`);
}

// 触发 chat.message hook（模拟用户选择 agent）
if (hooks["chat.message"]) {
  console.log(`[mock-opencode] 触发 chat.message: agent=${AGENT_NAME}`);
  await hooks["chat.message"]({ agent: AGENT_NAME }, {});
}

// 触发 shell.env hook
if (hooks["shell.env"]) {
  const env = { env: {} };
  await hooks["shell.env"]({}, env);
  console.log(`[mock-opencode] shell.env: ${JSON.stringify(env.env)}`);
}

console.log(`[mock-opencode] ✅ 运行中 (Ctrl+C 退出)`);
console.log(`[mock-opencode]   opencode API: http://0.0.0.0:${MOCK_PORT}`);
console.log(`[mock-opencode]   agent: ${AGENT_NAME}`);

// 保持运行
process.on("SIGINT", () => {
  console.log("\n[mock-opencode] 退出");
  apiServer.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  apiServer.close();
  process.exit(0);
});
