# Baton — Plan & Status

> A relay + launcher so two (or more) AI coding agents hand work to each other instead of
> the user relaying by hand. Open source, keyless core, bring your own agent CLI and key.

Name: **Baton**. Repo: `~/baton`. License: MIT.

---

## 1. Principles

1. **Keyless core.** Baton never holds a model or an API key. Each agent CLI keeps its own.
2. **Agent-agnostic.** Any agent that can run a shell command can join (`baton send`).
   MCP-capable agents get a native adapter (`baton-mcp`).
3. **Files are the truth.** The relay is an append-only log. If every other component
   dies, the log still works.
4. **The user is the boss, not the bottleneck.**
5. **Nothing runs away.** Every automatic action is hop-capped and killable.

---

## 2. Architecture

```
 agent A (any CLI)          agent B (any CLI)
        │                          │
        │  baton send / inbox      │  (or MCP relay_* tools)
        └────────┬─────────────────┘
                 │
          ┌──────▼───────┐
          │    batond    │   long-poll inbox, presence, replay
          └──────┬───────┘
                 │
        ~/.baton/log.jsonl      append-only, durable, source of truth
        ~/.baton/config.json    agents + splitter + port + maxHop
        ~/.baton/cursors/       per-agent read position
        ~/.baton/media/         attachments
        ~/.baton/memory/        persistent memory
        ~/.baton/sessions/      saved browser sessions
        ~/.baton/audit.jsonl    guardrail / action log
        ~/.baton/agents/*.log   background agent logs (pty fallback)
```

---

## 3. Message protocol

One JSON object per line in the log.

| Field | Meaning |
|-------|---------|
| `id`, `ts` | unique id, timestamp |
| `from`, `to` | agent names (`*` = broadcast) |
| `type` | `handoff` `blocked` `error` `question` `answer` `ack` `done` `fyi` |
| `priority` | `low` `normal` `high` `urgent` |
| `summary`, `body` | one-line + detail |
| `built[]` | files/paths produced |
| `contract` | interface the peer can rely on |
| `next[]` | concrete actions for the peer |
| `errors[]` | `{where, message, log}` |
| `tests` | `{ran[], passed, command}` |
| `git` | `{branch, worktree, commit, diffStat}` |
| `attachments[]` | `{path, mime, size, hash}` |
| `replyRequired`, `inReplyTo`, `hop`, `sessionRef`, `autoContinue` | threading + loop control |
| `cost` | `{model, inputTokens, outputTokens, usd}` |
| `memory[]` | things to remember |

Ordering is **file position**, not timestamp — two messages in the same millisecond still
read in the order they were appended (`src/core/store.ts::startIndex`).

`canAutoContinue()` (`src/core/schema.ts`) is the single rule for automatic handoff:
`type === handoff`, addressed to me, not from me, `autoContinue !== false`, `hop < maxHop`.

---

## 4. Terminal split

`src/core/splitter.ts` detects and picks; `baton splitters` shows the result.

| Platform | Splitter |
|----------|----------|
| Linux / macOS | `tmux` |
| Windows | `wt` (Windows Terminal, built in) |
| Any | `wezterm` |
| Any | `pty` — built-in fallback, agents run in the background |

---

## 5. Feature lanes

1. **Backbone** — relay, log, launcher, adapters.
2. **Attachments** — screenshots ride on messages (`--attach` stores the file, the message
   carries path + size + hash; the agent opens the path with its own reader, so
   vision-capable models actually see it).
3. **Verify-before-code** — protocol rule in `baton context` / `adapters/AGENTS.md`.
4. **Test harness** — `baton port` matches the serving process's working directory to the
   project (not a blind port scan); `baton session` stores a logged-in browser session.
5. **Memory** — `baton remember/recall/forget`, re-injected via `baton context`.
6. **Cost router** — model price table, cheapest capable model, tie-break to the lower tier.
7. **Boss-confirm** — protocol rule: the parent verifies a mini agent's work before "done".

---

## 6. Phase status

| Phase | Build | State |
|-------|-------|-------|
| P0 | protocol, log, files-first CLI | ✅ done, tested |
| P1 | `batond` long-poll, presence, replay | ✅ done, tested (SSE not implemented — long-poll only) |
| P2 | launcher (`up`/`down`/`kill`) | ✅ done; tmux/wt/wezterm command generation checked by `up --dry-run`, pty fallback executed, process-group kill tested |
| P3 | adapters: shell + `baton-mcp` | ✅ done, MCP handshake/tools verified over stdio |
| P4 | delivery + discipline | ⚠️ partial — protocol + `baton context` + instructions done; auto-injecting into a **live idle TUI** needs a Command Code mod / OpenCode plugin (not built) |
| P5 | memory | ✅ done, tested |
| P6 | attachments | ✅ done, tested (path-based; no inline image content block yet) |
| P7 | cost router | ✅ done, tested |
| P8 | test harness (port + auth) | ⚠️ partial — port probe done and tested; session store done; wiring a session into a specific browser tool is agent-specific |
| P9 | guardrails | ✅ hop cap, `baton kill`, audit log done and tested; "boss confirms" is protocol guidance |

---

## 7. Next

1. **Live delivery** — a Command Code mod (`~/.commandcode/mods/baton.ts`) and an OpenCode
   plugin that poll the inbox at turn boundaries and surface/auto-continue a handoff.
   This is the piece that removes the user from the loop entirely.
2. **Inline image content** — return MCP image blocks so a screenshot is *seen* without the
   agent opening the file.
3. **SSE** on `batond` for push without long-poll.
4. **Worktrees** — parallel agents on separate git worktrees with path claims.

---

## 8. Risks

- **Splitter portability** — tmux is Unix-only; Windows uses `wt`; pty covers the rest.
- **Not every CLI has MCP** — the shell adapter is the universal fallback.
- **Memory bloat** — capped at 1000 entries; needs a real precedence rule.
- **Price tables drift** — user-editable; stale prices must never silently mean "expensive is fine".
- **Auto-continue loops** — hard `maxHop` cap, plus `baton kill`.
