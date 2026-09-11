# AGENTS.md — Baton relay snippet

> Paste this into your project's `AGENTS.md` (or run `baton context` at the start of a
> session) so every agent knows how to hand work to the other one instead of asking the
> user to relay.

## You are one agent in a Baton relay

A second agent is working alongside you. Talk to it directly — the user should never have
to copy messages between you.

Start every session with:

```bash
baton context          # prints this protocol + saved memory
baton status           # who is online, who has pending messages
```

### Hand work off

```bash
baton send --from <you> --to <peer> --type handoff \
  --summary "auth module is done" \
  --next "wire the login UI to it" \
  --built src/auth.ts \
  --attach ./screenshot.png
```

Message types: `handoff` (work ready) · `blocked` · `error` · `question` · `answer` · `ack` · `done` · `fyi`.
Add `--hop <n+1>` when you pass work onward so loops are caught.

### Receive work

```bash
baton inbox            # messages for you (marks them read)
baton inbox --peek     # read without marking
baton watch            # stream new messages
```

**Check your inbox at the end of every turn before you call yourself finished.**

### Control directives

The coordinator can steer you with a `command` message (read it from your inbox and apply it):

| Directive | Meaning |
|-----------|---------|
| `model=<name>` | switch to a cheaper/other model for the next step |
| `effort=<low\|medium\|high>` | reasoning effort |
| `resume` | continue your previous work |
| `think` | allow deeper reasoning |
| `stop` | stop the current task |
| `remember=<text>` | store something in memory |

From the coordinator side: `baton cmd <agent> "model=deepseek-chat"`, or in the console
`/model <agent> <model>`.

## Rules

1. **Verify before coding.** If a bug is reported, reproduce it and attach evidence
   (screenshot / log / failing test) *before* changing code. Never guess.
2. **Use the real app when testing.** `baton port` finds the port that is actually serving
   (by matching the process working directory to the project). `baton session` reuses a
   logged-in browser session. Do not guess a port and do not test a login wall.
3. **The boss confirms.** When a mini agent (cheap model) returns work, *you* verify it —
   run the check — before telling the user it is done.
4. **Cheap models for cheap work.** Run `baton model --for "<task>"` before delegating.
   Tokens are money; never default to an expensive model.
5. **Remember.** When the user says to keep something, run `baton remember "<fact>"`.
   It is re-injected every session.
6. **Nothing runs away.** Every handoff carries a hop count. Do not loop. `baton kill`
   stops the daemon and every agent.
