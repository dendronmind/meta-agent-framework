import { Router, Request, Response } from 'express';
import { taskDispatcher } from '../services/task-dispatcher';
import { agentRegistry } from '../services/agent-registry';
import type { TaskCreatePayload, TaskResultPayload } from '../types';

const router = Router();

/** POST /api/tasks — 创建任务 */
router.post('/', (req: Request, res: Response) => {
  const payload = req.body as TaskCreatePayload;

  if (!payload.title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  const task = taskDispatcher.create(payload);
  res.status(201).json(task);
});

/** POST /api/tasks/:id/dispatch — 手动分发任务给指定 agent */
router.post('/:id/dispatch', (req: Request, res: Response) => {
  const { agent } = req.body;
  if (!agent) {
    res.status(400).json({ error: 'agent (name or id) is required' });
    return;
  }

  const result = taskDispatcher.dispatch(req.params.id as string, agent);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

/** POST /api/tasks/:id/result — 远端 agent 回报结果 */
router.post('/:id/result', (req: Request, res: Response) => {
  const principal = res.locals.mafPrincipal;
  const existingTask = taskDispatcher.getById(req.params.id as string);
  if (principal?.role === 'client') {
    const assignedAgent = existingTask?.assigned_agent_id
      ? agentRegistry.getById(existingTask.assigned_agent_id)
      : undefined;
    if (!assignedAgent || assignedAgent.client_id !== principal.id) {
      res.status(403).json({ error: 'Task does not belong to this client' });
      return;
    }
  }
  const payload: TaskResultPayload = {
    task_id: req.params.id,
    ...req.body,
  };

  if (!payload.status || !payload.result) {
    res.status(400).json({ error: 'status and result are required' });
    return;
  }

  const task = taskDispatcher.reportResult(payload);
  if (task) {
    res.json(task);
  } else {
    res.status(404).json({ error: 'Task not found' });
  }
});

/**
 * GET /api/tasks/poll?agent_name=xxx&user_id=yyy
 *
 * 插件轮询拉任务：返回分配给该 agent 且状态为 dispatched 的任务
 * 如果没有 dispatched 的，也返回 pending 且 target_agent 匹配的
 */
router.get('/poll', (req: Request, res: Response) => {
  const agentName = req.query.agent_name as string;
  const userId = req.query.user_id as string;
  if (!agentName) { res.status(400).json({ error: 'agent_name required' }); return; }
  const principal = res.locals.mafPrincipal;
  if (principal?.role === 'client' && !agentRegistry.clientOwnsAgent(principal.id, agentName)) {
    res.status(403).json({ error: 'Agent does not belong to this client' });
    return;
  }

  const task = taskDispatcher.pollForAgent(agentName, userId);
  if (task) {
    res.json({ has_task: true, task });
  } else {
    res.json({ has_task: false });
  }
});

/**
 * POST /api/tasks/:id/claim — 插件认领任务（从 dispatched → running）
 */
router.post('/:id/claim', (req: Request, res: Response) => {
  const { agent_name, user_id } = req.body;
  const principal = res.locals.mafPrincipal;
  if (principal?.role === 'client' && !agentRegistry.clientOwnsAgent(principal.id, agent_name)) {
    res.status(403).json({ error: 'Agent does not belong to this client' });
    return;
  }
  const task = taskDispatcher.claim(req.params.id as string, agent_name, user_id);
  if (task) {
    res.json(task);
  } else {
    res.status(404).json({ error: 'Task not found or not claimable' });
  }
});

/** GET /api/tasks — 列出任务 */
router.get('/', (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(taskDispatcher.list(status, limit));
});

/** GET /api/tasks/:id — 获取单个任务 */
router.get('/:id', (req: Request, res: Response) => {
  const task = taskDispatcher.getById(req.params.id as string);
  if (task) {
    res.json(task);
  } else {
    res.status(404).json({ error: 'Task not found' });
  }
});

/** GET /api/feedback — 获取 feedback 列表 */
router.get('/feedback/list', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(taskDispatcher.getFeedback(limit));
});

export default router;
