import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('dynamic Agent keeps a stable database id across registrations', async () => {
  const mafHome = mkdtempSync(path.join(os.tmpdir(), 'maf-registry-test-'));
  process.env.MAF_HOME = mafHome;
  process.env.FEISHU_SYNC_DISABLED = '1';
  const { initDb, closeDb } = await import('../dist/db/database.js');
  const { agentRegistry, isHistoricalAgentStatus } = await import('../dist/services/agent-registry.js');

  await initDb();
  const payload = {
    client_id: 'stable-client',
    user_id: 'test-user',
    host_user: 'test-host',
    client_endpoint: 'http://127.0.0.1:49000',
    agents: [{
      agent_name: 'stable-agent',
      project_path: '/tmp/stable-agent',
      capabilities: 'test agent',
      runtime: 'codex',
      skills: [],
      mcps: [],
    }],
  };

  try {
    const first = agentRegistry.registerClient(payload)[0];
    const second = agentRegistry.registerClient({
      ...payload,
      agents: [{ ...payload.agents[0], capabilities: 'updated description' }],
    })[0];

    assert.equal(second.id, first.id);
    assert.equal(second.capabilities, 'updated description');
    assert.equal(isHistoricalAgentStatus('online'), false);
    assert.equal(isHistoricalAgentStatus('busy'), false);
    assert.equal(isHistoricalAgentStatus('offline'), true);
    assert.equal(isHistoricalAgentStatus('dead'), true);
  } finally {
    closeDb();
    rmSync(mafHome, { recursive: true, force: true });
  }
});
