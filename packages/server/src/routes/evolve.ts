import { Router, Request, Response } from 'express';
import { evolutionService } from '../services/evolution-service';

const router = Router();

// ============================================================
// 进化 API
// ============================================================

/**
 * POST /api/evolve/skill
 * 推送 skill 到指定 agent
 *
 * Body: { agent_name, skill_name, files: [{ relative_path, content, encoding? }] }
 */
router.post('/skill', async (req: Request, res: Response) => {
  const { agent_name, skill_name, files } = req.body;
  if (!agent_name || !skill_name || !Array.isArray(files)) {
    res.status(400).json({ error: 'agent_name, skill_name, files[] required' });
    return;
  }
  const result = await evolutionService.pushSkill(agent_name, skill_name, files);
  res.status(result.pushed ? 200 : 404).json(result);
});

/**
 * POST /api/evolve/agent-config
 * 推送 agent 配置到远端
 *
 * Body: { agent_name, files: [...], restart?: boolean, project_path?: string }
 */
router.post('/agent-config', async (req: Request, res: Response) => {
  const { agent_name, files, restart, project_path } = req.body;
  if (!agent_name || !Array.isArray(files)) {
    res.status(400).json({ error: 'agent_name, files[] required' });
    return;
  }
  const result = await evolutionService.pushAgentConfig(agent_name, files, { restart, project_path });
  res.status(result.pushed ? 200 : 404).json(result);
});

/**
 * POST /api/evolve/mcp
 * 推送 MCP 配置更新
 *
 * Body: { agent_name, files: [...], install_command?: string, project_path?: string }
 */
router.post('/mcp', async (req: Request, res: Response) => {
  const { agent_name, files, install_command, project_path } = req.body;
  if (!agent_name || !Array.isArray(files)) {
    res.status(400).json({ error: 'agent_name, files[] required' });
    return;
  }
  const result = await evolutionService.pushMcpUpdate(agent_name, files, { install_command, project_path });
  res.status(result.pushed ? 200 : 404).json(result);
});

/**
 * POST /api/evolve/custom
 * 自定义进化指令
 *
 * Body: { agent_name, title, actions: [...], target_runtime? }
 */
router.post('/custom', async (req: Request, res: Response) => {
  const { agent_name, ...command } = req.body;
  if (!agent_name || !command.title || !Array.isArray(command.actions)) {
    res.status(400).json({ error: 'agent_name, title, actions[] required' });
    return;
  }
  const result = await evolutionService.evolve(agent_name, command);
  res.status(result.pushed ? 200 : 404).json(result);
});

/**
 * POST /api/evolve/broadcast
 * 广播进化到所有在线 Client
 *
 * Body: { title, actions: [...] }
 */
router.post('/broadcast', async (req: Request, res: Response) => {
  const { title, actions } = req.body;
  if (!title || !Array.isArray(actions)) {
    res.status(400).json({ error: 'title, actions[] required' });
    return;
  }
  const result = await evolutionService.broadcast({ title, actions });
  res.json(result);
});

/**
 * POST /api/evolve/:id/result
 * Client 回报进化执行结果
 */
router.post('/:id/result', (req: Request, res: Response) => {
  if (req.body?.evolve_id && req.body.evolve_id !== req.params.id) {
    res.status(409).json({ error: 'evolve_id mismatch' });
    return;
  }
  const principal = res.locals.mafPrincipal;
  const accepted = evolutionService.reportResult(
    { ...req.body, evolve_id: req.params.id },
    principal?.role === 'client' ? principal.id : undefined,
  );
  if (!accepted) {
    res.status(403).json({ error: 'Evolve command does not belong to this client' });
    return;
  }
  res.json({ ok: true });
});

/**
 * GET /api/evolve/:id
 * 查询进化结果
 */
router.get('/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const result = evolutionService.getResult(id);
  if (!result) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(result);
});

/**
 * GET /api/evolve
 * 列出所有进化结果
 */
router.get('/', (_req: Request, res: Response) => {
  res.json(evolutionService.listResults());
});

export default router;
