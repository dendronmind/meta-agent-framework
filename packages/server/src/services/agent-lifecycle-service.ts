import { serverAuthHeaders } from '../auth';
import type { Agent, AgentStatus, FrameworkExecution, Task, Workflow } from '../types';
import { isServerAgentName } from '../types';
import { agentRegistry } from './agent-registry';
import { codexConversationService } from './codex-conversation-service';
import { eventBus } from './event-bus';
import { executionService } from './execution-service';
import { taskDispatcher } from './task-dispatcher';
import { workflowEngine } from './workflow-engine';

const ACTIVE_WORKFLOW_NODE_STATUSES = new Set(['pending', 'queued', 'running']);
const ACTIVE_TASK_STATUSES = new Set(['pending', 'dispatched', 'running']);
const ACTIVE_EXECUTION_STATUSES = new Set(['queued', 'routing', 'running', 'cancelling']);
const VALID_STARTED_STATUSES = new Set<AgentStatus>(['online', 'standby', 'offline', 'busy', 'dead']);

export class AgentLifecycleError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface LifecycleOptions {
  force?: boolean;
  reason?: string;
}

interface CancelledActivity {
  executions: string[];
  workflows: string[];
  tasks: string[];
}

function daemonUrl(agent: Agent, pathname: string): string {
  const endpoint = new URL(agent.client_endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new AgentLifecycleError(422, 'Agent client_endpoint is not HTTP(S)');
  }
  return new URL(pathname, `${endpoint.protocol}//${endpoint.host}`).toString();
}

function taskTargetsAgent(task: Task, agent: Agent): boolean {
  if (task.assigned_agent_id === agent.id || task.assigned_agent_name === agent.agent_name) return true;
  try {
    const metadata = JSON.parse(String(task.metadata || '{}')) as Record<string, unknown>;
    return String(metadata.target_agent || '') === agent.agent_name;
  } catch {
    return false;
  }
}

function workflowTargetsAgent(workflow: Workflow, agentName: string): boolean {
  return workflow.status === 'running' && workflow.nodes.some(node =>
    node.agent_name === agentName && ACTIVE_WORKFLOW_NODE_STATUSES.has(node.status)
  );
}

function executionTargetsAgent(execution: FrameworkExecution, agentName: string): boolean {
  if (!ACTIVE_EXECUTION_STATUSES.has(execution.status)) return false;
  if (execution.selected_agent === agentName) return true;
  if (!execution.workflow_id) return false;
  const workflow = workflowEngine.get(execution.workflow_id);
  return Boolean(workflow && workflowTargetsAgent(workflow, agentName));
}

async function daemonPost(agent: Agent, pathname: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
  const url = daemonUrl(agent, pathname);
  const body = JSON.stringify(payload);
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentLifecycleError(502, `Agent Daemon unreachable: ${message}`);
  }

  const text = await response.text();
  let data: Record<string, any> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new AgentLifecycleError(
      response.status,
      String(data.error || data.message || `Agent Daemon responded ${response.status}`),
      data,
    );
  }
  return data;
}

export class AgentLifecycleService {
  private readonly operationTails = new Map<string, Promise<void>>();

  private async serialize<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(agentId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.operationTails.set(agentId, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(agentId) === tail) this.operationTails.delete(agentId);
    }
  }

  private requireAgent(agentId: string): Agent {
    const agent = agentRegistry.getById(agentId);
    if (!agent) throw new AgentLifecycleError(404, 'Agent not found');
    if (isServerAgentName(agent.agent_name)) {
      throw new AgentLifecycleError(409, 'Meta-Agent-Server is the control plane and cannot be stopped as a remote Agent');
    }
    if (!agent.client_endpoint) throw new AgentLifecycleError(409, 'Agent has no Client endpoint');
    return agent;
  }

  private activeActivity(agent: Agent): Record<string, unknown> {
    const workflows = workflowEngine.list().filter(item => workflowTargetsAgent(item, agent.agent_name));
    const tasks = taskDispatcher.list(undefined, 10_000).filter(task =>
      ACTIVE_TASK_STATUSES.has(task.status) && taskTargetsAgent(task, agent)
    );
    const executions = executionService.list().filter(item => executionTargetsAgent(item, agent.agent_name));
    const turns = codexConversationService.list(500, agent.id)
      .map(conversation => codexConversationService.activeTurn(conversation.id))
      .filter(Boolean);
    return {
      workflows: workflows.map(item => item.id),
      tasks: tasks.map(item => item.id),
      executions: executions.map(item => item.id),
      turns: turns.map(item => item!.id),
    };
  }

  private async cancelActivity(agent: Agent, reason: string): Promise<CancelledActivity> {
    const cancelled: CancelledActivity = { executions: [], workflows: [], tasks: [] };
    const executions = executionService.list().filter(item => executionTargetsAgent(item, agent.agent_name));
    for (const execution of executions) {
      await executionService.cancel(execution.id, reason);
      cancelled.executions.push(execution.id);
    }

    const workflows = workflowEngine.list().filter(item =>
      workflowTargetsAgent(item, agent.agent_name) && !executions.some(execution => execution.workflow_id === item.id)
    );
    for (const workflow of workflows) {
      await workflowEngine.cancel(workflow.id, reason);
      cancelled.workflows.push(workflow.id);
    }

    const tasks = taskDispatcher.list(undefined, 10_000).filter(task =>
      ACTIVE_TASK_STATUSES.has(task.status) && taskTargetsAgent(task, agent)
    );
    for (const task of tasks) {
      await taskDispatcher.cancel(task.id, reason);
      cancelled.tasks.push(task.id);
    }
    return cancelled;
  }

  async stop(agentId: string, options: LifecycleOptions = {}): Promise<Record<string, unknown>> {
    return this.serialize(agentId, () => this.stopUnlocked(agentId, options));
  }

  private async stopUnlocked(agentId: string, options: LifecycleOptions): Promise<Record<string, unknown>> {
    const agent = this.requireAgent(agentId);
    const force = options.force === true;
    const reason = String(options.reason || 'Agent stopped by administrator').trim().slice(0, 4000)
      || 'Agent stopped by administrator';
    if (agent.status === 'stopped') {
      return { ok: true, already_stopped: true, agent: agentRegistry.getById(agent.id) };
    }

    const activity = this.activeActivity(agent);
    const hasActivity = Object.values(activity).some(value => Array.isArray(value) && value.length > 0);
    if (hasActivity && !force) {
      throw new AgentLifecycleError(409, 'Agent has active work; cancel it first or explicitly request force=true', { activity });
    }
    // 先在 Server 侧占住 stopped 状态，阻止取消与远端关闭期间出现新的派发。
    const previousStatus = agent.status;
    agentRegistry.updateStatus(agent.id, 'stopped');
    let cancelled: CancelledActivity = { executions: [], workflows: [], tasks: [] };
    let remote: Record<string, any>;
    try {
      cancelled = force ? await this.cancelActivity(agent, reason) : cancelled;
      remote = await daemonPost(agent, '/agents/stop', {
        agent_name: agent.agent_name,
        runtime: agent.runtime,
        directory: agent.project_path,
        force,
        reason,
      });
    } catch (error) {
      agentRegistry.updateStatus(agent.id, previousStatus);
      throw error;
    }
    // Cancellation and a racing heartbeat can update the registry while the remote
    // executor is stopping. The persisted Daemon gate is authoritative on success.
    agentRegistry.updateStatus(agent.id, 'stopped');
    const interruptedTurns = force ? codexConversationService.interruptActiveTurnsForAgent(agent.id, reason) : [];
    const current = agentRegistry.getById(agent.id)!;
    eventBus.emit({
      type: 'agent_stopped',
      data: { agent_id: agent.id, agent_name: agent.agent_name, force, cancelled, interrupted_turns: interruptedTurns },
      timestamp: new Date().toISOString(),
    });
    return { ok: true, agent: current, cancelled, interrupted_turns: interruptedTurns, remote };
  }

  async start(agentId: string, options: LifecycleOptions = {}): Promise<Record<string, unknown>> {
    return this.serialize(agentId, () => this.startUnlocked(agentId, options));
  }

  private async startUnlocked(agentId: string, options: LifecycleOptions): Promise<Record<string, unknown>> {
    const agent = this.requireAgent(agentId);
    if (agent.status !== 'stopped') {
      return { ok: true, already_started: true, agent };
    }
    const reason = String(options.reason || 'Agent started by administrator').trim().slice(0, 4000)
      || 'Agent started by administrator';
    const remote = await daemonPost(agent, '/agents/start', {
      agent_name: agent.agent_name,
      runtime: agent.runtime,
      directory: agent.project_path,
      reason,
    });
    const reportedStatus = String(remote.status || 'offline') as AgentStatus;
    const status: AgentStatus = VALID_STARTED_STATUSES.has(reportedStatus) ? reportedStatus : 'offline';
    agentRegistry.updateStatus(agent.id, status);
    const current = agentRegistry.getById(agent.id)!;
    eventBus.emit({
      type: 'agent_started',
      data: { agent_id: agent.id, agent_name: agent.agent_name, status },
      timestamp: new Date().toISOString(),
    });
    return { ok: true, agent: current, remote };
  }
}

export const agentLifecycleService = new AgentLifecycleService();
