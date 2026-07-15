/**
 * Evolution Service — 主→从进化编排
 *
 * 负责：
 *   1. 构建进化指令包（EvolveCommand）
 *   2. 推送到目标 Client（单个或广播）
 *   3. 收集执行结果
 *
 * 设计原则：
 *   - Server 只声明"做什么"，不关心远端是 opencode 还是 claude-code
 *   - Client 根据自身 runtime 映射到正确的物理路径
 *   - 每个 action 按顺序执行，前一个失败则后续跳过
 */

import { v4 as uuidv4 } from 'uuid';
import { agentRegistry } from './agent-registry';
import { eventBus } from './event-bus';
import type {
  Agent, AgentRuntime, EvolveCommand, EvolveAction, EvolveFile, EvolveResult,
} from '../types';

// ============================================================
// SKILL.md frontmatter 校验
// runtime skill 要求 SKILL.md 以 YAML frontmatter 开头（name + description），
// 否则 skills 列表可能不显示。
// ============================================================

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateSkillFiles(files: EvolveFile[]): string | null {
  const skillMd = files.find(f => f.relative_path.endsWith('/SKILL.md') || f.relative_path === 'SKILL.md');
  if (!skillMd) return null;  // 没推 SKILL.md 就不校验

  const content = skillMd.content;
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return `SKILL.md 缺少 YAML frontmatter（必须以 --- 开头）`;
  }
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return `SKILL.md frontmatter 未闭合（缺少结束 ---）`;

  const fm = content.slice(4, endIdx);
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return `SKILL.md frontmatter 缺少 name 字段`;
  if (!SKILL_NAME_RE.test(nameMatch[1].trim())) {
    return `SKILL.md name 格式非法（需全小写字母数字+连字符）: "${nameMatch[1].trim()}"`;
  }
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  if (!descMatch || !descMatch[1].trim()) return `SKILL.md frontmatter 缺少 description 字段`;
  if (descMatch[1].trim().length > 1024) return `SKILL.md description 超过 1024 字符`;

  return null;  // 校验通过
}

// ============================================================
// 进化结果存储（内存）
// ============================================================

const evolveResults = new Map<string, EvolveResult>();

// ============================================================
// 公开 API
// ============================================================

export class EvolutionService {

  /**
   * 推送 skill 到指定 agent 所在的 Client
   *
   * 最常用的 L1 场景：传文件，不需要重启
   */
  async pushSkill(
    agentName: string,
    skillName: string,
    files: EvolveFile[],
  ): Promise<{ evolve_id: string; pushed: boolean; message: string }> {
    // SKILL.md frontmatter 校验（仅警告，不阻止推送）
    const fmError = validateSkillFiles(files);
    if (fmError) {
      console.log(`[Evolve] ⚠ ${fmError}（runtime skills 可能不显示，但不阻止推送）`);
    }

    const agent = this.findOnlineAgent(agentName);
    if (!agent) return { evolve_id: '', pushed: false, message: `Agent "${agentName}" not online` };

    const cmd: EvolveCommand = {
      evolve_id: uuidv4(),
      title: `推送 skill: ${skillName} → ${agentName}`,
      target_runtime: agent.runtime,
      actions: [{
        type: 'push_files',
        target: 'skill',
        files: files.map(f => ({
          // skill 文件的 relative_path 前缀加上 skill 名称
          relative_path: f.relative_path.startsWith(skillName + '/')
            ? f.relative_path
            : `${skillName}/${f.relative_path}`,
          content: f.content,
          encoding: f.encoding,
        })),
      }],
    };

    return this.pushToClient(agent, cmd);
  }

  /**
   * 推送 agent 配置到远端
   *
   * L2 场景：传文件 + 可选重启
   */
  async pushAgentConfig(
    agentName: string,
    files: EvolveFile[],
    opts: { restart?: boolean; project_path?: string } = {},
  ): Promise<{ evolve_id: string; pushed: boolean; message: string }> {
    const agent = this.findOnlineAgent(agentName);
    if (!agent) return { evolve_id: '', pushed: false, message: `Agent "${agentName}" not online` };

    const actions: EvolveAction[] = [{
      type: 'push_files',
      target: opts.project_path ? 'project_agent' : 'agent',
      project_path: opts.project_path || agent.project_path,
      files,
    }];

    if (opts.restart) {
      actions.push({ type: 'restart_agent' });
    }

    const cmd: EvolveCommand = {
      evolve_id: uuidv4(),
      title: `更新 agent 配置: ${agentName}`,
      target_runtime: agent.runtime,
      actions,
    };

    return this.pushToClient(agent, cmd);
  }

  /**
   * 推送 MCP 配置更新
   *
   * L3 场景：更新配置 + 可选安装命令 + 重启
   */
  async pushMcpUpdate(
    agentName: string,
    configFiles: EvolveFile[],
    opts: { install_command?: string; project_path?: string } = {},
  ): Promise<{ evolve_id: string; pushed: boolean; message: string }> {
    const agent = this.findOnlineAgent(agentName);
    if (!agent) return { evolve_id: '', pushed: false, message: `Agent "${agentName}" not online` };

    const actions: EvolveAction[] = [{
      type: 'push_files',
      target: 'mcp_config',
      project_path: opts.project_path || agent.project_path,
      files: configFiles,
    }];

    if (opts.install_command) {
      actions.push({
        type: 'run_command',
        command: opts.install_command,
        cwd: opts.project_path || agent.project_path || '~',
        timeout_ms: 120_000,  // MCP 安装可能比较慢
      });
    }

    // MCP 变更后必须重启
    actions.push({ type: 'restart_agent' });

    const cmd: EvolveCommand = {
      evolve_id: uuidv4(),
      title: `MCP 更新: ${agentName}`,
      target_runtime: agent.runtime,
      actions,
    };

    return this.pushToClient(agent, cmd);
  }

  /**
   * 自定义进化：直接发送完整的 EvolveCommand
   */
  async evolve(
    agentName: string,
    command: Omit<EvolveCommand, 'evolve_id'>,
  ): Promise<{ evolve_id: string; pushed: boolean; message: string }> {
    const agent = this.findOnlineAgent(agentName);
    if (!agent) return { evolve_id: '', pushed: false, message: `Agent "${agentName}" not online` };

    const cmd: EvolveCommand = {
      ...command,
      evolve_id: uuidv4(),
      target_runtime: command.target_runtime || agent.runtime,
    };

    return this.pushToClient(agent, cmd);
  }

  /**
   * 广播进化：推送到所有 online 的 Client（去重 by endpoint）
   *
   * 典型场景：全网推送一个新 skill
   */
  async broadcast(
    command: Omit<EvolveCommand, 'evolve_id' | 'target_runtime'>,
  ): Promise<{ total: number; pushed: number; results: { endpoint: string; evolve_id: string; status: string }[] }> {
    const allAgents = agentRegistry.listAll().filter(a => a.status === 'online');

    // 按 client_endpoint 去重（一个 Client 只推一次）
    const endpointMap = new Map<string, Agent>();
    for (const a of allAgents) {
      if (!endpointMap.has(a.client_endpoint)) {
        endpointMap.set(a.client_endpoint, a);
      }
    }

    const results: { endpoint: string; evolve_id: string; status: string }[] = [];
    let pushed = 0;

    for (const [endpoint, agent] of endpointMap) {
      const cmd: EvolveCommand = {
        ...command,
        evolve_id: uuidv4(),
        target_runtime: agent.runtime,
      };

      const r = await this.pushToClient(agent, cmd);
      results.push({ endpoint, evolve_id: r.evolve_id, status: r.pushed ? 'pushed' : 'failed' });
      if (r.pushed) pushed++;
    }

    return { total: endpointMap.size, pushed, results };
  }

  /**
   * 接收 Client 回报的进化结果
   */
  reportResult(result: EvolveResult): void {
    evolveResults.set(result.evolve_id, result);
    const emoji = result.status === 'completed' ? '🎉' : '💀';
    console.log(`[Evolution] ${emoji} ${result.evolve_id}: ${result.status} (${result.duration_ms}ms)`);

    eventBus.emit({
      type: result.status === 'completed' ? 'evolve_completed' : 'evolve_failed',
      data: { evolve_id: result.evolve_id, status: result.status, actions: result.actions },
      timestamp: new Date().toISOString(),
    });
  }

  /** 查询进化结果 */
  getResult(evolveId: string): EvolveResult | undefined {
    return evolveResults.get(evolveId);
  }

  /** 列出所有进化结果 */
  listResults(): EvolveResult[] {
    return Array.from(evolveResults.values());
  }

  // ============================================================
  // 内部
  // ============================================================

  private findOnlineAgent(agentName: string): Agent | undefined {
    const agents = agentRegistry.listAll().filter(
      a => a.agent_name === agentName && (a.status === 'online' || a.status === 'busy')
    );
    return agents.length > 0 ? agents[0] : undefined;
  }

  private async pushToClient(
    agent: Agent,
    cmd: EvolveCommand,
  ): Promise<{ evolve_id: string; pushed: boolean; message: string }> {
    console.log(`[Evolution] 🧬 → ${agent.user_id}@${agent.host_user} (${agent.client_endpoint})`);
    console.log(`           title: "${cmd.title}"`);
    console.log(`           actions: ${cmd.actions.map(a => a.type).join(' → ')}`);
    console.log(`           runtime: ${cmd.target_runtime || 'auto'}`);

    eventBus.emit({
      type: 'evolve_started',
      data: {
        evolve_id: cmd.evolve_id,
        title: cmd.title,
        target: `${agent.user_id}@${agent.host_user}`,
        actions: cmd.actions.map(a => a.type),
      },
      timestamp: new Date().toISOString(),
    });

    try {
      const res = await fetch(`${agent.client_endpoint}/evolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Client responded ${res.status}`);
      return { evolve_id: cmd.evolve_id, pushed: true, message: 'Evolve command accepted' };
    } catch (err: any) {
      console.error(`[Evolution] ❌ Push failed → ${agent.client_endpoint}: ${err.message}`);
      return { evolve_id: cmd.evolve_id, pushed: false, message: err.message };
    }
  }
}

export const evolutionService = new EvolutionService();
