// ============================================================
// Meta-Agent Framework 核心类型定义
// ============================================================

import { readFileSync } from 'fs';
import { join } from 'path';

/** Server 版本号 — 从 package.json 读取（唯一版本源） */
export const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();

/** Client 最低兼容版本（低于此版本自动触发 OTA，需手动管理） */
export const CLIENT_MIN_VERSION = '0.4.0';

// --- Agent（一行 = 一个 agent，用户信息内联） ---

export type AgentStatus = 'online' | 'offline' | 'busy' | 'dead';

/** Agent 运行时类型：决定 Client 端使用哪个 CLI 工具执行 */
export type AgentRuntime = 'opencode' | 'claude-code' | 'codex';

/** Client 注册时提交的 payload */
export interface ClientRegisterPayload {
  user_id: string;             // 用户标识，如 zhangsan
  host_user: string;               // 宿主机用户名，如 mi
  client_endpoint: string;         // http://ip:port
  agents: AgentInfo[];             // 该用户的所有 agent
  client_version?: string;         // Client（Plugin）版本号
  plugin_hash?: string;            // Plugin index.js 的 content hash
  daemon_port?: number;            // Daemon HTTP 端口
}

/** Skill 摘要（注册/心跳时上报） */
export interface SkillInfo {
  name: string;                      // skill 目录名，如 "feishu"
  description?: string;              // 从 SKILL.md 提取的首行描述
  files?: string[];                  // 文件列表（相对路径），如 ["SKILL.md", "reference/api.md"]
}

/** MCP Server 摘要（注册/心跳时上报） */
export interface McpInfo {
  name: string;                      // mcp key，如 "feishu-mcp-pro"
  type?: string;                     // local / remote / sse
  enabled?: boolean;                 // 是否启用
  command?: string[];                // local 类型的启动命令
  url?: string;                      // remote/sse 类型的 URL
}

/** 单个 agent 的信息（注册时上报） */
export interface AgentInfo {
  agent_name: string;
  project_path?: string;           // agent 所在项目目录
  capabilities: string;            // 自然语言描述
  mode?: 'primary' | 'subagent' | 'all';
  runtime?: AgentRuntime;          // 运行时：opencode（默认）/ claude-code / codex
  skills?: SkillInfo[];            // 该 agent 可用的 skills
  mcps?: McpInfo[];                // 该 agent 可用的 MCP servers
}

/** Agent 记录（数据库） */
export interface Agent {
  id: string;
  user_id: string;             // 用户标识
  host_user: string;               // 宿主机用户名
  client_endpoint: string;         // Client 地址
  status: AgentStatus;             // online/offline/busy/dead
  last_heartbeat: string;          // ISO timestamp
  agent_name: string;              // Agent 名称
  project_path: string;            // 项目路径
  capabilities: string;            // 能力标签（自然语言）
  mode: string;                    // primary/subagent/all
  runtime: AgentRuntime;           // 运行时：opencode / claude-code / codex
  skills: string;                  // JSON 字符串: SkillInfo[]
  mcps: string;                    // JSON 字符串: McpInfo[]
  client_version: string;          // Client（Plugin）版本号
  plugin_hash: string;             // Plugin index.js content hash
  daemon_port: number;             // Daemon HTTP 端口
  registered_at: string;
}

/** 心跳 payload */
export interface HeartbeatPayload {
  agent_statuses?: Record<string, AgentStatus>;  // agent_name → status
  /** 增量更新 agent 的 skills/mcps（进化后、配置变更后） */
  agent_inventory?: Record<string, { skills?: SkillInfo[]; mcps?: McpInfo[] }>;
  client_version?: string;         // Client（Plugin）版本号
  plugin_hash?: string;            // Plugin index.js 的 content hash
  daemon_port?: number;            // Daemon HTTP 端口
}

// --- Task ---

export type TaskStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'timeout';
export type TaskType = 'requirement' | 'bug' | 'review' | 'custom';

export interface TaskCreatePayload {
  type: TaskType;
  title: string;
  description: string;
  target_agent?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  type: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: string;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  assigned_user: string | null;    // user_id
  result: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskResultPayload {
  task_id: string;
  status: 'completed' | 'failed';
  result: string;
  token_input?: number;
  token_output?: number;
  duration_ms?: number;
}

// --- Feedback ---

export interface Feedback {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name: string;
  user_id: string;
  status: string;
  duration_ms: number;
  token_input: number;
  token_output: number;
  model: string;
  summary: string;
  score: number | null;
  created_at: string;
}

// --- Meta-Agent-Server Session ---

export type SessionStatus = 'active' | 'waiting' | 'completed' | 'failed';

/** 会话中的一轮交互 */
export interface SessionRound {
  round: number;                     // 第几轮（从 1 开始）
  mas_input: string;                 // 给 Meta-Agent-Server 的输入（含上一轮结果）
  mas_output: string;                // Meta-Agent-Server 的输出
  workflow_id?: string;              // 本轮创建的工作流（如有）
  workflow_result?: string;          // 工作流执行结果摘要
  timestamp: string;
}

/** Meta-Agent-Server 会话 */
export interface MASSession {
  id: string;
  title: string;                     // 任务标题
  description: string;               // 原始任务描述
  status: SessionStatus;
  rounds: SessionRound[];            // 多轮交互历史
  max_rounds: number;                // 最大轮次（防无限循环，默认 5）
  origin?: Record<string, unknown>;  // 发起方上下文（透传给 MAS 创建的 workflow）
  notify?: Record<string, unknown>;  // 通知偏好（透传给 MAS 创建的 workflow）
  created_at: string;
  completed_at?: string;
}

// --- Workflow ---

/** 工作流节点状态 */
export type WorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** 工作流失败策略 */
export type WorkflowFailurePolicy = 'fail_fast' | 'all_settled';

/** 工作流节点定义 */
export interface WorkflowNode {
  id: string;                      // 节点 ID (如 "step-1")
  agent_name: string;              // 要执行的 agent 名称
  prompt: string;                  // 给 agent 的指令（描述目标即可，不需要写具体命令）
  scope?: ExecuteScope;            // 操作范围：project（默认）| agent_self
  intent?: ExecuteIntent;          // 任务意图：query（默认）| modify | review | diagnose | execute
  delivery_mode?: 'attached' | 'detached' | 'auto'; // Codex 可选投递语义
  execution_mode?: 'attached' | 'detached' | 'auto'; // delivery_mode 兼容别名
  detached?: boolean;              // Codex detached screen/TUI 兜底开关
  depends_on?: string[];           // 依赖的前置节点 ID
  status: WorkflowNodeStatus;
  result?: string;                 // 执行结果
  started_at?: string;
  completed_at?: string;
}

/** 工作流定义 */
export interface Workflow {
  id: string;
  title: string;
  nodes: WorkflowNode[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  failure_policy?: WorkflowFailurePolicy;  // fail_fast（默认）| all_settled（等所有已可达分支完成/失败/超时后汇总）
  origin?: Record<string, unknown>;        // 发起方上下文（用于结果通知路由）
  notify?: Record<string, unknown>;        // 通知偏好/目标（用于前台 TUI 注入）
  created_at: string;
  completed_at?: string;
}

// --- Server → Client 指令协议 ---

/**
 * 执行范围：指令操作的目标是什么
 *
 * - project: 操作 agent 的工作项目（业务代码、项目 git 等）— 默认
 * - agent_self: 操作 agent 本身（agent 配置、agent 仓库的 git 等）
 *
 * Client 根据 scope 决定 cwd 和 prompt 上下文前缀，消除歧义。
 */
export type ExecuteScope = 'project' | 'agent_self';

/**
 * 任务意图分类
 *
 * Client 可据此做权限检查、日志分类、prompt 前缀注入等。
 * Server Agent 选择意图，Client 代码硬约束行为。
 */
export type ExecuteIntent =
  | 'query'       // 只读查询（git log, 代码搜索, 状态检查）
  | 'modify'      // 修改代码/文件
  | 'review'      // 代码审查
  | 'diagnose'    // 问题诊断/分析
  | 'execute';    // 运行命令/测试/构建

/** Server 要求 Client 拉起 agent */
export interface LaunchCommand {
  agent_name: string;              // 要拉起的 agent 名称
  project_path: string;            // cd 到这个目录再拉起
}

/** Server 要求 Client 在指定目录执行 agent */
export interface ExecuteCommand {
  execution_id: string;            // Server 生成的唯一执行 ID
  workflow_id: string;             // 所属工作流
  node_id: string;                 // 工作流节点 ID
  agent_name: string;              // 用哪个 agent 执行
  project_path: string;            // 在哪个目录执行
  prompt: string;                  // 执行指令（自然语言描述目标即可）
  scope: ExecuteScope;             // 操作范围：project（默认）| agent_self
  intent: ExecuteIntent;           // 任务意图：query | modify | review | diagnose | execute
  runtime?: AgentRuntime;          // 运行时：opencode（默认）/ claude-code / codex
  delivery_mode?: 'attached' | 'detached' | 'auto'; // Codex 可选投递语义
  execution_mode?: 'attached' | 'detached' | 'auto'; // delivery_mode 兼容别名
  detached?: boolean;              // Codex detached screen/TUI 兜底开关
  session_id?: string;             // Client 侧 agent session ID（续接用，首次为空）
}

/** Client 回报执行结果 */
export interface ExecutionResult {
  execution_id: string;
  workflow_id: string;
  node_id: string;
  agent_name: string;
  status: 'completed' | 'failed';
  result: string;
  duration_ms: number;
  session_id?: string;             // Client 侧 agent session ID（下次续接用）
}

// --- Evolution Protocol ---
// 主→从进化：Server 下发「进化包」，Client 按 runtime 差异本地执行

/**
 * 进化操作类型
 *
 * L1 轻量（热加载）: push_files
 * L2 中量（需重启）: push_files + restart_agent / reload_config
 * L3 重量（环境变更）: run_command + restart_agent
 */
export type EvolveActionType =
  | 'push_files'       // 推送文件到远端（skill 目录、agent .md、CLAUDE.md 等）
  | 'run_command'       // 在远端执行 shell 命令（npm install、pip install 等）
  | 'restart_agent'     // 重启远端 agent 进程（Client 守护进程 graceful restart）
  | 'reload_config';    // 热重载配置（如适用）

/**
 * 逻辑目标位置（声明式，Client 根据 runtime 映射到实际路径）
 *
 * Server 不需要知道远端到底是 ~/.claude/skills/ 还是 ~/.config/opencode/skills/，
 * 只需声明意图，Client 本地解析。
 */
export type EvolveTarget =
  | 'skill'            // 技能目录 → opencode: ~/.config/opencode/skills/ | claude: ~/.claude/skills/
  | 'agent'            // Agent 定义 → opencode: ~/.config/opencode/agents/ 或 项目 .opencode/agents/ | claude: 项目 CLAUDE.md
  | 'project_agent'    // 项目级 agent → opencode: {project}/.opencode/agents/ | claude: {project}/.claude/
  | 'mcp_config'       // MCP 配置 → opencode: opencode.json mcp 字段 | claude: .mcp.json + settings
  | 'global_rules'     // 全局规则 → opencode: ~/.config/opencode/AGENTS.md | claude: ~/.claude/CLAUDE.md
  | 'custom';          // 自定义路径（使用 target_path 指定绝对路径）

/** 单个文件推送描述 */
export interface EvolveFile {
  relative_path: string;            // 相对于 target 根目录的路径，如 "feishu/SKILL.md"
  content: string;                  // 文件内容（base64 或 utf-8 原文）
  encoding?: 'utf-8' | 'base64';   // 默认 utf-8
}

/** 单个进化动作 */
export interface EvolveAction {
  type: EvolveActionType;
  target?: EvolveTarget;            // push_files 时必填
  target_path?: string;             // target=custom 时的绝对路径
  project_path?: string;            // target=project_agent 时的项目路径
  files?: EvolveFile[];             // push_files 时的文件列表
  command?: string;                 // run_command 时的 shell 命令
  cwd?: string;                     // run_command 时的工作目录
  timeout_ms?: number;              // run_command 超时（默认 60s）
}

/**
 * 进化指令包（Server → Client）
 *
 * 一个包可以含多个 actions，按顺序执行。
 * 典型场景：
 *   1. push_files (skill) → 不需要重启，立即生效
 *   2. push_files (mcp_config) + run_command (npm install) + restart_agent
 *   3. push_files (agent) + restart_agent
 */
export interface EvolveCommand {
  evolve_id: string;                // Server 生成的唯一进化 ID
  title: string;                    // 进化描述，如 "推送 feishu skill v2.1"
  target_runtime?: AgentRuntime;    // 目标运行时（不填则根据 agent 注册信息自动判断）
  actions: EvolveAction[];          // 按顺序执行的动作列表
}

/** Client 回报进化结果 */
export interface EvolveResult {
  evolve_id: string;
  status: 'completed' | 'partial' | 'failed';
  actions: {
    type: EvolveActionType;
    status: 'ok' | 'failed';
    message?: string;
  }[];
  duration_ms: number;
}

// --- Proposal Protocol ---
// Client → Server 的逆向提议通道：贡献资源、反馈建议、报告问题

/** 提议类型 */
export type ProposalType =
  | 'skill'              // 贡献 skill（附带文件内容或源路径）
  | 'workflow_fix'       // 工作流问题反馈 + 修复建议
  | 'prompt_improvement' // Prompt/Agent 配置改进建议
  | 'bug_report'         // Bug 报告
  | 'general';           // 通用反馈

/** 提议状态 */
export type ProposalStatus =
  | 'pending'            // 待审核
  | 'accepted'           // 已采纳
  | 'rejected'           // 已拒绝
  | 'applied';           // 已应用（采纳后已分发/执行）

/** 提议中附带的文件 */
export interface ProposalFile {
  relative_path: string;           // 文件相对路径，如 "SKILL.md"
  content: string;                 // 文件内容
  encoding?: 'utf-8' | 'base64';  // 默认 utf-8
}

/** Client 提交提议的 payload */
export interface ProposalCreatePayload {
  from_agent: string;              // 提议来源 agent 名称
  type: ProposalType;              // 提议类型
  title: string;                   // 简要标题
  detail: string;                  // 详细描述
  target?: string;                 // 目标对象（如 "workflow:xxx" / "skill:yyy" / "agent:zzz"）
  suggested_fix?: string;          // 修复建议（自然语言或代码片段）
  files?: ProposalFile[];          // 附带文件（skill 贡献时必填）
  source_path?: string;            // 源路径（在提议方机器上的路径，Server 可通过 Daemon 拉取）
  priority?: 'low' | 'medium' | 'high';
}

/** 提议记录（数据库） */
export interface Proposal {
  id: string;
  from_agent: string;              // 来源 agent
  user_id: string;             // 来源用户
  type: ProposalType;
  status: ProposalStatus;
  title: string;
  detail: string;
  target: string;                  // 目标对象
  suggested_fix: string;           // 修复建议
  files: string;                   // JSON 字符串: ProposalFile[]
  source_path: string;             // 源路径
  priority: string;
  review_comment: string;          // 审核意见
  reviewed_by: string;             // 审核人（agent 或 user）
  created_at: string;
  updated_at: string;
}

/** 审核提议的 payload */
export interface ProposalReviewPayload {
  status: 'accepted' | 'rejected';
  review_comment?: string;
  reviewed_by?: string;            // 审核人
}

// --- SSE ---

export interface SSEEvent {
  type: 'client_registered' | 'client_offline' | 'client_dead' | 'client_revived' |
        'task_created' | 'task_dispatched' | 'task_completed' | 'task_failed' |
        'heartbeat' | 'agents_synced' | 'registry_synced' |
        'workflow_started' | 'workflow_node_running' | 'workflow_node_completed' |
        'workflow_node_failed' | 'workflow_completed' | 'workflow_failed' |
        'agent_launched' | 'agent_execute' |
        'evolve_started' | 'evolve_completed' | 'evolve_failed' |
        'proposal_created' | 'proposal_reviewed' | 'proposal_applied';
  data: Record<string, unknown>;
  timestamp: string;
}
