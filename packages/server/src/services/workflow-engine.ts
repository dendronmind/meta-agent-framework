/**
 * 工作流引擎
 *
 * 管理 DAG 工作流的生命周期：
 *   1. Meta-Agent-Server 创建工作流（定义节点 + 依赖关系）
 *   2. 引擎按拓扑序执行：查注册表找到 agent 所在 Client → 下发 /execute
 *   3. Client 执行完回报 → 引擎更新节点状态 → 检查后续节点是否可执行
 *   4. 所有节点完成 → 汇总结果返回给 Meta-Agent-Server
 */

import { v4 as uuidv4 } from 'uuid';
import { agentRegistry } from './agent-registry';
import { eventBus } from './event-bus';
import { serverAuthHeaders } from '../auth';
import type {
  Agent, Workflow, WorkflowNode, ExecuteCommand, ExecutionResult, WorkflowFailurePolicy, ExecutionErrorCode, ExecutionRunContext,
} from '../types';

// ============================================================
// 工作流存储（内存，重启丢失——后续可持久化）
// ============================================================

const workflows = new Map<string, Workflow>();

// 等待工作流完成的 resolver（Meta-Agent-Server 阻塞等待用）
const completionCallbacks = new Map<string, {
  resolve: (result: WorkflowSummary) => void;
  reject: (err: Error) => void;
}>();

/**
 * Agent Session 缓存：workflow_id → { agent_name → session_id }
 *
 * 当 Client 回报结果时带上 session_id，我们缓存起来。
 * 下次同一个工作流再调同一个 agent 时，把 session_id 传过去让 Client 续接。
 */
const workflowAgentSessions = new Map<string, Record<string, string>>();

/**
 * 节点超时定时器：node_key → timer
 * node_key = `${workflow_id}:${node_id}`
 */
const nodeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 默认节点超时：50 分钟。
 *
 * 该值需要大于各 Client/Receiver 自身的任务超时，避免 Client 仍在等待最终
 * assistant 回答时，Server 先把 workflow 节点标记为 failed。Codex attached 和
 * headless executor 默认任务上限为 45 分钟，这里保留 5 分钟网络/回报裕量。
 */
const NODE_TIMEOUT_MS = parseInt(process.env.NODE_TIMEOUT_MS || '3000000', 10);
const NODE_QUEUE_TIMEOUT_MS = parseInt(process.env.NODE_QUEUE_TIMEOUT_MS || '86400000', 10);

function codedFailure(code: ExecutionErrorCode, message: string): string {
  return `[${code}] ${message}`;
}

function executionErrorCode(value: unknown): ExecutionErrorCode {
  const message = String(value || '');
  const explicit = message.match(/\[(WORKSPACE_NOT_GIT|QUEUE_FULL|AGENT_NOT_DISPATCHABLE|CLIENT_UNREACHABLE|AGENT_START_FAILED|EXECUTION_TIMEOUT|MAS_ROUTING_FAILED|PATCH_EXPORT_FAILED|DISPATCH_FAILED)\]/)?.[1];
  if (explicit) return explicit as ExecutionErrorCode;
  if (/queue full|队列已满/i.test(message)) return 'QUEUE_FULL';
  if (/offline|dead|不可调度/i.test(message)) return 'AGENT_NOT_DISPATCHABLE';
  if (/ECONNREFUSED|ENETUNREACH|Client DEAD/i.test(message)) return 'CLIENT_UNREACHABLE';
  if (/timeout|timed out|超时/i.test(message)) return 'EXECUTION_TIMEOUT';
  return 'DISPATCH_FAILED';
}

export function isAgentDispatchable(agent: Pick<Agent, 'status' | 'client_endpoint'>): boolean {
  return agent.status === 'online' || agent.status === 'standby' || agent.status === 'busy';
}

function dispatchPriority(status: Agent['status']): number {
  if (status === 'online') return 3;
  if (status === 'standby') return 2;
  if (status === 'busy') return 1;
  return 0;
}

export interface WorkflowSummary {
  workflow_id: string;
  title?: string;
  status: 'completed' | 'failed';
  failure_policy?: WorkflowFailurePolicy;
  origin?: Record<string, unknown>;
  notify?: Record<string, unknown>;
  nodes: { id: string; agent_name: string; status: string; result?: string; error_code?: ExecutionErrorCode }[];
}

interface WorkflowStartOptions {
  failure_policy?: WorkflowFailurePolicy;
  origin?: Record<string, unknown>;
  notify?: Record<string, unknown>;
}

export type ResultReportCode =
  | 'accepted'
  | 'unknown_workflow'
  | 'unknown_node'
  | 'execution_mismatch'
  | 'agent_mismatch'
  | 'invalid_state';

export interface ResultReportOutcome {
  accepted: boolean;
  code: ResultReportCode;
  message?: string;
}

// ============================================================
// 公开 API
// ============================================================

export class WorkflowEngine {

  /**
   * 创建并启动工作流
   * 返回一个 Promise，工作流全部完成后 resolve（阻塞式，用于 MAS Runner）
   */
  async run(title: string, nodes: Omit<WorkflowNode, 'status'>[], options: WorkflowStartOptions = {}): Promise<WorkflowSummary> {
    const { promise } = this.startWorkflow(title, nodes, options);
    return promise;
  }

  /**
   * 创建并启动工作流（非阻塞式，用于 REST API）
   * 立即返回 workflow_id，不等完成
   */
  startAsync(title: string, nodes: Omit<WorkflowNode, 'status'>[], options: WorkflowStartOptions = {}): { workflow_id: string } {
    const { workflow_id } = this.startWorkflow(title, nodes, options);
    return { workflow_id };
  }

  /**
   * 内部：创建工作流 + 设置回调 + 触发首批节点
   */
  private startWorkflow(title: string, nodes: Omit<WorkflowNode, 'status'>[], options: WorkflowStartOptions = {}): {
    workflow_id: string;
    promise: Promise<WorkflowSummary>;
  } {
    this.validateNodes(nodes);

    const failurePolicy = this.normalizeFailurePolicy(options.failure_policy);
    const workflow: Workflow = {
      id: uuidv4(),
      title,
      nodes: nodes.map(n => ({ ...n, status: 'pending' as const })),
      status: 'running',
      failure_policy: failurePolicy,
      origin: options.origin,
      notify: options.notify,
      created_at: new Date().toISOString(),
    };

    workflows.set(workflow.id, workflow);
    console.log(`[Workflow] 🚀 "${title}" (${workflow.id}) — ${nodes.length} 节点, failure_policy=${failurePolicy}`);
    for (const n of workflow.nodes) {
      const deps = n.depends_on?.length ? ` (依赖: ${n.depends_on.join(', ')})` : '';
      console.log(`  [${n.id}] ${n.agent_name}${deps}`);
    }

    eventBus.emit({
      type: 'workflow_started',
      data: { workflow_id: workflow.id, title, node_count: nodes.length },
      timestamp: new Date().toISOString(),
    });

    // 创建完成回调
    const promise = new Promise<WorkflowSummary>((resolve, reject) => {
      completionCallbacks.set(workflow.id, { resolve, reject });
    });

    // 触发首批可执行节点
    this.scheduleReady(workflow);

    return { workflow_id: workflow.id, promise };
  }

  /**
   * Client 回报节点执行结果
   */
  reportNodeResult(result: ExecutionResult): ResultReportOutcome {
    const workflow = workflows.get(result.workflow_id);
    if (!workflow) {
      console.error(`[Workflow] 未知 workflow: ${result.workflow_id}`);
      return { accepted: false, code: 'unknown_workflow', message: 'Workflow not found' };
    }

    const node = workflow.nodes.find(n => n.id === result.node_id);
    if (!node) {
      console.error(`[Workflow] 未知 node: ${result.node_id}`);
      return { accepted: false, code: 'unknown_node', message: 'Workflow node not found' };
    }

    if (!node.execution_id || result.execution_id !== node.execution_id) {
      console.warn(`[Workflow] ⚠️ [${node.id}] execution_id 不匹配，拒绝回报`);
      return { accepted: false, code: 'execution_mismatch', message: 'execution_id does not match the active dispatch' };
    }

    if (result.agent_name !== node.agent_name) {
      console.warn(`[Workflow] ⚠️ [${node.id}] agent_name 不匹配，拒绝回报`);
      return { accepted: false, code: 'agent_mismatch', message: 'agent_name does not match the workflow node' };
    }

    // 超时、已完成或已失败节点的迟到回报不得再次推进状态。
    if (node.status !== 'running' && node.status !== 'queued') {
      console.warn(`[Workflow] ⚠️ [${node.id}] 收到迟到回报 (当前状态: ${node.status})，忽略`);
      return { accepted: false, code: 'invalid_state', message: `Node is ${node.status}, expected running` };
    }

    // 仅在所有关联校验通过后清除超时定时器。
    const nodeKey = `${result.workflow_id}:${result.node_id}`;
    const timer = nodeTimeouts.get(nodeKey);
    if (timer) {
      clearTimeout(timer);
      nodeTimeouts.delete(nodeKey);
    }

    node.status = result.status;
    node.result = result.result;
    node.error_code = result.status === 'failed' ? executionErrorCode(result.result) : undefined;
    node.completed_at = new Date().toISOString();

    // 缓存 Client 侧的 agent session ID
    if (result.session_id) {
      if (!workflowAgentSessions.has(result.workflow_id)) {
        workflowAgentSessions.set(result.workflow_id, {});
      }
      workflowAgentSessions.get(result.workflow_id)![node.agent_name] = result.session_id;
    }

    const eventType = result.status === 'completed' ? 'workflow_node_completed' : 'workflow_node_failed';
    console.log(`[Workflow] ${result.status === 'completed' ? '✅' : '❌'} [${node.id}] ${node.agent_name} — ${result.status}`);

    eventBus.emit({
      type: eventType,
      data: {
        workflow_id: workflow.id,
        node_id: node.id,
        agent_name: node.agent_name,
        status: result.status,
        duration_ms: result.duration_ms,
      },
      timestamp: new Date().toISOString(),
    });

    // 释放 agent
    const agents = agentRegistry.findByName(node.agent_name);
    for (const a of agents) {
      if (a.status === 'busy') agentRegistry.updateStatus(a.id, 'online');
    }

    this.advanceAfterNodeTerminal(workflow, result.status === 'failed'
      ? `节点 [${node.id}] ${node.agent_name} 执行失败`
      : undefined);
    return { accepted: true, code: 'accepted' };
  }

  /** Client 实际领取任务后，把排队超时切换为执行超时。 */
  reportNodeStarted(input: Pick<ExecutionResult, 'workflow_id' | 'node_id' | 'execution_id' | 'agent_name'>): ResultReportOutcome {
    const workflow = workflows.get(input.workflow_id);
    if (!workflow) return { accepted: false, code: 'unknown_workflow', message: 'Workflow not found' };
    const node = workflow.nodes.find(candidate => candidate.id === input.node_id);
    if (!node) return { accepted: false, code: 'unknown_node', message: 'Workflow node not found' };
    if (node.execution_id !== input.execution_id) return { accepted: false, code: 'execution_mismatch', message: 'execution_id does not match the active dispatch' };
    if (node.agent_name !== input.agent_name) return { accepted: false, code: 'agent_mismatch', message: 'agent_name does not match the workflow node' };
    if (node.status === 'running') return { accepted: true, code: 'accepted' };
    if (node.status !== 'queued') return { accepted: false, code: 'invalid_state', message: `Node is ${node.status}, expected queued` };
    const nodeKey = `${workflow.id}:${node.id}`;
    const timer = nodeTimeouts.get(nodeKey);
    if (timer) clearTimeout(timer);
    node.status = 'running';
    node.started_at = new Date().toISOString();
    eventBus.emit({
      type: 'workflow_node_running',
      data: { workflow_id: workflow.id, node_id: node.id, agent_name: node.agent_name },
      timestamp: new Date().toISOString(),
    });
    nodeTimeouts.set(nodeKey, this.createNodeTimeout(workflow, node, NODE_TIMEOUT_MS, 'running'));
    return { accepted: true, code: 'accepted' };
  }

  authorizesExecutionNode(executionId: string, workflowId: string, nodeId: string, agentName: string): boolean {
    const workflow = workflows.get(workflowId);
    const node = workflow?.nodes.find(candidate => candidate.id === nodeId);
    return Boolean(workflow && node && workflow.origin?.execution_id === executionId && node.agent_name === agentName);
  }

  /** 获取工作流 */
  get(id: string): Workflow | undefined {
    return workflows.get(id);
  }

  /** 等待工作流完成（用于 long-poll） */
  waitForCompletion(id: string): Promise<WorkflowSummary> {
    // 已完成 → 立即返回
    const wf = workflows.get(id);
    if (wf && wf.status !== 'running') {
      return Promise.resolve({
        workflow_id: wf.id,
        status: wf.status as 'completed' | 'failed',
        failure_policy: wf.failure_policy,
        nodes: wf.nodes.map(n => ({ id: n.id, agent_name: n.agent_name, status: n.status, result: n.result, error_code: n.error_code })),
      });
    }

    // 未完成 → 注册回调等待
    const existing = completionCallbacks.get(id);
    if (existing) {
      // 已有 startWorkflow 注册的回调，复用它的 promise
      return new Promise<WorkflowSummary>((resolve) => {
        const orig = existing.resolve;
        existing.resolve = (summary) => { orig(summary); resolve(summary); };
      });
    }

    // 没有回调（理论上不应该发生），创建新的
    return new Promise<WorkflowSummary>((resolve) => {
      completionCallbacks.set(id, { resolve, reject: () => {} });
    });
  }

  /** 列出所有工作流 */
  list(): Workflow[] {
    return Array.from(workflows.values()).sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    );
  }

  /**
   * Server 退出时清理所有工作流等待器和节点超时器。
   *
   * 当前工作流是内存态；退出时的目标是不要留下 timeout handle、
   * 不要让 MAS Runner 一直等待，并尽力通知 Daemon 释放 workflow 引用。
   */
  shutdown(reason = 'Server shutdown'): void {
    for (const timer of nodeTimeouts.values()) clearTimeout(timer);
    nodeTimeouts.clear();

    const now = new Date().toISOString();
    for (const workflow of workflows.values()) {
      if (workflow.status !== 'running') continue;
      workflow.status = 'failed';
      workflow.completed_at = now;
      for (const node of workflow.nodes) {
        if (node.status === 'running' || node.status === 'pending') {
          node.status = 'failed';
          node.result = reason;
          node.completed_at = now;
        }
      }
      this.notifyRelease(workflow, true);
    }

    for (const cb of completionCallbacks.values()) {
      cb.reject(new Error(reason));
    }
    completionCallbacks.clear();
    workflowAgentSessions.clear();
  }

  // ============================================================
  // 内部逻辑
  // ============================================================

  private normalizeFailurePolicy(policy?: string): WorkflowFailurePolicy {
    return policy === 'all_settled' ? 'all_settled' : 'fail_fast';
  }

  private validateNodes(nodes: Omit<WorkflowNode, 'status'>[]): void {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('workflow nodes[] required');
    }

    const byId = new Map<string, Omit<WorkflowNode, 'status'>>();
    for (const node of nodes) {
      if (!node.id || !node.agent_name || !node.prompt) {
        throw new Error(`Each node requires id, agent_name, prompt. Got: ${JSON.stringify(node)}`);
      }
      if (byId.has(node.id)) {
        throw new Error(`Duplicate workflow node id: ${node.id}`);
      }
      const deps = node.depends_on;
      if (deps !== undefined && !Array.isArray(deps)) {
        throw new Error(`Node "${node.id}" depends_on must be an array`);
      }
      byId.set(node.id, node);
    }

    for (const node of nodes) {
      for (const depId of node.depends_on || []) {
        if (typeof depId !== 'string' || depId.trim() === '') {
          throw new Error(`Node "${node.id}" has invalid dependency id: ${JSON.stringify(depId)}`);
        }
        if (!byId.has(depId)) {
          throw new Error(`Node "${node.id}" depends on missing node "${depId}"`);
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, path: string[]): void => {
      if (visiting.has(id)) {
        const start = path.indexOf(id);
        const cycle = [...path.slice(start >= 0 ? start : 0), id].join(' -> ');
        throw new Error(`Workflow dependency cycle detected: ${cycle}`);
      }
      if (visited.has(id)) return;
      visiting.add(id);
      const node = byId.get(id)!;
      for (const depId of node.depends_on || []) visit(depId, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of byId.keys()) visit(id, []);
  }

  private isAllSettled(workflow: Workflow): boolean {
    return workflow.failure_policy === 'all_settled';
  }

  private isNodeTerminal(node: WorkflowNode): boolean {
    return node.status === 'completed' || node.status === 'failed' || node.status === 'skipped';
  }

  private isWorkflowSettled(workflow: Workflow): boolean {
    return workflow.nodes.every(n => this.isNodeTerminal(n));
  }

  private hasFailedNodes(workflow: Workflow): boolean {
    return workflow.nodes.some(n => n.status === 'failed');
  }

  /**
   * all_settled 策略下，如果某个依赖失败/跳过，则其后继节点不可能再执行；
   * 这些节点需要显式标记 skipped，否则 workflow 会永久停在 pending。
   */
  private skipBlockedPendingNodes(workflow: Workflow): number {
    let skipped = 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of workflow.nodes) {
        if (node.status !== 'pending') continue;
        const blockedDep = (node.depends_on || [])
          .map(depId => workflow.nodes.find(n => n.id === depId))
          .find(dep => dep?.status === 'failed' || dep?.status === 'skipped');
        if (!blockedDep) continue;

        node.status = 'skipped';
        node.result = `Skipped: dependency [${blockedDep.id}] ${blockedDep.agent_name} is ${blockedDep.status}`;
        node.completed_at = new Date().toISOString();
        skipped++;
        changed = true;
        console.warn(`[Workflow] ⏭️ [${node.id}] ${node.agent_name} — skipped (${node.result})`);
      }
    }
    return skipped;
  }

  private advanceAfterNodeTerminal(workflow: Workflow, failureReason?: string): void {
    if (workflow.status !== 'running') return;

    if (!this.isAllSettled(workflow)) {
      if (this.isWorkflowDone(workflow)) {
        this.completeWorkflow(workflow);
      } else if (failureReason) {
        // fail_fast：一个节点失败 → 整个工作流失败
        this.failWorkflow(workflow, failureReason);
      } else {
        // 触发后续可执行节点
        this.scheduleReady(workflow);
      }
      return;
    }

    // all_settled：失败不立即结束；跳过被失败依赖阻塞的后继，继续等待其它并行分支。
    if (failureReason) this.skipBlockedPendingNodes(workflow);
    this.scheduleReady(workflow);
    if (this.isWorkflowSettled(workflow)) {
      if (this.hasFailedNodes(workflow)) {
        this.failWorkflow(workflow, failureReason || '一个或多个节点执行失败');
      } else {
        this.completeWorkflow(workflow);
      }
    }
  }

  /** 找到所有前置依赖已完成且状态为 pending 的节点，派发执行 */
  private scheduleReady(workflow: Workflow): void {
    for (const node of workflow.nodes) {
      if (node.status !== 'pending') continue;

      // 检查依赖是否全部完成
      const depsReady = (node.depends_on || []).every(depId => {
        const dep = workflow.nodes.find(n => n.id === depId);
        return dep?.status === 'completed';
      });

      if (depsReady) {
        this.executeNode(workflow, node);
      }
    }
  }

  /**
   * 派发单个节点到远端 Client 执行
   *
   * 路由策略：注册表中每个 agent 记录有完整的归属信息
   *   agent_name + user_id + host_user + client_endpoint + project_path
   * 按 agent_name 精确匹配，同名 agent 有多个时优先选 online 的。
   * 表里的信息足够确定「这个 agent 应该发给谁、在哪个目录执行」。
   */
  private async executeNode(workflow: Workflow, node: WorkflowNode): Promise<void> {
    node.status = 'queued';
    node.execution_id = uuidv4();

    // 精确查找：从注册表按 agent_name 查（包括所有状态）
    const allMatches = agentRegistry.listAll().filter(a => a.agent_name === node.agent_name);
    if (allMatches.length === 0) {
      const msg = `agent "${node.agent_name}" 未在注册表中`;
      console.error(`[Workflow] ❌ [${node.id}] ${msg}`);
      node.status = 'failed';
      node.error_code = 'AGENT_NOT_DISPATCHABLE';
      node.result = codedFailure(node.error_code, msg);
      node.completed_at = new Date().toISOString();
      this.advanceAfterNodeTerminal(workflow, msg);
      return;
    }

    // 注册表保证每个 agent_name 唯一归属一个用户+机器。
    // 优先 online，其次 standby，最后 busy；offline/dead 仅用于拓扑展示。
    const dispatchable = allMatches.filter(isAgentDispatchable);
    if (allMatches.length > 1) {
      console.warn(`[Workflow] ⚠️  agent "${node.agent_name}" 有 ${allMatches.length} 条记录:`);
      for (const a of allMatches) {
        console.warn(`           ${a.status} ${a.user_id}@${a.host_user} → ${a.client_endpoint}`);
      }
    }
    const agent = dispatchable.sort((a, b) => dispatchPriority(b.status) - dispatchPriority(a.status))[0];
    if (!agent) {
      const states = [...new Set(allMatches.map(a => a.status))].join(', ');
      const msg = `agent "${node.agent_name}" 当前不可调度（status: ${states || 'unknown'}）`;
      node.status = 'failed';
      node.error_code = 'AGENT_NOT_DISPATCHABLE';
      node.result = codedFailure(node.error_code, msg);
      node.completed_at = new Date().toISOString();
      this.advanceAfterNodeTerminal(workflow, node.result);
      return;
    }

    // 精确路由日志：谁、在哪台机器、哪个目录、什么运行时
    console.log(`[Workflow] ▶ [${node.id}] ${node.agent_name}`);
    console.log(`           → ${agent.user_id}@${agent.host_user} (${agent.client_endpoint})`);
    console.log(`           → cd ${agent.project_path || '(cwd)'}`);
    console.log(`           → runtime: ${agent.runtime || 'opencode'}`);

    const previousAgentStatus = agent.status;
    if (agent.status !== 'busy') {
      if (agent.status === 'standby') {
        console.log(`[Workflow] ℹ [${node.id}] ${node.agent_name} 待启动，交给 Daemon 按需拉起`);
      }
      agentRegistry.updateStatus(agent.id, 'busy');
      agentRegistry.touchHeartbeat(agent.id);
    }

    // 拼接前置节点的结果作为上下文
    const context = this.buildNodeContext(workflow, node);
    const fullPrompt = context ? `${context}\n\n---\n\n${node.prompt}` : node.prompt;

    // 查找该 agent 在此工作流中的历史 session（续接用）
    const cachedSessions = workflowAgentSessions.get(workflow.id);
    const agentSessionId = cachedSessions?.[node.agent_name];
    if (agentSessionId) {
      console.log(`           → session: ${agentSessionId} (续接)`);
    }

    try {
      const dispatched = await this.dispatchToEndpoint(agent, workflow, node, fullPrompt, agentSessionId);
      if (!dispatched) return; // dispatchToEndpoint 内部已处理失败

      // 推送成功后先等待 Client 领取；领取时切换为 running 超时。
      const nodeKey = `${workflow.id}:${node.id}`;
      nodeTimeouts.set(nodeKey, this.createNodeTimeout(workflow, node, NODE_QUEUE_TIMEOUT_MS, 'queue'));
    } catch (err: any) {
      console.error(`[Workflow] ❌ [${node.id}] 推送失败 → ${agent.user_id}@${agent.host_user}: ${err.message}`);
      node.status = 'failed';
      node.error_code = executionErrorCode(err.message);
      node.result = codedFailure(node.error_code, `推送失败: ${err.message}`);
      node.completed_at = new Date().toISOString();
      agentRegistry.updateStatus(agent.id, previousAgentStatus);
      this.advanceAfterNodeTerminal(workflow, node.result);
    }
  }

  /** 所有远端任务统一通过带 Server Ed25519 签名的 Daemon /execute 下发。 */
  private async dispatchToEndpoint(
    agent: Agent,
    workflow: Workflow,
    node: WorkflowNode,
    prompt: string,
    sessionId?: string,
  ): Promise<boolean> {
    return await this.dispatchViaClientExecute(agent, workflow, node, prompt, sessionId);
  }

  /** 通过 Node Daemon /execute 派发。 */
  private async dispatchViaClientExecute(
    agent: Agent,
    workflow: Workflow,
    node: WorkflowNode,
    prompt: string,
    sessionId?: string,
  ): Promise<boolean> {
    const endpoint = agent.client_endpoint;
    console.log(`[Workflow] 📦 Client /execute 模式: ${endpoint}`);

    const cmd: ExecuteCommand = {
      execution_id: node.execution_id!,
      workflow_id: workflow.id,
      node_id: node.id,
      agent_name: node.agent_name,
      project_path: agent.project_path,
      prompt,
      scope: node.scope || 'project',
      intent: node.intent || 'query',
      runtime: agent.runtime || 'opencode',
      delivery_mode: node.delivery_mode,
      execution_mode: node.execution_mode,
      detached: node.detached,
      session_id: sessionId,
      workspace_id: node.workspace_id || node.agent_name,
      run_context: this.executionRunContext(workflow),
    };

    const url = `${endpoint}/execute`;
    const body = JSON.stringify(cmd);
    const res = await fetch(url, {
      method: 'POST',
      headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {}
      throw new Error(`Client ${endpoint} responded ${res.status}${detail ? `: ${detail.slice(0, 1000)}` : ''}`);
    }

    console.log(`[Workflow]    ✅ 任务已推送到 Client`);
    return true;
  }

  private executionRunContext(workflow: Workflow): ExecutionRunContext | undefined {
    const origin = workflow.origin || {};
    if (!origin.execution_id) return undefined;
    return {
      execution_id: String(origin.execution_id),
      request_id: String(origin.request_id || origin.execution_id),
      external_id: String(origin.external_id || ''),
      source_type: String(origin.source_type || 'custom'),
      source_ref: String(origin.source_ref || ''),
      workdir_policy: origin.workdir_policy === 'none' || origin.workdir_policy === 'configured_workspace'
        ? origin.workdir_policy : 'managed_workspace',
      artifact_base_url: origin.artifact_base_url ? String(origin.artifact_base_url) : undefined,
      artifacts: Array.isArray(origin.artifacts) ? origin.artifacts.map(String) : [],
      metadata: origin.metadata && typeof origin.metadata === 'object' ? origin.metadata as Record<string, unknown> : {},
    };
  }

  private createNodeTimeout(workflow: Workflow, node: WorkflowNode, timeoutMs: number, phase: 'queue' | 'running'): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (node.status !== (phase === 'queue' ? 'queued' : 'running')) return;
      const label = phase === 'queue' ? '排队' : '执行';
      node.status = 'failed';
      node.error_code = 'EXECUTION_TIMEOUT';
      node.result = codedFailure(node.error_code, `Server-side ${label}超时: ${timeoutMs / 1000}s`);
      node.completed_at = new Date().toISOString();
      nodeTimeouts.delete(`${workflow.id}:${node.id}`);
      eventBus.emit({
        type: 'workflow_node_failed',
        data: { workflow_id: workflow.id, node_id: node.id, agent_name: node.agent_name, status: 'failed', reason: `${phase}_timeout` },
        timestamp: new Date().toISOString(),
      });
      this.advanceAfterNodeTerminal(workflow, node.result);
    }, timeoutMs);
  }

  /** 把前置节点的结果拼成上下文 */
  private buildNodeContext(workflow: Workflow, node: WorkflowNode): string {
    if (!node.depends_on || node.depends_on.length === 0) return '';

    const parts: string[] = ['## 前置节点结果'];
    for (const depId of node.depends_on) {
      const dep = workflow.nodes.find(n => n.id === depId);
      if (dep?.result) {
        parts.push(`### [${dep.id}] ${dep.agent_name}\n\n${dep.result}`);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * 强制失败指定 agent 的所有 running 节点
   * 由 HealthMonitor 在 Client DEAD 时调用
   */
  failRunningNodesByAgent(agentName: string): void {
    for (const workflow of workflows.values()) {
      if (workflow.status !== 'running') continue;
      for (const node of workflow.nodes) {
        if (node.agent_name === agentName && (node.status === 'queued' || node.status === 'running')) {
          console.error(`[Workflow] 💀 [${node.id}] ${node.agent_name} — Client DEAD，强制标记失败`);

          // 清除超时 timer
          const nodeKey = `${workflow.id}:${node.id}`;
          const timer = nodeTimeouts.get(nodeKey);
          if (timer) { clearTimeout(timer); nodeTimeouts.delete(nodeKey); }

          node.status = 'failed';
          node.error_code = 'CLIENT_UNREACHABLE';
          node.result = codedFailure(node.error_code, 'Client DEAD: 心跳超时，执行器已离线');
          node.completed_at = new Date().toISOString();

          eventBus.emit({
            type: 'workflow_node_failed',
            data: { workflow_id: workflow.id, node_id: node.id, agent_name: node.agent_name, status: 'failed', reason: 'client_dead' },
            timestamp: new Date().toISOString(),
          });

          this.advanceAfterNodeTerminal(workflow, `节点 [${node.id}] ${node.agent_name} 的 Client 已离线`);
          if (workflow.status !== 'running') break;
        }
      }
    }
  }

  private isWorkflowDone(workflow: Workflow): boolean {
    return workflow.nodes.every(n => n.status === 'completed' || n.status === 'skipped');
  }

  private completeWorkflow(workflow: Workflow): void {
    workflow.status = 'completed';
    workflow.completed_at = new Date().toISOString();
    console.log(`[Workflow] 🎉 "${workflow.title}" 全部完成`);

    const summary: WorkflowSummary = {
      workflow_id: workflow.id,
      title: workflow.title,
      status: 'completed',
      failure_policy: workflow.failure_policy,
      origin: workflow.origin,
      notify: workflow.notify,
      nodes: workflow.nodes.map(n => ({
        id: n.id, agent_name: n.agent_name, status: n.status, result: n.result, error_code: n.error_code,
      })),
    };

    eventBus.emit({
      type: 'workflow_completed',
      data: { ...summary },
      timestamp: new Date().toISOString(),
    });

    const cb = completionCallbacks.get(workflow.id);
    if (cb) { cb.resolve(summary); completionCallbacks.delete(workflow.id); }

    // 通知 Client 释放 agent serve 进程（非 immediate，让闲置超时兜底）
    this.notifyRelease(workflow, false);
  }

  private failWorkflow(workflow: Workflow, reason: string): void {
    workflow.status = 'failed';
    workflow.completed_at = new Date().toISOString();
    console.error(`[Workflow] 💀 "${workflow.title}" 失败: ${reason}`);

    // 标记所有 pending 节点为 skipped
    for (const n of workflow.nodes) {
      if (n.status === 'pending') n.status = 'skipped';
    }

    const summary: WorkflowSummary = {
      workflow_id: workflow.id,
      title: workflow.title,
      status: 'failed',
      failure_policy: workflow.failure_policy,
      origin: workflow.origin,
      notify: workflow.notify,
      nodes: workflow.nodes.map(n => ({
        id: n.id, agent_name: n.agent_name, status: n.status, result: n.result, error_code: n.error_code,
      })),
    };

    eventBus.emit({
      type: 'workflow_failed',
      data: { ...summary, reason },
      timestamp: new Date().toISOString(),
    });

    const cb = completionCallbacks.get(workflow.id);
    if (cb) { cb.resolve(summary); completionCallbacks.delete(workflow.id); }

    // 通知 Client 释放 agent serve 进程（非 immediate，让闲置超时兜底）
    this.notifyRelease(workflow, false);
  }

  /**
   * 通知所有参与 workflow 的 Client：该 workflow 已结束，可释放 serve 进程
   *
   * immediate=false: Client 仅取消 workflow 引用，serve 闲置超时后自动回收
   *   → 适合多轮场景：MAS Round 1 完成后，Round 2 可能还会用同一个 agent
   * immediate=true: Client 立即 kill（当 Server 确定不会有后续任务时）
   */
  private notifyRelease(workflow: Workflow, immediate: boolean): void {
    // 收集所有参与的 agent → 对应的 Client endpoint
    const agentEndpoints = new Map<string, string>();
    for (const node of workflow.nodes) {
      if (agentEndpoints.has(node.agent_name)) continue;
      const agents = agentRegistry.findByName(node.agent_name);
      for (const a of agents) {
        agentEndpoints.set(node.agent_name, a.client_endpoint);
      }
    }

    for (const [agentName, endpoint] of agentEndpoints) {
      console.log(`[Workflow] 📤 通知释放: ${agentName} → ${endpoint} (workflow: ${workflow.id}, immediate: ${immediate})`);
      const url = `${endpoint}/release`;
      const body = JSON.stringify({ agent_name: agentName, workflow_id: workflow.id, immediate });
      fetch(url, {
        method: 'POST',
        headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
        body,
        signal: AbortSignal.timeout(5_000),
      }).catch(err => {
        // 释放通知失败不影响主流程，Client 自己有闲置超时兜底
        console.warn(`[Workflow] 释放通知失败 (${agentName}): ${err.message}`);
      });
    }
  }
}

export const workflowEngine = new WorkflowEngine();
