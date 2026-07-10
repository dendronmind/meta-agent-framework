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

## Attached receiver for current Codex TUI

MAF can deliver tasks into the currently attached Codex session only when Codex is
connected to a Codex app-server endpoint. A plain local Codex TUI does not expose
a stable external injection point.

Typical flow:

```bash
codex app-server --listen ws://127.0.0.1:47891
codex --remote ws://127.0.0.1:47891 -C /path/to/project
```

When launched through the MAF wrapper, `codex --remote ...` auto-starts
`scripts/maf-codex-attached-receiver.mjs`, which registers with the local Node
Daemon using `plugin_pid`, long-polls `/tasks/wait`, forwards each task to
Codex app-server `turn/start`, and reports the assistant result via
`/tasks/done`.

Useful environment variables:

- `MAF_CODEX_APP_SERVER_URL=ws://127.0.0.1:<port>`: explicit app-server URL.
- `MAF_CODEX_APP_SERVER_CMD='codex app-server --stdio'`: start/connect via stdio command.
- `MAF_CODEX_THREAD_ID=<thread>`: bind a specific loaded thread when multiple sessions exist.
- `MAF_CODEX_AUTO_ATTACHED_RECEIVER=0`: disable wrapper/hook receiver autostart.
