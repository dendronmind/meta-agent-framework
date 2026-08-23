/**
 * SQLite 存储（基于 sql.js — 纯 WASM/asm.js，零原生编译）
 *
 * 对外暴露与 better-sqlite3 兼容的同步 API（prepare/run/get/all/exec），
 * 内部使用 sql.js。
 *
 * 使用前必须先调用 initDb()（async），之后 getDb() 同步可用。
 * 数据文件：~/.meta-agent-framework/data/maf.db
 */

import path from 'path';
import fs from 'fs';
import os from 'os';

const MAF_HOME = process.env.MAF_HOME || path.join(os.homedir(), '.meta-agent-framework');
const DATA_DIR = path.join(MAF_HOME, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'maf.db');

// ============================================================
// sql.js 实例
// ============================================================

let sqlJsDb: any = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistDb();
  }, 200);
}

function persistDb(): void {
  if (!sqlJsDb) return;
  try {
    const data = sqlJsDb.export();
    const buffer = Buffer.from(data);
    ensureDir();
    fs.writeFileSync(DB_PATH, buffer);
  } catch (err) {
    console.error('[DB] Failed to persist:', err);
  }
}

// ============================================================
// 初始化（async，Server 启动时调用一次）
// ============================================================

export async function initDb(): Promise<void> {
  if (sqlJsDb) return;

  ensureDir();

  const initSqlJs = require('sql.js/dist/sql-asm.js');
  const SQL = await initSqlJs();

  // 尝试加载已有数据库文件
  if (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0) {
    const buffer = fs.readFileSync(DB_PATH);
    sqlJsDb = new SQL.Database(buffer);
  } else {
    sqlJsDb = new SQL.Database();
  }

  initTables();
  sqlJsDb.run("UPDATE executions SET workdir_policy = 'direct_repository' WHERE workdir_policy != 'direct_repository' OR workdir_policy IS NULL");
  sqlJsDb.run(`UPDATE executions SET status = 'cancelled',
    result = CASE WHEN result = '' THEN 'Execution cancellation was interrupted by MAF Server restart' ELSE result END,
    error = 'Execution cancellation was interrupted by MAF Server restart; remote termination is unconfirmed',
    error_code = 'EXECUTION_CANCELLED', termination_confirmed = 0,
    completed_at = datetime('now'), updated_at = datetime('now')
    WHERE status = 'cancelling'`);
  sqlJsDb.run(`UPDATE executions SET status = 'failed', result = CASE WHEN result = '' THEN 'MAF Server restarted before execution completed' ELSE result END,
    error = 'MAF Server restarted before execution completed', error_code = 'DISPATCH_FAILED',
    completed_at = datetime('now'), updated_at = datetime('now')
    WHERE status IN ('routing', 'running')
       OR (status = 'queued' AND (started_at IS NOT NULL OR workflow_id != '' OR mas_session_id != ''))`);
  persistDb();
}

// ============================================================
// 兼容 better-sqlite3 的 API 包装
// ============================================================

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface Statement {
  run(...params: any[]): RunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

interface DatabaseLike {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(str: string): any;
  close(): void;
}

function createStatement(sql: string): Statement {
  return {
    run(...params: any[]): RunResult {
      try {
        sqlJsDb.run(sql, params);
        const changes = sqlJsDb.getRowsModified();
        scheduleSave();
        return { changes, lastInsertRowid: 0 };
      } catch (err: any) {
        console.error(`[DB] run error: ${err.message}\n  SQL: ${sql.slice(0, 200)}`);
        return { changes: 0, lastInsertRowid: 0 };
      }
    },

    get(...params: any[]): any {
      try {
        const stmt = sqlJsDb.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      } catch (err: any) {
        console.error(`[DB] get error: ${err.message}\n  SQL: ${sql.slice(0, 200)}`);
        return undefined;
      }
    },

    all(...params: any[]): any[] {
      try {
        const stmt = sqlJsDb.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        const results: any[] = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      } catch (err: any) {
        console.error(`[DB] all error: ${err.message}\n  SQL: ${sql.slice(0, 200)}`);
        return [];
      }
    }
  };
}

// ============================================================
// 表初始化
// ============================================================

function initTables(): void {
  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      host_user TEXT NOT NULL DEFAULT '',
      client_endpoint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline',
      last_heartbeat TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'subagent',
      runtime TEXT NOT NULL DEFAULT 'opencode',
      skills TEXT NOT NULL DEFAULT '[]',
      mcps TEXT NOT NULL DEFAULT '[]',
      client_version TEXT NOT NULL DEFAULT '',
      plugin_hash TEXT NOT NULL DEFAULT '',
      daemon_port INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT NOT NULL,
      UNIQUE(user_id, host_user, agent_name)
    )
  `);
  try { sqlJsDb.run("ALTER TABLE agents ADD COLUMN client_id TEXT NOT NULL DEFAULT ''"); } catch {}

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'custom',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent_id TEXT,
      assigned_agent_name TEXT,
      assigned_user TEXT,
      result TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      score REAL,
      created_at TEXT NOT NULL
    )
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      suggested_fix TEXT NOT NULL DEFAULT '',
      files TEXT NOT NULL DEFAULT '[]',
      source_path TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      review_comment TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS client_identities (
      client_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      public_key_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      client_endpoint TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      host_user TEXT NOT NULL DEFAULT '',
      source_ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      approved_at TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL
    )
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      external_id TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'custom',
      source_ref TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      preferred_agent TEXT NOT NULL DEFAULT '',
      selected_agent TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      mas_session_id TEXT NOT NULL DEFAULT '',
      workflow_id TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      workdir_policy TEXT NOT NULL DEFAULT 'direct_repository',
      artifact_base_url TEXT NOT NULL DEFAULT '',
      patch_path TEXT NOT NULL DEFAULT '',
      patch_filename TEXT NOT NULL DEFAULT '',
      patch_size INTEGER NOT NULL DEFAULT 0,
      patch_sha256 TEXT NOT NULL DEFAULT '',
      base_commit TEXT NOT NULL DEFAULT '',
      base_branch TEXT NOT NULL DEFAULT '',
      changed_files TEXT NOT NULL DEFAULT '[]',
      remote_workspace_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      deadline_at TEXT,
      cancel_requested_at TEXT,
      cancel_request_id TEXT NOT NULL DEFAULT '',
      termination_confirmed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  // 早期试验版 Execution 表使用 case_id/run_id/case_type。启动时一次性迁移为
  // 通用协议字段，避免框架数据库继续固化某个业务平台的数据模型。
  const executionInfo = sqlJsDb.exec("PRAGMA table_info('executions')")?.[0];
  const executionColumns = new Set<string>((executionInfo?.values || []).map((row: any[]) => String(row[1])));
  if (executionColumns.has('case_id') && !executionColumns.has('request_id')) {
    const value = (column: string, fallback: string) => executionColumns.has(column) ? column : fallback;
    sqlJsDb.run('ALTER TABLE executions RENAME TO executions_business_v0');
    sqlJsDb.run(`
      CREATE TABLE executions (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, external_id TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'custom', source_ref TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
        prompt TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',
        preferred_agent TEXT NOT NULL DEFAULT '', selected_agent TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '',
        mas_session_id TEXT NOT NULL DEFAULT '', workflow_id TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '', workdir_policy TEXT NOT NULL DEFAULT 'direct_repository',
        artifact_base_url TEXT NOT NULL DEFAULT '', patch_path TEXT NOT NULL DEFAULT '', patch_filename TEXT NOT NULL DEFAULT '',
        patch_size INTEGER NOT NULL DEFAULT 0, patch_sha256 TEXT NOT NULL DEFAULT '', base_commit TEXT NOT NULL DEFAULT '',
        base_branch TEXT NOT NULL DEFAULT '', changed_files TEXT NOT NULL DEFAULT '[]', remote_workspace_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        deadline_at TEXT, cancel_requested_at TEXT, cancel_request_id TEXT NOT NULL DEFAULT '',
        termination_confirmed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      )
    `);
    sqlJsDb.run(`INSERT INTO executions (
      id, request_id, external_id, source_type, source_ref, title, prompt, status, preferred_agent,
      selected_agent, workspace_id, mas_session_id, workflow_id, result, error, error_code, workdir_policy,
      artifact_base_url, patch_path, patch_filename, patch_size, patch_sha256, base_commit, base_branch,
      changed_files, remote_workspace_path, created_at, started_at, completed_at,
      deadline_at, cancel_requested_at, cancel_request_id, termination_confirmed, updated_at
    ) SELECT id, ${value('run_id', 'id')}, ${value('case_id', "''")}, ${value('case_type', "'custom'")},
      ${value('source_ref', "''")}, title, prompt, status, ${value('preferred_agent', "''")},
      ${value('selected_agent', "''")}, ${value('workspace_id', "''")}, ${value('mas_session_id', "''")},
      ${value('workflow_id', "''")}, ${value('result', "''")}, ${value('error', "''")},
      ${value('error_code', "''")}, ${value('workdir_policy', "'direct_repository'")},
      ${value('artifact_base_url', "''")}, ${value('patch_path', "''")}, ${value('patch_filename', "''")},
      ${value('patch_size', '0')}, ${value('patch_sha256', "''")}, ${value('base_commit', "''")},
      ${value('base_branch', "''")}, ${value('changed_files', "'[]'")}, ${value('remote_workspace_path', "''")},
      created_at, started_at, completed_at, ${value('deadline_at', "NULL")},
      ${value('cancel_requested_at', "NULL")}, ${value('cancel_request_id', "''")},
      ${value('termination_confirmed', '0')}, updated_at FROM executions_business_v0`);
    sqlJsDb.run('DROP TABLE executions_business_v0');
  }

  const executionMigrations: Record<string, string> = {
    deadline_at: 'TEXT',
    cancel_requested_at: 'TEXT',
    cancel_request_id: "TEXT NOT NULL DEFAULT ''",
    termination_confirmed: 'INTEGER NOT NULL DEFAULT 0',
  };
  const currentExecutionInfo = sqlJsDb.exec("PRAGMA table_info('executions')")?.[0];
  const currentExecutionColumns = new Set<string>((currentExecutionInfo?.values || []).map((row: any[]) => String(row[1])));
  for (const [name, definition] of Object.entries(executionMigrations)) {
    if (!currentExecutionColumns.has(name)) sqlJsDb.run(`ALTER TABLE executions ADD COLUMN ${name} ${definition}`);
  }

  // 索引
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_agents_client_id ON agents(client_id)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_feedback_agent ON feedback(agent_id)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_feedback_task ON feedback(task_id)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_proposals_agent ON proposals(from_agent)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_proposals_type ON proposals(type)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_client_identities_status ON client_identities(status)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status)");
  sqlJsDb.run("CREATE INDEX IF NOT EXISTS idx_executions_external_id ON executions(external_id)");
}

// ============================================================
// 导出
// ============================================================

let dbInstance: DatabaseLike | null = null;

export function getDb(): DatabaseLike {
  if (!sqlJsDb) {
    throw new Error('[DB] Database not initialized. Call initDb() first.');
  }
  if (!dbInstance) {
    dbInstance = {
      prepare(sql: string): Statement {
        return createStatement(sql);
      },
      exec(sql: string): void {
        try {
          sqlJsDb.run(sql);
          scheduleSave();
        } catch (err: any) {
          console.error(`[DB] exec error: ${err.message}\n  SQL: ${sql.slice(0, 200)}`);
        }
      },
      pragma(str: string): any {
        if (str.startsWith('table_info')) {
          const table = str.match(/table_info\('(\w+)'\)/)?.[1];
          if (table) {
            try {
              const stmt = sqlJsDb.prepare(`PRAGMA table_info('${table}')`);
              const results: any[] = [];
              while (stmt.step()) results.push(stmt.getAsObject());
              stmt.free();
              return results;
            } catch { return []; }
          }
        }
        try { sqlJsDb.run(`PRAGMA ${str}`); } catch {}
        return undefined;
      },
	      close(): void {
	        if (saveTimer) {
	          clearTimeout(saveTimer);
	          saveTimer = null;
	        }
	        persistDb();
	        if (sqlJsDb) {
	          sqlJsDb.close();
	          sqlJsDb = null;
        }
        dbInstance = null;
      }
    };
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
  }
}
