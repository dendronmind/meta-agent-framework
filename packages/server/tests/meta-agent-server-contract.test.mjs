import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(path.join(serverRoot, relativePath), 'utf8');
}

const skillPath = 'common_agent/server_skills/meta-agent-server/SKILL.md';

test('Meta-Agent-Server skill exposes a complete parseable single-node Workflow request', () => {
  const skill = read(skillPath);
  const section = skill.match(
    /<!-- MAF_MINIMAL_WORKFLOW_TEMPLATE_BEGIN -->([\s\S]*?)<!-- MAF_MINIMAL_WORKFLOW_TEMPLATE_END -->/,
  );
  assert.ok(section, 'minimal Workflow template marker is missing');
  assert.match(section[1], /curl -s -X POST http:\/\/localhost:3000\/api\/workflows/);

  const heredoc = section[1].match(/<<'JSON'\n([\s\S]*?)\nJSON/);
  assert.ok(heredoc, 'template must contain an executable JSON heredoc');
  const body = JSON.parse(heredoc[1]);

  assert.equal(typeof body.title, 'string');
  assert.ok(body.title.length > 0);
  assert.deepEqual(body.origin, { agent_name: 'Meta-Agent-Server' });
  assert.deepEqual(body.notify, { mode: 'originator', include_result: true });
  assert.equal(body.nodes.length, 1);
  assert.deepEqual(Object.keys(body.nodes[0]).sort(), [
    'agent_name', 'id', 'intent', 'prompt', 'scope',
  ]);
  assert.equal(body.nodes[0].id, 'step-1');
  assert.equal(body.nodes[0].scope, 'project');
  assert.equal(body.nodes[0].intent, 'query');
  assert.ok(body.nodes[0].agent_name.length > 0);
  assert.ok(body.nodes[0].prompt.length > 0);
});

test('runtime entries delegate fast dispatch to the skill without duplicating a partial template', () => {
  const entries = [
    'opencode/agents/Meta-Agent-Server.md',
    'claude/CLAUDE.md',
    'codex/AGENTS.md',
    'codex/agents/Meta-Agent-Server.toml',
  ].map(read);

  for (const entry of entries) {
    assert.match(entry, /skills\/meta-agent-server\/SKILL\.md/);
    assert.match(entry, /MAF_ASYNC_RESULT_DELIVERY/);
    assert.doesNotMatch(entry, /curl\s+-s\s+-X\s+POST\s+http:\/\/localhost:3000\/api\/workflows/);
    assert.doesNotMatch(entry, /origin\.agent_name\s*=/);
  }
});

test('dispatch contract defaults to synchronous delivery without verified recovery', () => {
  const contractFiles = [
    skillPath,
    'common_agent/instructions/Meta-Agent-Server.md',
    'common_agent/rules/dispatch-flow.md',
    'common_agent/rules/polling-strategy.md',
    'opencode/agents/Meta-Agent-Server.md',
    'claude/CLAUDE.md',
    'codex/AGENTS.md',
  ];
  const contract = contractFiles.map(read).join('\n');

  assert.match(contract, /派发 -> 执行 -> 结果交付/);
  assert.match(contract, /MAF_ASYNC_RESULT_DELIVERY=verified/);
  assert.match(contract, /bash scripts\/poll-workflow\.sh <workflow_id>/);
  assert.match(contract, /变量缺失[\s\S]*同步等待/);

  const staleRules = [
    '默认异步派发并返回“结果会自动回来”',
    '派发后不轮询',
    '回复用户“已派发给 xxx，结果会自动回来。”',
    '结果自动推送 — 异步派发后不用轮询',
  ];
  for (const staleRule of staleRules) assert.equal(contract.includes(staleRule), false);
});

test('Meta-Agent-Server skill exposes guarded Agent stop and start contracts', () => {
  const skill = read(skillPath);
  const stopSection = skill.match(
    /<!-- MAF_AGENT_STOP_TEMPLATE_BEGIN -->([\s\S]*?)<!-- MAF_AGENT_STOP_TEMPLATE_END -->/,
  );
  const startSection = skill.match(
    /<!-- MAF_AGENT_START_TEMPLATE_BEGIN -->([\s\S]*?)<!-- MAF_AGENT_START_TEMPLATE_END -->/,
  );
  assert.ok(stopSection, 'Agent stop template marker is missing');
  assert.ok(startSection, 'Agent start template marker is missing');

  assert.match(stopSection[1], /\/api\/agents\/<agent-id>\/stop/);
  assert.match(startSection[1], /\/api\/agents\/<agent-id>\/start/);
  const stopBody = stopSection[1].match(/-d '([^']+)'/);
  const startBody = startSection[1].match(/-d '([^']+)'/);
  assert.ok(stopBody, 'Agent stop template must contain a JSON body');
  assert.ok(startBody, 'Agent start template must contain a JSON body');
  assert.equal(JSON.parse(stopBody[1]).force, false);
  assert.equal(typeof JSON.parse(stopBody[1]).reason, 'string');
  assert.equal(typeof JSON.parse(startBody[1]).reason, 'string');

  assert.match(skill, /fields=id,agent_name,status,runtime/);
  assert.match(skill, /409[\s\S]*不得擅自重试/);
  assert.match(skill, /明确要求强制关闭[\s\S]*force:true/);
  assert.match(skill, /不直接调用 Daemon `\/shutdown`/);
});
