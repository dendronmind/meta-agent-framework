import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { agentRegistry } from './agent-registry';
import { eventBus } from './event-bus';
import { serverAuthHeaders } from '../auth';
import { codexManagedExecutionService, resolveCodexDelivery } from './codex-managed-execution-service';
import type { Agent, Task, TaskCreatePayload, TaskResultPayload } from '../types';

// ============================================================
// 确定性预判规则
// ============================================================
interface PreJudgeResult {
  action: 'dispatch' | 'skip' | 'need_ai';
  target_agent?: string;
  reason: string;
}

function preJudge(task: TaskCreatePayload): PreJudgeResult {
  const meta = task.metadata || {};

  if (task.target_agent) {
    return { action: 'dispatch', target_agent: task.target_agent, reason: 'target_agent specified' };
  }

  if (task.type === 'review') {
    const agents = agentRegistry.findByCapability('review');
    if (agents.length > 0) {
      return { action: 'dispatch', target_agent: agents[0].agent_name, reason: 'auto-match review capability' };
    }
  }

  if (task.type === 'bug' && task.priority === 'critical') {
    const agents = agentRegistry.findByCapability('bug');
    if (agents.length > 0) {
      return { action: 'dispatch', target_agent: agents[0].agent_name, reason: 'auto-match critical bug' };
    }
  }

  if (meta.source === 'gerrit-scanner') {
    const score = (meta.review_score as number) || 0;
    const age = (meta.age_days as number) || 0;
    const hasUnresolved = meta.has_unresolved_comments as boolean;

    if (score >= 2 && !hasUnresolved) {
      return { action: 'skip', reason: 'gerrit: already +2 with no unresolved comments' };
    }
    if (age > 7) {
      const agents = agentRegistry.findByCapability('escalate');
      if (agents.length > 0) {
        return { action: 'dispatch', target_agent: agents[0].agent_name, reason: `gerrit: age ${age}d > 7, escalate` };
      }
    }
    if (hasUnresolved) {
      const agents = agentRegistry.findByCapability('remind');
      if (agents.length > 0) {
        return { action: 'dispatch', target_agent: agents[0].agent_name, reason: 'gerrit: unresolved comments' };
      }
    }
  }

  return { action: 'need_ai', reason: 'no deterministic rule matched' };
}

// ============================================================
// 二次流转规则
// ============================================================
interface FlowDecision {
  action: 'done' | 'forward';
  target_agent?: string;
  reason: string;
}

function judgeFlowForward(task: Task, result: TaskResultPayload): FlowDecision {
  if (result.status === 'failed' && task.priority === 'critical') {
    const agents = agentRegistry.findByCapability('escalate');
    if (agents.length > 0) {
      return { action: 'forward', target_agent: agents[0].agent_name, reason: 'critical task failed' };
    }
  }

  if (task.type === 'review' && result.status === 'completed') {
    const lower = (result.result || '').toLowerCase();
    if (lower.includes('issue') || lower.includes('problem') || lower.includes('error')) {
      const agents = agentRegistry.findByCapability('report');
      if (agents.length > 0) {
        return { action: 'forward', target_agent: agents[0].agent_name, reason: 'review found issues' };
      }
    }
  }

  return { action: 'done', reason: 'no forward needed' };
}

// ============================================================
// TaskDispatcher
// ============================================================
export class TaskDispatcher {

  create(payload: TaskCreatePayload): Task {
    const db = getDb();
    const now = new Date().toISOString();
    const id = uuidv4();

    const judge = preJudge(payload);
    console.log(`[Dispatcher] PreJudge: ${judge.action} — ${judge.reason}`);

    if (judge.action === 'skip') {
      db.prepare(`
        INSERT INTO tasks (id, type, title, description, status, priority, result, metadata, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
      `).run(id, payload.type || 'custom', payload.title, payload.description || '',
        payload.priority || 'medium', `Skipped: ${judge.reason}`,
        JSON.stringify(payload.metadata || {}), now, now, now);
      return this.getById(id)!;
    }

    db.prepare(`
      INSERT INTO tasks (id, type, title, description, status, priority, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, payload.type || 'custom', payload.title, payload.description || '',
      payload.priority || 'medium', JSON.stringify(payload.metadata || {}), now, now);

    eventBus.emit({
      type: 'task_created',
      data: { task_id: id, title: payload.title, type: payload.type, judge: judge.action },
      timestamp: now,
    });

    if (judge.action === 'dispatch' && judge.target_agent) {
      this.dispatch(id, judge.target_agent);
    }

    return this.getById(id)!;
  }

  dispatch(taskId: string, agentName: string): { success: boolean; message: string } {
    const db = getDb();
    const task = this.getById(taskId);
    if (!task) return { success: false, message: 'Task not found' };
    if (task.status !== 'pending') return { success: false, message: `Task is ${task.status}` };

    // 单表：直接查 agents 表，找 online 的同名 agent
    const agents = agentRegistry.findByName(agentName);
    if (agents.length === 0) return { success: false, message: `No available agent: ${agentName}` };

    // 注册表保证 agent_name 唯一归属，直接取第一个
    const agent = agents[0];
    const now = new Date().toISOString();

    console.log(`[Dispatcher] → ${agent.agent_name} @ ${agent.user_id}@${agent.host_user} (${agent.client_endpoint})`);
    console.log(`             → cd ${agent.project_path || '(cwd)'} | runtime: ${agent.runtime || 'opencode'}`);

    db.prepare(`
      UPDATE tasks SET status = 'dispatched', assigned_agent_id = ?, assigned_agent_name = ?, assigned_user = ?, updated_at = ?
      WHERE id = ?
    `).run(agent.id, agent.agent_name, agent.user_id, now, taskId);

    agentRegistry.updateStatus(agent.id, 'busy');

    eventBus.emit({
      type: 'task_dispatched',
      data: { task_id: taskId, agent_name: agent.agent_name, user_id: agent.user_id },
      timestamp: now,
    });

    this.pushToClient(task, agent).catch(err => {
      console.error(`[Dispatcher] ❌ Push failed → ${agent.user_id}@${agent.host_user}: ${err.message}`);
      db.prepare("UPDATE tasks SET status = 'pending', assigned_agent_id = NULL, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), taskId);
      agentRegistry.updateStatus(agent.id, 'online');
    });

    return { success: true, message: `Dispatched to ${agent.user_id}/${agent.agent_name} @ ${agent.client_endpoint}` };
  }

  reportResult(payload: TaskResultPayload): Task | null {
    const db = getDb();
    const task = this.getById(payload.task_id);
    if (!task) return null;
    if (['completed', 'failed', 'timeout', 'cancelled'].includes(task.status)) {
      console.log(`[Dispatcher] Ignore late result: "${task.title}" is already ${task.status}`);
      return task;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks SET status = ?, result = ?, updated_at = ?, completed_at = ? WHERE id = ?
    `).run(payload.status, payload.result, now, now, payload.task_id);

    if (task.assigned_agent_id) {
      agentRegistry.updateStatus(task.assigned_agent_id, 'online');

      const agent = agentRegistry.getById(task.assigned_agent_id);
      db.prepare(`
        INSERT INTO feedback (id, task_id, agent_id, agent_name, user_id, status, duration_ms, token_input, token_output, model, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), payload.task_id,
        task.assigned_agent_id, task.assigned_agent_name || '',
        agent?.user_id || task.assigned_user || '',
        payload.status, payload.duration_ms || 0,
        payload.token_input || 0, payload.token_output || 0,
        '', (payload.result || '').substring(0, 500), now
      );
    }

    eventBus.emit({
      type: payload.status === 'completed' ? 'task_completed' : 'task_failed',
      data: { task_id: payload.task_id, agent_name: task.assigned_agent_name, status: payload.status },
      timestamp: now,
    });

    const flow = judgeFlowForward(task, payload);
    if (flow.action === 'forward' && flow.target_agent) {
      console.log(`[Dispatcher] Flow forward: "${task.title}" → ${flow.target_agent} (${flow.reason})`);
      this.create({
        type: task.type as any,
        title: `[Follow-up] ${task.title}`,
        description: `Previous result:\n\n${(payload.result || '').substring(0, 1000)}\n\nForward: ${flow.reason}`,
        target_agent: flow.target_agent,
        priority: task.priority as any,
        metadata: { parent_task_id: task.id, forward_reason: flow.reason },
      });
    }

    return this.getById(payload.task_id)!;
  }

  async cancel(taskId: string, reason = 'Task cancelled'): Promise<{ task: Task; termination_confirmed: boolean } | null> {
    const task = this.getById(taskId);
    if (!task) return null;
    if (['completed', 'failed', 'timeout', 'cancelled'].includes(task.status)) {
      return { task, termination_confirmed: true };
    }

    let terminationConfirmed = task.status === 'pending';
    const agent = task.assigned_agent_id ? agentRegistry.getById(task.assigned_agent_id) : undefined;
    if (agent?.client_endpoint && (task.status === 'dispatched' || task.status === 'running')) {
      const url = `${agent.client_endpoint}/cancel`;
      const body = JSON.stringify({
        execution_id: task.id,
        task_id: task.id,
        agent_name: task.assigned_agent_name || agent.agent_name,
        reason,
      });
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const value = await response.json() as { termination_confirmed?: boolean };
          terminationConfirmed = value.termination_confirmed === true;
        }
      } catch {}
    }

    const now = new Date().toISOString();
    getDb().prepare(`
      UPDATE tasks SET status = 'cancelled', result = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'timeout', 'cancelled')
    `).run(reason, now, now, task.id);
    if (task.assigned_agent_id) agentRegistry.updateStatus(task.assigned_agent_id, 'online');
    eventBus.emit({
      type: 'task_cancelled',
      data: { task_id: task.id, agent_name: task.assigned_agent_name, termination_confirmed: terminationConfirmed },
      timestamp: now,
    });
    return { task: this.getById(task.id)!, termination_confirmed: terminationConfirmed };
  }

  /**
   * 插件轮询：查找分配给该 agent 的待执行任务
   *
   * 优先级：
   *   1. status=dispatched 且 assigned_agent_name 匹配 → 已被 Server 分配
   *   2. status=pending 且 target_agent 匹配（metadata 中或字段中）→ 尚未分配但指定了目标
   */
  pollForAgent(agentName: string, userId?: string): Task | null {
    const db = getDb();

    // 优先找已 dispatch 给自己的
    const dispatched = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'dispatched' AND assigned_agent_name = ?
      ORDER BY created_at ASC LIMIT 1
    `).get(agentName) as Task | undefined;

    if (dispatched) return dispatched;

    // 再找 pending 且 target_agent 指定了自己的（自动认领）
    const pending = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
        AND (assigned_agent_name = ? OR json_extract(metadata, '$.target_agent') = ?)
      ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 1
    `).get(agentName, agentName) as Task | undefined;

    if (pending) {
      // 自动 dispatch
      const now = new Date().toISOString();
      const agents = agentRegistry.findByName(agentName);
      const agent = agents.find(a => !userId || a.user_id === userId) || agents[0];

      if (agent) {
        db.prepare(`
          UPDATE tasks SET status = 'dispatched', assigned_agent_id = ?, assigned_agent_name = ?, assigned_user = ?, updated_at = ?
          WHERE id = ?
        `).run(agent.id, agentName, agent.user_id, now, pending.id);

        console.log(`[Dispatcher] Poll auto-dispatch: "${pending.title}" → ${agentName}`);
        return this.getById(pending.id);
      }
    }

    return null;
  }

  /**
   * 插件认领任务：dispatched → running
   */
  claim(taskId: string, agentName?: string, userId?: string): Task | null {
    const db = getDb();
    const task = this.getById(taskId);
    if (!task) return null;
    if (task.status !== 'dispatched') return null;

    const now = new Date().toISOString();
    db.prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`).run(now, taskId);

    console.log(`[Dispatcher] Claimed: "${task.title}" by ${agentName || task.assigned_agent_name} (${userId || task.assigned_user})`);

    eventBus.emit({
      type: 'task_dispatched',
      data: { task_id: taskId, agent_name: agentName || task.assigned_agent_name, status: 'running' },
      timestamp: now,
    });

    return this.getById(taskId);
  }

  getById(id: string): Task | null {
    return (getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task) || null;
  }

  list(status?: string, limit: number = 50): Task[] {
    const db = getDb();
    if (status) return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) as Task[];
    return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as Task[];
  }

  getFeedback(limit: number = 50): any[] {
    return getDb().prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  private async pushToClient(task: Task, agent: Agent): Promise<void> {
    const url = `${agent.client_endpoint}/execute`;
    const metadata = JSON.parse(task.metadata || '{}') as Record<string, unknown>;
    const delivery = agent.runtime === 'codex'
      ? resolveCodexDelivery(metadata.delivery_mode || metadata.execution_mode, metadata.detached as boolean | undefined)
      : undefined;
    const managedBinding = agent.runtime === 'codex' && delivery === 'managed'
      ? codexManagedExecutionService.create(agent, task.title, task.description, {
        source_type: 'task',
        task_id: task.id,
        execution_id: task.id,
      })
      : undefined;
    const body = JSON.stringify({
      task_id: task.id, type: task.type, title: task.title,
      description: task.description, priority: task.priority,
      target_agent: agent.agent_name,
      runtime: agent.runtime || 'opencode',
      delivery_mode: delivery,
      metadata,
      codex_conversation_id: managedBinding?.conversation_id,
      codex_turn_id: managedBinding?.turn_id,
      codex_thread_id: managedBinding?.thread_id,
    });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Client responded ${res.status}`);
    } catch (error) {
      codexManagedExecutionService.fail(managedBinding, error);
      throw error;
    }
    getDb().prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), task.id);
  }
}

export const taskDispatcher = new TaskDispatcher();
