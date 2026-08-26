import { Router, Request, Response } from 'express';
import { workflowEngine } from '../services/workflow-engine';
import { masRunner } from '../services/mas-runner';
import { agentRegistry } from '../services/agent-registry';
import type { ExecutionResult, ExecuteScope, ExecuteIntent, WorkflowFailurePolicy } from '../types';

const router = Router();

// ============================================================
// 工作流 API
// ============================================================

const VALID_SCOPES: ExecuteScope[] = ['project', 'agent_self'];
const VALID_INTENTS: ExecuteIntent[] = ['query', 'modify', 'review', 'diagnose', 'execute'];
const VALID_FAILURE_POLICIES = ['fail_fast', 'all_settled'];

/** POST /api/workflows — 创建并启动工作流（异步，立即返回 workflow_id） */
router.post('/', async (req: Request, res: Response) => {
  const { title, nodes, origin, notify } = req.body;
  const failure_policy = (req.body.failure_policy || req.body.failurePolicy || 'fail_fast') as WorkflowFailurePolicy;
  if (!title || !Array.isArray(nodes) || nodes.length === 0) {
    res.status(400).json({ error: 'title and nodes[] required' });
    return;
  }
  if (!VALID_FAILURE_POLICIES.includes(failure_policy)) {
    res.status(400).json({ error: `Invalid failure_policy "${failure_policy}". Must be: ${VALID_FAILURE_POLICIES.join(', ')}` });
    return;
  }

  // 验证并规范化每个节点的 scope 和 intent
  for (const node of nodes) {
    if (!node.id || !node.agent_name || !node.prompt) {
      res.status(400).json({ error: `Each node requires id, agent_name, prompt. Got: ${JSON.stringify(node)}` });
      return;
    }
    // scope 默认 project，intent 默认 query
    node.scope = node.scope || 'project';
    node.intent = node.intent || 'query';
    if (!VALID_SCOPES.includes(node.scope)) {
      res.status(400).json({ error: `Invalid scope "${node.scope}". Must be: ${VALID_SCOPES.join(', ')}` });
      return;
    }
    if (!VALID_INTENTS.includes(node.intent)) {
      res.status(400).json({ error: `Invalid intent "${node.intent}". Must be: ${VALID_INTENTS.join(', ')}` });
      return;
    }
  }

  try {
    const { workflow_id } = workflowEngine.startAsync(title, nodes, { failure_policy, origin, notify });
    res.status(202).json({ workflow_id, status: 'running', title, failure_policy });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/workflows — 列出工作流 */
router.get('/', (_req: Request, res: Response) => {
  res.json(workflowEngine.list());
});

/**
 * GET /api/workflows/:id — 获取工作流详情
 *
 * ?wait=true  — long-poll 模式：工作流未完成时短暂 hold 连接（默认 10s），完成后立即返回
 * ?wait=false — 立即返回当前状态（默认）
 */
router.get('/:id', async (req: Request, res: Response) => {
  const wf = workflowEngine.get(req.params.id as string);
  if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }

  // 已完成或不需要等待 → 立即返回
  if (wf.status !== 'running' || req.query.wait !== 'true') {
    res.json(wf);
    return;
  }

  // long-poll：等待工作流完成或超时
  const timeout = parseInt(req.query.timeout as string) || 10_000;
  await Promise.race([
    workflowEngine.waitForCompletion(wf.id),
    new Promise<null>(resolve => setTimeout(() => resolve(null), timeout)),
  ]);

  // 超时 → 返回当前状态；完成 → 返回最新状态
  const latest = workflowEngine.get(req.params.id as string);
  res.json(latest || wf);
});

/** POST /api/workflows/:id/cancel — 取消 Workflow，并中断所有活动执行器。 */
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const reason = String(req.body?.reason || 'Workflow cancelled by caller').trim().slice(0, 4000);
  if (!workflowEngine.get(req.params.id as string)) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  res.json(await workflowEngine.cancel(req.params.id as string, reason || 'Workflow cancelled by caller'));
});

function sendNodeReportOutcome(res: Response, outcome: ReturnType<typeof workflowEngine.reportNodeResult>): void {
  if (outcome.accepted) { res.json({ received: true }); return; }
  if (outcome.code === 'unknown_workflow' || outcome.code === 'unknown_node') {
    res.status(404).json({ error: outcome.message, code: outcome.code });
    return;
  }
  if (outcome.code === 'invalid_state') {
    res.status(422).json({ error: outcome.message, code: outcome.code });
    return;
  }
  res.status(409).json({ error: outcome.message, code: outcome.code });
}

/** POST /api/workflows/:wid/nodes/:nid/started — Client 实际领取节点。 */
router.post('/:wid/nodes/:nid/started', (req: Request, res: Response) => {
  const { execution_id, agent_name } = req.body;
  if (!execution_id || !agent_name) {
    res.status(400).json({ error: 'execution_id and agent_name required' });
    return;
  }
  const principal = res.locals.mafPrincipal;
  if (principal?.role === 'client' && !agentRegistry.clientOwnsAgent(principal.id, agent_name)) {
    res.status(403).json({ error: 'Agent does not belong to this client' });
    return;
  }
  sendNodeReportOutcome(res, workflowEngine.reportNodeStarted({
    execution_id,
    agent_name,
    workflow_id: req.params.wid as string,
    node_id: req.params.nid as string,
  }));
});

/** POST /api/workflows/:wid/nodes/:nid/result — Client 回报节点结果 */
router.post('/:wid/nodes/:nid/result', (req: Request, res: Response) => {
  const { execution_id, status, agent_name } = req.body;
  if (!execution_id || !status || !agent_name) {
    res.status(400).json({ error: 'execution_id, status, and agent_name required' });
    return;
  }
  if (status !== 'completed' && status !== 'failed') {
    res.status(422).json({ error: 'status must be completed or failed' });
    return;
  }
  const principal = res.locals.mafPrincipal;
  if (principal?.role === 'client' && !agentRegistry.clientOwnsAgent(principal.id, agent_name)) {
    res.status(403).json({ error: 'Agent does not belong to this client' });
    return;
  }

  const result: ExecutionResult = {
    ...req.body,
    execution_id,
    status,
    agent_name,
    workflow_id: req.params.wid as string,
    node_id: req.params.nid as string,
  };
  sendNodeReportOutcome(res, workflowEngine.reportNodeResult(result));
});

// ============================================================
// Meta-Agent-Server 入口
// ============================================================

/** 提交任务的通用处理 */
async function handleSubmitTask(req: Request, res: Response): Promise<void> {
  const { title, description, origin, notify } = req.body;
  if (!title) {
    res.status(400).json({ error: 'title required' });
    return;
  }

  const sessionPromise = masRunner.submitTask(title, description || '', { origin, notify });

  // 先等第一轮输出，超过 30s 就先返回
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 30_000));
  const session = await Promise.race([sessionPromise, timeout]);

  if (session) {
    res.json({ session_id: session.id, status: session.status, rounds: session.rounds.length });
  } else {
    const sessions = masRunner.listSessions();
    const latest = sessions.find(s => s.title === title && s.status !== 'completed');
    res.status(202).json({
      message: 'Session started, still running',
      session_id: latest?.id || 'unknown',
      status: latest?.status || 'active',
    });
  }
}

/** POST /api/workflows/mas/task — 提交任务给 Meta-Agent-Server */
router.post('/mas/task', handleSubmitTask);

/** GET /api/workflows/mas/sessions — 列出所有会话 */
router.get('/mas/sessions', (_req: Request, res: Response) => {
  res.json(masRunner.listSessions());
});

/** GET /api/workflows/mas/sessions/:id — 获取会话详情 */
router.get('/mas/sessions/:id', (req: Request, res: Response) => {
  const session = masRunner.getSession(req.params.id as string);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json(session);
});

export default router;
