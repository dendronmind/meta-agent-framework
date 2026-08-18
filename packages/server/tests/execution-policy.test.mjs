import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateExecutionOutcome,
  inferExecutionErrorCode,
  routingDecisionStatus,
} from '../dist/services/execution-service.js';
import { isHistoricalAgentStatus } from '../dist/services/agent-registry.js';
import { isAgentDispatchable } from '../dist/services/workflow-engine.js';

test('routing decisions map to framework statuses without business semantics', () => {
  assert.equal(routingDecisionStatus('NO_MATCHING_AGENT'), 'awaiting_agent');
  assert.equal(routingDecisionStatus('NO_DISPATCHABLE_AGENT'), 'waiting_agent_online');
  assert.equal(routingDecisionStatus('AMBIGUOUS_AGENT'), 'needs_routing_review');
});

test('successful workflow result wins over later failed branches', () => {
  const outcome = aggregateExecutionOutcome([
    {
      id: 'workflow-success',
      nodes: [{ id: 'one', agent_name: 'worker-a', status: 'completed', result: 'authoritative result' }],
    },
    {
      id: 'workflow-followup',
      nodes: [{ id: 'two', agent_name: 'worker-b', status: 'failed', result: '[EXECUTION_TIMEOUT] follow-up timed out', error_code: 'EXECUTION_TIMEOUT' }],
    },
  ], 'fallback');

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.workflow_id, 'workflow-success');
  assert.equal(outcome.selected_agent, 'worker-a');
  assert.equal(outcome.result, 'authoritative result');
  assert.match(outcome.error, /follow-up timed out/);
});

test('generic error and historical status policies remain deterministic', () => {
  assert.equal(inferExecutionErrorCode('[WORKSPACE_NOT_GIT] invalid source'), 'WORKSPACE_NOT_GIT');
  assert.equal(inferExecutionErrorCode('queue full'), 'QUEUE_FULL');
  assert.equal(inferExecutionErrorCode('operation timed out'), 'EXECUTION_TIMEOUT');
  assert.equal(isHistoricalAgentStatus('online'), false);
  assert.equal(isHistoricalAgentStatus('busy'), false);
  assert.equal(isHistoricalAgentStatus('offline'), true);
  assert.equal(isHistoricalAgentStatus('dead'), true);
});

test('offline runtime remains dispatchable through Daemon auto-launch', () => {
  assert.equal(isAgentDispatchable({ status: 'online', client_endpoint: 'http://client:4100' }), true);
  assert.equal(isAgentDispatchable({ status: 'busy', client_endpoint: 'http://client:4100' }), true);
  assert.equal(isAgentDispatchable({ status: 'offline', client_endpoint: 'http://client:4100' }), true);
  assert.equal(isAgentDispatchable({ status: 'offline', client_endpoint: '' }), false);
  assert.equal(isAgentDispatchable({ status: 'dead', client_endpoint: 'http://client:4100' }), false);
});
