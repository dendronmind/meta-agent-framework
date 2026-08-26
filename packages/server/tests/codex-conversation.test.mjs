import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Codex conversation service keeps one Agent context without persisting conversation content', async () => {
  const mafHome = mkdtempSync(path.join(os.tmpdir(), 'maf-codex-service-test-'));
  process.env.MAF_HOME = mafHome;
  process.env.DB_PATH = path.join(mafHome, 'data', 'conversation.db');
  process.env.FEISHU_SYNC_DISABLED = '1';
  process.env.MAF_CODEX_WORKFLOW_DELIVERY = 'managed';
  const { initDb, closeDb, getDb } = await import('../dist/db/database.js');
  const { agentRegistry } = await import('../dist/services/agent-registry.js');
  const { codexConversationService } = await import('../dist/services/codex-conversation-service.js');
  const { codexManagedExecutionService, resolveCodexDelivery } = await import('../dist/services/codex-managed-execution-service.js');
  await initDb();
  try {
    const agent = agentRegistry.registerClient({
      client_id: 'conversation-client',
      user_id: 'conversation-user',
      host_user: 'conversation-host',
      client_endpoint: 'http://127.0.0.1:49991',
      agents: [{
        agent_name: 'conversation-agent',
        project_path: '/tmp/conversation-agent',
        capabilities: 'test',
        runtime: 'codex',
        skills: [],
        mcps: [],
      }],
    })[0];
    const firstBinding = codexConversationService.getOrCreateAgentConversation(agent);
    const secondBinding = codexConversationService.getOrCreateAgentConversation(agent);
    const conversation = firstBinding.conversation;
    assert.equal(firstBinding.created, true);
    assert.equal(secondBinding.created, false);
    assert.equal(secondBinding.conversation.id, conversation.id);
    assert.equal(conversation.status, 'starting');
    assert.equal(conversation.source_type, 'agent');
    assert.notEqual(conversation.context_key, '');
    assert.deepEqual(codexConversationService.list().map(item => item.id), [conversation.id]);
    assert.equal(resolveCodexDelivery(undefined), 'managed');
    codexConversationService.setReady(conversation.id, 'thread-1', 'mock-model');
    const turn = codexConversationService.createTurn(conversation.id, 'hello');
    assert.equal(turn.input, '');
    assert.equal(turn.result, '');
    codexConversationService.setTurnStarted(turn.id, 'remote-turn-1');
    const first = codexConversationService.appendClientEvents(conversation.id, agent.client_id, [{
      event_id: 'client-event-0001',
      turn_id: turn.id,
      remote_turn_id: 'remote-turn-1',
      event_type: 'turn/started',
      payload: { threadId: 'thread-1', turn: { id: 'remote-turn-1', status: 'inProgress' } },
    }, {
      event_id: 'client-event-0002',
      turn_id: turn.id,
      remote_turn_id: 'remote-turn-1',
      event_type: 'item/agentMessage/delta',
      payload: { threadId: 'thread-1', turnId: 'remote-turn-1', delta: 'hello' },
    }]);
    assert.deepEqual(first.map(event => event.seq), [1, 2]);
    assert.equal(codexConversationService.get(conversation.id).status, 'running');
    assert.equal(codexConversationService.getTurn(turn.id).status, 'running');
    assert.equal(codexConversationService.getTurn(turn.id).result, '');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM codex_events').get().count, 0);

    const duplicate = codexConversationService.appendClientEvents(conversation.id, agent.client_id, [{
      event_id: 'client-event-0002',
      turn_id: turn.id,
      remote_turn_id: 'remote-turn-1',
      event_type: 'item/agentMessage/delta',
      payload: { delta: 'must not duplicate' },
    }]);
    assert.equal(duplicate.length, 0);
    assert.equal(codexConversationService.get(conversation.id).last_event_seq, 2);

    const completed = codexConversationService.appendClientEvents(conversation.id, agent.client_id, [{
      event_id: 'client-event-0003',
      turn_id: turn.id,
      remote_turn_id: 'remote-turn-1',
      event_type: 'turn/completed',
      payload: { threadId: 'thread-1', turn: { id: 'remote-turn-1', status: 'completed', error: null } },
    }]);
    assert.equal(completed[0].seq, 3);
    assert.equal(codexConversationService.getTurn(turn.id).status, 'completed');
    assert.equal(codexConversationService.get(conversation.id).status, 'idle');
    assert.equal(codexConversationService.listEvents(conversation.id, 1).length, 2);

    const binding = codexManagedExecutionService.create(agent, 'managed workflow', 'managed input', {
      source_type: 'workflow',
      workflow_id: 'workflow-managed-1',
      node_id: 'node-managed-1',
      execution_id: 'execution-managed-1',
    });
    const managedConversation = codexConversationService.get(binding.conversation_id);
    const managedTurn = codexConversationService.getTurn(binding.turn_id);
    assert.equal(binding.conversation_id, conversation.id);
    assert.equal(binding.thread_id, 'thread-1');
    assert.equal(managedConversation.source_type, 'agent');
    assert.equal(managedTurn.source_type, 'workflow');
    assert.equal(managedTurn.input, '');
    assert.equal(managedTurn.result, '');
    assert.equal(managedTurn.workflow_id, 'workflow-managed-1');
    assert.equal(managedTurn.node_id, 'node-managed-1');
    assert.equal(managedTurn.execution_id, 'execution-managed-1');

    assert.throws(() => codexConversationService.appendClientEvents(conversation.id, 'other-client', [{
      event_id: 'client-event-0004',
      event_type: 'error',
      payload: {},
    }]), /conversation_client_mismatch/);
    assert.throws(() => codexConversationService.appendClientEvents(conversation.id, agent.client_id, [{
      event_id: 'client-event-0005',
      turn_id: 'missing-turn',
      event_type: 'error',
      payload: {},
    }]), /event_turn_mismatch/);

    assert.ok(codexConversationService.listEvents(conversation.id).length > 0);
    const reset = codexConversationService.resetConversation(conversation.id, 'thread-2', 'mock-model-2');
    assert.equal(reset.thread_id, 'thread-2');
    assert.equal(reset.source_type, 'agent');
    assert.deepEqual(codexConversationService.getDetail(conversation.id).turns, []);
    assert.deepEqual(codexConversationService.listEvents(conversation.id).map(event => event.event_type), ['maf/conversation/reset']);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM codex_events').get().count, 0);
  } finally {
    closeDb();
    rmSync(mafHome, { recursive: true, force: true });
  }
});

test('Codex conversations in uncertain runtime state recover as reconnecting after Server restart', async () => {
  const mafHome = mkdtempSync(path.join(os.tmpdir(), 'maf-codex-recovery-test-'));
  process.env.MAF_HOME = mafHome;
  process.env.DB_PATH = path.join(mafHome, 'data', 'conversation.db');
  process.env.FEISHU_SYNC_DISABLED = '1';
  const { initDb, closeDb } = await import('../dist/db/database.js');
  const { agentRegistry } = await import('../dist/services/agent-registry.js');
  const { codexConversationService } = await import('../dist/services/codex-conversation-service.js');
  await initDb();
  try {
    const agent = agentRegistry.registerClient({
      client_id: 'recovery-client',
      user_id: 'recovery-user',
      host_user: 'recovery-host',
      client_endpoint: 'http://127.0.0.1:49992',
      agents: [{
        agent_name: 'recovery-agent',
        project_path: '/tmp/recovery-agent',
        capabilities: 'test',
        runtime: 'codex',
        skills: [],
        mcps: [],
      }],
    })[0];
    const conversation = codexConversationService.create(agent, 'recovery conversation');
    codexConversationService.setReady(conversation.id, 'thread-recovery');
    codexConversationService.createTurn(conversation.id, 'running before restart');
    codexConversationService.recoverAfterServerRestart();
    assert.equal(codexConversationService.get(conversation.id).status, 'reconnecting');
  } finally {
    closeDb();
    rmSync(mafHome, { recursive: true, force: true });
  }
});
