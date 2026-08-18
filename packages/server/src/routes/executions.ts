import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import { executionService } from '../services/execution-service';
import { agentRegistry } from '../services/agent-registry';
import { workflowEngine } from '../services/workflow-engine';

const router = Router();

function streamFile(res: Response, file: string, contentType?: string): void {
  res.status(200);
  res.type(contentType || path.extname(file) || 'application/octet-stream');
  res.setHeader('Content-Length', String(fs.statSync(file).size));
  const stream = fs.createReadStream(file);
  stream.on('error', err => res.headersSent ? res.destroy(err) : res.status(500).json({ error: err.message }));
  stream.pipe(res);
}

router.post('/', (req: Request, res: Response) => {
  try {
    const host = req.get('host');
    const artifactBaseUrl = String(req.body?.artifact_base_url || (host
      ? `${req.protocol}://${host}/api/v1/executions/{execution_id}`
      : ''));
    const value = executionService.create({ ...req.body, artifact_base_url: artifactBaseUrl });
    res.status(value.created ? 201 : 200).json(value.execution);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', (_req: Request, res: Response) => res.json(executionService.list()));

router.post('/:id/start', (req: Request, res: Response) => {
  const value = executionService.start(String(req.params.id));
  if (!value) { res.status(404).json({ error: 'Execution not found' }); return; }
  res.status(value.started ? 202 : 200).json({ ...value.execution, started: value.started });
});

router.get('/:id', (req: Request, res: Response) => {
  const record = executionService.get(String(req.params.id));
  if (!record) { res.status(404).json({ error: 'Execution not found' }); return; }
  res.json(record);
});

router.put('/:id/artifacts/{*path}', (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!executionService.get(id)) { res.status(404).json({ error: 'Execution not found' }); return; }
  let target = '';
  let temporary = '';
  let relative = '';
  try {
    const raw = (req.params as any).path;
    relative = Array.isArray(raw) ? raw.join('/') : String(raw || '');
    target = executionService.artifactPath(id, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    temporary = `${target}.upload-${process.pid}-${Date.now()}`;
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }
  const maxBytes = Number.parseInt(process.env.MAF_ARTIFACT_MAX_BYTES || String(2 * 1024 * 1024 * 1024), 10);
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  let size = 0;
  let failed = false;
  const cleanup = () => { try { fs.rmSync(temporary, { force: true }); } catch {} };
  req.on('data', chunk => {
    size += chunk.length;
    if (size > maxBytes && !failed) {
      failed = true;
      req.unpipe(output);
      output.destroy();
      cleanup();
      res.status(413).json({ error: 'Artifact too large' });
      req.resume();
    }
  });
  req.on('error', err => {
    failed = true;
    output.destroy();
    cleanup();
    if (!res.headersSent) res.status(400).json({ error: err.message });
  });
  output.on('error', err => {
    failed = true;
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  output.on('finish', () => {
    if (failed) return;
    try {
      fs.renameSync(temporary, target);
      res.status(201).json({ path: relative.replace(/\\/g, '/').replace(/^\/+/, ''), size });
    } catch (err: any) {
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  req.pipe(output);
});

router.get('/:id/artifacts/{*path}', (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!executionService.get(id)) { res.status(404).json({ error: 'Execution not found' }); return; }
  try {
    const raw = (req.params as any).path;
    const relative = Array.isArray(raw) ? raw.join('/') : String(raw || '');
    const file = executionService.artifactPath(id, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.status(404).json({ error: 'Artifact not found' }); return; }
    streamFile(res, file);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/patch', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const record = executionService.get(id);
  if (!record) { res.status(404).json({ error: 'Execution not found' }); return; }
  const principal = res.locals.mafPrincipal;
  if (principal?.role === 'client') {
    const agentName = String(req.body?.agent_name || '');
    if (!agentRegistry.clientOwnsAgent(principal.id, agentName)
        || !workflowEngine.authorizesExecutionNode(id, String(req.body?.workflow_id || ''), String(req.body?.node_id || ''), agentName)) {
      res.status(403).json({ error: 'Execution workflow node does not belong to this client' });
      return;
    }
  }
  try {
    const encoded = String(req.body?.content_base64 || '');
    const content = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    if (encoded && content.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      res.status(400).json({ error: 'Invalid patch base64' });
      return;
    }
    const value = executionService.storePatch(id, {
      content,
      base_commit: req.body?.base_commit,
      base_branch: req.body?.base_branch,
      changed_files: Array.isArray(req.body?.changed_files) ? req.body.changed_files : [],
      workspace_path: req.body?.workspace_path,
    });
    res.json(value.patch);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/patch', (req: Request, res: Response) => {
  const patch = executionService.getPatchFile(String(req.params.id));
  if (!patch) { res.status(404).json({ error: 'Patch not found' }); return; }
  res.download(patch.path, patch.filename);
});

router.get('/:id/output/result.md', (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!executionService.get(id)) { res.status(404).json({ error: 'Execution not found' }); return; }
  const file = path.join(executionService.outputDir(id), 'result.md');
  if (!fs.existsSync(file)) { res.status(404).json({ error: 'Result not available' }); return; }
  streamFile(res, file, 'text/markdown; charset=utf-8');
});

export default router;
