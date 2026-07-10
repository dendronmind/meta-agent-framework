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

Typical flow without the MAF wrapper:

```bash
codex app-server --listen ws://127.0.0.1:47891
codex --remote ws://127.0.0.1:47891 -C /path/to/project
```

When launched through the MAF wrapper from a project with explicit Codex agent
metadata, normal interactive commands (`codex`, `codex resume ...`, prompts, and
forks) are auto-remote-ized:

1. `scripts/maf-codex-app-server.mjs` starts or reuses a local
   `codex app-server --listen ws://127.0.0.1:<port>`.
2. The wrapper injects `--remote ws://127.0.0.1:<port>` before exec'ing the real
   Codex TUI.
3. `scripts/maf-codex-attached-receiver.mjs` registers with the local Node
   Daemon using `plugin_pid`, long-polls `/tasks/wait`, forwards each task to
   Codex app-server `turn/start`, and reports the assistant result via
   `/tasks/done`.

Non-interactive/admin commands such as `codex exec`, `codex review`,
`codex plugin`, `codex mcp`, `codex app-server`, `codex debug`, and login/update
commands pass through to the real Codex binary without auto-remote conversion.

Useful environment variables:

- `MAF_CODEX_APP_SERVER_URL=ws://127.0.0.1:<port>`: explicit app-server URL.
- `MAF_CODEX_APP_SERVER_CMD='codex app-server --stdio'`: start/connect via stdio command.
- `MAF_CODEX_AUTO_REMOTE=0`: disable wrapper auto-remote conversion.
- `MAF_CODEX_APP_SERVER_PORT=<port>`: pin the auto-started app-server port.
- `MAF_CODEX_THREAD_ID=<thread>`: bind a specific loaded thread when multiple sessions exist.
- `MAF_CODEX_AUTO_ATTACHED_RECEIVER=0`: disable wrapper/hook receiver autostart.
