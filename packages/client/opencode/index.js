/**
 * Meta-Agent Bridge Plugin
 *
 * 运行在 opencode 进程内部，拥有对 opencode SDK client 的直接访问权。
 *
 * 职责：
 *   1. Hook 透传（agent 切换、session 事件）→ 通知 Node Daemon
 *   2. 连接 & 按需拉起 Node Daemon（固定端口，机器级别常驻）
 *   3. 任务执行桥梁：long-poll Daemon 等任务 → fetch opencode HTTP API 执行 → session.idle 收结果
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, userInfo, networkInterfaces } from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// ============================================================
// Markdown → ANSI 终端富文本转换
// ============================================================

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  // 颜色
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

/**
 * 轻量 Markdown → ANSI 转换
 * 处理：标题、粗体、斜体、行内代码、代码块、列表、分割线、表格
 */
function md2ansi(text) {
  if (!text) return "";
  const lines = text.split("\n");
  const out = [];
  let inCodeBlock = false;
  let codeBlockLang = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // 代码块 ```
    if (line.match(/^```/)) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        out.push(`${ANSI.dim}┌─${codeBlockLang ? ` ${codeBlockLang} ` : ""}${"─".repeat(Math.max(0, 40 - codeBlockLang.length))}${ANSI.reset}`);
      } else {
        inCodeBlock = false;
        codeBlockLang = "";
        out.push(`${ANSI.dim}└${"─".repeat(42)}${ANSI.reset}`);
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(`${ANSI.dim}│${ANSI.reset} ${ANSI.yellow}${line}${ANSI.reset}`);
      continue;
    }

    // 标题 # ## ###
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2];
      const colors = [ANSI.cyan + ANSI.bold, ANSI.green + ANSI.bold, ANSI.blue + ANSI.bold, ANSI.magenta];
      out.push(`${colors[level - 1] || ANSI.bold}${title}${ANSI.reset}`);
      continue;
    }

    // 分割线 --- / ***
    if (line.match(/^[-*_]{3,}\s*$/)) {
      out.push(`${ANSI.dim}${"─".repeat(50)}${ANSI.reset}`);
      continue;
    }

    // 表格行 | xxx | yyy |
    if (line.match(/^\|.*\|$/)) {
      // 分隔行（|---|---|）→ 画线
      if (line.match(/^\|[\s:]*[-]+[\s:]*\|/)) {
        const cols = line.split("|").filter(c => c.trim());
        out.push(`${ANSI.dim}${"─".repeat(cols.length * 15)}${ANSI.reset}`);
        continue;
      }
      // 数据行 → 对齐
      const cols = line.split("|").filter(c => c.trim()).map(c => c.trim());
      // 表头检测：下一行是分隔行
      const nextLine = lines[i + 1] || "";
      if (nextLine.match(/^\|[\s:]*[-]+[\s:]*\|/)) {
        out.push(`${ANSI.bold}${cols.map(c => c.padEnd(15)).join("")}${ANSI.reset}`);
      } else {
        out.push(`${cols.map(c => c.padEnd(15)).join("")}`);
      }
      continue;
    }

    // 无序列表 - / * / •
    const listMatch = line.match(/^(\s*)[*\-•]\s+(.+)/);
    if (listMatch) {
      const indent = listMatch[1] || "";
      const content = inlineFormat(listMatch[2]);
      out.push(`${indent}  ${ANSI.cyan}•${ANSI.reset} ${content}`);
      continue;
    }

    // 有序列表 1. 2. 3.
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (olMatch) {
      const indent = olMatch[1] || "";
      const num = olMatch[2];
      const content = inlineFormat(olMatch[3]);
      out.push(`${indent}  ${ANSI.cyan}${num}.${ANSI.reset} ${content}`);
      continue;
    }

    // 引用块 >
    if (line.match(/^>\s?/)) {
      const content = inlineFormat(line.replace(/^>\s?/, ""));
      out.push(`${ANSI.dim}│${ANSI.reset} ${ANSI.italic}${content}${ANSI.reset}`);
      continue;
    }

    // 普通行：处理行内格式
    out.push(inlineFormat(line));
  }

  // 如果代码块没闭合
  if (inCodeBlock) {
    out.push(`${ANSI.dim}└${"─".repeat(42)}${ANSI.reset}`);
  }

  return out.join("\n");
}

/** 行内格式：粗体、斜体、代码、链接 */
function inlineFormat(line) {
  return line
    // 粗体 **text**
    .replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
    // 斜体 *text* （不匹配列表符号）
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${ANSI.italic}$1${ANSI.reset}`)
    // 行内代码 `code`
    .replace(/`([^`]+)`/g, `${ANSI.yellow}$1${ANSI.reset}`)
    // 链接 [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${ANSI.underline}$1${ANSI.reset} ${ANSI.dim}($2)${ANSI.reset}`)
    // 删除线 ~~text~~
    .replace(/~~([^~]+)~~/g, `${ANSI.dim}$1${ANSI.reset}`);
}

// ============================================================
// 配置
// ============================================================
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), ".meta-agent-framework");
const LOG_FILE = join(STATE_DIR, "bridge.log");
const NODE_PORT = parseInt(process.env.MAF_NODE_PORT || "4100");

mkdirSync(STATE_DIR, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} [plugin] ${msg}`;
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

/** 获取本机可达 IP */
function getLocalIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (!iface.internal && iface.family === "IPv4") return iface.address;
    }
  }
  return "127.0.0.1";
}

/** 把 localhost/127.0.0.1 替换为局域网 IP */
function makeReachableUrl(url) {
  return url.replace(/127\.0\.0\.1|localhost/, getLocalIP());
}

/** 检测用户标识 */
function detectUserId() {
  if (process.env.MAF_USER_ID) return process.env.MAF_USER_ID;
  try {
    const email = execSync("git config user.email", { encoding: "utf-8" }).trim();
    if (email.includes("@")) return email.split("@")[0];
  } catch {}
  return userInfo().username;
}

/** 检查是否是 Meta-Agent-Server 项目（跳过自身） */
function isMetaAgentServer(directory) {
  try {
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf-8"));
    if (pkg.name === "meta-agent-framework") return true;
  } catch {}
  return false;
}

/** 计算 daemon.mjs 的 hash */
function localDaemonHash() {
  const f = join(PLUGIN_DIR, "daemon.mjs");
  if (!existsSync(f)) return "";
  try { return createHash("sha256").update(readFileSync(f, "utf-8")).digest("hex").substring(0, 16); } catch { return ""; }
}

// ============================================================
// Node Daemon 管理（固定端口，连接而非 fork）
// ============================================================
const daemonUrl = `http://127.0.0.1:${NODE_PORT}`;

async function getDaemonHealth() {
  try {
    const res = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

/** 拉起 Node Daemon（仅在没有已运行实例时） */
async function spawnNodeDaemon(directory) {
  const script = join(PLUGIN_DIR, "daemon.mjs");
  if (!existsSync(script)) { log(`⚠ daemon.mjs 不存在: ${script}`); return false; }

  const child = spawn("node", [script], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      MAF_NODE_PORT: String(NODE_PORT),
      MAF_DIRECTORY: directory,
      MAF_PLUGIN_DIR: PLUGIN_DIR,
      // 不传 MAF_PARENT_PID — Node Daemon 常驻，不跟随任何 TUI
    },
  });
  child.unref();

  // 等待启动确认
  return new Promise((resolve) => {
    let output = "";
    const timeout = setTimeout(() => { resolve(false); }, 8000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/^PORT:(\d+)$/m);
      if (match) {
        clearTimeout(timeout);
        log(`✅ Node Daemon 拉起成功 (pid=${child.pid}, port=${match[1]})`);
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.unref();
        resolve(true);
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        // exit(0) 可能是端口已占用（已有实例），视为成功
        log(`Node Daemon exit(0)，可能已有实例在运行`);
        resolve(true);
      } else {
        log(`⚠ Node Daemon 退出 code=${code}`);
        resolve(false);
      }
    });
  });
}

/** 确保 Node Daemon 可用（检查存活 → 不在则拉起） */
async function ensureNodeDaemon(directory) {
  const health = await getDaemonHealth();
  if (health) {
    // 检查版本一致性
    const localHash = localDaemonHash();
    if (localHash && health.daemon_hash && localHash !== health.daemon_hash) {
      log(`🔄 Node Daemon 版本不一致，重启...`);
      try {
        const res = await fetch(`${daemonUrl}/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(2000),
        });
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    } else {
      return true; // Node Daemon 活着且版本一致
    }
  }

  log("Node Daemon 未运行，拉起中...");
  return await spawnNodeDaemon(directory);
}

/** 通知 Node Daemon */
async function notifyDaemon(path, body) {
  try {
    await fetch(`${daemonUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

// ============================================================
// Plugin 入口
// ============================================================

export const MetaAgentBridge = async ({ client, serverUrl, project, directory }) => {
  log("========== Plugin 启动 ==========");

  if (isMetaAgentServer(directory)) {
    log("Meta-Agent-Server 项目，跳过");
    return {};
  }

  const userId = detectUserId();
  const hostUser = userInfo().username;
  const rawUrl = serverUrl.toString().replace(/\/$/, "");
  const opencodeUrl = makeReachableUrl(rawUrl);
  const urlObj = new URL(rawUrl);
  const opencodePort = parseInt(urlObj.port) || 4096;

  log(`用户: ${userId}@${hostUser}`);
  log(`项目: ${directory}`);

  // 确定 opencode 内部 API 的实际可达地址
  let opencodeApiUrl = "";
  async function detectOpencodeApiUrl() {
    try {
      const cfg = client._client.getConfig();
      if (cfg.baseUrl) {
        const u = new URL(cfg.baseUrl);
        if (u.port && u.port !== "0" && u.port !== "4096") {
          return cfg.baseUrl;
        }
      }
    } catch {}
    try {
      const u = new URL(serverUrl.toString());
      if (u.port && u.port !== "0") {
        return `http://127.0.0.1:${u.port}`;
      }
    } catch {}
    try {
      const pid = process.pid;
      const ssOut = execSync(`ss -tlnp 2>/dev/null | grep ",pid=${pid},"`, { encoding: "utf-8", timeout: 3000 }).trim();
      const match = ssOut.match(/:(\d+)\s/);
      if (match) return `http://127.0.0.1:${match[1]}`;
    } catch {}
    return "";
  }
  for (let i = 0; i < 10; i++) {
    opencodeApiUrl = await detectOpencodeApiUrl();
    if (opencodeApiUrl) break;
    await new Promise(r => setTimeout(r, 500));
  }
  log(`opencode API: ${opencodeApiUrl || "(未检测到)"}`);

  // 连接/拉起 Node Daemon（固定端口，机器级别常驻）
  const ok = await ensureNodeDaemon(directory);
  if (ok) {
    log(`Node Daemon 就绪: ${daemonUrl}`);
  } else {
    log("⚠ Node Daemon 不可用");
  }

  // 当前活跃 agent / session
  let activeAgent = null;
  let currentSessionID = null;

  // 启动时自动检测 agent name（不等 chat.message）
  // 优先级：MAF_INITIAL_AGENT 环境变量 > --agent 命令行参数
  const detectedAgent = process.env.MAF_INITIAL_AGENT
    || (() => { const i = process.argv.indexOf("--agent"); return i !== -1 ? process.argv[i + 1] : ""; })();
  // Meta-Agent-Server 是管理者，不注册为 Client Agent
  if (detectedAgent && detectedAgent !== "Meta-Agent-Server") {
    log(`🔗 启动时检测到 agent: ${detectedAgent}，直接 connect`);
    activeAgent = detectedAgent;
    notifyDaemon("/agents/connect", {
      agent_name: detectedAgent, runtime: "opencode",
      user_id: userId, host_user: hostUser,
      plugin_pid: process.pid,
      directory,
    });
  } else if (detectedAgent === "Meta-Agent-Server") {
    log(`ℹ️ Meta-Agent-Server 是管理者，不注册为 Client Agent`);
    activeAgent = detectedAgent;
  }

  // ============================================================
  // 任务执行桥梁（long-poll 与执行解耦）
  // ============================================================

  let sessionIdleResolve = null;
  let executingTask = null;  // 当前正在执行的任务（long-poll 期间不取新任务）
  let isRemoteTaskExecuting = false;  // 远端任务执行期间为 true → permission.ask 自动批准

  async function fetchAssistantResult(baseUrl, headers, sessionID) {
    try {
      const msgFetch = await fetch(`${baseUrl}/session/${sessionID}/message`, { headers });
      if (!msgFetch.ok) return "";
      const messages = await msgFetch.json();
      const arr = Array.isArray(messages) ? messages : (messages.data || []);
      for (let j = arr.length - 1; j >= 0; j--) {
        const role = arr[j].info?.role || arr[j].role;
        if (role === "assistant") {
          const texts = (arr[j].parts || []).filter(p => p.type === "text").map(p => p.text).join("");
          if (texts) return texts;
        }
      }
    } catch {}
    return "";
  }

  async function executeTask(task) {
    executingTask = task;
    isRemoteTaskExecuting = true;
    // 通知 Daemon 开始执行（状态 → busy）
    await notifyDaemon("/tasks/executing", { agent_name: activeAgent, task_id: task.id });
    const start = Date.now();
    try {
      const baseUrl = opencodeApiUrl;
      const headers = { "Content-Type": "application/json", ...client._client.getConfig().headers };
      const promptText = `[MAF Server 下发任务]\n类型: ${task.type || "custom"}\n标题: ${task.title}\n\n${task.description || ""}`;

      // 优先用 TUI 当前 session（chat.message 传入的），没有则创建新的
      let sessionID = currentSessionID;
      if (!sessionID) {
        const createRes = await fetch(`${baseUrl}/session`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(5000) });
        const sessionData = await createRes.json();
        sessionID = sessionData.id;
        if (!sessionID) throw new Error("创建 session 失败: " + JSON.stringify(sessionData).substring(0, 200));
        log(`  创建新 session: ${sessionID}`);
      } else {
        log(`  复用当前 session: ${sessionID}`);
      }

      // 两种执行模式：
      // 1. opencode TUI/serve: POST message 同步阻塞（执行完才返回 200）→ 返回后直接拉结果
      // 2. mock-opencode/旧版: POST message 立即返回 → 需要等 session.idle 事件
      const idlePromise = new Promise(resolve => { sessionIdleResolve = resolve; });
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve("timeout"), 20 * 60_000));

      const postStart = Date.now();
      const msgRes = await fetch(`${baseUrl}/session/${sessionID}/message`, {
        method: "POST", headers,
        body: JSON.stringify({
          parts: [{ type: "text", text: promptText }],
          ...(task.target_agent || activeAgent ? { agent: task.target_agent || activeAgent } : {}),
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const postDuration = Date.now() - postStart;
      const msgText = await msgRes.text();
      log(`  POST message: status=${msgRes.status} (${postDuration}ms) body=${msgText.substring(0, 200)}`);

      if (postDuration > 5000) {
        // POST 阻塞超过 5s → 同步模式，opencode 已执行完，直接拉结果
        log(`  同步模式: POST 耗时 ${postDuration}ms，直接拉结果`);
      } else {
        // POST 立即返回 → 异步模式，等 session.idle 事件
        log(`  异步模式: 等待 session.idle 事件...`);
        const signal = await Promise.race([idlePromise, timeoutPromise]);
        if (signal === "timeout") {
          log(`  ⏰ 等待超时 (20min)`);
        }
      }
      sessionIdleResolve = null;

      // 拉取结果
      const result = await fetchAssistantResult(baseUrl, headers, sessionID);

      const duration = Date.now() - start;
      log(`✅ 任务完成: "${task.title}" (${duration}ms, ${result.length} chars)`);
      await notifyDaemon("/tasks/done", {
        task_id: task.id, agent_name: activeAgent, status: "completed",
        result: result || "Completed", duration_ms: duration,
      });
    } catch (err) {
      const duration = Date.now() - start;
      log(`❌ 任务失败: "${task.title}" ${err.message}`);
      await notifyDaemon("/tasks/done", {
        task_id: task.id, agent_name: activeAgent, status: "failed",
        result: err.message, duration_ms: duration,
      });
    } finally {
      sessionIdleResolve = null;
      executingTask = null;
      isRemoteTaskExecuting = false;
      // 任务执行完后立即尝试注入待推送的 workflow 结果
      setTimeout(() => injectPendingResults(), 1000);
    }
  }

  /**
   * long-poll 循环：持续从 Node Daemon 等待任务（按 agent 隔离）
   *
   * 关键设计：long-poll 和 executeTask 完全解耦
   * - long-poll 每 2s 循环一次到 Daemon，保持 lastSeen 刷新（= agent 存活心跳）
   * - 取到任务后，executeTask 异步执行（不阻塞 long-poll 循环）
   * - 执行期间 long-poll 继续运行，但不取新任务（executingTask != null）
   */
  async function longPollLoop() {
    log(`🔄 启动 long-poll 任务等待 (daemonUrl=${daemonUrl})`);
    while (true) {
      try {
        const agent = activeAgent || "";
        const url = agent
          ? `${daemonUrl}/tasks/wait?agent=${encodeURIComponent(agent)}`
          : `${daemonUrl}/tasks/wait`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) { await new Promise(r => setTimeout(r, 3000)); continue; }
        const data = await res.json();
        if (!data.task) continue;

        // 如果已有任务在执行，不取新任务（Daemon 侧也不会重复分发）
        if (executingTask) {
          log(`⏳ 收到任务但当前有任务执行中，跳过: "${data.task.title}"`);
          continue;
        }

        const task = data.task;
        log(`📥 收到任务: "${task.title}" (id=${task.id})`);
        // 立即标记执行中（防止 long-poll 下一轮在 executeTask await 之前再取到新任务）
        executingTask = task;
        // 异步执行（不阻塞 long-poll 循环）
        executeTask(task).catch(err => {
          log(`❌ executeTask 异常: ${err.message}`);
        });
      } catch (err) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  // 启动 long-poll（不阻塞 Plugin 初始化）
  longPollLoop();

  // ============================================================
  // 异步 Workflow 结果通知（后台收集 + 前台空闲时呈现）
  //
  // 流程：
  //   1. Plugin 订阅 MAF Server 的 SSE 事件流
  //   2. 收到 workflow_completed/workflow_failed → 结果入队列
  //   3. session.idle 时检查队列 → 有结果就注入 TUI 触发 agent 处理
  // ============================================================

  const pendingResults = [];  // 后台收到的 workflow 结果队列
  let mafServerUrl = "";      // MAF Server URL（从 Daemon health 获取）
  let sseAbortController = null;

  /** 从 Daemon health 获取 MAF Server URL */
  async function getMafServerUrl() {
    if (mafServerUrl) return mafServerUrl;
    const health = await getDaemonHealth();
    if (health?.server) {
      mafServerUrl = health.server.replace(/\/$/, "");
      return mafServerUrl;
    }
    return "";
  }

  /** 订阅 MAF Server SSE 事件流 */
  async function subscribeServerSSE() {
    const serverUrl = await getMafServerUrl();
    if (!serverUrl) {
      log("⚠ 无法订阅 Server SSE: MAF Server URL 未知");
      return;
    }

    // 防止重复订阅
    if (sseAbortController) return;
    sseAbortController = new AbortController();

    log(`📡 订阅 Server SSE: ${serverUrl}/api/events`);

    try {
      const res = await fetch(`${serverUrl}/api/events`, {
        signal: sseAbortController.signal,
        headers: { "Accept": "text/event-stream" },
      });

      if (!res.ok || !res.body) {
        log(`⚠ SSE 连接失败: HTTP ${res.status}`);
        sseAbortController = null;
        return;
      }

      // 读取 SSE 流
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // 解析 SSE 事件（格式: "event: xxx\ndata: {...}\n\n"）
            const events = buffer.split("\n\n");
            buffer = events.pop() || "";  // 最后一个可能不完整

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
                  // 只有 Meta-Agent-Server（管理者）接收 workflow 结果广播
                  // Client agent 不需要：结果已在执行时输出，协作由 Server 编排传递
                  const isRelevant = activeAgent === "Meta-Agent-Server";
                  if (isRelevant) {
                    pendingResults.push({
                      type: eventType,
                      workflow_id: data.data?.workflow_id || "",
                      title: data.data?.title || "",
                      status: data.data?.status || eventType.replace("workflow_", ""),
                      nodes: data.data?.nodes || [],
                      timestamp: data.timestamp || new Date().toISOString(),
                    });
                    log(`📬 收到 workflow 结果: "${data.data?.title}" (${eventType}, 队列: ${pendingResults.length})`);
                    // 立即尝试注入（如果当前 idle，不等下一次 session.idle 事件）
                    setTimeout(() => injectPendingResults(), 2000);
                  }
                } catch {}
              }
            }
          }
        } catch (err) {
          if (err.name !== "AbortError") {
            log(`⚠ SSE 流断开: ${err.message}`);
          }
        }
        sseAbortController = null;
        // 断开后 10s 重连
        setTimeout(subscribeServerSSE, 10_000);
      })();
    } catch (err) {
      log(`⚠ SSE 连接异常: ${err.message}`);
      sseAbortController = null;
      setTimeout(subscribeServerSSE, 10_000);
    }
  }

  /** 空闲时注入 workflow 结果到 TUI */
  async function injectPendingResults() {
    if (pendingResults.length === 0) return;
    if (!currentSessionID || !opencodeApiUrl) {
      log(`⏳ 注入跳过: sessionID=${!!currentSessionID} apiUrl=${!!opencodeApiUrl}`);
      return;
    }
    if (executingTask || isRemoteTaskExecuting) {
      log(`⏳ 注入跳过: 正在执行任务 (executingTask=${!!executingTask} isRemote=${isRemoteTaskExecuting})`);
      return;  // 正在执行任务，不打断
    }

    const results = pendingResults.splice(0, pendingResults.length);  // 取出所有
    const headers = { "Content-Type": "application/json", ...client._client.getConfig().headers };

    // 构建结果展示：让 LLM 原样输出（assistant message 会渲染 markdown）
    const sections = [];
    for (const r of results) {
      const agents = (r.nodes || []).map(n => n.agent_name).join(", ");
      sections.push(`## ${r.title}\n**来源**: ${agents} | **状态**: ${r.status}\n`);
      for (const node of r.nodes) {
        sections.push(node.result || "无输出");
      }
    }
    const resultContent = sections.join("\n\n---\n\n");
    const promptText = `[远端任务完成] 以下是远端 Agent 的执行结果，请原样输出，不要修改、总结或添加任何其他文字：\n\n${resultContent}`;

    log(`📢 注入 ${results.length} 个 workflow 结果到 TUI (session=${currentSessionID})`);

    try {
      isRemoteTaskExecuting = true;  // 触发 permission.ask 自动批准
      await fetch(`${opencodeApiUrl}/session/${currentSessionID}/message`, {
        method: "POST", headers,
        body: JSON.stringify({
          parts: [{ type: "text", text: promptText }],
          ...(activeAgent ? { agent: activeAgent } : {}),
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (err) {
      log(`⚠ 注入结果失败: ${err.message}`);
      // 失败的结果放回队列
      pendingResults.unshift(...results);
    } finally {
      isRemoteTaskExecuting = false;
      // 注入完成后检查队列是否还有待处理的结果（注入期间新到达的）
      if (pendingResults.length > 0) {
        setTimeout(() => injectPendingResults(), 2000);
      }
    }
  }

  // 延迟启动 SSE 订阅（等 Daemon 就绪 + Server URL 可用）
  setTimeout(subscribeServerSSE, 5_000);

  // opencode 退出时通知 Node Daemon 断开此 agent（不杀 Daemon）
  const disconnectAgent = () => {
    if (!activeAgent) return;
    // 关闭 SSE 连接
    if (sseAbortController) { sseAbortController.abort(); sseAbortController = null; }
    log(`通知 Node Daemon 断开 agent: ${activeAgent}`);
    try {
      execSync(`curl -s -X POST ${daemonUrl}/agents/disconnect -H 'Content-Type: application/json' -d '{"agent_name":"${activeAgent}","plugin_pid":${process.pid}}' --max-time 1 2>/dev/null`, { timeout: 2000, stdio: "ignore" });
    } catch {}
  };
  process.on("exit", disconnectAgent);
  process.on("SIGINT", () => { disconnectAgent(); process.exit(0); });
  process.on("SIGTERM", () => { disconnectAgent(); process.exit(0); });

  // 定时检查 Node Daemon 存活 + 自己的 agent 是否已注册
  setInterval(async () => {
    const health = await getDaemonHealth();
    if (!health) {
      // Daemon 不可达，拉起并重新注册
      log("⚠ Node Daemon 不可达，重新拉起...");
      const restarted = await ensureNodeDaemon(directory);
      if (restarted && activeAgent) {
        notifyDaemon("/agents/connect", {
          agent_name: activeAgent, runtime: "opencode",
          user_id: userId, host_user: hostUser,
          plugin_pid: process.pid,
          directory,
        });
      }
    } else if (activeAgent && !health.agents?.includes(activeAgent)) {
      // Daemon 在运行但我的 agent 不在里面（Daemon 被重启过，别的 Plugin 先拉起了）
      log(`⚠ agent ${activeAgent} 未在 Daemon 注册，重新连接...`);
      notifyDaemon("/agents/connect", {
        agent_name: activeAgent, runtime: "opencode",
        user_id: userId, host_user: hostUser,
        plugin_pid: process.pid,
        directory,
      });
    }
  }, 5_000);

  return {
    // agent 切换 + 跟踪当前 session → 通知 Node Daemon
    "chat.message": async (input, _output) => {
      if (input.sessionID) {
        currentSessionID = input.sessionID;
      }
      const newAgent = input.agent;
      if (newAgent && newAgent !== activeAgent) {
        log(`🔄 agent: ${activeAgent || "-"} → ${newAgent}`);
        // 先断开旧 agent（一个 TUI 同一时间只注册一个 agent）
        if (activeAgent && activeAgent !== "Meta-Agent-Server") {
          notifyDaemon("/agents/disconnect", {
            agent_name: activeAgent,
            plugin_pid: process.pid,
          });
        }
        activeAgent = newAgent;
        // Meta-Agent-Server 是管理者，不注册为 Client Agent
        if (newAgent === "Meta-Agent-Server") return;
        // 通知 Node Daemon 连接新 agent
        notifyDaemon("/agents/connect", {
          agent_name: newAgent, runtime: "opencode",
          user_id: userId, host_user: hostUser,
          plugin_pid: process.pid,
          directory,
        });
      }
    },

    // session 事件 → 跟踪当前 session + 唤醒任务等待 + 注入后台结果
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID;
        if (sessionId) {
          currentSessionID = sessionId;
          if (sessionIdleResolve) {
            sessionIdleResolve("idle");
          }
          if (activeAgent) {
            notifyDaemon("/session", { agent_name: activeAgent, session_id: sessionId });
          }
          // 空闲时注入后台 workflow 结果
          injectPendingResults();
        }
      }
      if (event.type === "session.selected" || event.type === "session.created") {
        const sessionId = event.properties?.sessionID || event.properties?.id;
        if (sessionId) currentSessionID = sessionId;
      }
    },

    // 注入环境变量
    "shell.env": async (_input, output) => {
      output.env.META_AGENT_DAEMON_URL = daemonUrl;
      output.env.META_AGENT_USER = userId;
    },

    // 远端任务执行期间自动批准权限请求（无人值守模式）
    // 用户手动操作时不修改 output.status，保持原有 ask 行为
    "permission.ask": async (input, output) => {
      if (isRemoteTaskExecuting) {
        log(`🔓 自动批准权限 [${input.type}]: "${input.title}"`);
        output.status = "allow";
      }
    },

    // Meta-Agent-Server 文件写入保护：禁止修改 .opencode/ 目录（框架管理）
    // 强制 agent 将积累的知识写入 user/ 目录
    "tool.execute.before": async (input, output) => {
      if (activeAgent !== "Meta-Agent-Server") return;

      if ((input.tool === "edit" || input.tool === "write") && output.args?.filePath) {
        const filePath = output.args.filePath;
        if (filePath.includes("/.opencode/")) {
          throw new Error(
            `禁止修改 .opencode/ 目录（框架升级会覆盖）。` +
            `请将内容写入 user/ 目录，例如: ${filePath.replace(/\/.opencode\//, "/user/")}`
          );
        }
      }
    },
  };
};

export const server = MetaAgentBridge;
