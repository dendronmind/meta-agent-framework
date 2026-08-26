import { Router, type Request, type Response } from 'express';
import { agentRegistry } from '../services/agent-registry';
import { codexConversationService } from '../services/codex-conversation-service';
import { requireAdminAuth, serverAuthHeaders } from '../auth';
import type { Agent } from '../types';

const router = Router();
const ACTIVE_AGENT_STATUSES = new Set(['online', 'standby', 'busy']);

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function daemonUrl(agent: Agent, pathname: string): string {
  const base = new URL(agent.client_endpoint);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('invalid_client_endpoint');
  return new URL(pathname, `${base.protocol}//${base.host}`).toString();
}

async function daemonPost(agent: Agent, pathname: string, payload: Record<string, unknown>): Promise<any> {
  const url = daemonUrl(agent, pathname);
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: 'POST',
    headers: serverAuthHeaders('POST', url, body, { 'Content-Type': 'application/json' }),
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error || data.message || `Daemon HTTP ${response.status}`);
  return data;
}

function conversationAgent(conversationId: string): { conversation: NonNullable<ReturnType<typeof codexConversationService.get>>; agent: Agent } {
  const conversation = codexConversationService.get(conversationId);
  if (!conversation) throw new Error('conversation_not_found');
  const agent = agentRegistry.getById(conversation.agent_id);
  if (!agent || agent.client_id !== conversation.client_id || agent.agent_name !== conversation.agent_name) {
    throw new Error('conversation_agent_unavailable');
  }
  return { conversation, agent };
}

function sendKnownError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = message === 'conversation_not_found' ? 404
    : message === 'conversation_agent_unavailable' ? 409
      : message === 'active_turn_exists' ? 409
        : 400;
  res.status(status).json({ error: message });
}

async function detailWithRemoteSnapshot(conversationId: string): Promise<any> {
  const detail = codexConversationService.getDetail(conversationId);
  if (!detail) return undefined;
  try {
    const { conversation, agent } = conversationAgent(conversationId);
    const remote = await daemonPost(agent, '/codex/conversations/read', {
      conversation_id: conversation.id,
      agent_name: conversation.agent_name,
      project_path: conversation.project_path,
      thread_id: conversation.thread_id,
      model: conversation.model,
      approval_policy: conversation.approval_policy,
      sandbox_mode: conversation.sandbox_mode,
    });
    return { ...detail, remote };
  } catch {
    return { ...detail, remote: null };
  }
}

router.get('/conversations', (req, res) => {
  res.json(codexConversationService.list(
    parseLimit(req.query.limit, 100),
    String(req.query.agent_id || ''),
  ));
});

router.post('/conversations', requireAdminAuth, async (req, res) => {
  const agentId = String(req.body?.agent_id || '');
  const agent = agentRegistry.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.runtime !== 'codex') { res.status(422).json({ error: 'Agent runtime must be codex' }); return; }
  if (!agent.client_id || !agent.client_endpoint || !ACTIVE_AGENT_STATUSES.has(agent.status)) {
    res.status(409).json({ error: `Codex Agent is not reachable: ${agent.status}` });
    return;
  }

  const model = String(req.body?.model || '').trim().slice(0, 120);
  const reset = req.body?.reset === true || req.body?.new_thread === true;
  const binding = codexConversationService.getOrCreateAgentConversation(agent, model);
  const conversation = binding.conversation;
  if (reset && codexConversationService.activeTurn(conversation.id)) {
    res.status(409).json({ error: 'active_turn_exists' });
    return;
  }
  try {
    const started = await daemonPost(agent, '/codex/conversations/start', {
      conversation_id: conversation.id,
      agent_name: agent.agent_name,
      project_path: agent.project_path,
      thread_id: reset ? '' : conversation.thread_id,
      new_thread: reset,
      model,
      approval_policy: conversation.approval_policy,
      sandbox_mode: conversation.sandbox_mode,
    });
    const threadId = String(started.thread_id || '');
    if (!threadId) throw new Error('Daemon returned no Codex thread_id');
    if (reset) codexConversationService.resetConversation(conversation.id, threadId, String(started.model || model));
    else codexConversationService.setReady(conversation.id, threadId, String(started.model || model));
    res.status(binding.created ? 201 : 200).json(await detailWithRemoteSnapshot(conversation.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    codexConversationService.setConversationStatus(conversation.id, 'failed');
    codexConversationService.appendInternalEvent(conversation.id, '', 'maf/conversation/failed', { error: message });
    res.status(502).json({ error: message, conversation: codexConversationService.get(conversation.id) });
  }
});

router.get('/conversations/:id', async (req, res) => {
  const detail = await detailWithRemoteSnapshot(String(req.params.id));
  if (!detail) { res.status(404).json({ error: 'Conversation not found' }); return; }
  res.json(detail);
});

router.get('/conversations/:id/events', (req, res) => {
  const id = String(req.params.id);
  if (!codexConversationService.get(id)) { res.status(404).json({ error: 'Conversation not found' }); return; }
  res.json(codexConversationService.listEvents(
    id,
    parseLimit(req.query.after_seq, 0),
    parseLimit(req.query.limit, 2000),
  ));
});

router.get('/conversations/:id/stream', (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!codexConversationService.get(id)) { res.status(404).json({ error: 'Conversation not found' }); return; }
  const afterSeq = parseLimit(req.query.after_seq || req.get('last-event-id'), 0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`event: connected\ndata: ${JSON.stringify({ conversation_id: id, after_seq: afterSeq })}\n\n`);

  // All operations below are synchronous, so replay and subscription cannot have an event-loop gap.
  // Page through the complete history; a long conversation may exceed the per-query 5000 row cap.
  let replayCursor = afterSeq;
  while (true) {
    const page = codexConversationService.listEvents(id, replayCursor, 5000);
    for (const event of page) codexConversationService.writeReplay(res, event);
    if (page.length < 5000) break;
    replayCursor = page[page.length - 1].seq;
  }
  codexConversationService.subscribe(id, res);
  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch { clearInterval(keepAlive); }
  }, 15_000);
  keepAlive.unref();
  req.on('close', () => clearInterval(keepAlive));
});

router.post('/conversations/:id/turns', requireAdminAuth, async (req, res) => {
  const input = String(req.body?.input || '').trim();
  if (!input) { res.status(400).json({ error: 'input is required' }); return; }
  if (Buffer.byteLength(input, 'utf-8') > 256 * 1024) {
    res.status(413).json({ error: 'input is too large' });
    return;
  }

  try {
    const { conversation, agent } = conversationAgent(String(req.params.id));
    if (codexConversationService.activeTurn(conversation.id)) throw new Error('active_turn_exists');
    const turn = codexConversationService.createTurn(conversation.id, input);
    codexConversationService.appendInternalEvent(conversation.id, turn.id, 'maf/userMessage', { text: input });
    try {
      const started = await daemonPost(agent, '/codex/conversations/turn', {
        conversation_id: conversation.id,
        maf_turn_id: turn.id,
        agent_name: conversation.agent_name,
        project_path: conversation.project_path,
        thread_id: conversation.thread_id,
        input,
        model: conversation.model,
        approval_policy: conversation.approval_policy,
        sandbox_mode: conversation.sandbox_mode,
      });
      const remoteTurnId = String(started.turn_id || '');
      if (!remoteTurnId) throw new Error('Daemon returned no Codex turn_id');
      codexConversationService.setTurnStarted(turn.id, remoteTurnId);
      codexConversationService.appendInternalEvent(conversation.id, turn.id, 'maf/turnAccepted', {
        remote_turn_id: remoteTurnId,
      });
      res.status(202).json(codexConversationService.getTurn(turn.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      codexConversationService.failTurn(turn.id, message);
      codexConversationService.appendInternalEvent(conversation.id, turn.id, 'maf/turnFailed', { error: message });
      res.status(502).json({ error: message, turn: codexConversationService.getTurn(turn.id) });
    }
  } catch (error) {
    sendKnownError(res, error);
  }
});

router.post('/conversations/:id/interrupt', requireAdminAuth, async (req, res) => {
  try {
    const { conversation, agent } = conversationAgent(String(req.params.id));
    const turn = codexConversationService.activeTurn(conversation.id);
    if (!turn) { res.status(409).json({ error: 'No active turn' }); return; }
    try {
      await daemonPost(agent, '/codex/conversations/interrupt', {
        conversation_id: conversation.id,
        maf_turn_id: turn.id,
        agent_name: conversation.agent_name,
        thread_id: conversation.thread_id,
        turn_id: turn.remote_turn_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      codexConversationService.failTurn(turn.id, `Interrupt failed: ${message}`, 'reconnecting');
      codexConversationService.appendInternalEvent(conversation.id, turn.id, 'maf/turnFailed', {
        error: message,
        recovery: 'conversation_reconnecting',
      });
      res.status(502).json({ error: message, turn: codexConversationService.getTurn(turn.id) });
      return;
    }
    codexConversationService.appendInternalEvent(conversation.id, turn.id, 'maf/interruptRequested', {
      remote_turn_id: turn.remote_turn_id,
    });
    res.status(202).json({ ok: true, turn: codexConversationService.getTurn(turn.id) });
  } catch (error) {
    sendKnownError(res, error);
  }
});

router.post('/conversations/:id/events', (req, res) => {
  const principal = res.locals.mafPrincipal;
  if (principal?.role !== 'client') {
    res.status(403).json({ error: 'Client credential required' });
    return;
  }
  const id = String(req.params.id);
  const conversation = codexConversationService.get(id);
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
  if (!agentRegistry.clientOwnsAgent(principal.id, conversation.agent_name)) {
    res.status(403).json({ error: 'Client does not own conversation Agent' });
    return;
  }
  try {
    const accepted = codexConversationService.appendClientEvents(id, principal.id, req.body?.events);
    res.json({ accepted: accepted.length, last_event_seq: codexConversationService.get(id)?.last_event_seq || 0 });
  } catch (error) {
    sendKnownError(res, error);
  }
});

// Client 事件入口位于 /api/codex 下，但不能依赖浏览器的 Admin middleware；
// auth.ts 负责签名校验，这里只接受 client principal，并按 Agent 归属再次收敛。

export default router;
