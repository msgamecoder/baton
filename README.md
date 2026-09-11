# Baton

**Pass the work between AI coding agents.**

Baton is a relay + launcher. Instead of copy-pasting between two agent CLIs, the agents
hand work to each other: one finishes a piece, messages the other, the other picks it up.

- **Bring your own agent and key.** Baton never holds a model or an API key. It launches
  whatever CLI you point it at — Claude, OpenCode, Command Code, Kimi/Moonshot, DeepSeek,
  anything.
- **Two adapter tiers.** Any agent that can run a shell command can use `baton send` /
  `baton inbox`. Agents that speak MCP get `baton-mcp` as native tools.
- **Cross-platform.** Linux/macOS via tmux, Windows via Windows Terminal split panes,
  WezTerm anywhere, with a built-in PTY fallback.

## Requirements

Node 22.6+ (runs TypeScript directly — no build step, no dependencies).

```bash
git clone <this repo> ~/baton
node ~/baton/src/cli/index.ts help
```

Optionally add it to your PATH:

```bash
alias baton="node $HOME/baton/src/cli/index.ts"
```

## Quickstart

```bash
baton init                       # writes ~/.baton/config.json
baton up --dry-run               # see how it will split your terminal
baton up                         # start the daemon + launch your agents
```

Then, from inside either agent:

```bash
baton send --from cc --to oc --type handoff --summary "auth is done" --next "wire the UI"
baton inbox
```

Everything lives in `~/.baton/`. No daemon is required — the CLI falls back to the
append-only log and still works.

## Commands

| Command | What it does |
|---------|--------------|
| `init` | create `~/.baton` and a starter config |
| `up` / `down` / `kill` | launch agents + daemon / stop daemon / stop everything |
| `daemon` / `mcp` | run `batond` (HTTP) / run the MCP server on stdio |
| `send` / `inbox` / `ack` / `watch` | the relay |
| `status` / `log` / `logs` / `audit` | observe |
| `context` / `instructions` | print the handoff protocol (+ memory) to inject |
| `remember` / `recall` / `forget` | persistent memory across sessions |
| `attach` / `media` | screenshots and files on messages |
| `model` / `cost` | pick the cheapest capable model, price a job |
| `port` | find the port that is actually serving |
| `session` | reuse a logged-in browser session |
| `splitters` | show available terminal splitters |

## Config (`~/.baton/config.json`)

```json
{
  "agents": [
    { "name": "oc", "command": "opencode" },
    { "name": "cc", "command": "cmd", "env": { "COMMANDCODE_API_KEY": "..." } }
  ],
  "splitter": "tmux",
  "port": 7331,
  "maxHop": 8,
  "autoContinue": true
}
```

Baton launches `command` and sets `BATON_AGENT=<name>` for that pane, so the agent always
knows who it is. Swap in `claude`, `kimi`, `deepseek`, … — Baton does not care.

## MCP (native tools for MCP-capable agents)

The stdio MCP server exposes `relay_send`, `relay_inbox`, `relay_ack`, `relay_status`,
`relay_remember`, `relay_context`.

```bash
# Command Code
cmd mcp add --scope user --env BATON_AGENT=cc baton -- node "$HOME/baton/src/cli/index.ts" mcp

# OpenCode (interactive picker; choose local/stdio, then the command above)
opencode mcp add baton
```

Give each agent its own registration with its own `BATON_AGENT`.

## Terminal split (cross-platform)

`baton splitters` shows what this machine has. `baton up` picks the best:

| Platform | Splitter |
|----------|----------|
| Linux / macOS | `tmux` |
| Windows | `wt` (Windows Terminal, built in) |
| Any | `wezterm` |
| Any | `pty` — built-in fallback: agents run in the background, logs in `~/.baton/agents/` |

Without a multiplexer, Baton still works: the pty fallback runs the agents in the
background and `baton logs <agent>` tails them. Install `tmux` (`sudo apt install tmux`) or
use WSL for real panes.

## Status

Implemented and tested: relay + log, daemon (long-poll), launcher, MCP server, memory,
attachments, cost router, port probe, session store, audit, guardrails.

Not yet built: a mod/plugin that injects a new peer message into a *live, idle* agent's TUI
automatically. Today the agent picks up messages by calling `baton inbox` (or `relay_inbox`)
at the end of a turn — see `adapters/AGENTS.md`.

## License

MIT
