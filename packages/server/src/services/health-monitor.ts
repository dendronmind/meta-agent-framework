import { agentRegistry } from './agent-registry';
import { eventBus } from './event-bus';
import { workflowEngine } from './workflow-engine';
import { serverAuthHeaders } from '../auth';

const HEARTBEAT_TIMEOUT_MS = 5_000;    // 5s 无心跳 → offline（心跳间隔 1s + 4s 裕量）
const DEAD_TIMEOUT_MS = 30_000;        // 30s 无心跳 → dead
const LAUNCHING_GRACE_MS = 90_000;     // 90s — busy 的 opencode agent 宽限期（Daemon 自动拉起 serve 需要时间）
const CHECK_INTERVAL_MS = 3_000;       // 3s 检查一次（心跳 1s，超时 5s，3s 间隔确保及时发现）

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    console.log(`[HealthMonitor] Started (check every ${CHECK_INTERVAL_MS / 1000}s)`);
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async check(): Promise<void> {
    const now = Date.now();
    // 按 agent 逐个检查（不按用户聚合，避免一个 agent 的心跳覆盖另一个）
    const agents = agentRegistry.listAll();

    for (const agent of agents) {
      if ((agent.status as string) === 'dead' || (agent.status as string) === 'stopped') continue;

      const elapsed = now - new Date(agent.last_heartbeat).getTime();

      // busy 的 opencode agent 可能正在被 Daemon 自动拉起 serve，给予更长宽限期
      const isBusyOpencode = agent.status === 'busy' && (agent.runtime || 'opencode') === 'opencode';
      const deadThreshold = isBusyOpencode ? LAUNCHING_GRACE_MS : DEAD_TIMEOUT_MS;

      if (elapsed > deadThreshold && (agent.status as string) !== 'dead') {
        if (isBusyOpencode) {
          console.warn(`[HealthMonitor] ${agent.agent_name} — busy opencode agent 超过 ${LAUNCHING_GRACE_MS / 1000}s 仍无心跳，标记 dead`);
        }
        this.markAgentDead(agent);
      } else if (elapsed > HEARTBEAT_TIMEOUT_MS && !['offline', 'dead'].includes(agent.status as string)) {
        this.markAgentOffline(agent);
      }
    }
  }

  private markAgentOffline(agent: { id: string; agent_name: string; user_id: string; host_user: string }): void {
    agentRegistry.updateStatus(agent.id, 'offline');
    console.log(`[HealthMonitor] ${agent.agent_name} (${agent.user_id}@${agent.host_user}) → OFFLINE`);
    eventBus.emit({
      type: 'client_offline',
      data: { user_id: agent.user_id, host_user: agent.host_user, agent_name: agent.agent_name },
      timestamp: new Date().toISOString(),
    });
  }

  private markAgentDead(agent: { id: string; agent_name: string; user_id: string; host_user: string }): void {
    agentRegistry.updateStatus(agent.id, 'dead');
    console.log(`[HealthMonitor] ${agent.agent_name} (${agent.user_id}@${agent.host_user}) → DEAD`);
    eventBus.emit({
      type: 'client_dead',
      data: { user_id: agent.user_id, host_user: agent.host_user, agent_name: agent.agent_name },
      timestamp: new Date().toISOString(),
    });

    // 联动 WorkflowEngine：强制 fail 该 agent 的 running 节点
    workflowEngine.failRunningNodesByAgent(agent.agent_name);
  }

  async restartClient(endpoint: string): Promise<{ success: boolean; message: string }> {
    try {
      const url = `${endpoint}/restart`;
      const res = await fetch(url, {
        method: 'POST',
        headers: serverAuthHeaders('POST', url),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { success: true, message: 'Restart signal sent' };
      return { success: false, message: `Responded ${res.status}` };
    } catch (err: any) {
      return { success: false, message: `Unreachable: ${err.message}` };
    }
  }
}

export const healthMonitor = new HealthMonitor();
