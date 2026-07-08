# MAF Codex Plugin

This Codex plugin connects Codex sessions to Meta-Agent Framework.

On `SessionStart`, `scripts/maf-codex-hook.mjs` attempts to:

1. infer the current project agent from explicit metadata;
2. start `~/.meta-agent-framework/daemon.mjs` if the Node Daemon is not running;
3. register the agent as `runtime=codex` with the local Daemon.

Supported agent metadata:

- `MAF_AGENT_NAME` environment variable;
- a single `.codex/agents/<agent>.md`;
- `AGENTS.md` line: `# Codex project agent: <agent>`.
