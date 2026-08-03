/**
 * Meta-Agent-Server Runner — 有状态多轮编排
 *
 * Meta-Agent-Server 是 Server 端的主 Agent，
 * 负责任务拆解和工作流 JSON 输出。它是多轮会话制的。
 *
 * 流程：
 *   Round 1: 任务进入 → 调 Meta-Agent-Server → 它输出工作流
 *   Round 2: 工作流执行完 → 汇总结果 → 再调 Meta-Agent-Server
 *            "上一轮结果是...，从 agent 步骤进度是...，你要继续么？"
 *   Round N: Meta-Agent-Server 说 DONE → 会话结束
 *            Meta-Agent-Server 说要追加 → 新工作流 → 继续
 *
 * 历史会话保留在 Session 对象中，每轮的输入输出都记录。
 * Meta-Agent-Server 每次被调用时能看到完整历史。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { agentRegistry } from './agent-registry';
import { workflowEngine, WorkflowSummary } from './workflow-engine';
import { getConfig } from '../config';
import { getAuthToken } from '../auth';
import type { Agent, MASSession, SessionRound } from '../types';

// ============================================================
// 配置
// ============================================================

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MAX_ROUNDS = parseInt(process.env.MAS_MAX_ROUNDS || '5');
const MAS_RUN_TIMEOUT_MS = parseInt(process.env.MAS_RUN_TIMEOUT_MS || '600000');

type MasRuntime = 'opencode' | 'codex' | 'claude';

// ============================================================
// 会话存储（内存）
// ============================================================

const sessions = new Map<string, MASSession>();

interface MASSubmitOptions {
  origin?: Record<string, unknown>;
  notify?: Record<string, unknown>;
}

// ============================================================
// 核心
// ============================================================

export class MASRunner {
  private activeChildren = new Set<ChildProcessWithoutNullStreams>();
  private shuttingDown = false;

  /**
   * 提交任务 → 创建会话 → 开始第一轮
   */
  async submitTask(taskTitle: string, taskDescription: string, options: MASSubmitOptions = {}): Promise<MASSession> {
    const session: MASSession = {
      id: uuidv4(),
      title: taskTitle,
      description: taskDescription,
      status: 'active',
      rounds: [],
      max_rounds: MAX_ROUNDS,
      origin: options.origin,
      notify: options.notify,
      created_at: new Date().toISOString(),
    };

    sessions.set(session.id, session);
    console.log(`[MAS] 📋 新会话 ${session.id}: "${taskTitle}"`);

    // 启动第一轮
    await this.executeRound(session);

    return session;
  }

  /**
   * 执行一轮 Meta-Agent-Server 交互
   *
   * 1. 构建 prompt（含历史会话 + 当前 agent 网络 + 上一轮结果）
   * 2. 调 opencode run --agent Meta-Agent-Server
   * 3. 解析输出：如果有工作流 JSON → 创建工作流 → 等执行完 → 自动进入下一轮
   *             如果没有（直接回答或 DONE）→ 会话结束
   */
  private async executeRound(session: MASSession): Promise<void> {
    const roundNum = session.rounds.length + 1;

    if (roundNum > session.max_rounds) {
      console.warn(`[MAS] ⚠️ 会话 ${session.id} 达到最大轮次 ${session.max_rounds}，强制结束`);
      session.status = 'completed';
      session.completed_at = new Date().toISOString();
      return;
    }

    const agents = agentRegistry.listAll();
    const prompt = this.buildRoundPrompt(session, agents);

    console.log(`[MAS] 🔄 Round ${roundNum} — "${session.title}"`);

    let output: string;
    try {
      output = await this.runMetaAgentServer(prompt);
    } catch (err: any) {
      console.error(`[MAS] ❌ Round ${roundNum} 失败: ${err.message}`);
      session.status = 'failed';
      session.completed_at = new Date().toISOString();
      session.rounds.push({
        round: roundNum,
        mas_input: prompt,
        mas_output: `ERROR: ${err.message}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 记录本轮
    const round: SessionRound = {
      round: roundNum,
      mas_input: prompt,
      mas_output: output,
      timestamp: new Date().toISOString(),
    };
    session.rounds.push(round);

    // 解析输出：有工作流 JSON 么？
    const workflowJson = this.extractWorkflowJson(output);

    if (!workflowJson) {
      // 没有工作流 → Meta-Agent-Server 认为任务完成（直接回答或 DONE）
      console.log(`[MAS] ✅ Round ${roundNum} — 无工作流输出，会话结束`);
      session.status = 'completed';
      session.completed_at = new Date().toISOString();
      return;
    }

    // 有工作流 → 执行
    console.log(`[MAS] 🔀 Round ${roundNum} — 创建工作流: "${workflowJson.title}" (${workflowJson.nodes.length} 节点)`);
    session.status = 'waiting';  // 等待工作流执行

    try {
      const summary = await workflowEngine.run(workflowJson.title, workflowJson.nodes, {
        failure_policy: workflowJson.failure_policy,
        origin: session.origin || workflowJson.origin,
        notify: session.notify || workflowJson.notify,
      });
      round.workflow_id = summary.workflow_id;
      round.workflow_result = this.formatWorkflowResult(summary);

      console.log(`[MAS] 📊 Round ${roundNum} 工作流 ${summary.status}`);

      // 工作流执行完 → 自动进入下一轮
      session.status = 'active';
      await this.executeRound(session);

    } catch (err: any) {
      console.error(`[MAS] ❌ Round ${roundNum} 工作流异常: ${err.message}`);
      round.workflow_result = `ERROR: ${err.message}`;
      session.status = 'failed';
      session.completed_at = new Date().toISOString();
    }
  }

  /**
   * 构建单轮 prompt — 包含完整历史上下文
   */
  private buildRoundPrompt(session: MASSession, agents: Agent[]): string {
    const agentList = agents.length > 0
      ? agents.map(a => {
          const icon = a.status === 'online' ? '🟢' : a.status === 'busy' ? '🟡' : '🔴';
          return `  ${icon} ${a.agent_name} (${a.mode}, ${a.runtime || 'opencode'}) — ${a.capabilities || '无描述'}`;
        }).join('\n')
      : '  （当前无可用 agent）';

    const roundNum = session.rounds.length + 1;

    let prompt = `# 任务

**${session.title}**

${session.description}

# 当前 Agent 网络

${agentList}
`;

    // 如果有历史轮次，拼入上下文
    if (session.rounds.length > 0) {
      prompt += `\n# 历史交互（共 ${session.rounds.length} 轮）\n`;

      for (const r of session.rounds) {
        prompt += `\n## Round ${r.round}\n`;
        prompt += `### 你的决策\n${r.mas_output.slice(0, 2000)}\n`;  // 截断防超长
        if (r.workflow_result) {
          prompt += `### 执行结果\n${r.workflow_result}\n`;
        }
      }

      prompt += `\n# 当前是 Round ${roundNum}

基于以上历史结果，请判断：
1. 如果从 agent 的步骤进度有未完成的 required 步骤 → 追加工作流
2. 如果结果有问题需要修正 → 追加工作流
3. 如果全部完成 → 直接输出最终总结（不要输出工作流 JSON）

⚠️ 如果你认为任务已全部完成，请直接输出总结，不要输出 workflow JSON。
`;
    } else {
      // 第一轮
      prompt += `\n# 你的职责

这是 Round 1。分析任务，决定调用哪些 agent 来完成。

如果需要创建工作流，请用以下 JSON 格式输出：
\`\`\`json
{
  "workflow": {
    "title": "工作流标题",
    "nodes": [
      {"id": "step-1", "agent_name": "agent名", "prompt": "给agent的指令"},
      {"id": "step-2", "agent_name": "agent名", "prompt": "指令", "depends_on": ["step-1"]}
    ],
    "failure_policy": "all_settled"
  }
}
\`\`\`

failure_policy 可选：
- "all_settled"：推荐用于多 agent 并行任务；等待所有已派发/可达分支完成、失败或超时后统一汇总。
- "fail_fast"：任一节点失败即终止整个工作流。

如果任务简单到你自己就能回答，直接输出结果（不要输出 workflow JSON）。
`;
    }

    return prompt;
  }

  /**
   * 从 Meta-Agent-Server 输出中提取工作流 JSON
   */
  private extractWorkflowJson(output: string): {
    title: string;
    nodes: any[];
    failure_policy?: 'fail_fast' | 'all_settled';
    origin?: Record<string, unknown>;
    notify?: Record<string, unknown>;
  } | null {
    // 尝试从 ```json ... ``` 中提取
    const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.workflow && Array.isArray(parsed.workflow.nodes)) {
          return parsed.workflow;
        }
      } catch { /* 不是合法 JSON，忽略 */ }
    }

    // 尝试直接解析整个输出
    try {
      const parsed = JSON.parse(output);
      if (parsed.workflow && Array.isArray(parsed.workflow.nodes)) {
        return parsed.workflow;
      }
    } catch { /* 不是 JSON */ }

    return null;
  }

  /**
   * 格式化工作流结果给 Meta-Agent-Server 看
   */
  private formatWorkflowResult(summary: WorkflowSummary): string {
    const lines = [`工作流 ${summary.status}（${summary.nodes.length} 节点）\n`];

    for (const node of summary.nodes) {
      const icon = node.status === 'completed' ? '✅' : node.status === 'failed' ? '❌' : '⏭️';
      lines.push(`${icon} [${node.id}] ${node.agent_name}: ${node.status}`);
      if (node.result) {
        // 截取前 1000 字符，避免过长
        const truncated = node.result.length > 1000
          ? node.result.slice(0, 1000) + '\n...(截断)'
          : node.result;
        lines.push(truncated);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 按 Server runtime 执行一次性 Meta-Agent-Server 编排。
   *
   * 这里是 Server 内部 headless 调用，不是启动长期 TUI/Plugin：
   * - codex runtime → `codex exec`
   * - opencode runtime → `opencode run --pure`（避免加载 MAF opencode plugin 常驻循环）
   * - claude runtime → `claude --print` 且只加载 user settings（避免项目 hooks 常驻等待）
   */
  private async runMetaAgentServer(prompt: string): Promise<string> {
    const runtime = this.getServerRuntime();
    const mafHome = this.getMafHome();
    console.log(`[MAS] 🧠 使用 ${runtime} runtime 执行 Meta-Agent-Server headless`);

    if (runtime === 'codex') return await this.runCodex(prompt, mafHome);
    if (runtime === 'claude') return await this.runClaude(prompt, mafHome);
    return await this.runOpencode(prompt, mafHome);
  }

  private getMafHome(): string {
    return process.env.MAF_HOME || path.join(os.homedir(), '.meta-agent-framework');
  }

  private getServerRuntime(): MasRuntime {
    const cfg = getConfig();
    const raw = String(process.env.MAF_SERVER_RUNTIME || cfg.server.runtime || process.env.MAF_RUNTIME || '').trim();
    const normalized: Record<string, MasRuntime> = {
      opencode: 'opencode',
      codex: 'codex',
      claude: 'claude',
      'claude-code': 'claude',
      cc: 'claude',
    };
    const runtime = normalized[raw];
    if (!runtime) {
      throw new Error(`Server runtime not configured or unsupported: "${raw || '-'}". Please set server.runtime to opencode, codex, or claude.`);
    }
    return runtime;
  }

  private getServerUrl(): string {
    const cfg = getConfig();
    return process.env.META_AGENT_SERVER || cfg.server.url || `http://127.0.0.1:${cfg.server.port || 3000}`;
  }

  private baseRuntimeEnv(mafHome: string, runtime: MasRuntime): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MAF_HOME: mafHome,
      MAF_AGENT_NAME: 'Meta-Agent-Server',
      MAF_RUNTIME: runtime === 'claude' ? 'claude-code' : runtime,
      MAF_DIRECTORY: mafHome,
      META_AGENT_SERVER: this.getServerUrl(),
      MAF_AUTH_TOKEN: getAuthToken(),
    };
  }

  private runCommand(
    label: string,
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      input?: string;
      timeoutMs?: number;
      allowEmptyOutput?: boolean;
    },
  ): Promise<string> {
    if (this.shuttingDown) {
      return Promise.reject(new Error(`${label} skipped: MAS runner is shutting down`));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      this.activeChildren.add(child);

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const timeoutMs = options.timeoutMs || MAS_RUN_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        this.killChild(child, 'SIGTERM');
        setTimeout(() => this.killChild(child, 'SIGKILL'), 2000).unref();
      }, timeoutMs);

      child.stdout?.on('data', d => { stdout += d; });
      child.stderr?.on('data', d => { stderr += d; });
      child.on('error', e => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        reject(new Error(`${label} spawn failed: ${e.message}`));
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        const output = stdout.trim();
        const errOutput = stderr.trim();
        if (this.shuttingDown) {
          reject(new Error(`${label} terminated during server shutdown`));
          return;
        }
        if (timedOut) {
          reject(new Error(`${label} timed out after ${timeoutMs}ms${errOutput ? `: ${errOutput}` : ''}`));
          return;
        }
        if (code === 0 && (output || options.allowEmptyOutput)) {
          resolve(output);
        } else if (code === 0) {
          reject(new Error(`${label} completed without output${errOutput ? `: ${errOutput}` : ''}`));
        } else {
          reject(new Error(`${label} exited ${code}: ${errOutput || output}`));
        }
      });

      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      } else {
        child.stdin?.end();
      }
    });
  }

  private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (!pid) return;
    // detached=true 让子进程成为进程组 leader；优先杀进程组，兜底杀单进程。
    try { process.kill(-pid, signal); return; } catch {}
    try { child.kill(signal); } catch {}
  }

  shutdown(reason = 'Server shutdown'): void {
    this.shuttingDown = true;
    const now = new Date().toISOString();
    for (const session of sessions.values()) {
      if (session.status === 'active' || session.status === 'waiting') {
        session.status = 'failed';
        session.completed_at = now;
        session.rounds.push({
          round: session.rounds.length + 1,
          mas_input: '',
          mas_output: `ERROR: ${reason}`,
          timestamp: now,
        });
      }
    }
    for (const child of this.activeChildren) this.killChild(child, 'SIGTERM');
    setTimeout(() => {
      for (const child of this.activeChildren) this.killChild(child, 'SIGKILL');
    }, 2000).unref();
  }

  private async runCodex(prompt: string, mafHome: string): Promise<string> {
    const outDir = path.join(mafHome, 'state', 'mas-runner');
    mkdirSync(outDir, { recursive: true });
    const outputFile = path.join(outDir, `codex-${Date.now()}-${uuidv4()}.txt`);
    try {
      const stdout = await this.runCommand('codex exec', CODEX_BIN, [
        'exec',
        '-c', 'approval_policy="never"',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox', 'workspace-write',
        '--output-last-message', outputFile,
        '-',
      ], {
        cwd: mafHome,
        input: prompt,
        allowEmptyOutput: true,
        env: {
          ...this.baseRuntimeEnv(mafHome, 'codex'),
          CODEX_CWD: mafHome,
          // headless MAS 不需要 attached receiver；避免把一次性编排误注册成前台接收器
          MAF_CODEX_AUTO_ATTACHED_RECEIVER: '0',
          MAF_CODEX_ATTACHED_RECEIVER_DISABLE: '1',
        },
      });
      const final = existsSync(outputFile) ? readFileSync(outputFile, 'utf-8').trim() : '';
      const result = final || stdout.trim();
      if (!result) throw new Error('codex exec completed without output');
      return result;
    } finally {
      try { rmSync(outputFile, { force: true }); } catch {}
    }
  }

  private async runClaude(prompt: string, mafHome: string): Promise<string> {
    return await this.runCommand('claude --print', CLAUDE_BIN, [
      '--print',
      '--output-format', 'text',
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
      '--setting-sources', 'user',
      prompt,
    ], {
      cwd: mafHome,
      env: this.baseRuntimeEnv(mafHome, 'claude'),
    });
  }

  private async runOpencode(prompt: string, mafHome: string): Promise<string> {
    return await this.runCommand('opencode run', OPENCODE_BIN, [
      'run',
      '--pure',
      '--agent', 'Meta-Agent-Server',
      prompt,
    ], {
      cwd: mafHome,
      env: {
        ...this.baseRuntimeEnv(mafHome, 'opencode'),
        OPENCODE_AGENTS_DIR: path.join(mafHome, '.opencode/agents'),
      },
    });
  }

  // ============================================================
  // 查询
  // ============================================================

  getSession(id: string): MASSession | undefined {
    return sessions.get(id);
  }

  listSessions(): MASSession[] {
    return Array.from(sessions.values()).sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    );
  }

  /**
   * 直接提交工作流（跳过自动编排，手动指定）
   */
  async submitWorkflow(
    title: string,
    nodes: { id: string; agent_name: string; prompt: string; depends_on?: string[] }[],
    failure_policy: 'fail_fast' | 'all_settled' = 'all_settled',
    options: MASSubmitOptions = {},
  ) {
    console.log(`[MAS] 🔄 手动工作流: "${title}" (${nodes.length} 步)`);
    return workflowEngine.run(title, nodes, { failure_policy, origin: options.origin, notify: options.notify });
  }
}

export const masRunner = new MASRunner();
