# Meta-Agent Framework

**Break the coding Agent silo** — Automatically network AI Agents across different machines in your LAN into an organized cluster. Simply talk to the Server Agent to orchestrate all remote Agents. Built-in collaborative evolution enables Agents to share skills and grow together.

English | [中文](./README.md)

## Demo

![demo](./docs/demo.gif)

## Architecture

```
                    ┌─────────────────────────────┐
                    │   User (natural language)     │
                    └──────────────┬──────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    Server (orchestrator)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Workflow  │ │  Agent   │ │  Health  │ │    Evolve     │  │
│  │  Engine   │ │ Registry │ │ Monitor  │ │ (co-evolution)│  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │ push / heartbeat / result
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐
     │  Machine A │ │  Machine B │ │  Machine C │
     │  Daemon    │ │  Daemon    │ │  Daemon    │
     │  ├ Agent 1 │ │  ├ Agent 3 │ │  ├ Agent 5 │
     │  └ Agent 2 │ │  └ Agent 4 │ │  └ Agent 6 │
     └────────────┘ └────────────┘ └────────────┘
```

## Key Features

- **Auto-networking** — Agents register on startup, forming a schedulable distributed network
- **Conversational orchestration** — Talk to the Server Agent in natural language; it decides who handles what
- **Async collaboration** — Tasks are dispatched without blocking; results stream back automatically
- **Collaborative evolution** — Push skills / configs / MCP tools to all Agents simultaneously
- **Auto-launch** — Offline Agents are automatically started via screen when tasks arrive
- **Dual runtime** — Supports [opencode](https://opencode.ai) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- **Task queue** — Multiple consecutive tasks execute serially without loss
- **OTA updates** — Remote Plugin updates with zero-downtime Daemon restart

## Quick Start

### 1. Install

```bash
# Server (one machine as orchestrator)
npm install -g https://github.com/dendronmind/meta-agent-framework/releases/download/latest/meta-agent-server.tgz

# Client (machines running Agents, can be many)
npm install -g https://github.com/dendronmind/meta-agent-framework/releases/download/latest/meta-agent-client.tgz
```

### 2. Start Server

```bash
maf-server start
```

First run triggers interactive setup, then starts the Server and enters the Meta-Agent-Server chat interface.

### 3. Configure Client (remote machines)

```bash
maf-client init    # Interactive setup: Server URL + Plugin installation
```

Two modes of operation after installation:

**Manual start:**
```bash
opencode --agent <name>    # opencode Agent
claude --agent <name>      # Claude Code Agent
```

> ⚠️ **Agent Configuration Requirements**: Each Agent project directory must contain a standard agent definition file:
> - opencode: `.opencode/agents/<agent-name>.md` (note: `agents` plural)
> - Claude Code: `.claude/agents/<agent-name>.md`
>
> The `model` field in the agent definition must specify an actually available model. The opencode HTTP API does not fallback to a default model like the TUI does — an invalid model will cause API calls to fail silently.

**Auto-launch (recommended):**

No manual start needed. As long as the Client machine's Daemon is running (auto-started after `maf-client init`), the Server will automatically launch the Agent via `screen` when tasks arrive. Prerequisite: the Agent must be registered in the Server's Agent registry.

### 4. Use

Describe your needs in natural language:

> "Check what's changed in Project A recently"
> "Have the frontend Agent run the unit tests"
> "Send this bug fix plan to the backend Agent"

The Server Agent automatically decides who handles it, dispatches the task, waits for results, and presents them to you.

## Command Reference

```bash
# Server
maf-server start      # Start (auto-setup on first run) + enter chat
maf-server resume     # Resume last session (use after Ctrl+C exit)
maf-server tui        # Start a new chat session
maf-server stop       # Stop
maf-server restart    # Restart
maf-server status     # Status
maf-server logs       # View logs
maf-server uninstall  # Uninstall (stop + clean data + remove npm package)
maf-server help       # Show all commands

# Client
maf-client init       # Configure Server URL + install Plugin
maf-client resume [agent]  # Resume last session for an Agent
maf-client sessions   # List recent sessions
maf-client status     # Check status
maf-client uninstall  # Uninstall (stop Daemon + clean Plugin + remove npm package)
maf-client help       # Show all commands
```

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and release process.

## License

MIT
