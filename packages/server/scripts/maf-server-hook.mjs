#!/usr/bin/env node
/**
 * MAF Server Hook for Claude Code
 *
 * 订阅 MAF Server SSE 事件流，收到 workflow 结果时 exit 2 唤醒 Claude。
 * 用于 Server 侧 claude 运行时接收异步任务结果通知。
 *
 * 用法（由 hooks.json 配置调用）：
 *   node maf-server-hook.mjs --wait    asyncRewake hook，订阅 SSE 等结果
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_DIR = join(homedir(), ".meta-agent-framework");

function loadConfig() {
  const configPath = join(STATE_DIR, "maf.config.json");
  try {
    if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {}
  return {};
}

const config = loadConfig();
const SERVER_PORT = config.server?.port || 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const ADMIN_TOKEN = String(
  process.env.MAF_AUTH_TOKEN
  || config.auth?.token
  || (() => {
    try { return readFileSync(join(STATE_DIR, "auth", "admin-token"), "utf-8").trim(); } catch { return ""; }
  })(),
).trim();

/**
 * 订阅 Server SSE，等待 workflow_completed / workflow_failed 事件
 * 收到后 exit 2 唤醒 Claude，并通过 stderr 传递结果内容
 */
async function waitForResult() {
  // 等 Server 就绪
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }

  // 订阅 SSE
  try {
    const res = await fetch(`${SERVER_URL}/api/events`, {
      headers: { "Accept": "text/event-stream", Authorization: `Bearer ${ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(86400_000), // 24h
    });

    if (!res.ok || !res.body) {
      process.exit(0);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const raw of events) {
        if (!raw.trim()) continue;
        const lines = raw.split("\n");
        let eventType = "";
        let eventData = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          if (line.startsWith("data: ")) eventData = line.slice(6);
        }

        if ((eventType === "workflow_completed" || eventType === "workflow_failed") && eventData) {
          try {
            const data = JSON.parse(eventData);
            const workflow = data.data || {};
            const nodes = workflow.nodes || [];
            
            // 构建结果消息
            const sections = [];
            const agents = nodes.map(n => n.agent_name).join(", ");
            sections.push(`## ${workflow.title || "任务完成"}`);
            sections.push(`**来源**: ${agents} | **状态**: ${workflow.status || eventType.replace("workflow_", "")}\n`);
            for (const node of nodes) {
              if (node.result) sections.push(node.result);
            }

            const resultContent = sections.join("\n\n---\n\n");
            const msg = `[远端任务完成] 以下是远端 Agent 的执行结果，请原样输出，不要修改、总结或添加任何其他文字：\n\n${resultContent}`;

            process.stderr.write(msg);
            process.exit(2); // asyncRewake: 唤醒 Claude
          } catch {}
        }
      }
    }
  } catch (err) {
    // SSE 断开，静默退出
    process.exit(0);
  }
}

waitForResult();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
