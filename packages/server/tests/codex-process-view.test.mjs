import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { aggregateCodexProcess } = require('../src/public/codex-process-view.js');
const dashboardSource = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');

test('Codex process view aggregates streaming fragments into TUI-style steps', () => {
  const events = [
    { seq: 1, turn_id: 'turn-1', event_type: 'turn/started', payload: { turn: { id: 'remote-1', status: 'inProgress' } } },
    { seq: 2, turn_id: 'turn-1', event_type: 'turn/started', payload: { turn: { id: 'remote-1', status: 'inProgress' } } },
    { seq: 3, turn_id: 'turn-1', event_type: 'item/started', payload: { item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] } } },
    { seq: 4, turn_id: 'turn-1', event_type: 'item/reasoning/summaryTextDelta', payload: { itemId: 'reason-1', summaryIndex: 0, delta: 'Inspecting ' } },
    { seq: 5, turn_id: 'turn-1', event_type: 'item/reasoning/summaryTextDelta', payload: { itemId: 'reason-1', summaryIndex: 0, delta: 'the code' } },
    { seq: 6, turn_id: 'turn-1', event_type: 'item/completed', payload: { item: { id: 'reason-1', type: 'reasoning', summary: ['Inspecting the code'], content: [] } } },
    { seq: 7, turn_id: 'turn-1', event_type: 'item/started', payload: { item: { id: 'command-1', type: 'commandExecution', command: 'npm test', status: 'inProgress', aggregatedOutput: null } } },
    { seq: 8, turn_id: 'turn-1', event_type: 'item/commandExecution/outputDelta', payload: { itemId: 'command-1', delta: 'tests ' } },
    { seq: 9, turn_id: 'turn-1', event_type: 'item/commandExecution/outputDelta', payload: { itemId: 'command-1', delta: 'passed' } },
    { seq: 10, turn_id: 'turn-1', event_type: 'item/completed', payload: { item: { id: 'command-1', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'tests passed', exitCode: 0 } } },
    { seq: 11, turn_id: 'turn-1', event_type: 'item/agentMessage/delta', payload: { itemId: 'message-1', delta: 'one' } },
    { seq: 12, turn_id: 'turn-1', event_type: 'item/agentMessage/delta', payload: { itemId: 'message-1', delta: ' word' } },
    { seq: 13, turn_id: 'turn-1', event_type: 'thread/tokenUsage/updated', payload: { tokenUsage: { total: { totalTokens: 12345 } } } },
    { seq: 14, turn_id: 'turn-1', event_type: 'turn/completed', payload: { turn: { id: 'remote-1', status: 'completed' } } },
  ];

  const steps = aggregateCodexProcess(events);
  assert.deepEqual(steps.map(step => step.kind), ['turnStart', 'reasoning', 'command', 'turnComplete']);
  assert.equal(steps.filter(step => step.kind === 'turnStart').length, 1);
  assert.equal(steps.find(step => step.kind === 'reasoning').text, 'Inspecting the code');
  assert.equal(steps.find(step => step.kind === 'reasoning').status, 'completed');
  assert.equal(steps.find(step => step.kind === 'command').text, 'npm test');
  assert.equal(steps.find(step => step.kind === 'command').detail, 'tests passed');
  assert.equal(steps.find(step => step.kind === 'command').status, 'completed');
  assert.equal(steps.some(step => step.text === 'one word'), false);
  assert.equal(steps.some(step => JSON.stringify(step).includes('12345')), false);
});

test('Codex process view preserves plan, file and tool actions as readable steps', () => {
  const steps = aggregateCodexProcess([
    { seq: 1, turn_id: 'turn-2', event_type: 'turn/plan/updated', payload: { explanation: 'Implement and verify', plan: [{ step: 'Edit UI', status: 'completed' }, { step: 'Run tests', status: 'inProgress' }] } },
    { seq: 2, turn_id: 'turn-2', event_type: 'item/completed', payload: { item: { id: 'files-1', type: 'fileChange', status: 'completed', changes: [{ path: 'src/app.ts', kind: 'update', diff: '@@ patch' }] } } },
    { seq: 3, turn_id: 'turn-2', event_type: 'item/completed', payload: { item: { id: 'tool-1', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', result: { content: ['found'] } } } },
  ]);

  assert.deepEqual(steps.map(step => step.kind), ['plan', 'files', 'mcp']);
  assert.equal(steps[0].plan[1].text, 'Run tests');
  assert.deepEqual(steps[1].files, [{ path: 'src/app.ts', kind: 'update' }]);
  assert.equal(steps[2].text, 'docs / search');
});

test('Dashboard batches Codex SSE rendering instead of repainting for every event', () => {
  const streamHandler = dashboardSource.match(
    /async function loadCodexConversation[\s\S]*?async function refreshCodexSnapshot/,
  );
  assert.ok(streamHandler, 'Codex conversation stream handler is missing');
  assert.match(dashboardSource, /const CODEX_RENDER_DEBOUNCE_MS = 100;/);
  assert.match(dashboardSource, /const CODEX_MAX_RENDER_EVENTS = 12000;/);
  assert.match(streamHandler[0], /appendCodexEvent\(event, generation\);/);
  assert.doesNotMatch(streamHandler[0], /appendCodexEvent\(event, generation\);\s*renderCodex\(\);/);
});

test('Dashboard exposes one remote thread per Agent and does not render Server-stored history', () => {
  assert.doesNotMatch(dashboardSource, /id="codex-conversation-list"/);
  assert.doesNotMatch(dashboardSource, /window\.prompt\(/);
  assert.match(dashboardSource, /apiPost\('\/api\/codex\/conversations', \{ agent_id: agent\.id, reset: true \}\)/);
  assert.match(dashboardSource, /const thread = detail\?\.remote\?\.thread;/);
  assert.match(dashboardSource, /const liveTurnIds = new Set/);
  assert.match(dashboardSource, /state\.codex\.events\.filter\(event => liveTurnIds\.has\(event\.turn_id\)\)/);
});
