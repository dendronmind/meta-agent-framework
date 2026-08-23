import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import type {
  ExecutionErrorCode,
  FrameworkExecution,
  FrameworkExecutionStatus,
  MASRoutingDecision,
  WorkdirPolicy,
  Workflow,
  WorkflowNode,
} from '../types';
import { masRunner } from './mas-runner';
import { workflowEngine } from './workflow-engine';

const MAF_HOME = process.env.MAF_HOME || path.join(os.homedir(), '.meta-agent-framework');
const EXECUTION_ARTIFACTS_DIR = path.join(MAF_HOME, 'artifacts', 'executions');
const PATCH_MAX_BYTES = Number.parseInt(process.env.MAF_PATCH_MAX_BYTES || String(8 * 1024 * 1024), 10);

export interface CreateExecutionInput {
  request_id: string;
  external_id?: string;
  source_type?: string;
  source_ref?: string;
  title: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  preferred_agent?: string;
  workdir_policy?: WorkdirPolicy;
  artifact_base_url?: string;
  timeout_seconds?: number;
  auto_start?: boolean;
}

interface StorePatchInput {
  content: Buffer;
  base_commit?: string;
  base_branch?: string;
  changed_files?: string[];
  workspace_path?: string;
}

interface ExecutionOutcome {
  status: 'completed' | 'failed';
  selected_agent: string;
  workflow_id: string;
  result: string;
  error: string;
  error_code?: ExecutionErrorCode;
}

function safePart(value: string, fallback: string): string {
  const result = String(value || '').trim().replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return result || fallback;
}

function safeRelative(value: string): string {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) throw new Error('Invalid artifact path');
  return parts.join('/');
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

export function inferExecutionErrorCode(value: unknown): ExecutionErrorCode {
  const message = String(value || '');
  const explicit = message.match(/\[(WORKSPACE_NOT_GIT|QUEUE_FULL|AGENT_NOT_DISPATCHABLE|CLIENT_UNREACHABLE|AGENT_START_FAILED|EXECUTION_TIMEOUT|EXECUTION_CANCELLED|EXECUTION_PROTOCOL|MAS_ROUTING_FAILED|PATCH_EXPORT_FAILED|DISPATCH_FAILED)\]/)?.[1];
  if (explicit) return explicit as ExecutionErrorCode;
  if (/not a git repository|不是 git 仓库/i.test(message)) return 'WORKSPACE_NOT_GIT';
  if (/queue full|队列已满/i.test(message)) return 'QUEUE_FULL';
  if (/offline|dead|不可调度/i.test(message)) return 'AGENT_NOT_DISPATCHABLE';
  if (/ECONNREFUSED|ENETUNREACH|Client DEAD|客户端.*离线/i.test(message)) return 'CLIENT_UNREACHABLE';
  if (/timed out|timeout|超时/i.test(message)) return 'EXECUTION_TIMEOUT';
  return 'DISPATCH_FAILED';
}

export function routingDecisionStatus(decision: MASRoutingDecision['decision']): FrameworkExecutionStatus {
  if (decision === 'NO_MATCHING_AGENT') return 'awaiting_agent';
  if (decision === 'NO_DISPATCHABLE_AGENT') return 'waiting_agent_online';
  return 'needs_routing_review';
}

export function aggregateExecutionOutcome(workflows: Workflow[], fallback: string): ExecutionOutcome {
  const entries = workflows.flatMap(workflow => workflow.nodes
    .filter(node => node.status === 'completed' || node.status === 'failed')
    .map(node => ({ workflow, node })));
  const successful = [...entries].reverse()
    .find(({ node }) => node.status === 'completed' && Boolean(String(node.result || '').trim()));
  const failures = entries.filter(({ node }) => node.status === 'failed');
  if (successful) {
    return {
      status: 'completed',
      selected_agent: successful.node.agent_name,
      workflow_id: successful.workflow.id,
      result: String(successful.node.result),
      error: failures.map(({ node }) => `${node.agent_name}: ${node.result || 'execution failed'}`).join('\n').slice(0, 4000),
      error_code: failures[0]?.node.error_code,
    };
  }
  const lastFailure = failures[failures.length - 1]?.node;
  const result = String(lastFailure?.result || fallback || 'Execution completed without result');
  return {
    status: 'failed',
    selected_agent: lastFailure?.agent_name || entries[0]?.node.agent_name || '',
    workflow_id: entries[entries.length - 1]?.workflow.id || workflows[workflows.length - 1]?.id || '',
    result,
    error: result.slice(0, 4000),
    error_code: lastFailure?.error_code || inferExecutionErrorCode(result),
  };
}

function rowToExecution(row: any, artifacts: { path: string; size: number }[]): FrameworkExecution {
  return {
    id: String(row.id),
    request_id: String(row.request_id),
    external_id: String(row.external_id || ''),
    source_type: String(row.source_type || 'custom'),
    source_ref: String(row.source_ref || ''),
    title: String(row.title),
    prompt: String(row.prompt),
    metadata: parseObject(row.metadata),
    status: row.status,
    preferred_agent: row.preferred_agent || undefined,
    selected_agent: row.selected_agent || undefined,
    workspace_id: row.workspace_id || undefined,
    mas_session_id: row.mas_session_id || undefined,
    workflow_id: row.workflow_id || undefined,
    workdir_policy: row.workdir_policy || 'direct_repository',
    artifact_base_url: row.artifact_base_url || undefined,
    artifacts,
    patch: {
      available: Boolean(row.patch_path && Number(row.patch_size) > 0),
      filename: row.patch_filename || undefined,
      size: Number(row.patch_size || 0),
      sha256: row.patch_sha256 || undefined,
      base_commit: row.base_commit || undefined,
      base_branch: row.base_branch || undefined,
      changed_files: parseStringList(row.changed_files),
      workspace_path: row.remote_workspace_path || undefined,
    },
    result: row.result || undefined,
    error: row.error || undefined,
    error_code: row.error_code || undefined,
    deadline_at: row.deadline_at || undefined,
    cancel_requested_at: row.cancel_requested_at || undefined,
    cancel_request_id: row.cancel_request_id || undefined,
    termination_confirmed: Boolean(row.termination_confirmed),
    created_at: String(row.created_at),
    started_at: row.started_at || undefined,
    completed_at: row.completed_at || undefined,
    updated_at: String(row.updated_at),
  };
}

export class ExecutionService {
  private deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  create(input: CreateExecutionInput): { execution: FrameworkExecution; created: boolean } {
    const requestId = String(input.request_id || '').trim();
    if (!requestId || !input.title || !input.prompt) throw new Error('request_id, title and prompt required');
    if (requestId.length > 200) throw new Error('request_id is too long');
    const existing = getDb().prepare('SELECT * FROM executions WHERE request_id = ?').get(requestId);
    if (existing) return { execution: rowToExecution(existing, this.listArtifacts(String(existing.id))), created: false };

    const policy: WorkdirPolicy = 'direct_repository';
    const now = new Date().toISOString();
    const configuredTimeout = Number.parseInt(process.env.MAF_EXECUTION_TIMEOUT_SECONDS || '3600', 10);
    const requestedTimeout = Number(input.timeout_seconds || configuredTimeout);
    const timeoutSeconds = Math.min(24 * 60 * 60, Math.max(60, Number.isFinite(requestedTimeout) ? requestedTimeout : configuredTimeout));
    const deadlineAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();
    const id = uuidv4();
    const artifactBaseUrl = String(input.artifact_base_url || '')
      .replace('{execution_id}', encodeURIComponent(id))
      .replace(/\/$/, '');
    getDb().prepare(`INSERT INTO executions (
      id, request_id, external_id, source_type, source_ref, title, prompt, metadata, status,
      preferred_agent, workdir_policy, artifact_base_url, deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(
      id, requestId, String(input.external_id || ''), String(input.source_type || 'custom'), String(input.source_ref || ''),
      String(input.title), String(input.prompt), JSON.stringify(parseObject(input.metadata)), String(input.preferred_agent || ''),
      policy, artifactBaseUrl, deadlineAt, now, now,
    );
    fs.mkdirSync(this.inputDir(id), { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.outputDir(id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.inputDir(id), 'prompt.md'), String(input.prompt), { encoding: 'utf-8', mode: 0o600 });
    if (input.auto_start !== false) this.start(id);
    return { execution: this.get(id)!, created: true };
  }

  start(id: string): { execution: FrameworkExecution; started: boolean } | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    if (record.status !== 'queued') return { execution: record, started: false };

    const startedAt = new Date().toISOString();
    const changed = getDb().prepare(
      "UPDATE executions SET status = 'routing', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'"
    ).run(startedAt, startedAt, id).changes > 0;
    if (!changed) return { execution: this.get(id)!, started: false };
    this.armDeadline(id, record.deadline_at);
    queueMicrotask(() => void this.run(id).catch(err => this.fail(id, err?.message || String(err))));
    return { execution: this.get(id)!, started: true };
  }

  get(id: string): FrameworkExecution | undefined {
    const row = getDb().prepare('SELECT * FROM executions WHERE id = ?').get(id);
    return row ? rowToExecution(row, this.listArtifacts(id)) : undefined;
  }

  list(): FrameworkExecution[] {
    return getDb().prepare('SELECT * FROM executions ORDER BY created_at DESC').all()
      .map((row: any) => rowToExecution(row, this.listArtifacts(String(row.id))));
  }

  async cancel(id: string, reason = 'Execution cancelled', finalStatus: 'cancelled' | 'timeout' = 'cancelled'): Promise<FrameworkExecution | undefined> {
    const record = this.get(id);
    if (!record) return undefined;
    if (['completed', 'failed', 'cancelled', 'timeout', 'awaiting_agent', 'waiting_agent_online', 'needs_routing_review'].includes(record.status)) {
      return record;
    }
    const now = new Date().toISOString();
    const requestId = record.cancel_request_id || uuidv4();
    getDb().prepare(`UPDATE executions SET status = 'cancelling', cancel_requested_at = COALESCE(cancel_requested_at, ?),
      cancel_request_id = ?, error = ?, error_code = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed','failed','cancelled','timeout','awaiting_agent','waiting_agent_online','needs_routing_review')`).run(
      now, requestId, reason.slice(0, 4000), finalStatus === 'timeout' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_CANCELLED', now, id,
    );
    const active = this.get(id) || record;
    if (active.mas_session_id) masRunner.cancelSession(active.mas_session_id, reason);
    const workflowResult = active.workflow_id
      ? await workflowEngine.cancel(active.workflow_id, reason)
      : { cancelled: true, termination_confirmed: true };
    const completedAt = new Date().toISOString();
    getDb().prepare(`UPDATE executions SET status = ?, result = ?, error = ?, error_code = ?,
      termination_confirmed = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'cancelling'`).run(
      finalStatus, reason, reason.slice(0, 4000), finalStatus === 'timeout' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_CANCELLED',
      workflowResult.termination_confirmed ? 1 : 0, completedAt, completedAt, id,
    );
    this.clearDeadline(id);
    return this.get(id);
  }

  private armDeadline(id: string, deadline?: string): void {
    this.clearDeadline(id);
    if (!deadline) return;
    const delay = Math.max(0, new Date(deadline).getTime() - Date.now());
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(id);
      void this.cancel(id, `Execution exceeded its total deadline ${deadline}`, 'timeout');
    }, Math.min(delay, 2_147_000_000));
    timer.unref?.();
    this.deadlineTimers.set(id, timer);
  }

  private clearDeadline(id: string): void {
    const timer = this.deadlineTimers.get(id);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(id);
  }

  inputDir(id: string): string { return path.join(EXECUTION_ARTIFACTS_DIR, safePart(id, 'execution'), 'input'); }
  outputDir(id: string): string { return path.join(EXECUTION_ARTIFACTS_DIR, safePart(id, 'execution'), 'output'); }

  artifactPath(id: string, relativePath: string): string {
    const root = path.resolve(this.inputDir(id));
    const target = path.resolve(root, safeRelative(relativePath));
    if (!target.startsWith(root + path.sep)) throw new Error('Invalid artifact path');
    return target;
  }

  listArtifacts(id: string): { path: string; size: number }[] {
    const root = this.inputDir(id);
    if (!fs.existsSync(root)) return [];
    const output: { path: string; size: number }[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile()) output.push({ path: path.relative(root, absolute).replace(/\\/g, '/'), size: fs.statSync(absolute).size });
      }
    };
    walk(root);
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }

  storePatch(id: string, input: StorePatchInput): FrameworkExecution {
    const record = this.get(id);
    if (!record) throw new Error('Execution not found');
    if (!Buffer.isBuffer(input.content)) throw new Error('Patch content must be a Buffer');
    if (!Number.isFinite(PATCH_MAX_BYTES) || PATCH_MAX_BYTES <= 0 || input.content.length > PATCH_MAX_BYTES) {
      throw new Error(`Patch exceeds ${PATCH_MAX_BYTES} byte limit`);
    }
    const changedFiles = [...new Set((input.changed_files || []).map(String).filter(Boolean))].slice(0, 5000);
    const directory = this.outputDir(id);
    const filename = `${safePart(record.external_id || record.request_id, 'changes')}.patch`;
    const patchPath = path.join(directory, filename);
    let sha256 = '';
    if (input.content.length) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(patchPath, input.content, { mode: 0o600 });
      sha256 = createHash('sha256').update(input.content).digest('hex');
    } else {
      try { fs.unlinkSync(patchPath); } catch {}
    }
    const now = new Date().toISOString();
    getDb().prepare(`UPDATE executions SET patch_path = ?, patch_filename = ?, patch_size = ?, patch_sha256 = ?,
      base_commit = ?, base_branch = ?, changed_files = ?, remote_workspace_path = ?, updated_at = ? WHERE id = ?`).run(
      input.content.length ? patchPath : '', input.content.length ? filename : '', input.content.length, sha256,
      String(input.base_commit || ''), String(input.base_branch || ''), JSON.stringify(changedFiles),
      String(input.workspace_path || ''), now, id,
    );
    return this.get(id)!;
  }

  getPatchFile(id: string): { path: string; filename: string } | undefined {
    const row = getDb().prepare('SELECT patch_path, patch_filename, patch_size FROM executions WHERE id = ?').get(id) as any;
    if (!row?.patch_path || Number(row.patch_size || 0) <= 0 || !fs.existsSync(row.patch_path)) return undefined;
    return { path: String(row.patch_path), filename: String(row.patch_filename || 'changes.patch') };
  }

  private async run(id: string): Promise<void> {
    const record = this.get(id);
    if (!record || ['cancelling', 'cancelled', 'timeout'].includes(record.status)) return;
    const routingPrompt = [
      'This is a formal framework Execution and requires remote dispatch.',
      'Route semantically using Agent descriptions, live status, Skills, MCPs, runtime, and workspace metadata.',
      'Do not perform the task in MAS. Create a remote workflow only for a reliable match; otherwise return a structured routing_decision.',
      record.preferred_agent ? `Caller preference: ${record.preferred_agent}. This is a hint, not an override.` : '',
      '', record.prompt,
    ].filter(Boolean).join('\n');
    const session = await masRunner.submitTask(record.title, routingPrompt, {
      origin: {
        execution_id: record.id,
        request_id: record.request_id,
        external_id: record.external_id,
        source_type: record.source_type,
        source_ref: record.source_ref,
        metadata: record.metadata,
        workdir_policy: 'direct_repository',
        artifact_base_url: record.artifact_base_url,
        artifacts: record.artifacts.map(item => item.path),
        portable_prompt: record.prompt,
        require_remote_dispatch: true,
      },
      maxRounds: 1,
      onSessionCreated: (sessionId) => {
        const now = new Date().toISOString();
        const updated = getDb().prepare("UPDATE executions SET mas_session_id = ?, updated_at = ? WHERE id = ? AND status = 'routing'")
          .run(sessionId, now, id);
        if (updated.changes === 0) masRunner.cancelSession(sessionId, 'Execution was cancelled before MAS routing started');
      },
      onWorkflowCreated: (workflowId, sessionId) => {
        const now = new Date().toISOString();
        const updated = getDb().prepare("UPDATE executions SET status = 'running', workflow_id = ?, mas_session_id = ?, updated_at = ? WHERE id = ? AND status = 'routing'")
          .run(workflowId, sessionId, now, id);
        if (updated.changes === 0) {
          masRunner.cancelSession(sessionId, 'Execution was cancelled before Workflow registration completed');
          void workflowEngine.cancel(workflowId, 'Execution was cancelled before Workflow registration completed')
            .then(result => {
              const completedAt = new Date().toISOString();
              getDb().prepare(`UPDATE executions SET termination_confirmed = ?, updated_at = ?
                WHERE id = ? AND status IN ('cancelled','timeout')`).run(
                result.termination_confirmed ? 1 : 0, completedAt, id,
              );
            });
        }
      },
    });
    const workflowIds = session.rounds.map(round => round.workflow_id).filter(Boolean) as string[];
    const current = this.get(id);
    if (!current || current.status === 'cancelling' || current.status === 'cancelled' || current.status === 'timeout') {
      masRunner.cancelSession(session.id, 'Execution no longer accepts routing output');
      await Promise.all(workflowIds.map(workflowId => workflowEngine.cancel(workflowId, 'Execution no longer accepts routing output')));
      return;
    }
    if (workflowIds.length > 1) throw new Error('[EXECUTION_PROTOCOL] Formal Execution created more than one workflow');
    if (!workflowIds.length) {
      if (session.routing_decision) {
        const now = new Date().toISOString();
        getDb().prepare(`UPDATE executions SET status = ?, mas_session_id = ?, result = ?, error = '', error_code = '',
          completed_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('cancelling','cancelled','timeout')`).run(
          routingDecisionStatus(session.routing_decision.decision), session.id, session.routing_decision.reason, now, now, id,
        );
        this.clearDeadline(id);
        return;
      }
      const reason = String(session.rounds[session.rounds.length - 1]?.mas_output || 'MAS returned no workflow or routing decision');
      throw new Error(`[MAS_ROUTING_FAILED] ${reason.slice(0, 4000)}`);
    }
    const workflows = workflowIds.map(workflowId => workflowEngine.get(workflowId)).filter(Boolean) as Workflow[];
    const fallback = String(session.rounds[session.rounds.length - 1]?.mas_output || 'Execution completed without result');
    const outcome = aggregateExecutionOutcome(workflows, fallback);
    const completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.outputDir(id), 'result.md'), `${outcome.result.trim()}\n`, { encoding: 'utf-8', mode: 0o600 });
    getDb().prepare(`UPDATE executions SET status = ?, selected_agent = ?, workspace_id = ?, mas_session_id = ?,
      workflow_id = ?, result = ?, error = ?, error_code = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('cancelling','cancelled','timeout')`).run(
      outcome.status, outcome.selected_agent, outcome.selected_agent, session.id, outcome.workflow_id,
      outcome.result, outcome.error, outcome.error_code || '', completedAt, completedAt, id,
    );
    this.clearDeadline(id);
  }

  private fail(id: string, error: string): void {
    const current = this.get(id);
    if (!current || current.status === 'cancelling' || current.status === 'cancelled' || current.status === 'timeout') return;
    const now = new Date().toISOString();
    const code = inferExecutionErrorCode(error);
    getDb().prepare("UPDATE executions SET status = 'failed', result = ?, error = ?, error_code = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .run(error, error.slice(0, 4000), code, now, now, id);
    this.clearDeadline(id);
  }
}

export const executionService = new ExecutionService();
