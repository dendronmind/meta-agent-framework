import { Router, Request, Response } from 'express';
import { agentRegistry, isHistoricalAgentStatus } from '../services/agent-registry';
import { healthMonitor } from '../services/health-monitor';
import { getRegistry } from '../services/registry';
import { getConfig } from '../config';
import { buildClientOtaBundle, getClientOtaBundleHash, pushClientOta } from '../services/client-ota';
import { requireAdminAuth } from '../auth';
import { agentLifecycleService, AgentLifecycleError } from '../services/agent-lifecycle-service';
import type { ClientRegisterPayload, HeartbeatPayload } from '../types';

const router = Router();

function clientRuntimeModes(): { codex_delivery: string } {
  return { codex_delivery: getConfig().codex.workflow_delivery };
}

// ============================================================
// Client 注册 / 心跳 / 同步
// ============================================================

/** POST /api/clients/register */
router.post('/clients/register', (req: Request, res: Response) => {
  const payload = req.body as ClientRegisterPayload;
  if (!payload.client_id && res.locals.mafPrincipal?.role === 'admin') {
    payload.client_id = `admin-${payload.user_id || 'manual'}-${payload.host_user || 'client'}`.replace(/[^A-Za-z0-9_-]/g, '_');
  }
  if (!payload.client_id || !payload.user_id || !payload.client_endpoint) {
    res.status(400).json({ error: 'client_id, user_id and client_endpoint are required' });
    return;
  }
  const agents = agentRegistry.registerClient(payload);
  res.status(201).json({ agents, runtime_modes: clientRuntimeModes() });
});

/** POST /api/clients/heartbeat */
router.post('/clients/heartbeat', (req: Request, res: Response) => {
  const { user_id, host_user, ...payload } = req.body;
  if (!user_id) { res.status(400).json({ error: 'user_id required' }); return; }
  const result = agentRegistry.heartbeat(user_id, host_user || '', payload as HeartbeatPayload);
  res.json({ ...result, runtime_modes: clientRuntimeModes() });
});

/** POST /api/clients/sync */
router.post('/clients/sync', (req: Request, res: Response) => {
  const { client_id, user_id, host_user, client_endpoint, agents } = req.body;
  if (!client_id || !user_id || !Array.isArray(agents)) {
    res.status(400).json({ error: 'client_id, user_id and agents[] required' });
    return;
  }
  const result = agentRegistry.syncAgents(client_id, user_id, host_user || '', client_endpoint || '', agents);
  res.json({ synced: result.length, agents: result });
});

/** POST /api/clients/restart */
router.post('/clients/restart', async (req: Request, res: Response) => {
  const { client_endpoint } = req.body;
  if (!client_endpoint) { res.status(400).json({ error: 'client_endpoint required' }); return; }
  const result = await healthMonitor.restartClient(client_endpoint);
  res.json(result);
});

/** GET /api/clients */
router.get('/clients', (_req: Request, res: Response) => {
  res.json(agentRegistry.listUsers());
});

/**
 * GET /api/clients/my-agents?user_id=xxx&host_user=yyy
 *
 * Client 启动时调用：Server 根据注册表（已加载到 SQLite）
 * 告诉 Client「你这台机器应该运行哪些 agent」
 */
router.get('/clients/my-agents', (req: Request, res: Response) => {
  const userId = req.query.user_id as string;
  const hostUser = req.query.host_user as string;
  if (!userId) { res.status(400).json({ error: 'user_id required' }); return; }

  // 从注册表查该用户+机器的所有 agent
  const allAgents = agentRegistry.listAll().filter(a =>
    a.user_id === userId &&
    (!hostUser || a.host_user === hostUser)
  );

  res.json({
    agents: allAgents.map(a => ({
      agent_name: a.agent_name,
      project_path: a.project_path,
      capabilities: a.capabilities,
      mode: a.mode,
      runtime: a.runtime || 'opencode',
    })),
  });
});

// ============================================================
// Plugin 注册（opencode 插件自动调用）
// ============================================================

/**
 * POST /api/clients/plugin-register
 *
 * opencode 启动时 meta-agent-framework-bridge 插件自动调用。
 * 不拉起 agent，只注册"这台机器上有一个 opencode 实例在跑"。
 * Server 可以通过 instance.serverUrl 直接对这个 opencode 下发任务。
 */
router.post('/clients/plugin-register', (req: Request, res: Response) => {
  const { user_id, host_user, instance } = req.body;
  if (!user_id || !instance?.serverUrl) {
    res.status(400).json({ error: 'user_id and instance.serverUrl required' });
    return;
  }
  console.log(`[Plugin] ${user_id}@${host_user} 注册实例: ${instance.serverUrl} (${instance.directory})`);

  // 存到内存（后续可扩展到 SQLite）
  if (!pluginInstances.has(user_id)) {
    pluginInstances.set(user_id, []);
  }
  const list = pluginInstances.get(user_id)!;
  // 去重（同一 serverUrl 只保留最新）
  const idx = list.findIndex(i => i.serverUrl === instance.serverUrl);
  if (idx >= 0) list.splice(idx, 1);
  list.push({ ...instance, last_seen: new Date().toISOString() });

  res.json({ registered: true, total_instances: list.length });
});

/** POST /api/clients/plugin-event — 接收插件事件 */
router.post('/clients/plugin-event', (req: Request, res: Response) => {
  const { user_id, event_type, serverUrl } = req.body;
  console.log(`[Plugin] Event: ${event_type} from ${user_id} (${serverUrl})`);
  res.json({ received: true });
});

/** GET /api/clients/instances — 查看所有通过插件注册的 opencode 实例 */
router.get('/clients/instances', (_req: Request, res: Response) => {
  const result: any[] = [];
  for (const [user, instances] of pluginInstances) {
    for (const inst of instances) {
      result.push({ user_id: user, ...inst });
    }
  }
  res.json(result);
});

/** 插件注册的 opencode 实例存储（内存） */
const pluginInstances = new Map<string, any[]>();

// ============================================================
// Agent 查询
// ============================================================

/**
 * GET /api/agents
 *
 * 返回所有 agent 状态（直接读 DB）。
 * 状态准确性由 HealthMonitor（心跳超时检测）保证，不做实时探活。
 *
 * 插件模式下 client_endpoint 不一定有 HTTP server（TUI 模式没有），
 * 探活会误报，所以只信任心跳机制。
 */
/**
 * GET /api/agents
 * 支持 ?fields=agent_name,status,runtime 过滤返回字段（逗号分隔）
 * 默认去重：同名 agent 只保留最近心跳的一条；状态包含 online/standby/busy/stopped/offline/dead
 * ?all=true 返回全部（含重复）
 * ?include_server=true 诊断时返回控制面 Server 身份；默认不把 Server 当 Agent 展示/统计
 */
router.get('/agents', (req: Request, res: Response) => {
  let agents = agentRegistry.listAll(req.query.include_server === 'true');

  // 默认去重：同名 agent 只保留最新的（最近心跳）
  if (req.query.all !== 'true') {
    const latest = new Map<string, typeof agents[0]>();
    for (const a of agents) {
      const existing = latest.get(a.agent_name);
      if (!existing || a.last_heartbeat > existing.last_heartbeat) {
        latest.set(a.agent_name, a);
      }
    }
    agents = [...latest.values()];
  }

  const fieldsParam = req.query.fields as string | undefined;
  if (!fieldsParam) {
    res.json(agents);
    return;
  }
  const fields = fieldsParam.split(',').map(f => f.trim());
  res.json(agents.map(a => {
    const filtered: Record<string, any> = {};
    for (const f of fields) {
      if (f in a) filtered[f] = (a as any)[f];
    }
    return filtered;
  }));
});

/** DELETE /api/agents/:id — 删除指定 agent 记录（清理 dead/过期） */
router.delete('/agents/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const agent = agentRegistry.getById(id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  if (!isHistoricalAgentStatus(agent.status)) {
    res.status(409).json({ error: `Only offline/dead historical agents can be deleted; "${agent.agent_name}" is ${agent.status}` });
    return;
  }
  if (!agentRegistry.deleteById(id)) {
    res.status(500).json({ error: 'Agent deletion failed' });
    return;
  }
  res.json(agent);
});

function sendLifecycleError(res: Response, error: unknown): void {
  if (error instanceof AgentLifecycleError) {
    res.status(error.status).json({ error: error.message, ...error.detail });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message });
}

/** POST /api/agents/:id/stop — 停止单个远端 Agent，不退出共享 Daemon。 */
router.post('/agents/:id/stop', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    res.json(await agentLifecycleService.stop(String(req.params.id), {
      force: req.body?.force === true,
      reason: req.body?.reason,
    }));
  } catch (error) {
    sendLifecycleError(res, error);
  }
});

/** POST /api/agents/:id/start — 解除 stopped 门禁，返回远端真实执行器状态。 */
router.post('/agents/:id/start', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    res.json(await agentLifecycleService.start(String(req.params.id), { reason: req.body?.reason }));
  } catch (error) {
    sendLifecycleError(res, error);
  }
});

/** GET /api/agents/stats */
router.get('/agents/stats', (_req: Request, res: Response) => {
  res.json(agentRegistry.getStats());
});

/**
 * GET /api/agents/inventory
 *
 * 全网 skill/mcp 矩阵：哪些 agent 有哪些 skill、接了哪些 MCP。
 * 用于进化决策（"谁缺什么"）和全局能力视图。
 */
router.get('/agents/inventory', (_req: Request, res: Response) => {
  const agents = agentRegistry.listAll();

  // skill 矩阵：skill_name → 哪些 agent 有
  const skillMap: Record<string, string[]> = {};
  // mcp 矩阵：mcp_name → 哪些 agent 有
  const mcpMap: Record<string, string[]> = {};

  for (const a of agents) {
    try {
      const skills = JSON.parse(a.skills || '[]');
      for (const s of skills) {
        if (!skillMap[s.name]) skillMap[s.name] = [];
        skillMap[s.name].push(a.agent_name);
      }
    } catch {}
    try {
      const mcps = JSON.parse(a.mcps || '[]');
      for (const m of mcps) {
        if (!mcpMap[m.name]) mcpMap[m.name] = [];
        mcpMap[m.name].push(a.agent_name);
      }
    } catch {}
  }

  // 缺失矩阵：每个 skill/mcp 哪些 agent 没有
  const allAgentNames = agents.map(a => a.agent_name);
  const skillGaps: Record<string, string[]> = {};
  for (const [skill, hasAgents] of Object.entries(skillMap)) {
    const missing = allAgentNames.filter(n => !hasAgents.includes(n));
    if (missing.length > 0) skillGaps[skill] = missing;
  }
  const mcpGaps: Record<string, string[]> = {};
  for (const [mcp, hasAgents] of Object.entries(mcpMap)) {
    const missing = allAgentNames.filter(n => !hasAgents.includes(n));
    if (missing.length > 0) mcpGaps[mcp] = missing;
  }

  res.json({
    total_agents: agents.length,
    skills: { coverage: skillMap, gaps: skillGaps },
    mcps: { coverage: mcpMap, gaps: mcpGaps },
  });
});

/** GET /api/agents/search?cap=xxx */
router.get('/agents/search', (req: Request, res: Response) => {
  const cap = req.query.cap as string;
  if (!cap) { res.status(400).json({ error: 'cap required' }); return; }
  res.json(agentRegistry.findByCapability(cap));
});

/** GET /api/agents/by-user/:user_id */
router.get('/agents/by-user/:user_id', (req: Request, res: Response) => {
  res.json(agentRegistry.listByUser(req.params.user_id as string));
});

// ============================================================
// 外部注册表拉取
// ============================================================

async function pullAndReconcileRegistry(res: Response): Promise<void> {
  const registry = getRegistry();
  if (!registry.isEnabled) {
    res.status(503).json({ error: 'External registry not enabled' });
    return;
  }
  try {
    const agents = await registry.pull();
    const result = agentRegistry.reconcileExternalAgents(agents);
    res.json({ ...result, agents });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

/** POST /api/agents/registry-pull — 手动从外部注册表拉取最新 agent 拓扑 */
router.post('/agents/registry-pull', async (_req: Request, res: Response) => {
  await pullAndReconcileRegistry(res);
});

/** POST /api/agents/feishu-pull — 向后兼容旧 API */
router.post('/agents/feishu-pull', async (_req: Request, res: Response) => {
  await pullAndReconcileRegistry(res);
});

// ============================================================
// OTA 推送
// ============================================================

/**
 * POST /api/ota/push
 *
 * 向指定 agent 的 Daemon 推送 OTA 升级。
 * Server 读取最新 Plugin 文件 → 通过 Daemon HTTP 推送到远端。
 *
 * Body: { agent_name: string, files?: [{path, content, hash}], restart?: boolean }
 *   - 如果不传 files，Server 自动用本地最新 Plugin 文件
 */
router.post('/ota/push', async (req: Request, res: Response) => {
  const { agent_name, files, restart = true } = req.body;
  if (!agent_name) {
    res.status(400).json({ error: 'agent_name required' });
    return;
  }

  // 找到目标 agent 的 client endpoint → 推导 Daemon 地址
  const agents = agentRegistry.findByName(agent_name);
  if (agents.length === 0) {
    // 也尝试找 offline/dead 的
    const all = agentRegistry.listAll().filter(a => a.agent_name === agent_name);
    if (all.length === 0) {
      res.status(404).json({ error: `agent "${agent_name}" not found` });
      return;
    }
    // 用 dead/offline 的 endpoint 也尝试推
    agents.push(...all);
  }

  const agent = agents[0];
  // Daemon 端口优先使用心跳/注册上报值，其次 endpoint URL 端口，最后使用配置默认值。
  const clientUrl = new URL(agent.client_endpoint);
  const daemonPort = agent.daemon_port || Number.parseInt(clientUrl.port, 10) || getConfig().daemon.port;
  const daemonUrl = `http://${clientUrl.hostname}:${daemonPort}`;

  // 如果没传 files，自动构建 Daemon + OpenCode + Claude Code + Codex 完整 Client bundle。
  let otaFiles = files;
  let bundleHash = '';
  let bundleVersion = '';
  if (!otaFiles) {
    const bundle = buildClientOtaBundle(agent.client_version);
    if (bundle.missing.length > 0) {
      res.status(500).json({ error: 'Client OTA bundle 源文件不完整', missing: bundle.missing });
      return;
    }
    otaFiles = bundle.files;
    bundleHash = bundle.bundle_hash;
    bundleVersion = bundle.version;
  }

  // 推送到 Daemon
  try {
    const payload = {
      files: otaFiles,
      restart_agents: restart,
      ...(bundleHash ? { bundle_hash: bundleHash, client_version: bundleVersion } : {}),
    };
    const result = await pushClientOta(daemonUrl, payload);
    console.log(`[OTA] 推送到 ${agent_name} (${daemonUrl}): applied=${result.applied} failed=${result.failed} restarted=${result.restarted} attempts=${result.attempts}`);
    res.json({ target: agent_name, daemon: daemonUrl, ...(result as object) });
  } catch (err: any) {
    res.status(502).json({ error: `Daemon 不可达: ${err.message}`, daemon: daemonUrl });
  }
});

/**
 * GET /api/ota/status
 *
 * 查看全网 Plugin 版本状态（哪些 client 版本落后）
 */
router.get('/ota/status', (_req: Request, res: Response) => {
  const agents = agentRegistry.listAll();
  const latestHash = getClientOtaBundleHash();
  res.json({
    latest_hash: latestHash,
    latest_bundle_hash: latestHash,
    agents: agents.map(a => ({
      agent_name: a.agent_name,
      status: a.status,
      client_endpoint: a.client_endpoint,
      client_version: a.client_version,
      bundle_hash: a.plugin_hash,
      up_to_date: a.plugin_hash === latestHash,
    })),
  });
});

export default router;
