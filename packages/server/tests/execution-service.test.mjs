import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('generic Execution supports idempotency, staged artifacts, and Patch metadata', async () => {
  const mafHome = mkdtempSync(path.join(os.tmpdir(), 'maf-execution-test-'));
  process.env.MAF_HOME = mafHome;
  process.env.DB_PATH = path.join(mafHome, 'data', 'execution-test.db');
  const { initDb, closeDb } = await import('../dist/db/database.js');
  const { executionService } = await import('../dist/services/execution-service.js');

  await initDb();
  try {
    const first = executionService.create({
      request_id: 'request-001',
      external_id: 'external-001',
      source_type: 'arbitrary-source',
      source_ref: 'source://example/001',
      title: 'generic execution',
      prompt: 'inspect the supplied input',
      metadata: { opaque_business_context: { value: 42 } },
      workdir_policy: 'managed_workspace',
      auto_start: false,
    });

    assert.equal(first.created, true);
    assert.equal(first.execution.status, 'queued');
    assert.equal(first.execution.source_type, 'arbitrary-source');
    assert.deepEqual(first.execution.metadata, { opaque_business_context: { value: 42 } });
    assert.equal('case_id' in first.execution, false);
    assert.equal(readFileSync(executionService.artifactPath(first.execution.id, 'prompt.md'), 'utf8'), 'inspect the supplied input');

    const duplicate = executionService.create({
      request_id: 'request-001',
      title: 'must not replace the original',
      prompt: 'must not replace the original',
      auto_start: false,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.execution.id, first.execution.id);
    assert.equal(duplicate.execution.title, 'generic execution');

    assert.throws(() => executionService.artifactPath(first.execution.id, '../escape.txt'), /Invalid artifact path/);
    const patch = Buffer.from('diff --git a/a.txt b/a.txt\n');
    const patched = executionService.storePatch(first.execution.id, {
      content: patch,
      base_commit: 'abc123',
      base_branch: 'main',
      changed_files: ['a.txt', 'a.txt'],
      workspace_path: '/managed/source',
    });
    assert.equal(patched.patch.available, true);
    assert.equal(patched.patch.sha256, createHash('sha256').update(patch).digest('hex'));
    assert.deepEqual(patched.patch.changed_files, ['a.txt']);
    assert.equal(readFileSync(executionService.getPatchFile(first.execution.id).path).equals(patch), true);
  } finally {
    closeDb();
    rmSync(mafHome, { recursive: true, force: true });
  }
});
