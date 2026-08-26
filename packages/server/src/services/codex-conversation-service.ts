import type { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import type { Agent } from '../types';

export type CodexConversationStatus = 'starting' | 'idle' | 'running' | 'failed' | 'closed' | 'reconnecting';
export type CodexTurnStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface CodexConversation {
  id: string;
  agent_id: string;
  agent_name: string;
  client_id: string;
  thread_id: string;
  title: string;
  status: CodexConversationStatus;
  project_path: string;
  model: string;
  approval_policy: string;
  sandbox_mode: string;
  source_type: string;
  context_key: string;
  last_event_seq: number;
  created_at: string;
  updated_at: string;
}

export interface CodexTurn {
  id: string;
  conversation_id: string;
  remote_turn_id: string;
  input: string;
  status: CodexTurnStatus;
  error: string;
  result: string;
  source_type: string;
  workflow_id: string;
  node_id: string;
  execution_id: string;
  task_id: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CodexTurnLink {
  source_type?: 'dashboard' | 'workflow' | 'task';
  workflow_id?: string;
  node_id?: string;
  execution_id?: string;
  task_id?: string;
}

export interface CodexConversationEvent {
  id: string;
  conversation_id: string;
  turn_id: string;
  client_event_id: string;
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface IncomingCodexEvent {
  event_id: string;
  turn_id?: string;
  remote_turn_id?: string;
  event_type: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTurnStatus(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.type || record.status || record.state || '');
  }
  return '';
}

function writeSseEvent(res: Response, event: CodexConversationEvent): void {
  res.write(`id: ${event.seq}\nevent: codex_event\ndata: ${JSON.stringify(event)}\n\n`);
}

class CodexConversationService {
  private subscribers = new Map<string, Set<Response>>();
  private recentEvents = new Map<string, CodexConversationEvent[]>();
  private recentEventIds = new Map<string, Set<string>>();

  private contextKey(agent: Agent): string {
    return [agent.client_id, agent.agent_name, agent.project_path].join('\u001f');
  }

  recoverAfterServerRestart(): void {
    const now = nowIso();
    getDb().prepare(`
      UPDATE codex_conversations SET status = 'reconnecting', updated_at = ?
      WHERE status IN ('starting', 'running')
    `).run(now);
  }

  create(agent: Agent, title: string, model = '', sourceType = 'dashboard'): CodexConversation {
    const id = uuidv4();
    const now = nowIso();
    getDb().prepare(`
      INSERT INTO codex_conversations (
        id, agent_id, agent_name, client_id, thread_id, title, status, project_path,
        model, approval_policy, sandbox_mode, source_type, context_key, last_event_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, 'starting', ?, ?, 'never', 'danger-full-access', ?, '', 0, ?, ?)
    `).run(id, agent.id, agent.agent_name, agent.client_id, title, agent.project_path, model, sourceType, now, now);
    return this.get(id)!;
  }

  getOrCreateAgentConversation(agent: Agent, model = ''): { conversation: CodexConversation; created: boolean } {
    const key = this.contextKey(agent);
    const existing = getDb().prepare('SELECT * FROM codex_conversations WHERE context_key = ? LIMIT 1').get(key);
    if (existing) return { conversation: this.get(String(existing.id))!, created: false };

    // Adopt the most recent legacy conversation so an existing remote thread
    // remains usable, but stop exposing every historical task as a conversation.
    const legacy = getDb().prepare(`
      SELECT * FROM codex_conversations
      WHERE context_key = '' AND agent_id = ? AND client_id = ? AND project_path = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(agent.id, agent.client_id, agent.project_path);
    if (legacy) {
      getDb().prepare(`
        UPDATE codex_conversations SET context_key = ?, title = ?, source_type = 'agent',
          model = CASE WHEN ? = '' THEN model ELSE ? END, updated_at = ? WHERE id = ?
      `).run(key, agent.agent_name, model, model, nowIso(), legacy.id);
      return { conversation: this.get(String(legacy.id))!, created: false };
    }

    const conversation = this.create(agent, agent.agent_name, model, 'agent');
    getDb().prepare('UPDATE codex_conversations SET context_key = ? WHERE id = ?').run(key, conversation.id);
    return { conversation: this.get(conversation.id)!, created: true };
  }

  get(id: string): CodexConversation | undefined {
    const row = getDb().prepare('SELECT * FROM codex_conversations WHERE id = ?').get(id);
    if (!row) return undefined;
    return { ...row, last_event_seq: Number(row.last_event_seq || 0) } as CodexConversation;
  }

  list(limit = 100, agentId = ''): CodexConversation[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit || 100)));
    const rows = agentId
      ? getDb().prepare("SELECT * FROM codex_conversations WHERE context_key != '' AND agent_id = ? ORDER BY updated_at DESC LIMIT ?").all(agentId, safeLimit)
      : getDb().prepare("SELECT * FROM codex_conversations WHERE context_key != '' ORDER BY updated_at DESC LIMIT ?").all(safeLimit);
    return rows.map(row => ({ ...row, last_event_seq: Number(row.last_event_seq || 0) })) as CodexConversation[];
  }

  getDetail(id: string): { conversation: CodexConversation; turns: CodexTurn[] } | undefined {
    const conversation = this.get(id);
    if (!conversation) return undefined;
    const turns = getDb().prepare(
      'SELECT * FROM codex_turns WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(id) as CodexTurn[];
    return { conversation, turns };
  }

  setReady(id: string, threadId: string, model = '', projectPath = ''): void {
    const now = nowIso();
    getDb().prepare(`
      UPDATE codex_conversations SET thread_id = ?, model = CASE WHEN ? = '' THEN model ELSE ? END,
        project_path = CASE WHEN ? = '' THEN project_path ELSE ? END,
        status = 'idle', updated_at = ? WHERE id = ?
    `).run(threadId, model, model, projectPath, projectPath, now, id);
  }

  setConversationStatus(id: string, status: CodexConversationStatus): void {
    getDb().prepare('UPDATE codex_conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  resetConversation(id: string, threadId: string, model = ''): CodexConversation | undefined {
    const conversation = this.get(id);
    if (!conversation) return undefined;
    getDb().prepare('DELETE FROM codex_turns WHERE conversation_id = ?').run(id);
    getDb().prepare('DELETE FROM codex_events WHERE conversation_id = ?').run(id);
    this.recentEvents.delete(id);
    this.recentEventIds.delete(id);
    const now = nowIso();
    getDb().prepare(`
      UPDATE codex_conversations SET thread_id = ?, model = CASE WHEN ? = '' THEN model ELSE ? END,
        status = 'idle', title = agent_name, source_type = 'agent', updated_at = ? WHERE id = ?
    `).run(threadId, model, model, now, id);
    this.appendInternalEvent(id, '', 'maf/conversation/reset', { thread_id: threadId });
    return this.get(id);
  }

  createTurn(conversationId: string, _input: string, link: CodexTurnLink = {}): CodexTurn {
    const id = uuidv4();
    const now = nowIso();
    getDb().prepare(`
      INSERT INTO codex_turns (
        id, conversation_id, remote_turn_id, input, status, error, result,
        source_type, workflow_id, node_id, execution_id, task_id,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, '', ?, 'starting', '', '', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      id, conversationId, '',
      String(link.source_type || 'dashboard'),
      String(link.workflow_id || ''),
      String(link.node_id || ''),
      String(link.execution_id || ''),
      String(link.task_id || ''),
      now, now,
    );
    getDb().prepare("UPDATE codex_conversations SET status = 'running', updated_at = ? WHERE id = ?")
      .run(now, conversationId);
    return this.getTurn(id)!;
  }

  getTurn(id: string): CodexTurn | undefined {
    return getDb().prepare('SELECT * FROM codex_turns WHERE id = ?').get(id) as CodexTurn | undefined;
  }

  activeTurn(conversationId: string): CodexTurn | undefined {
    return getDb().prepare(`
      SELECT * FROM codex_turns WHERE conversation_id = ? AND status IN ('queued', 'starting', 'running')
      ORDER BY created_at DESC LIMIT 1
    `).get(conversationId) as CodexTurn | undefined;
  }

  setTurnStarted(id: string, remoteTurnId: string): void {
    const now = nowIso();
    getDb().prepare(`
      UPDATE codex_turns SET remote_turn_id = ?, status = 'running',
        started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
    `).run(remoteTurnId, now, now, id);
  }

  failTurn(id: string, error: string, conversationStatus: CodexConversationStatus = 'failed'): void {
    const turn = this.getTurn(id);
    if (!turn) return;
    const now = nowIso();
    getDb().prepare(`
      UPDATE codex_turns SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(error, now, now, id);
    this.setConversationStatus(turn.conversation_id, conversationStatus);
  }

  listEvents(conversationId: string, afterSeq = 0, limit = 2000): CodexConversationEvent[] {
    const safeAfter = Math.max(0, Math.floor(afterSeq || 0));
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit || 2000)));
    return (this.recentEvents.get(conversationId) || [])
      .filter(event => event.seq > safeAfter)
      .slice(0, safeLimit);
  }

  appendInternalEvent(
    conversationId: string,
    turnId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): CodexConversationEvent {
    const [event] = this.appendEvents(conversationId, [{
      event_id: `server-${uuidv4()}`,
      turn_id: turnId,
      event_type: eventType,
      payload,
      created_at: nowIso(),
    }]);
    return event;
  }

  appendClientEvents(conversationId: string, clientId: string, events: IncomingCodexEvent[]): CodexConversationEvent[] {
    const conversation = this.get(conversationId);
    if (!conversation) throw new Error('conversation_not_found');
    if (!clientId || conversation.client_id !== clientId) throw new Error('conversation_client_mismatch');
    return this.appendEvents(conversationId, events);
  }

  private appendEvents(conversationId: string, events: IncomingCodexEvent[]): CodexConversationEvent[] {
    const conversation = this.get(conversationId);
    if (!conversation) throw new Error('conversation_not_found');
    if (!Array.isArray(events) || events.length === 0 || events.length > 100) throw new Error('invalid_event_batch');

    let nextSeq = conversation.last_event_seq;
    const inserted: CodexConversationEvent[] = [];
    for (const incoming of events) {
      const eventId = String(incoming?.event_id || '');
      const eventType = String(incoming?.event_type || '');
      const turnId = String(incoming?.turn_id || '');
      if (!/^[A-Za-z0-9._:-]{8,160}$/.test(eventId) || !/^[A-Za-z0-9._/:-]{1,160}$/.test(eventType)) {
        throw new Error('invalid_event');
      }
      if (turnId) {
        const turn = this.getTurn(turnId);
        if (!turn || turn.conversation_id !== conversationId) throw new Error('event_turn_mismatch');
      }
      let eventIds = this.recentEventIds.get(conversationId);
      if (!eventIds) {
        eventIds = new Set<string>();
        this.recentEventIds.set(conversationId, eventIds);
      }
      if (eventIds.has(eventId)) continue;

      const payload = parsePayload(incoming.payload || {});
      const payloadJson = JSON.stringify(payload);
      if (Buffer.byteLength(payloadJson, 'utf-8') > 512 * 1024) throw new Error('event_payload_too_large');
      const createdAt = /^\d{4}-\d{2}-\d{2}T/.test(String(incoming.created_at || ''))
        ? String(incoming.created_at)
        : nowIso();
      nextSeq += 1;
      const id = uuidv4();
      const event: CodexConversationEvent = {
        id,
        conversation_id: conversationId,
        turn_id: turnId,
        client_event_id: eventId,
        seq: nextSeq,
        event_type: eventType,
        payload,
        created_at: createdAt,
      };
      inserted.push(event);
      eventIds.add(eventId);
      this.applyEventState(event, String(incoming.remote_turn_id || ''));
    }

    if (inserted.length > 0) {
      getDb().prepare('UPDATE codex_conversations SET last_event_seq = ?, updated_at = ? WHERE id = ?')
        .run(nextSeq, nowIso(), conversationId);
      const recent = this.recentEvents.get(conversationId) || [];
      recent.push(...inserted);
      if (recent.length > 5000) recent.splice(0, recent.length - 5000);
      this.recentEvents.set(conversationId, recent);
      const retainedIds = new Set(recent.map(event => event.client_event_id));
      this.recentEventIds.set(conversationId, retainedIds);
      for (const event of inserted) this.publish(event);
    }
    return inserted;
  }

  private applyEventState(event: CodexConversationEvent, remoteTurnId: string): void {
    const now = nowIso();
    if (event.event_type === 'maf/conversation/ready') {
      this.setReady(
        event.conversation_id,
        String(event.payload.thread_id || ''),
        String(event.payload.model || ''),
        String(event.payload.project_path || ''),
      );
      return;
    }
    if (event.turn_id && remoteTurnId) {
      getDb().prepare(`
        UPDATE codex_turns SET remote_turn_id = CASE WHEN remote_turn_id = '' THEN ? ELSE remote_turn_id END,
          updated_at = ? WHERE id = ?
      `).run(remoteTurnId, now, event.turn_id);
    }
    if (event.event_type === 'turn/started' && event.turn_id) {
      getDb().prepare(`
        UPDATE codex_turns SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
      `).run(now, now, event.turn_id);
      this.setConversationStatus(event.conversation_id, 'running');
      return;
    }
    if (event.event_type === 'item/agentMessage/delta' && event.turn_id) return;
    if (event.event_type === 'item/completed' && event.turn_id) return;
    if (event.event_type === 'turn/completed' && event.turn_id) {
      const payloadTurn = parsePayload(event.payload.turn);
      const rawStatus = normalizeTurnStatus(payloadTurn.status);
      const status: CodexTurnStatus = rawStatus === 'interrupted' ? 'interrupted'
        : rawStatus === 'failed' ? 'failed'
          : 'completed';
      const error = payloadTurn.error ? JSON.stringify(payloadTurn.error) : '';
      getDb().prepare(`
        UPDATE codex_turns SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?
      `).run(status, error, now, now, event.turn_id);
      this.setConversationStatus(event.conversation_id, 'idle');
      return;
    }
    if (event.event_type === 'maf/app-server/exited') {
      if (event.turn_id) this.failTurn(event.turn_id, String(event.payload.error || 'Codex app-server exited'), 'reconnecting');
      else this.setConversationStatus(event.conversation_id, 'reconnecting');
      return;
    }
    if (event.event_type === 'maf/app-server/reconnecting') {
      this.setConversationStatus(event.conversation_id, 'reconnecting');
    }
  }

  subscribe(conversationId: string, res: Response): void {
    let clients = this.subscribers.get(conversationId);
    if (!clients) {
      clients = new Set<Response>();
      this.subscribers.set(conversationId, clients);
    }
    clients.add(res);
    res.on('close', () => {
      clients!.delete(res);
      if (clients!.size === 0) this.subscribers.delete(conversationId);
    });
  }

  private publish(event: CodexConversationEvent): void {
    const clients = this.subscribers.get(event.conversation_id);
    if (!clients) return;
    for (const client of clients) {
      try { writeSseEvent(client, event); } catch { clients.delete(client); }
    }
    if (clients.size === 0) this.subscribers.delete(event.conversation_id);
  }

  writeReplay(res: Response, event: CodexConversationEvent): void {
    writeSseEvent(res, event);
  }

  closeAll(reason = 'server_shutdown'): void {
    for (const clients of this.subscribers.values()) {
      for (const client of clients) {
        try {
          client.write(`event: server_shutdown\ndata: ${JSON.stringify({ reason })}\n\n`);
          client.end();
        } catch {}
      }
    }
    this.subscribers.clear();
  }
}

export const codexConversationService = new CodexConversationService();
