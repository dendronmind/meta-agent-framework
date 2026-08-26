# MAF Codex Plugin

This Codex plugin connects Codex sessions to Meta-Agent Framework.

On interactive Codex startup, `scripts/maf-codex-hook.mjs` attempts to:

1. infer the current project root;
2. start `~/.meta-agent-framework/daemon.mjs` if the Node Daemon is not running;
3. register the Codex session as `runtime=codex` with the local Daemon when a valid non-home project agent name can be inferred.

MAF Codex agent identity inference:

- `MAF_AGENT_NAME` environment variable, as an explicit temporary override;
- project-local Codex standard agent definitions: `.codex/agents/*.toml`;
- the exact first line `# Codex project agent: <agent>` in project-local `AGENTS.md`;
- if neither project-local TOML nor the marker selects a main agent, the non-home project root directory name.

Project-root discovery uses the nearest ancestor containing `.codex/agents` or a valid `AGENTS.md` first-line marker; if neither exists, it preserves the exact Codex launch directory. A `.git` directory is not a MAF project identity marker and never promotes a nested launch directory to the Git repository root.

`AGENTS.md` remains free-form Codex project guidance; MAF only interprets the exact first-line marker above as an explicit compatibility convention. A later heading with the same text is ignored. MAF also does not use `~/.codex/agents/*.toml` for project identity, because those are global Codex subagents rather than the current project agent.

Identity selection rules:

1. prefer `.codex/agents/<project-dir-name>.toml` or a TOML whose `name` equals the project directory name;
2. if there is exactly one `.codex/agents/*.toml`, use its `name` or file stem;
3. otherwise use a valid `AGENTS.md` first-line marker;
4. otherwise fall back to the project root directory name;
5. skip registration when the inferred name is not `[A-Za-z0-9_.-]+` or the project root is the user home directory.

## Attached receiver for current Codex TUI

MAF can deliver tasks into the currently attached Codex session only when Codex is
connected to a Codex app-server endpoint. A plain local Codex TUI does not expose
a stable external injection point.

Typical flow without the MAF wrapper:

```bash
codex app-server --listen ws://127.0.0.1:47891
codex --remote ws://127.0.0.1:47891 -C /path/to/project
```

When launched through the MAF wrapper from a non-home project with a valid Codex
agent identity, normal interactive commands (`codex`, `codex resume ...`, prompts,
and forks) are auto-remote-ized:

1. `scripts/maf-codex-app-server.mjs` starts or reuses a local
   `codex app-server --listen ws://127.0.0.1:<port>`.
2. The wrapper injects `--remote ws://127.0.0.1:<port>` before exec'ing the real
   Codex TUI.
3. `scripts/maf-codex-attached-receiver.mjs` registers with the local Node
   Daemon using `plugin_pid`, long-polls `/tasks/wait`, forwards explicitly
   attached tasks to Codex app-server `turn/start`, and reports the assistant
   result via `/tasks/done`. It listens for completion notifications and also
   polls `thread/read` every 15 seconds with a 5-second per-read timeout.

Non-interactive/admin commands such as `codex exec`, `codex review`,
`codex plugin`, `codex mcp`, `codex app-server`, `codex debug`, and login/update
commands pass through to the real Codex binary without auto-remote conversion.

## Managed workflow and task execution

Codex Workflow nodes and traditional Tasks use managed delivery by default. The
Server keeps one current conversation metadata record per Agent, includes its IDs
in the signed Daemon `/execute` request, and the Daemon runs that turn through a private
`codex app-server --stdio` process. Assistant text and public execution events
are streamed back to the Server while the final Assistant result completes the
Workflow node or Task. Managed delivery never creates a screen and does not use
the user's attached TUI.

Server selection order is:

1. Workflow node `delivery_mode` or `execution_mode`;
2. traditional Task `metadata.delivery_mode` or `metadata.execution_mode`;
3. `MAF_CODEX_WORKFLOW_DELIVERY=managed|detached`;
4. `codex.workflow_delivery` in `maf.config.json`, default `managed`.

Use `delivery_mode: "detached"` for the legacy screen/TUI path, or
`delivery_mode: "attached"` only when the current interactive TUI is intended.
Managed formal Executions still run the existing workspace/repository lock,
read-only gate, runtime directory environment, and Gerrit finalization.

## Remote Agent lifecycle

The Server controls one Agent through `POST /api/agents/:id/stop` and
`POST /api/agents/:id/start`. Stop persists a `stopped` gate in
`$MAF_HOME/state/stopped-agents.json`, closes that Agent's MAF-owned private
app-server and detached screen, and terminates an attached receiver only after
verifying its Linux process identity. It never kills a user-started foreground
Codex TUI and never exits the machine-wide Node Daemon.

An Agent with active work rejects normal stop. An explicitly forced stop first
cancels Server Task/Workflow/Execution state, interrupts active managed turns,
and then terminates local execution. Plugin or hook reconnects cannot clear the
gate. Start only removes the gate; status returns to `standby`, `offline`, or
`online` according to the executor that is actually alive.

## Persistent detached Codex TUI compatibility

Explicit detached delivery keeps one background screen per agent, named
`maf-codex-<agent>`. The first task starts a Codex TUI in that screen; later
tasks are serialized and injected into the same TUI, preserving its conversation
until the TUI or Node Daemon exits. Task completion only reports `/tasks/done`
and does not close the screen. If the TUI exits before reporting, the Daemon
fails the active task and creates a fresh persistent screen for the next task.

## Dashboard realtime conversations

Dashboard conversations and managed Workflow/Task execution share one current
Agent conversation and its remote Codex thread. The Server sends Ed25519-signed conversation or
task control requests to the Node Daemon, and the Daemon owns one private
`codex app-server --stdio` process per conversation.
No app-server TCP/WebSocket listener is exposed to the LAN.

The bridge supports `thread/start`, restart recovery through `thread/resume`,
multiple `turn/start` calls, `turn/interrupt`, and explicit new-session reset.
The remote `thread/read` snapshot is the only source for completed conversation
messages and execution history. Server event rows are not persisted; a bounded
in-memory buffer is used only for live SSE, while the Daemon spool is a temporary
delivery queue during outages.
Before upload, events are stored under
`$MAF_HOME/state/codex-conversation-events/*.jsonl`; this is a temporary delivery
spool, not conversation history, and it is removed after upload or new-session reset.
If the Client or remote thread cannot be read, the Dashboard leaves the conversation
area blank rather than falling back to Server history. It shows app-server public messages and execution events only, not
hidden model reasoning. Public reasoning summaries, plans, commands, file
changes, tools, and collaboration items are grouped by turn/item into readable
TUI-style steps; assistant streaming fragments and token/protocol counters are
not rendered as separate execution steps. Remote browsers are read-only;
conversation writes are restricted to the Server-local Dashboard.

The Server returns its current `managed|detached` default in registration and
heartbeat responses; an explicitly set local `MAF_CODEX_DELIVERY` takes
precedence for idle status. A healthy Daemon and valid project path make the
Agent dispatchable but only `standby`; managed mode becomes `online` after a
private conversation app-server bridge is actually running, and an active turn
is `busy`. Detached mode becomes `online` only while its background TUI screen
is alive, and attached mode requires a live receiver. Dashboard and registry
online counts exclude `standby`.

Diagnostics:

- Node Daemon log: `$MAF_HOME/logs/client-daemon.log`
- Pending event spool: `$MAF_HOME/state/codex-conversation-events/`
- `MAF_CODEX_APP_SERVER_BIN=<real-codex>`: explicitly select the app-server binary
- `MAF_CODEX_EVENT_RETRY_ATTEMPTS=<n>`: upload retries per attempt, default 8
- `MAF_CODEX_EVENT_SPOOL_MAX_BYTES=<bytes>`: per-conversation spool cap, default 64 MiB

Useful environment variables:

- `MAF_CODEX_WORKFLOW_DELIVERY=managed|detached`: Server default for Codex Workflow/Task dispatch; default `managed`.
- `MAF_CODEX_DELIVERY=managed|detached|attached|auto`: Daemon fallback for legacy requests that omit `delivery_mode`; default `detached`. Current Servers send the resolved mode explicitly.
- `MAF_CODEX_ATTACHED_TASK_TIMEOUT_MS=<ms>`: overall attached-turn limit; default 45 minutes while short `thread/read` attempts continue throughout the wait.
- `MAF_CODEX_TURN_POLL_MS=<ms>`: attached `thread/read` poll interval; default 15000 ms.
- `MAF_CODEX_TURN_READ_TIMEOUT_MS=<ms>`: timeout for one `thread/read` request; default 5000 ms. A failed read is retried until the overall task limit.
- `MAF_AGENT_NAME=<agent>`: explicit temporary MAF agent-name override.
- `MAF_CODEX_APP_SERVER_URL=ws://127.0.0.1:<port>`: explicit app-server URL.
- `MAF_CODEX_APP_SERVER_CMD='codex app-server --stdio'`: start/connect via stdio command.
- `MAF_CODEX_AUTO_REMOTE=0`: disable wrapper auto-remote conversion.
- `MAF_CODEX_APP_SERVER_PORT=<port>`: pin the auto-started app-server port.
- `MAF_CODEX_THREAD_ID=<thread>`: bind a specific loaded thread when multiple sessions exist.
- `MAF_CODEX_AUTO_ATTACHED_RECEIVER=0`: disable wrapper/hook receiver autostart.
