import { Router, Request, Response } from 'express';
import { proposalService } from '../services/proposal-service';
import { agentRegistry } from '../services/agent-registry';
import type { ProposalCreatePayload, ProposalReviewPayload, ProposalStatus } from '../types';

const router = Router();

// ============================================================
// Proposal API — Client → Server 的逆向提议通道
// ============================================================

/**
 * POST /api/proposals
 * Client 提交提议（贡献 skill、反馈问题、改进建议等）
 *
 * Body: ProposalCreatePayload
 *   { from_agent, type, title, detail, target?, suggested_fix?, files?, source_path?, priority? }
 *
 * 来源用户从 from_agent 关联的已注册 agent 中推导，或通过 user_id 字段显式传入。
 */
router.post('/', (req: Request, res: Response) => {
  const payload = req.body as ProposalCreatePayload & { user_id?: string };

  if (!payload.from_agent || !payload.title || !payload.type) {
    res.status(400).json({ error: 'from_agent, type, and title are required' });
    return;
  }

  const validTypes = ['skill', 'workflow_fix', 'prompt_improvement', 'bug_report', 'general'];
  if (!validTypes.includes(payload.type)) {
    res.status(400).json({ error: `Invalid type. Valid types: ${validTypes.join(', ')}` });
    return;
  }
  const principal = res.locals.mafPrincipal;
  if (principal?.role === 'client' && !agentRegistry.clientOwnsAgent(principal.id, payload.from_agent)) {
    res.status(403).json({ error: 'Agent does not belong to this client' });
    return;
  }

  // user_id: 优先从 body 取，否则留空（Daemon 转发时会附上）
  const userId = payload.user_id || '';

  const proposal = proposalService.create(payload, userId);
  res.status(201).json(proposal);
});

/**
 * GET /api/proposals
 * 列出提议（支持过滤）
 *
 * Query: status?, type?, from_agent?, limit?
 */
router.get('/', (req: Request, res: Response) => {
  const status = req.query.status as ProposalStatus | undefined;
  const type = req.query.type as string | undefined;
  const from_agent = req.query.from_agent as string | undefined;
  const limit = parseInt(req.query.limit as string) || 50;

  const principal = res.locals.mafPrincipal;
  const proposals = proposalService.list({ status, type, from_agent, limit });
  res.json(principal?.role === 'client'
    ? proposals.filter(proposal => agentRegistry.clientOwnsAgent(principal.id, proposal.from_agent))
    : proposals);
});

/**
 * GET /api/proposals/stats
 * 提议统计
 */
router.get('/stats', (_req: Request, res: Response) => {
  res.json(proposalService.getStats());
});

/**
 * GET /api/proposals/:id
 * 获取单个提议详情
 */
router.get('/:id', (req: Request, res: Response) => {
  const proposal = proposalService.getById(req.params.id as string);
  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }
  res.json(proposal);
});

/**
 * POST /api/proposals/:id/review
 * 审核提议（接受/拒绝）
 *
 * Body: { status: 'accepted' | 'rejected', review_comment?, reviewed_by? }
 */
router.post('/:id/review', (req: Request, res: Response) => {
  const payload = req.body as ProposalReviewPayload;

  if (!payload.status || !['accepted', 'rejected'].includes(payload.status)) {
    res.status(400).json({ error: "status must be 'accepted' or 'rejected'" });
    return;
  }

  const proposal = proposalService.review(req.params.id as string, payload);
  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }
  res.json(proposal);
});

/**
 * POST /api/proposals/:id/apply
 * 标记提议为已应用（采纳后执行了分发/修复）
 */
router.post('/:id/apply', (req: Request, res: Response) => {
  const proposal = proposalService.markApplied(req.params.id as string);
  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found or not in accepted state' });
    return;
  }
  res.json(proposal);
});

export default router;
