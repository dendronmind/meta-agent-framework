import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb, closeDb } from './db/database';
import { healthMonitor } from './services/health-monitor';
import { getRegistry } from './services/registry';
import { agentRegistry } from './services/agent-registry';
import { SERVER_VERSION, CLIENT_MIN_VERSION } from './types';
import agentsRouter from './routes/agents';
import tasksRouter from './routes/tasks';
import eventsRouter from './routes/events';
import workflowsRouter from './routes/workflows';
import evolveRouter from './routes/evolve';
import proposalsRouter from './routes/proposals';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

// ============================================================
// 日志：同时输出到 console 和文件（不依赖 shell 重定向）
// ============================================================
const MAF_HOME = process.env.MAF_HOME || path.join(os.homedir(), '.meta-agent-framework');
const LOG_DIR = path.join(MAF_HOME, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const origLog = console.log;
const origError = console.error;
/** 本地时间戳（YYYY-MM-DD HH:mm:ss） */
function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
console.log = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origLog(...args);
  logStream.write(`${localTimestamp()} ${msg}\n`);
};
console.error = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origError(...args);
  logStream.write(`${localTimestamp()} [ERROR] ${msg}\n`);
};

/** 探测本机局域网 IP */
function getLocalIP(): string {
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces || []) {
        if (!iface.internal && iface.family === 'IPv4') return iface.address;
      }
    }
  } catch (err: any) {
    console.warn(`[Server] networkInterfaces unavailable, fallback to 127.0.0.1: ${err?.message || err}`);
  }
  return '127.0.0.1';
}
const LOCAL_IP = getLocalIP();
const SERVER_URL = `http://${LOCAL_IP}:${PORT}`;

const app = express();

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---
// agentsRouter 同时挂载 /api/clients/* 和 /api/agents/*
app.use('/api', agentsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/api/evolve', evolveRouter);
app.use('/api/proposals', proposalsRouter);
app.use('/api/events', eventsRouter);

// --- Health check ---
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    server_version: SERVER_VERSION,
    client_min_version: CLIENT_MIN_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// --- Client 安装 ---
// GET /install.sh — 动态注入 Server 地址，远端直接 curl 执行即可
app.get('/install.sh', (_req, res) => {
  const scriptPath = path.join(__dirname, '..', 'plugins', 'install.sh');
  try {
    let script = fs.readFileSync(scriptPath, 'utf-8');
    script = script.replace(/__SERVER_URL__/g, SERVER_URL);
    res.type('text/plain').send(script);
  } catch {
    res.status(500).send('# install.sh not found');
  }
});
// GET /uninstall.sh
app.get('/uninstall.sh', (_req, res) => {
  const scriptPath = path.join(__dirname, '..', 'plugins', 'uninstall.sh');
  try {
    res.type('text/plain').sendFile(scriptPath);
  } catch {
    res.status(500).send('# uninstall.sh not found');
  }
});
// GET /plugins/:file — install.sh 从这里下载 opencode Plugin 文件
app.get('/plugins/:file', (req, res) => {
  const allowed = ['index.js', 'daemon.mjs', 'package.json'];
  const file = req.params.file;
  if (!allowed.includes(file)) { res.status(404).send('Not found'); return; }
  const filePath = file === 'daemon.mjs'
    ? path.join(__dirname, '..', 'plugins', 'node-daemon', 'daemon.mjs')
    : path.join(__dirname, '..', 'plugins', 'opencode-plugin-meta-agent-framework', file);
  res.sendFile(filePath);
});

// GET /codex-install.mjs — install.sh 用它在远端安装 Codex plugin + launcher wrapper
app.get('/codex-install.mjs', (_req, res) => {
  const filePath = path.join(__dirname, '..', 'plugins', 'codex-install.mjs');
  if (fs.existsSync(filePath)) {
    res.type('text/javascript').sendFile(filePath);
  } else {
    res.status(404).send('Not found');
  }
});

// GET /cc-plugins/* — install.sh 从这里下载 Claude Code Plugin 文件
app.get('/cc-plugins/{*path}', (req, res) => {
  const rawPath = (req.params as any).path;
  const relPath = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
  // 安全检查：不允许路径穿越
  if (!relPath || relPath.includes('..')) { res.status(400).send('Bad request'); return; }
  const filePath = path.join(__dirname, '..', 'plugins', 'claude-code-plugin-maf', relPath);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath, { dotfiles: 'allow' });
  } else {
    res.status(404).send('Not found');
  }
});

// GET /codex-plugins/* — codex-install.mjs 从这里下载 Codex Plugin 文件
app.get('/codex-plugins/{*path}', (req, res) => {
  const rawPath = (req.params as any).path;
  const relPath = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
  // 安全检查：不允许路径穿越
  if (!relPath || relPath.includes('..')) { res.status(400).send('Bad request'); return; }
  const filePath = path.join(__dirname, '..', 'plugins', 'codex', relPath);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath, { dotfiles: 'allow' });
  } else {
    res.status(404).send('Not found');
  }
});

// --- SPA fallback ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 启动时从外部注册表拉取 agent，更新本地 SQLite ---
// 外部注册表是权威源。启动时单向：外部 → SQLite。
// 运行时 Client 注册/心跳写 SQLite 后再单向推送：SQLite → 外部。
async function reconcileWithRegistry(): Promise<void> {
  const registry = getRegistry();
  const localAgents = agentRegistry.listAll();
  const remoteAgents = await registry.pull();

  if (remoteAgents.length === 0) {
    console.log('[Startup] 外部注册表中无 agent 数据，跳过');
    return;
  }

  // 用外部数据更新 SQLite（外部源说了算）
  const db = (await import('./db/database')).getDb();
  const { v4: uuidv4 } = await import('uuid');
  const now = new Date().toISOString();

  // 构建本地索引：key → Agent（不含 project_path，避免路径差异导致重复）
  const localKey = (a: { user_id: string; host_user: string; agent_name: string }) =>
    `${a.user_id}|${a.host_user}|${a.agent_name}`;
  const localMap = new Map(localAgents.map(a => [localKey(a), a]));

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const remote of remoteAgents) {
    const key = localKey(remote);
    const local = localMap.get(key);

    if (!local) {
      // 外部有、本地没有 → 插入（状态初始为 offline，等 Client 心跳上线）
      db.prepare(`
        INSERT OR IGNORE INTO agents (id, user_id, host_user, client_endpoint, status, last_heartbeat, agent_name, project_path, capabilities, mode, runtime, skills, mcps, registered_at)
        VALUES (?, ?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), remote.user_id, remote.host_user, remote.client_endpoint,
        remote.last_heartbeat || now,
        remote.agent_name, remote.project_path, remote.capabilities, remote.mode || 'subagent',
        remote.runtime || 'opencode',
        remote.skills || '[]', remote.mcps || '[]',
        now
      );
      added++;
    } else {
      // 两边都有 → 用外部源的字段覆盖本地
      const changed =
        local.client_endpoint !== remote.client_endpoint ||
        local.capabilities !== remote.capabilities ||
        local.mode !== remote.mode ||
        local.runtime !== (remote.runtime || 'opencode') ||
        local.skills !== (remote.skills || '[]') ||
        local.mcps !== (remote.mcps || '[]');

      if (changed) {
        db.prepare(`
          UPDATE agents SET client_endpoint = ?, capabilities = ?, mode = ?, runtime = ?, project_path = ?, skills = ?, mcps = ?
          WHERE user_id = ? AND host_user = ? AND agent_name = ?
        `).run(
          remote.client_endpoint, remote.capabilities, remote.mode, remote.runtime || 'opencode',
          remote.project_path, remote.skills || '[]', remote.mcps || '[]',
          local.user_id, local.host_user, local.agent_name
        );
        updated++;
      } else {
        unchanged++;
      }
    }
  }

  console.log(`[Startup] 外部注册表 → SQLite 同步完成: +${added} 新增, ~${updated} 更新, =${unchanged} 一致`);

  // 打印当前所有 agent 的状态（全部 offline，等待 Client 上线）
  const allAgents = agentRegistry.listAll();
  if (allAgents.length > 0) {
    console.log('[Startup] 已注册 agent 列表:');
    for (const a of allAgents) {
      console.log(`  [${a.agent_name}] ${a.status} (${a.user_id}@${a.host_user} → ${a.client_endpoint}) runtime=${a.runtime || 'opencode'}`);
    }
  }
}

// --- Start ---
async function start(): Promise<void> {
  // 初始化数据库（sql.js 异步加载 WASM/asm）
  await initDb();
  const db = getDb();
  console.log('[DB] SQLite initialized (sql.js)');

  // 启动时全部重置为 offline，等 Client 注册/心跳再恢复
  const reset = db.prepare("UPDATE agents SET status = 'offline' WHERE status IN ('online', 'busy')").run();
  if (reset.changes > 0) {
    console.log(`[DB] 启动重置: ${reset.changes} agents → offline（等待心跳恢复）`);
  }

  // 初始化外部注册表（只标记启用状态，不阻塞启动）
  const registry = getRegistry();
  const registryEnabled = registry.init();

  // 启动健康检查
  healthMonitor.start();

  // 先启动 HTTP server（不等外部注册表）
  app.listen(PORT, HOST, async () => {
    const registryLabel = registryEnabled ? `✅ ${(registry as any).constructor.name}` : '⚠️  disabled';
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════╗');
    console.log('  ║            Meta-Agent Framework Server              ║');
    console.log('  ╠══════════════════════════════════════════════════════╣');
    console.log(`  ║  Server:    ${SERVER_URL.padEnd(40)}║`);
    console.log(`  ║  Registry:  ${registryLabel.padEnd(40)}║`);
    console.log('  ╠══════════════════════════════════════════════════════╣');
    console.log(`  ║  Client 安装命令（远端机器执行）:                    ║`);
    console.log(`  ║  source <(curl -fsSL ${SERVER_URL}/install.sh)`.padEnd(56) + '║');
    console.log('  ╚══════════════════════════════════════════════════════╝');
    console.log('');

    // 1. 从外部注册表拉取数据（确保 DB 里有 agent endpoint 信息）
    if (registryEnabled) {
      try {
        await reconcileWithRegistry();
      } catch (err: any) {
        console.error(`[Startup] 外部注册表初始同步失败（不影响服务）: ${err.message}`);
      }
    }

    // 2. 数据就绪后，再广播 ping（此时 DB 里有完整的 endpoint 列表）
    broadcastPing();
  });
}

/** 广播 ping：通知所有已知 Client "Server 上线了，请重新注册" */
async function broadcastPing(): Promise<void> {
  const db = getDb();
  const endpoints = db.prepare(
    'SELECT DISTINCT client_endpoint FROM agents WHERE client_endpoint != ?'
  ).all('') as { client_endpoint: string }[];

  if (endpoints.length === 0) return;

  console.log(`[Broadcast] ping ${endpoints.length} 个已知 Client endpoint...`);

  const results = await Promise.allSettled(
    endpoints.map(async ({ client_endpoint }) => {
      try {
        const res = await fetch(`${client_endpoint}/ping`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: `http://${HOST}:${PORT}`, timestamp: new Date().toISOString() }),
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          console.log(`[Broadcast] ✅ ${client_endpoint} → agent=${data.agent || '?'}`);
        }
      } catch {
        // Client 不在线，静默跳过
      }
    })
  );

  const responded = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[Broadcast] 完成: ${responded}/${endpoints.length} 响应`);
}

// --- Graceful shutdown ---
function shutdown(): void {
  console.log('\n[Server] Shutting down...');
  healthMonitor.stop();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
