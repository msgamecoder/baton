# Baton

**Your own AI coding agent — two of them, in one terminal, handing work to each other.**

Baton is not a wrapper around another CLI. It is its own agent: you pick a model provider,
paste your API key, and talk to it. Install two of them side by side and they pass work
back and forth instead of you relaying by hand.

- **No provider SDK, no other agent CLI.** Baton talks to the provider's HTTP API directly.
- **Bring your own key.** Command Code, OpenCode Zen/Go, Claude, OpenAI, DeepSeek,
  Kimi/Moonshot, Gemini, OpenRouter, Groq, xAI, Mistral, or a local Ollama/LM Studio.
- **It can actually code** — read/write/edit files, glob, grep, run shell commands.
- **Two sides, two setups.** Left pane and right pane can each use a different provider,
  key and model.

## Install

Requires **Node.js >= 22.6** (Baton runs TypeScript directly — no build step, no runtime
dependencies).

```bash
npm install -g .          # from a checkout
bash scripts/install.sh   # or: install + optional terminal multiplexer
```

## First run

```bash
baton
```

1. It checks node and the terminal, and installs a multiplexer if you want panes
   (**no sudo** — tmux is unpacked into `~/.baton/bin`).
2. It lists providers, you pick one, paste your key, and it **fetches the model list from
   that provider** so you choose from what you actually have.
3. Then it launches: **left pane and right pane, both running Baton's own agent.**

Re-running `baton` attaches to what is already running. `baton kill` stops everything.

```
baton                   set up + launch (--no-start, --yes, --force)
baton chat              talk to the agent here (--agent, --provider, --model, --session)
baton ask "…"           one-shot headless run (--yes to allow tools)
```

## Providers

```bash
baton providers                     # what is available, and whether a key is set
baton key deepseek sk-…             # save a key (written to ~/.baton/keys.json, chmod 600)
baton models --provider deepseek    # list models straight from the provider
baton providers --json
```

| Provider | Wire format |
|----------|-------------|
| Command Code, Claude (Anthropic) | anthropic |
| OpenCode Zen, OpenCode Go, OpenAI, DeepSeek, Kimi, Gemini, OpenRouter, Groq, xAI, Mistral | openai |
| Ollama, LM Studio (local) | openai, no key |
| Custom | you give the base URL + format |

Keys live in `~/.baton/keys.json` (mode 600). Environment variables are honoured as a
fallback (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, …).

## Slash commands

Inside `baton chat`:

| Command | What it does |
|---------|--------------|
| `/help` | list everything |
| `/status` | agent, provider, model, key, session, tool policy |
| `/model [name]` `/models` | show/switch the model, or list the provider's models |
| `/provider [id]` `/key <p> <k>` | switch provider, save a key |
| `/yes` | toggle auto-approve for tools |
| `/clear` `/resume [id]` | conversation history |
| `/remember <text>` `/context` | memory |
| `/cost` | price the next request |
| `/send <to> [type] <text>` `/inbox` | the relay to the other agent |
| `/update` | update baton itself |
| `/quit` | leave |

## Tools

`read_file` · `write_file` · `edit_file` · `list_dir` · `glob` · `grep` · `shell`

Writes and shell commands ask for confirmation unless you run with `--yes` or toggle
`/yes`.

## The two-agent relay

The second job. Two Baton agents (the two panes) hand work to each other over a local
relay — append-only log, long-poll daemon, hop cap so nothing loops, MCP server for native
tool access. See `adapters/AGENTS.md` for the protocol, and `baton console` for the relay
control view.

```bash
baton console     # slash commands: /send /inbox /model /cmd /run /kill
baton cmd <agent> model=deepseek-chat
baton status / log / logs / kill
```

## Config (`~/.baton/config.json`)

```json
{
  "agents": [
    { "name": "left",  "provider": "command-code", "model": "claude-sonnet-4-6" },
    { "name": "right", "provider": "deepseek",     "model": "deepseek-chat" }
  ],
  "defaultProvider": "command-code",
  "defaultModel": "claude-sonnet-4-6",
  "autoApprove": false,
  "port": 7331,
  "maxHop": 8
}
```

An agent with no `command` runs Baton's own agent. An agent with a `command` launches that
CLI instead — so you can still point a pane at any external tool if you want.

## Status

Working: own agent (OpenAI + Anthropic wire formats), streaming, tool loop, provider
registry, key store, model fetching, provider wizard, tmux/Windows Terminal/WezTerm/PTY
launcher, relay (log + daemon + MCP), memory, attachments, cost router, port probe,
guardrails.

Not yet: a full-screen TUI (the chat is line-based), a `/` command palette popup, and
`/update` needs the package published to npm.

## License

MIT
