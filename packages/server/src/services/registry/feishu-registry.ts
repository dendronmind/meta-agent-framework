/**
 * FeishuRegistry — 飞书多维表格（bitable）作为外部注册源
 *
 * 飞书多维表格存储 Agent 注册信息，作为可选的外部权威源。
 *
 * 读取（启动时）：飞书 bitable → SQLite（拉取 agent 拓扑 + 建立 record_id 映射）
 * 回写（运行时）：状态/Skills/MCPs 变更 → 异步更新飞书 bitable
 *
 * 直接调飞书 Open API，用 feishu-mcp-pro 的 OAuth user token 认证。
 */

import { isServerAgentName } from '../../types';
import type { Agent, AgentRuntime, SkillInfo, McpInfo } from '../../types';
import type { ExternalRegistry } from './index';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getConfig } from '../../config';

// ============================================================
// 配置
// ============================================================

function getFeishuConfig() {
  const cfg = getConfig();
  return {
    bitableAppToken: cfg.feishu.bitable.app_token,
    bitableTableId: cfg.feishu.bitable.table_id,
    apiUrl: cfg.feishu.api_url,
    appId: cfg.feishu.app_id,
    appSecret: cfg.feishu.app_secret,
  };
}

/** feishu-mcp-pro 的 auth token 文件路径 */
const AUTH_FILE = join(homedir(), '.feishu-mcp-pro', 'auth.json');

// ============================================================
// OAuth Token 管理
// ============================================================

function readAuthFile(): any | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeAuthFile(auth: any): void {
  try {
    writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf-8');
  } catch (err: any) {
    console.error(`[FeishuRegistry] 写入 auth.json 失败: ${err.message}`);
  }
}

async function getAppAccessToken(): Promise<string | null> {
  const { apiUrl, appId, appSecret } = getFeishuConfig();
  try {
    const res = await fetch(`${apiUrl}/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as any;
    if (data.code === 0 && data.app_access_token) return data.app_access_token;
    console.error(`[FeishuRegistry] 获取 app_access_token 失败: code=${data.code} msg=${data.msg}`);
  } catch (err: any) {
    console.error(`[FeishuRegistry] 获取 app_access_token 异常: ${err.message}`);
  }
  return null;
}

async function refreshAccessToken(auth: any): Promise<string | null> {
  const refreshToken = auth.refresh_token;
  if (!refreshToken) { console.error('[FeishuRegistry] 无 refresh_token'); return null; }

  const refreshExpiresAt = auth.refresh_expires_at || 0;
  if (refreshExpiresAt > 0 && Date.now() / 1000 > refreshExpiresAt) {
    console.error('[FeishuRegistry] refresh_token 已过期，需要重新 OAuth 登录（重启 opencode）');
    return null;
  }

  const appToken = await getAppAccessToken();
  if (!appToken) return null;

  const { apiUrl } = getFeishuConfig();
  try {
    const res = await fetch(`${apiUrl}/authen/v1/oidc/refresh_access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${appToken}` },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as any;
    if (data.code === 0 && data.data?.access_token) {
      const now = Date.now() / 1000;
      const newAuth = {
        ...auth,
        access_token: data.data.access_token,
        refresh_token: data.data.refresh_token || refreshToken,
        expires_at: now + (data.data.expires_in || 7200),
        refresh_expires_at: now + (data.data.refresh_expires_in || 2592000),
      };
      writeAuthFile(newAuth);
      console.log(`[FeishuRegistry] ✅ token 刷新成功（有效期 ${data.data.expires_in || 7200}s）`);
      return data.data.access_token;
    }
    console.error(`[FeishuRegistry] 刷新 token 失败: code=${data.code} msg=${data.message || data.msg}`);
  } catch (err: any) {
    console.error(`[FeishuRegistry] 刷新 token 异常: ${err.message}`);
  }
  return null;
}

async function getAccessToken(): Promise<string | null> {
  const auth = readAuthFile();
  if (!auth?.access_token) return null;

  const expiresAt = auth.expires_at || 0;
  if (expiresAt > 0 && Date.now() / 1000 < expiresAt - 300) {
    return auth.access_token;
  }

  console.log('[FeishuRegistry] access_token 已过期，自动刷新...');
  return await refreshAccessToken(auth);
}

// ============================================================
// 飞书 Open API 调用
// ============================================================

async function fetchBitableRecords(appToken: string, tableId: string): Promise<any[]> {
  const token = await getAccessToken();
  if (!token) throw new Error('无法获取飞书 access_token');

  const { apiUrl } = getFeishuConfig();
  const allRecords: any[] = [];
  let pageToken: string | undefined;

  do {
    let url = `${apiUrl}/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=100`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json() as any;
    if (data.code !== 0) {
      throw new Error(`飞书 API 错误: code=${data.code}, msg=${data.msg}`);
    }

    const items = data.data?.items || [];
    allRecords.push(...items);
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);

  return allRecords;
}

async function updateBitableRecord(recordId: string, fields: Record<string, any>): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) return false;

  const { apiUrl, bitableAppToken, bitableTableId } = getFeishuConfig();
  try {
    const url = `${apiUrl}/bitable/v1/apps/${bitableAppToken}/tables/${bitableTableId}/records/${recordId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await res.json() as any;
    if (data.code !== 0) {
      console.error(`[FeishuRegistry] 回写失败 (record=${recordId}): code=${data.code}, msg=${data.msg}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[FeishuRegistry] 回写异常 (record=${recordId}): ${err.message}`);
    return false;
  }
}

// ============================================================
// 记录解析
// ============================================================

function extractTextValue(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    return val.map((item: any) => item?.text || '').join('');
  }
  if (typeof val === 'object' && val.text) return val.text;
  return String(val);
}

function formatSkillsForFeishu(skillsJson: string): string {
  try {
    const skills: SkillInfo[] = JSON.parse(skillsJson || '[]');
    if (skills.length === 0) return '';
    return skills.map(s => s.name).join('\n');
  } catch { return ''; }
}

function formatMcpsForFeishu(mcpsJson: string, agentOnline: boolean): string {
  try {
    const mcps: McpInfo[] = JSON.parse(mcpsJson || '[]');
    if (mcps.length === 0) return '';
    return mcps.map(m => {
      const status = agentOnline && m.enabled !== false ? 'connected' : 'disconnected';
      return `${m.name} [${status}]`;
    }).join('\n');
  } catch { return ''; }
}

// ============================================================
// FeishuRegistry 实现
// ============================================================

export class FeishuRegistry implements ExternalRegistry {
  private enabled = false;
  /** agent_name → 飞书 record_id 映射 */
  private recordIdMap = new Map<string, string>();

  init(): boolean {
    if (process.env.FEISHU_SYNC_DISABLED === '1') {
      console.log('[FeishuRegistry] ⚠️  飞书同步已通过 FEISHU_SYNC_DISABLED=1 关闭');
      this.enabled = false;
      return false;
    }
    if (!existsSync(AUTH_FILE)) {
      console.warn(`[FeishuRegistry] ⚠️  未找到 ${AUTH_FILE}，飞书同步不可用`);
      this.enabled = false;
      return false;
    }
    const { bitableAppToken, bitableTableId } = getFeishuConfig();
    this.enabled = true;
    console.log(`[Registry] 模式: feishu（双向 bitable）, app=${bitableAppToken}, table=${bitableTableId}`);
    return true;
  }

  get isEnabled(): boolean { return this.enabled; }

  /** 从飞书多维表格拉取 agent 拓扑 */
  async pull(): Promise<Agent[]> {
    if (!this.enabled) return [];
    try {
      this.recordIdMap.clear();
      const { bitableAppToken, bitableTableId } = getFeishuConfig();
      const records = await fetchBitableRecords(bitableAppToken, bitableTableId);
      const agents = this.parseRecords(records);
      console.log(`[FeishuRegistry] 从飞书多维表格拉取了 ${agents.length} 条 agent 记录 (${this.recordIdMap.size} 条映射)`);
      return agents;
    } catch (err: any) {
      console.error(`[FeishuRegistry] 拉取失败: ${err.message}`);
      return [];
    }
  }

  /** 回写 agent 状态到飞书 */
  async pushStatus(agentName: string, status: string): Promise<void> {
    if (!this.enabled) return;
    const recordId = this.recordIdMap.get(agentName);
    if (!recordId) return;

    const ok = await updateBitableRecord(recordId, {
      '状态': status,
      '最后心跳': Date.now(),
    });
    if (ok) {
      console.log(`[FeishuRegistry] ↑ 状态回写: ${agentName} → ${status}`);
    }
  }

  /** 回写 Skills + MCPs 到飞书 */
  async pushInventory(agentName: string, skillsJson: string, mcpsJson: string, agentOnline: boolean): Promise<void> {
    if (!this.enabled) return;
    const recordId = this.recordIdMap.get(agentName);
    if (!recordId) return;

    const fields: Record<string, any> = {
      'Skills': formatSkillsForFeishu(skillsJson),
      'MCPs': formatMcpsForFeishu(mcpsJson, agentOnline),
    };

    const ok = await updateBitableRecord(recordId, fields);
    if (ok) {
      console.log(`[FeishuRegistry] ↑ inventory 回写: ${agentName}`);
    }
  }

  /** 回写 Agent 全量信息 */
  async pushAgent(agent: Agent): Promise<void> {
    if (!this.enabled) return;
    const recordId = this.recordIdMap.get(agent.agent_name);
    if (!recordId) return;

    const isOnline = agent.status === 'online' || agent.status === 'busy';
    const fields: Record<string, any> = {
      '状态': agent.status,
      '最后心跳': Date.now(),
      'Skills': formatSkillsForFeishu(agent.skills),
      'MCPs': formatMcpsForFeishu(agent.mcps, isOnline),
    };

    if (agent.client_endpoint) {
      fields['Client 地址'] = { text: agent.client_endpoint, link: agent.client_endpoint };
    }

    const ok = await updateBitableRecord(recordId, fields);
    if (ok) {
      console.log(`[FeishuRegistry] ↑ 全量回写: ${agent.agent_name} → ${agent.status}`);
    }
  }

  /** 判断某个 agent 是否在飞书表中注册 */
  isManaged(agentName: string): boolean {
    return this.recordIdMap.has(agentName);
  }

  /** 获取所有飞书表中的 agent 名称 */
  getManagedNames(): string[] {
    return Array.from(this.recordIdMap.keys());
  }

  // ============================================================
  // 内部方法：解析 bitable 记录
  // ============================================================

  private parseRecords(records: any[]): Agent[] {
    const agents: Agent[] = [];

    for (const rec of records) {
      const f = rec.fields || {};
      const recordId = rec.record_id || rec.id;

      const agentName = extractTextValue(f['Agent 名称']);
      if (!agentName) continue;
      if (isServerAgentName(agentName)) continue;

      if (recordId) {
        this.recordIdMap.set(agentName, recordId);
      }

      let endpoint = '';
      const clientAddr = f['Client 地址'];
      if (typeof clientAddr === 'string') endpoint = clientAddr;
      else if (clientAddr?.link) endpoint = clientAddr.link;
      else if (clientAddr?.text) endpoint = clientAddr.text;

      const runtimeRaw = (extractTextValue(f['运行时']) || '').trim();
      const runtime: AgentRuntime = runtimeRaw === 'claude-code'
        ? 'claude-code'
        : runtimeRaw === 'codex'
          ? 'codex'
          : 'opencode';

      let heartbeat = '';
      const hbRaw = f['最后心跳'];
      if (typeof hbRaw === 'number') heartbeat = new Date(hbRaw).toISOString();
      else if (typeof hbRaw === 'string') heartbeat = hbRaw;

      const skillsText = extractTextValue(f['Skills']) || '';
      const skills = skillsText
        ? skillsText.split(/[\n,]/).map((s: string) => ({ name: s.trim() })).filter((s: any) => s.name && s.name !== '(待上线采集)')
        : [];

      const mcpsText = extractTextValue(f['MCPs']) || '';
      const mcps = mcpsText
        ? mcpsText.split(/[\n,]/).map((m: string) => {
            const trimmed = m.trim();
            if (!trimmed || trimmed === '(待上线采集)') return null;
            const match = trimmed.match(/^(.+?)\s*\[(connected|disconnected)\]\s*$/);
            if (match) return { name: match[1].trim(), enabled: match[2] === 'connected' };
            return { name: trimmed, enabled: true };
          }).filter(Boolean)
        : [];

      agents.push({
        id: '',
        user_id: extractTextValue(f['用户']) || '',
        host_user: extractTextValue(f['宿主机用户名']) || '',
        client_endpoint: endpoint,
        status: (extractTextValue(f['状态']) as Agent['status']) || 'offline',
        last_heartbeat: heartbeat || new Date().toISOString(),
        agent_name: agentName,
        project_path: extractTextValue(f['项目路径']) || '',
        capabilities: extractTextValue(f['能力标签']) || '',
        mode: extractTextValue(f['模式']) || 'subagent',
        runtime,
        skills: JSON.stringify(skills),
        mcps: JSON.stringify(mcps),
        client_version: '',
        plugin_hash: '',
        daemon_port: 0,
        registered_at: new Date().toISOString(),
      });
    }

    return agents;
  }
}
