# Baton

**Pass the work between AI coding agents.**

Baton is a relay + launcher. Instead of copy-pasting between two agent CLIs, the agents
hand work to each other: one finishes a piece, messages the other, the other picks it up —
and you watch instead of relaying.

- **Bring your own agent and key.** Baton never holds a model or an API key. It launches
  whatever CLI you point it at — Claude, OpenCode, Command Code, Kimi/Moonshot, DeepSeek,
  anything.
- **Two adapter tiers.** Any agent that can run a shell command can use `baton send` /
  `baton inbox`. Agents that speak MCP get `baton-mcp` as native tools.
- **Cross-platform.** Linux/macOS via tmux, Windows via Windows Terminal split panes,
  WezTerm anywhere, with a built-in PTY fallback.

## Install

Requires **Node.js >= 22.6** (Baton runs TypeScript directly — no build step, no runtime
dependencies).

```bash
# from a checkout
npm install -g .
baton doctor          # check node + terminal support
baton install         # install tmux (asks your package manager)
```

Or the one-shot installer (installs the CLI, then offers the panes):

```bash
bash scripts/install.sh
```

Then **just run `baton`**. With no command it sets up (creates `~/.baton/config.json`,
checks node and the terminal splitter), **installs what is missing**, and then **launches the
daemon and your agents** in one go. Re-running `baton` attaches to what is already running
instead of starting a second copy.

```bash
baton                 # set up + install what's missing + launch
baton --no-start      # set up only
baton --yes           # never prompt (auto-accept installs)
baton up --dry-run    # preview the launch without running it
baton kill            # stop everything
```

> The CLI itself must exist once before it can bootstrap the rest — that is the one
> install line above. Everything after that, `baton` handles.

### Terminal multiplexer

`baton doctor` reports what this machine has; `baton install` installs one.

| Platform | Splitter | Notes |
|----------|----------|-------|
| Linux / macOS | `tmux` | `baton install` runs apt/dnf/pacman/zypper/apk/brew for you |
| Windows | `wt` | Windows Terminal is built into Windows 11; `winget install --id Microsoft.WindowsTerminal -e` otherwise |
| Any | `wezterm` | used automatically if installed |
| Any | `pty` | built-in fallback — agents run in the background, `baton logs <agent>` tails them |

No multiplexer is required: the PTY fallback still relays. Install one for real split panes.

## Quickstart

```bash
baton init
baton up
```

From inside either agent (or a shell):

```bash
baton send --from cc --to oc --type handoff --summary "auth is done" --next "wire the UI"
baton inbox
```

## Console (slash commands)

```bash
baton console
```

```
baton> /status
baton> /send oc handoff the API is ready
baton> /model oc deepseek-chat
baton> /inbox cc
baton> /run cc "run the tests and report"
baton> /quit
```

| Command | What it does |
|---------|--------------|
| `/help` | list commands |
| `/status` `/agents` | who exists, what is pending |
| `/send <to> [type] <text>` | send a message |
| `/inbox [agent]` | read an inbox |
| `/cmd <agent> <directive>` | send a control directive |
| `/model <agent> <model>` | set that agent's launch model **and** notify it |
| `/resume <agent>` | tell an agent to resume |
| `/run <agent> <prompt>` | run that agent headlessly |
| `/context` | print protocol + memory |
| `/kill` | stop the daemon and every agent |

Control directives (`baton cmd <agent> …`, or `baton commands`):

`model=<name>` · `effort=<low\|medium\|high>` · `resume` · `think` · `stop` · `remember=<text>`

## Different model on the left and the right

Yes. Each agent is its own process with its own CLI and its own key, so each pane can run a
different model. Set it per agent:

```json
{
  "agents": [
    { "name": "oc", "command": "opencode", "model": "deepseek/deepseek-chat" },
    { "name": "cc", "command": "cmd",      "model": "claude-sonnet-4-6" }
  ]
}
```

Baton appends `<modelFlag> <model>` (default `--model`) when it launches that agent. Put
your own flags straight in `command` if your CLI differs. Change it live with
`/model oc deepseek-chat` — that updates the config and sends the agent a `model=` directive.

## Commands

| Command | What it does |
|---------|--------------|
| `init` / `doctor` / `install` | setup |
| `up` / `down` / `kill` | launch / stop daemon / stop everything |
| `console` | interactive slash-command console |
| `send` / `cmd` / `inbox` / `ack` / `watch` | the relay |
| `run <agent>` | headless run (`--model`, `--resume`, `--dry-run`) |
| `daemon` / `mcp` | run `batond` / the MCP server |
| `status` / `log` / `logs` / `audit` | observe |
| `context` / `instructions` | protocol + memory for injection |
| `remember` / `recall` / `forget` | memory across sessions |
| `attach` / `media` | screenshots and files on messages |
| `model` / `cost` | cheapest capable model, price a job |
| `port` | the port that is actually serving |
| `session` | reuse a logged-in browser session |
| `splitters` | available terminal splitters |

## Config (`~/.baton/config.json`)

```json
{
  "agents": [
    { "name": "oc", "command": "opencode", "modelFlag": "--model",
      "headless": "opencode run {prompt}" },
    { "name": "cc", "command": "cmd", "modelFlag": "--model", "resumeFlag": "--continue",
      "headless": "cmd -p {prompt}", "env": { "COMMANDCODE_API_KEY": "..." } }
  ],
  "splitter": "tmux",
  "port": 7331,
  "maxHop": 8,
  "autoContinue": true
}
```

`headless` is the template `baton run` uses: `{prompt}`, `{model}`, `{resume}`.
Baton sets `BATON_AGENT=<name>` for each pane, so the agent always knows who it is.

## MCP (native tools)

```bash
# Command Code
cmd mcp add --scope user --env BATON_AGENT=cc baton -- node "$HOME/baton/src/cli/index.ts" mcp

# OpenCode (interactive picker; choose local/stdio, then the command above)
opencode mcp add baton
```

Exposes `relay_send`, `relay_inbox`, `relay_ack`, `relay_status`, `relay_remember`,
`relay_context`. Give each agent its own registration with its own `BATON_AGENT`.

## Status

Implemented and tested: relay + log, daemon, launcher, MCP server, memory, attachments,
cost router, port probe, session store, audit, guardrails, console with slash commands,
per-agent models, npm install.

Not yet built: a mod/plugin that injects a peer message into a **live, idle** agent's TUI
automatically. Today the agent picks up messages with `baton inbox` / `relay_inbox` at the
end of a turn — see `adapters/AGENTS.md`.

## License

MIT
