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
import type {
  Agent, Workflow, WorkflowNode, ExecuteCommand, ExecutionResult, WorkflowFailurePolicy,
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
 * 默认节点超时：12 分钟。
 *
 * 该值需要大于各 Client/Receiver 自身的任务超时，避免 Client 仍在等待最终
 * assistant 回答时，Server 先把 workflow 节点标记为 failed。当前 Codex attached
 * receiver 默认任务超时为 10 分钟，这里保留 2 分钟网络/回报裕量。
 */
const NODE_TIMEOUT_MS = parseInt(process.env.NODE_TIMEOUT_MS || '720000', 10);

export interface WorkflowSummary {
  workflow_id: string;
  title?: string;
  status: 'completed' | 'failed';
  failure_policy?: WorkflowFailurePolicy;
  origin?: Record<string, unknown>;
  notify?: Record<string, unknown>;
  nodes: { id: string; agent_name: string; status: string; result?: string }[];
}

interface WorkflowStartOptions {
  failure_policy?: WorkflowFailurePolicy;
  origin?: Record<string, unknown>;
  notify?: Record<string, unknown>;
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
    const { workflow_id, promise } = this.startWorkflow(title, nodes, options);
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
  reportNodeResult(result: ExecutionResult): void {
    const workflow = workflows.get(result.workflow_id);
    if (!workflow) {
      console.error(`[Workflow] 未知 workflow: ${result.workflow_id}`);
      return;
    }

    const node = workflow.nodes.find(n => n.id === result.node_id);
    if (!node) {
      console.error(`[Workflow] 未知 node: ${result.node_id}`);
      return;
    }

    // 清除超时定时器
    const nodeKey = `${result.workflow_id}:${result.node_id}`;
    const timer = nodeTimeouts.get(nodeKey);
    if (timer) {
      clearTimeout(timer);
      nodeTimeouts.delete(nodeKey);
    }

    // 如果节点已经被超时标记为 failed，忽略迟到的回报
    if (node.status !== 'running') {
      console.warn(`[Workflow] ⚠️ [${node.id}] 收到迟到回报 (当前状态: ${node.status})，忽略`);
      return;
    }

    node.status = result.status;
    node.result = result.result;
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
        nodes: wf.nodes.map(n => ({ id: n.id, agent_name: n.agent_name, status: n.status, result: n.result })),
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

  // ============================================================
  // 内部逻辑
  // ============================================================

  private normalizeFailurePolicy(policy?: string): WorkflowFailurePolicy {
    return policy === 'all_settled' ? 'all_settled' : 'fail_fast';
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
    node.status = 'running';
    node.started_at = new Date().toISOString();

    eventBus.emit({
      type: 'workflow_node_running',
      data: { workflow_id: workflow.id, node_id: node.id, agent_name: node.agent_name },
      timestamp: new Date().toISOString(),
    });

    // 精确查找：从注册表按 agent_name 查（包括所有状态）
    const allMatches = agentRegistry.listAll().filter(a => a.agent_name === node.agent_name);
    if (allMatches.length === 0) {
      const msg = `agent "${node.agent_name}" 未在注册表中`;
      console.error(`[Workflow] ❌ [${node.id}] ${msg}`);
      node.status = 'failed';
      node.result = msg;
      node.completed_at = new Date().toISOString();
      this.advanceAfterNodeTerminal(workflow, msg);
      return;
    }

    // 注册表保证每个 agent_name 唯一归属一个用户+机器
    // 如果出现多条同名记录，以 online 的为准，并打印警告
    const online = allMatches.filter(a => a.status === 'online');
    if (allMatches.length > 1) {
      console.warn(`[Workflow] ⚠️  agent "${node.agent_name}" 有 ${allMatches.length} 条记录:`);
      for (const a of allMatches) {
        console.warn(`           ${a.status} ${a.user_id}@${a.host_user} → ${a.client_endpoint}`);
      }
    }
    const agent = online.length > 0 ? online[0] : allMatches[0];

    if (agent.status !== 'online') {
      // 不论 runtime，都尝试推送到 Daemon，Daemon 自动通过 screen 拉起 agent
      console.log(`[Workflow] ⚠ [${node.id}] ${node.agent_name} 状态为 ${agent.status} (${agent.runtime})，尝试推送（Daemon 自动拉起）`);
    }

    // 精确路由日志：谁、在哪台机器、哪个目录、什么运行时
    console.log(`[Workflow] ▶ [${node.id}] ${node.agent_name}`);
    console.log(`           → ${agent.user_id}@${agent.host_user} (${agent.client_endpoint})`);
    console.log(`           → cd ${agent.project_path || '(cwd)'}`);
    console.log(`           → runtime: ${agent.runtime || 'opencode'}`);

    agentRegistry.updateStatus(agent.id, 'busy');

    // 刷新 heartbeat，让 HealthMonitor 从此刻开始计时
    // 避免 dead/offline agent 被设为 busy 后因旧心跳超时立即被杀
    agentRegistry.touchHeartbeat(agent.id);

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
      // 尝试两种派发模式
      const dispatched = await this.dispatchToEndpoint(agent, workflow, node, fullPrompt, agentSessionId);
      if (!dispatched) return; // dispatchToEndpoint 内部已处理失败

      // 推送成功 → 设置 server-side 超时定时器
      const nodeKey = `${workflow.id}:${node.id}`;
      const timer = setTimeout(() => {
        if (node.status === 'running') {
          console.error(`[Workflow] ⏰ [${node.id}] ${node.agent_name} 执行超时 (${NODE_TIMEOUT_MS / 1000}s)`);
          node.status = 'failed';
          node.result = `Server-side 超时: ${NODE_TIMEOUT_MS / 1000}s 内未收到 Client 回报`;
          node.completed_at = new Date().toISOString();
          agentRegistry.updateStatus(agent.id, 'online');
          nodeTimeouts.delete(nodeKey);

          eventBus.emit({
            type: 'workflow_node_failed',
            data: { workflow_id: workflow.id, node_id: node.id, agent_name: node.agent_name, status: 'failed', reason: 'timeout' },
            timestamp: new Date().toISOString(),
          });

          this.advanceAfterNodeTerminal(workflow, `节点 [${node.id}] ${node.agent_name} 执行超时`);
        }
      }, NODE_TIMEOUT_MS);
      nodeTimeouts.set(nodeKey, timer);
    } catch (err: any) {
      console.error(`[Workflow] ❌ [${node.id}] 推送失败 → ${agent.user_id}@${agent.host_user}: ${err.message}`);
      node.status = 'failed';
      node.result = `推送失败: ${err.message}`;
      node.completed_at = new Date().toISOString();
      agentRegistry.updateStatus(agent.id, 'online');
      this.advanceAfterNodeTerminal(workflow, node.result);
    }
  }

  /**
   * 向端点派发任务（自动检测模式）
   *
   * 模式 1 — opencode HTTP API（plugin 注册的实例）
   *   端点有 /session 接口 → 创建 session → 通过 prompt_async 下发
   *   Plugin 的 event hook 会在 session idle 时自动回报结果
   *
   * 模式 2 — Client /execute（join.sh 注册的传统 Client）
   *   端点有 /execute 接口 → 传统推送模式
   *   Client 的 executeWorkflowNode 处理执行和回报
   */
  private async dispatchToEndpoint(
    agent: Agent,
    workflow: Workflow,
    node: WorkflowNode,
    prompt: string,
    sessionId?: string,
  ): Promise<boolean> {
    const endpoint = agent.client_endpoint;

    // 先尝试 opencode HTTP API 模式：探测 /session 端点
    try {
      const probe = await fetch(`${endpoint}/session`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (probe.ok) {
        // opencode 实例 → 用 HTTP API 派发
        return await this.dispatchViaOpencodeAPI(agent, workflow, node, prompt, sessionId);
      }
    } catch {
      // /session 不可用，不是 opencode 实例
    }

    // 降级到传统 Client /execute 模式
    return await this.dispatchViaClientExecute(agent, workflow, node, prompt, sessionId);
  }

  /**
   * 模式 1：通过 opencode HTTP API 派发
   *
   * 1. 创建 session（或复用已有）
   * 2. prompt_async 异步下发任务
   * 3. Plugin 的 event hook 自动在 session idle 时回报结果
   */
  private async dispatchViaOpencodeAPI(
    agent: Agent,
    workflow: Workflow,
    node: WorkflowNode,
    prompt: string,
    sessionId?: string,
  ): Promise<boolean> {
    const endpoint = agent.client_endpoint;
    console.log(`[Workflow] 📡 opencode API 模式: ${endpoint}`);

    try {
      // 1. 创建或复用 session
      let sid = sessionId;
      if (!sid) {
        const createRes = await fetch(`${endpoint}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directory: agent.project_path || undefined }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!createRes.ok) throw new Error(`创建 session 失败: HTTP ${createRes.status}`);
        const sessionData = await createRes.json() as any;
        sid = sessionData.id;
        console.log(`[Workflow]    session 创建: ${sid}`);
      }

      // 缓存 session ID
      if (!workflowAgentSessions.has(workflow.id)) {
        workflowAgentSessions.set(workflow.id, {});
      }
      workflowAgentSessions.get(workflow.id)![node.agent_name] = sid!;

      // 2. 更新 session title 带上 meta-agent 标记（Plugin 用来识别）
      try {
        await fetch(`${endpoint}/session/${sid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `[meta-agent:${workflow.id}:${node.id}] ${prompt.slice(0, 80)}`,
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // title 更新失败不影响主流程
      }

      // 3. 异步下发任务
      const promptRes = await fetch(`${endpoint}/session/${sid}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
          agent: node.agent_name,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!promptRes.ok && promptRes.status !== 204) {
        throw new Error(`prompt_async 失败: HTTP ${promptRes.status}`);
      }

      console.log(`[Workflow]    ✅ 任务已下发到 opencode (session: ${sid})`);
      return true;
    } catch (err: any) {
      console.error(`[Workflow]    ❌ opencode API 失败: ${err.message}，尝试 Client 模式`);
      // 降级到 Client 模式
      return await this.dispatchViaClientExecute(agent, workflow, node, prompt, sessionId);
    }
  }

  /**
   * 模式 2：通过传统 Client /execute 派发（join.sh 模式）
   */
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
      execution_id: uuidv4(),
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
    };

    const res = await fetch(`${endpoint}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Client ${endpoint} responded ${res.status}`);

    console.log(`[Workflow]    ✅ 任务已推送到 Client`);
    return true;
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
        if (node.agent_name === agentName && node.status === 'running') {
          console.error(`[Workflow] 💀 [${node.id}] ${node.agent_name} — Client DEAD，强制标记失败`);

          // 清除超时 timer
          const nodeKey = `${workflow.id}:${node.id}`;
          const timer = nodeTimeouts.get(nodeKey);
          if (timer) { clearTimeout(timer); nodeTimeouts.delete(nodeKey); }

          node.status = 'failed';
          node.result = 'Client DEAD: 心跳超时，执行器已离线';
          node.completed_at = new Date().toISOString();

          eventBus.emit({
            type: 'workflow_node_failed',
            data: { workflow_id: workflow.id, node_id: node.id, agent_name: node.agent_name, status: 'failed', reason: 'client_dead' },
            timestamp: new Date().toISOString(),
          });

          this.failWorkflow(workflow, `节点 [${node.id}] ${node.agent_name} 的 Client 已离线`);
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
        id: n.id, agent_name: n.agent_name, status: n.status, result: n.result,
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
        id: n.id, agent_name: n.agent_name, status: n.status, result: n.result,
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
      fetch(`${endpoint}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: agentName, workflow_id: workflow.id, immediate }),
        signal: AbortSignal.timeout(5_000),
      }).catch(err => {
        // 释放通知失败不影响主流程，Client 自己有闲置超时兜底
        console.warn(`[Workflow] 释放通知失败 (${agentName}): ${err.message}`);
      });
    }
  }
}

export const workflowEngine = new WorkflowEngine();
