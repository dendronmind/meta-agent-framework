import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { Server } from 'http';
import { initDb, getDb, closeDb } from './db/database';
import { healthMonitor } from './services/health-monitor';
import { getRegistry } from './services/registry';
import { agentRegistry } from './services/agent-registry';
import { eventBus } from './services/event-bus';
import { workflowEngine } from './services/workflow-engine';
import { masRunner } from './services/mas-runner';
import { SERVER_VERSION, CLIENT_MIN_VERSION } from './types';
import agentsRouter from './routes/agents';
import tasksRouter from './routes/tasks';
import eventsRouter from './routes/events';
import workflowsRouter from './routes/workflows';
import evolveRouter from './routes/evolve';
import proposalsRouter from './routes/proposals';
import {
  acceptSignedNonce,
  ensureServerIdentity,
  getAuthToken,
  getServerPublicKey,
  isLoopbackRequest,
  requestRawBody,
  requireAdminAuth,
  requireApiAuth,
  serverAuthHeaders,
} from './auth';
import { verifySignedRequest } from './request-signing';
import { clientIdentityService } from './services/client-identity-service';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

// ============================================================
// 日志：同时输出到 console 和文件（不依赖 shell 重定向）
// ============================================================
const MAF_HOME = process.env.MAF_HOME || path.join(os.homedir(), '.meta-agent-framework');
const LOG_DIR = path.join(MAF_HOME, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const LOG_MAX_BYTES = parseLogInt(process.env.MAF_LOG_MAX_BYTES, 20 * 1024 * 1024);
const LOG_BACKUPS = parseLogInt(process.env.MAF_LOG_BACKUPS, 2);
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const origLog = console.log;
const origError = console.error;
/** 本地时间戳（YYYY-MM-DD HH:mm:ss） */
function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseLogInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rotateLogIfNeeded(incomingBytes: number): void {
  if (LOG_MAX_BYTES <= 0) return;
  try {
    const currentSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    if (currentSize + incomingBytes <= LOG_MAX_BYTES) return;
    if (LOG_BACKUPS <= 0) {
      try { fs.unlinkSync(LOG_FILE); } catch {}
      return;
    }
    for (let i = LOG_BACKUPS; i >= 1; i -= 1) {
      const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      const dst = `${LOG_FILE}.${i}`;
      if (!fs.existsSync(src)) continue;
      try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch {}
      try { fs.renameSync(src, dst); } catch {}
    }
  } catch {}
}

function appendLogLine(line: string): void {
  try {
    const content = `${line}\n`;
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateLogIfNeeded(Buffer.byteLength(content));
    fs.appendFileSync(LOG_FILE, content);
  } catch {}
}
console.log = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origLog(...args);
  appendLogLine(`${localTimestamp()} ${msg}`);
};
console.error = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  origError(...args);
  appendLogLine(`${localTimestamp()} [ERROR] ${msg}`);
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
let httpServer: Server | null = null;
let shuttingDown = false;

// --- Middleware ---
app.use(express.json({
  verify: (req, _res, buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// 探活端点不包含敏感数据，保持匿名可用。
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'ok',
    server_version: SERVER_VERSION,
    client_min_version: CLIENT_MIN_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Dashboard 用它决定是否显示本机管理操作。该结果只用于 UI；真正权限仍由
// requireApiAuth 基于 socket.remoteAddress 强制执行。
app.get('/api/access-context', (req, res) => {
  const local = isLoopbackRequest(req);
  res.json({ local, can_write: local });
});

// Client 首次上线提交本机公钥及持有证明。私网/VPN来源默认自动准入；
// 其他来源持久化为 pending，不依赖短期配对码。
app.post('/api/auth/enroll', (req, res) => {
  const payload = req.body || {};
  const clientId = String(payload.client_id || '');
  const publicKey = String(payload.public_key || '');
  const timestamp = req.get('x-maf-timestamp') || '';
  const nonce = req.get('x-maf-nonce') || '';
  const signature = req.get('x-maf-signature') || '';
  if (req.get('x-maf-role') !== 'client' || req.get('x-maf-id') !== clientId
      || !verifySignedRequest(publicKey, req.method, req.originalUrl, requestRawBody(req), timestamp, nonce, signature)
      || !acceptSignedNonce(`enroll:${clientId}`, nonce, timestamp)) {
    res.status(401).json({ error: 'Invalid enrollment proof' });
    return;
  }
  try {
    const sourceIp = req.ip || req.socket.remoteAddress || '';
    const { identity, created } = clientIdentityService.enroll(payload, sourceIp);
    if (identity.status === 'revoked') {
      res.status(403).json({ error: 'Client identity is revoked', status: identity.status });
      return;
    }
    res.status(identity.status === 'active' ? (created ? 201 : 200) : 202).json({
      client_id: identity.client_id,
      status: identity.status,
      server_public_key: getServerPublicKey(),
    });
  } catch (err: any) {
    const code = String(err?.message || 'enrollment_failed');
    const status = code === 'client_key_mismatch' ? 409
      : code === 'enrollment_disabled' ? 403
        : 400;
    res.status(status).json({ error: code });
  }
});

// localhost 是本机管理面；Dashboard 固定 GET/SSE 通路允许远端匿名只读；
// Client 取任务/回报等调用使用机器密钥签名并受路径白名单限制。
app.use('/api', requireApiAuth);

// 身份摘要供远端只读 Dashboard 展示；list() 不返回 Client 公钥。
// approve/revoke 仍由下面的 requireAdminAuth 限制为 localhost 管理请求。
app.get('/api/auth/clients', (_req, res) => {
  res.json(clientIdentityService.list());
});

app.post('/api/auth/clients/:id/approve', requireAdminAuth, (req, res) => {
  const identity = clientIdentityService.approve(req.params.id as string);
  if (!identity) { res.status(404).json({ error: 'Client identity not found' }); return; }
  res.json({ client_id: identity.client_id, status: identity.status });
});

app.post('/api/auth/clients/:id/revoke', requireAdminAuth, (req, res) => {
  const identity = clientIdentityService.revoke(req.params.id as string);
  if (!identity) { res.status(404).json({ error: 'Client identity not found' }); return; }
  res.json({ client_id: identity.client_id, status: identity.status });
});

function sendJsonWithVersion(res: express.Response, filePath: string): void {
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    manifest.version = SERVER_VERSION;
    res.type('application/json').send(JSON.stringify(manifest, null, 2) + '\n');
  } catch {
    res.status(500).send('manifest not found');
  }
}

// --- API Routes ---
// agentsRouter 同时挂载 /api/clients/* 和 /api/agents/*
app.use('/api', agentsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/api/evolve', evolveRouter);
app.use('/api/proposals', proposalsRouter);
app.use('/api/events', eventsRouter);

// --- Client 安装 ---
// GET /install.sh — 动态注入 Server 地址，远端直接 curl 执行即可
app.get('/install.sh', (_req, res) => {
  const scriptPath = path.join(__dirname, '..', 'plugins', 'install.sh');
  try {
    let script = fs.readFileSync(scriptPath, 'utf-8');
    script = script
      .replace(/__SERVER_URL__/g, SERVER_URL)
      .replace(/__PACKAGE_VERSION__/g, SERVER_VERSION);
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
  if (file === 'package.json') {
    sendJsonWithVersion(res, filePath);
  } else {
    res.sendFile(filePath);
  }
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
    if (relPath === '.claude-plugin/plugin.json') {
      sendJsonWithVersion(res, filePath);
    } else {
      res.sendFile(filePath, { dotfiles: 'allow' });
    }
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
    if (relPath === '.codex-plugin/plugin.json') {
      sendJsonWithVersion(res, filePath);
    } else {
      res.sendFile(filePath, { dotfiles: 'allow' });
    }
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
  const remoteAgents = await registry.pull();

  if (remoteAgents.length === 0) {
    console.log('[Startup] 外部注册表中无 agent 数据，跳过');
    return;
  }

  const result = agentRegistry.reconcileExternalAgents(remoteAgents);

  console.log(`[Startup] 外部注册表 → SQLite 同步完成: +${result.added} 新增, ~${result.updated} 更新, =${result.unchanged} 一致`);

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
  // 直接运行 Server 或 maf-server start 都会自动创建管理凭证和 Server 身份密钥。
  ensureServerIdentity();
  getAuthToken();

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
  httpServer = app.listen(PORT, HOST, async () => {
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

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[Server] HTTP server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') process.exit(1);
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
        const url = `${client_endpoint}/ping`;
        const body = JSON.stringify({ server: `http://${HOST}:${PORT}`, timestamp: new Date().toISOString() });
        const res = await fetch(url, {
          method: 'POST',
          headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
          body,
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

function closeHttpServer(): Promise<void> {
  return new Promise(resolve => {
    if (!httpServer) { resolve(); return; }
    const server = httpServer;
    httpServer = null;
    server.close(err => {
      if (err) console.error(`[Server] HTTP close error: ${err.message}`);
      resolve();
    });
  });
}

// --- Graceful shutdown ---
async function shutdown(signal = 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] Shutting down (${signal})...`);

  const forceTimer = setTimeout(() => {
    console.error('[Server] Graceful shutdown timeout, forcing exit');
    process.exit(1);
  }, 8_000);
  forceTimer.unref();

  try {
    healthMonitor.stop();
    workflowEngine.shutdown(`Server shutdown: ${signal}`);
    masRunner.shutdown(`Server shutdown: ${signal}`);
    eventBus.closeAll(`Server shutdown: ${signal}`);
    await closeHttpServer();
    closeDb();
  } catch (err: any) {
    console.error(`[Server] Shutdown error: ${err?.message || err}`);
  } finally {
    clearTimeout(forceTimer);
    process.exit(0);
  }
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('uncaughtException', err => {
  console.error('[Server] uncaughtException:', err);
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', err => {
  console.error('[Server] unhandledRejection:', err);
  void shutdown('unhandledRejection');
});

start().catch(err => {
  console.error('[Server] Failed to start:', err);
  void shutdown('startup_error');
});
