import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { eventBus } from './event-bus';
import { getRegistry } from './registry';
import { SERVER_VERSION, CLIENT_MIN_VERSION } from '../types';
import { getConfig } from '../config';
import type { Agent, AgentStatus, ClientRegisterPayload, AgentInfo, HeartbeatPayload } from '../types';

export class AgentRegistry {

  // OTA 冷却：同一个用户 5 分钟内只触发一次
  private otaCooldown = new Map<string, number>();
  private readonly OTA_COOLDOWN_MS = 5 * 60 * 1000;

  // 上次注册的状态缓存：只在状态变化时打日志（避免刷屏）
  private lastLoggedStatus = new Map<string, string>();  // agent_name → status
  private lastRegisteredAgents = '';  // 上次注册的 agent 列表指纹

  private canTriggerOTA(key: string): boolean {
    const last = this.otaCooldown.get(key) || 0;
    if (Date.now() - last < this.OTA_COOLDOWN_MS) return false;
    this.otaCooldown.set(key, Date.now());
    return true;
  }

  // ============================================================
  // 注册 / 注销
  // ============================================================

  /** Client 注册（一个用户 + 其所有 agent，每个 agent 一行） */
  registerClient(payload: ClientRegisterPayload): Agent[] {
    const db = getDb();
    const now = new Date().toISOString();

    // 策略：外部注册表管理的 agent 不能随意删除
    //   - 受管理的 agent：UPDATE（更新 endpoint/status/skills/mcps）
    //   - 动态 agent：先删旧的再 INSERT（全量同步）
    const incomingNames = new Set(payload.agents.map(a => a.agent_name));

    // 不再删除旧 agent——多个 Client（opencode + Claude Code）可能各自注册不同 agent
    // 每个 agent 通过下面的 upsert/insert 更新，不在列表里的保持原样（靠心跳超时自然下线）

    const clientVersion = payload.client_version || '';
    const clientPluginHash = payload.plugin_hash || '';
    const clientDaemonPort = payload.daemon_port || 0;
    // Daemon 可以在注册时上报每个 agent 的实际状态（在线/离线），避免僵尸 agent 被标 online
    const agentStatuses: Record<string, string> = (payload as any).agent_statuses || {};

    // 更新/插入 agent
    // 外部注册表管理的 agent：不覆盖 runtime（外部源是 runtime 的权威源）
    const registry = getRegistry();
    const upsertManaged = db.prepare(`
      UPDATE agents SET client_endpoint = ?, status = ?, last_heartbeat = ?,
        project_path = ?, capabilities = ?, mode = ?, skills = ?, mcps = ?,
        client_version = ?, plugin_hash = ?, daemon_port = ?
      WHERE user_id = ? AND host_user = ? AND agent_name = ?
    `);
    const insertNew = db.prepare(`
      INSERT OR REPLACE INTO agents (id, user_id, host_user, client_endpoint, status, last_heartbeat, agent_name, project_path, capabilities, mode, runtime, skills, mcps, client_version, plugin_hash, daemon_port, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const agents: Agent[] = [];
    for (const info of payload.agents) {
      // Daemon 上报的状态优先，没上报的默认 online（向后兼容旧版 Daemon）
      const agentStatus = agentStatuses[info.agent_name] || 'online';

      if (registry.isManaged(info.agent_name)) {
        // 受管理的 agent → UPDATE（保留原记录 ID）
        upsertManaged.run(
          payload.client_endpoint, agentStatus, now,
          info.project_path || '', info.capabilities || '',
          info.mode || 'subagent',
          JSON.stringify(info.skills || []), JSON.stringify(info.mcps || []),
          clientVersion, clientPluginHash, clientDaemonPort,
          payload.user_id, payload.host_user, info.agent_name
        );
        const existing = db.prepare(
          'SELECT * FROM agents WHERE user_id = ? AND host_user = ? AND agent_name = ?'
        ).get(payload.user_id, payload.host_user, info.agent_name) as Agent | undefined;
        if (existing) agents.push(existing);
      } else {
        // 动态 agent → INSERT
        const id = uuidv4();
        insertNew.run(
          id, payload.user_id, payload.host_user, payload.client_endpoint,
          agentStatus, now, info.agent_name, info.project_path || '',
          info.capabilities || '', info.mode || 'subagent',
          info.runtime || 'opencode',
          JSON.stringify(info.skills || []), JSON.stringify(info.mcps || []),
          clientVersion, clientPluginHash, clientDaemonPort,
          now
        );
        agents.push(this.getById(id)!);
      }
      // 只在状态变化时打日志
      const lastStatus = this.lastLoggedStatus.get(info.agent_name);
      if (lastStatus !== agentStatus) {
        const sk = (info.skills || []).map(s => s.name).join(', ') || '-';
        const mc = (info.mcps || []).map(m => m.name).join(', ') || '-';
        console.log(`  [${info.agent_name}] ${agentStatus} (${payload.user_id}@${payload.host_user}) v=${clientVersion || '?'} skills=[${sk}] mcps=[${mc}]`);
        this.lastLoggedStatus.set(info.agent_name, agentStatus);
      }
    }

    // 只在 agent 列表或状态变化时打日志 + 推送外部注册表
    const agentsFP = agents.map(a => a.agent_name).sort().join(',');
    const agentsChanged = agentsFP !== this.lastRegisteredAgents;
    if (agentsChanged) {
      console.log(`[Registry] ${payload.user_id}(${payload.host_user}) registered ${agents.length} agents: [${agentsFP}]`);
      this.lastRegisteredAgents = agentsFP;
      // 异步回写外部注册表
      for (const agent of agents) {
        registry.pushAgent(agent).catch(() => {});
      }
    }

    eventBus.emit({
      type: 'client_registered',
      data: {
        user_id: payload.user_id,
        host_user: payload.host_user,
        endpoint: payload.client_endpoint,
        agent_count: agents.length,
        agent_names: agents.map(a => a.agent_name),
      },
      timestamp: now,
    });

    // 版本检查 → 自动触发 OTA（带冷却）
    if (clientVersion && clientVersion < CLIENT_MIN_VERSION) {
      const otaKey = `${payload.user_id}:${payload.host_user}`;
      if (this.canTriggerOTA(otaKey)) {
        console.log(`[OTA] ⚠ ${payload.user_id} client v=${clientVersion} < min=${CLIENT_MIN_VERSION}，触发 OTA`);
        if (agents.length > 0) {
          this.triggerOTA(agents[0]).catch(() => {});
        }
      }
    }

    return agents;
  }

  /** 同步 agent 列表（Client 检测到文件变更后调用） */
  syncAgents(userId: string, hostUser: string, clientEndpoint: string, agentInfos: AgentInfo[]): Agent[] {
    return this.registerClient({
      user_id: userId,
      host_user: hostUser,
      client_endpoint: clientEndpoint,
      agents: agentInfos,
    });
  }

  /** 注销（删除该用户的所有 agent） */
  unregisterClient(userId: string, hostUser: string): number {
    const db = getDb();
    const result = db.prepare('DELETE FROM agents WHERE user_id = ? AND host_user = ?')
      .run(userId, hostUser);
    return result.changes;
  }

  // ============================================================
  // 心跳
  // ============================================================

  /** 心跳：更新心跳时间，按上报的 agent_statuses 精确恢复状态 */
  heartbeat(userId: string, hostUser: string, payload: HeartbeatPayload): number {
    const db = getDb();
    const now = new Date().toISOString();
    const registry = getRegistry();

    // 1. 按上报的 agent_statuses 精确更新心跳时间和状态（只更新上报了的 agent）
    let changes = 0;
    if (payload.agent_statuses) {
      for (const [agentName, status] of Object.entries(payload.agent_statuses)) {
        // 更新该 agent 的心跳时间
        db.prepare(`
          UPDATE agents SET last_heartbeat = ? WHERE user_id = ? AND host_user = ? AND agent_name = ?
        `).run(now, userId, hostUser, agentName);
        changes++;

        // 先查当前状态，只在真正变化时更新 + 打日志
        const current = db.prepare(
          'SELECT status FROM agents WHERE user_id = ? AND host_user = ? AND agent_name = ?'
        ).get(userId, hostUser, agentName) as { status: string } | undefined;
        const oldStatus = current?.status || '';

        if (oldStatus && oldStatus !== status) {
          db.prepare(`
            UPDATE agents SET status = ? WHERE user_id = ? AND host_user = ? AND agent_name = ?
          `).run(status, userId, hostUser, agentName);
          console.log(`[Registry] ${agentName}: ${oldStatus} → ${status}`);
          eventBus.emit({
            type: 'client_revived',
            data: { user_id: userId, host_user: hostUser, agent_name: agentName },
            timestamp: now,
          });
          // 异步回写外部注册表
          registry.pushStatus(agentName, status).catch(() => {});
        }
      }
    }

    // 3. 更新版本信息
    if (payload.client_version || payload.plugin_hash || payload.daemon_port) {
      db.prepare(`
        UPDATE agents SET client_version = COALESCE(NULLIF(?, ''), client_version),
          plugin_hash = COALESCE(NULLIF(?, ''), plugin_hash),
          daemon_port = CASE WHEN ? > 0 THEN ? ELSE daemon_port END
        WHERE user_id = ? AND host_user = ?
      `).run(
        payload.client_version || '', payload.plugin_hash || '',
        payload.daemon_port || 0, payload.daemon_port || 0,
        userId, hostUser,
      );
    }

    // 4. 版本检查 → 自动触发 OTA（带冷却，同一用户 5 分钟只推一次）
    if (payload.client_version && payload.client_version < CLIENT_MIN_VERSION) {
      const otaKey = `${userId}:${hostUser}`;
      if (this.canTriggerOTA(otaKey)) {
        console.log(`[OTA] ⚠ ${userId}(${hostUser}) client v=${payload.client_version} < min=${CLIENT_MIN_VERSION}，触发 OTA`);
        const userAgents = this.listByUser(userId).filter(a => a.host_user === hostUser && a.status === 'online');
        if (userAgents.length > 0) {
          this.triggerOTA(userAgents[0]).catch(() => {});
        }
      } else {
        console.log(`[OTA] ${userId}(${hostUser}) client v=${payload.client_version} 需要更新，冷却期内，跳过`);
      }
    }

    // 5. 增量更新 skills/mcps（进化后、配置变更后触发）
    if (payload.agent_inventory) {
      const updateSkills = db.prepare(`
        UPDATE agents SET skills = ? WHERE user_id = ? AND host_user = ? AND agent_name = ?
      `);
      const updateMcps = db.prepare(`
        UPDATE agents SET mcps = ? WHERE user_id = ? AND host_user = ? AND agent_name = ?
      `);
      for (const [agentName, inv] of Object.entries(payload.agent_inventory)) {
        if (inv.skills) {
          updateSkills.run(JSON.stringify(inv.skills), userId, hostUser, agentName);
        }
        if (inv.mcps) {
          updateMcps.run(JSON.stringify(inv.mcps), userId, hostUser, agentName);
        }
        // 异步回写外部注册表
        registry.pushInventory(
          agentName,
          JSON.stringify(inv.skills || []),
          JSON.stringify(inv.mcps || []),
          true, // 正在心跳 = 在线
        ).catch(() => {});
      }
    }

    return changes;
  }

  // ============================================================
  // 状态更新
  // ============================================================

  /** 按 ID 更新状态 */
  updateStatus(agentId: string, status: AgentStatus): boolean {
    const changed = getDb().prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, agentId).changes > 0;
    if (changed) {
      const agent = this.getById(agentId);
      if (agent) {
        console.log(`  [${agent.agent_name}] ${status} (${agent.user_id}@${agent.host_user})`);
        // 异步回写外部注册表
        getRegistry().pushStatus(agent.agent_name, status).catch(() => {});
      }
    }
    return changed;
  }

  /**
   * 刷新 agent 的 last_heartbeat 到当前时间
   * 用于 workflow 派发时，让 HealthMonitor 从此刻开始计时宽限期
   */
  touchHeartbeat(agentId: string): void {
    getDb().prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?')
      .run(new Date().toISOString(), agentId);
  }

  /** 批量更新一个用户所有 agent 的状态 */
  updateUserStatus(userId: string, hostUser: string, status: AgentStatus): number {
    const agents = this.listByUser(userId).filter(a => a.host_user === hostUser);
    const changes = getDb().prepare('UPDATE agents SET status = ? WHERE user_id = ? AND host_user = ?')
      .run(status, userId, hostUser).changes;
    if (changes > 0) {
      const registry = getRegistry();
      for (const a of agents) {
        console.log(`  [${a.agent_name}] ${status} (${userId}@${hostUser})`);
        // 异步回写外部注册表
        registry.pushStatus(a.agent_name, status).catch(() => {});
      }
    }
    return changes;
  }

  // ============================================================
  // 查询
  // ============================================================

  getById(id: string): Agent | undefined {
    return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
  }

  deleteById(id: string): boolean {
    const result = getDb().prepare('DELETE FROM agents WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listAll(): Agent[] {
    return getDb().prepare('SELECT * FROM agents ORDER BY user_id, agent_name').all() as Agent[];
  }

  listByUser(userId: string): Agent[] {
    return getDb().prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY agent_name').all(userId) as Agent[];
  }

  listUsers(): { user_id: string; host_user: string; client_endpoint: string; status: string; last_heartbeat: string; agent_count: number }[] {
    return getDb().prepare(`
      SELECT user_id, host_user, client_endpoint,
             MIN(status) as status,
             MAX(last_heartbeat) as last_heartbeat,
             COUNT(*) as agent_count
      FROM agents
      GROUP BY user_id, host_user
      ORDER BY user_id
    `).all() as any[];
  }

  findByName(name: string): Agent[] {
    return getDb().prepare(`
      SELECT * FROM agents WHERE agent_name = ? AND status IN ('online', 'busy')
    `).all(name) as Agent[];
  }

  findByCapability(keyword: string): Agent[] {
    return getDb().prepare(`
      SELECT * FROM agents WHERE capabilities LIKE ? AND status = 'online'
    `).all(`%${keyword}%`) as Agent[];
  }

  // ============================================================
  // OTA
  // ============================================================

  /** 自动触发 OTA：读取本地最新 Plugin 文件，推送到 Client 的 Daemon */
  async triggerOTA(agent: Agent): Promise<void> {
    // Node Daemon 使用固定端口，优先从 daemon_port 字段取，兜底从 client_endpoint 提取
    const clientUrl = new URL(agent.client_endpoint);
    const daemonPort = agent.daemon_port || parseInt(clientUrl.port) || getConfig().daemon.port;
    const daemonUrl = `http://${clientUrl.hostname}:${daemonPort}`;

    // 读取本地最新 Plugin 文件
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { createHash } = await import('crypto');

    const pluginDir = join(process.cwd(), 'plugins', 'opencode-plugin-meta-agent-framework');
    const daemonFile = join(process.cwd(), 'plugins', 'node-daemon', 'daemon.mjs');
    const files: { path: string; content: string; hash: string }[] = [];

    for (const [filePath, remoteName] of [
      [join(pluginDir, 'index.js'), 'index.js'],
      [daemonFile, 'daemon.mjs'],
      [join(pluginDir, 'package.json'), 'package.json'],
    ] as const) {
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex').substring(0, 16);
      files.push({ path: `plugin/${remoteName}`, content, hash });
    }

    if (files.length === 0) {
      console.log(`[OTA] ⚠ 本地 Plugin 文件未找到，跳过 OTA`);
      return;
    }

    try {
      console.log(`[OTA] 🚀 自动推送到 ${agent.agent_name} (${daemonUrl}), ${files.length} 个文件...`);
      const res = await fetch(`${daemonUrl}/ota`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files,
          restart_agents: true,
          target_agents: [agent.agent_name],
          agent_info: { [agent.agent_name]: { directory: agent.project_path, session_id: null } },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const result = await res.json() as Record<string, unknown>;
        console.log(`[OTA] ✅ ${agent.agent_name}: applied=${result.applied} restarted=${result.restarted}`);
      } else {
        console.log(`[OTA] ❌ ${agent.agent_name}: HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.log(`[OTA] ❌ ${agent.agent_name}: Daemon 不可达 (${err.message})`);
    }
  }

  getStats(): { users_total: number; users_online: number; agents_total: number; agents_online: number } {
    const db = getDb();
    const agents = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
    const agentsOnline = db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'online'").get() as { c: number };
    const users = db.prepare('SELECT COUNT(DISTINCT user_id || host_user) as c FROM agents').get() as { c: number };
    const usersOnline = db.prepare("SELECT COUNT(DISTINCT user_id || host_user) as c FROM agents WHERE status = 'online'").get() as { c: number };
    return {
      users_total: users.c,
      users_online: usersOnline.c,
      agents_total: agents.c,
      agents_online: agentsOnline.c,
    };
  }
}

export const agentRegistry = new AgentRegistry();
