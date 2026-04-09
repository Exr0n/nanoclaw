# Pipes — Intent & Architecture Notes

Context doc capturing the design intent for the pipes system, the current
(partially migrated) state, and the desired end state. Written for future-me /
future-agents reading this repo cold.

## The user's intent

> "I want to have pipes watching my email, but my email should NOT be a channel
> for openclaw (but my albot openclaw should be able to manage the pipes)."

Translated:

1. **Pipes are a separate system from channels.** They watch external event
   sources (email, iMessage, cron) and run lightweight user code. They are
   **not** a way to talk to the agent.
2. **A pipe source is not a channel.** Enabling gmail-as-pipe-source must not
   implicitly enable gmail-as-channel (i.e., the agent must not be triggered
   just because an email arrived).
3. **The agent can manage pipes.** The albot/main agent, from inside its
   container, can read/write pipe files under `groups/*/pipes/` — it is the
   authoring surface for pipe logic.
4. **Pipes can still explicitly hand an event to the agent** when they decide
   the agent should get involved (via the `trigger` action). That path is
   opt-in per-pipe, per-event — never the default.

## Why this matters

The root coupling problem: `src/channels/gmail.ts` is simultaneously

- a pipe feeder (calls `firePipeEvent`), and
- a message injector into the main group as a fallback when no pipe handles an
  event.

This means "enable gmail" currently means "enable gmail AND route unhandled
emails through the agent as if they were user messages." That's the wrong
default — email should never spawn the agent without an explicit opt-in from a
pipe.

## Current architecture (as of this doc)

### Pipe runtime (`src/pipe-runtime.ts`)

- Loaded at NanoClaw startup. Scans `groups/*/pipes/*.{js,py}`.
- Each pipe file has a `// pipe.meta: { id, triggers, schedule? }` header.
- Triggers:
  - `channel_event` — fired by a channel/source via `firePipeEvent()`
  - `cron` — checked every 30s against TIMEZONE-aware cron expressions
- Execution model: `spawn('node'|'python3', file)` with the event JSON on
  stdin. The pipe writes a single JSON action to stdout. 15s timeout. No
  shared state with the host beyond what it reads from disk.
- Actions: `drop`, `notify`, `trigger`, `sms`, `pipe.delete`, `pipe.create`.
  - `drop` — silently swallows the event
  - `notify` — sends a message to a target chat via `sendNotification`
  - `trigger` — injects a message as a user-message into a target group,
    which spawns the agent
  - `pipe.create` — lets a pipe spawn new pipes (self-modification)

### Gmail channel (`src/channels/gmail.ts`)

- Polls Gmail via the Google API for both accounts (`~/.gmail-mcp` and
  `~/.gmail-mcp-2`).
- For each new email: calls `firePipeEvent({ type: 'channel_event', channel:
'gmail'|'gmail2', event: 'new_message', ... })`.
- **Previous default (the bug):** if no pipe handled the event, gmail fell
  through and delivered the email to the main group via `onMessage`, spawning
  the agent for every unhandled email.
- **New default:** `pipeOnly` flag on `GmailChannel`, wired via the
  `GMAIL_PIPE_ONLY=1` env var. When true, the fallthrough is skipped. The
  `.env` sets this to `1` — emails **never** trigger the agent unless a pipe
  explicitly returns a `trigger` action.

### The email-filter pipe (`groups/main/pipes/email-filter.js`)

- Triggers on `channel_event` for both `gmail` and `gmail2`.
- Runs a regex pre-filter for obvious automated senders, then hits Haiku to
  classify the rest as NOTIFY or SKIP.
- Returns either `drop` (SKIP) or `notify` to main (NOTIFY).
- Should never return `trigger` — if the user wants agent involvement on a
  specific email, that happens out-of-band.

## Desired end state

The right architectural cut is:

```
src/
  channels/         ← user-facing I/O with the agent (Discord, WhatsApp, ...)
  pipe-sources/     ← event feeds for the pipe runtime (gmail, imessage, ...)
  pipe-runtime.ts   ← the pipe scheduler/executor (already exists)
```

Key properties of the target design:

1. `PipeSource` is a distinct interface from `Channel`. It has:
   - `connect()`, `disconnect()`
   - an internal loop that calls `firePipeEvent()` for each event
   - **no** `onMessage`, **no** `sendMessage`, **no** registry entry in the
     channel registry
2. Enabling a pipe source does nothing user-visible on its own. The user
   must also create a pipe that consumes the source's events.
3. If the user wants a source to _also_ be a channel (e.g. iMessage where you
   legitimately want to chat with the agent over iMessage), those are two
   separate modules — the pipe-source half and the channel half — both
   backed by the same underlying BlueBubbles/Google API client, but
   composed, not conflated.
4. `firePipeEvent` stays the only public coupling between sources and the
   pipe runtime. Actions route out through a small dispatcher that resolves
   `target` strings to JIDs and delegates to whatever channel can deliver
   the message (for `notify`/`trigger`/`sms`). The dispatcher is the only
   place that knows about both halves.

This refactor is now implemented in the harness: pipe sources live separately
from channels, and source events feed the pipe runtime directly.

## Per-group agent-runner (footgun, worth knowing)

`src/container-runner.ts` creates a per-group copy of `container/agent-runner/src/`
at `data/sessions/<group>/agent-runner-src/`. The container mounts that copy
over `/app/src` so each group can customize its runner independently (add MCP
servers, tools, hooks) without affecting other groups.

Consequence: editing `container/agent-runner/src/` on the host only applies to
**new** groups. Existing groups keep their snapshot until you either
`rm -rf data/sessions/<group>/agent-runner-src` or manually copy over the
changed file.

## What's done

- `GmailChannel` has a `pipeOnly` flag. `GMAIL_PIPE_ONLY=1` in `.env`.
- Google Calendar MCP servers wired into `container/agent-runner/src/index.ts`
  (`gcal-personal`, `gcal-pinkmatter`). Credentials under `~/.gcal-mcp/` on
  the host, mounted into the container, multi-account via
  `GOOGLE_ACCOUNT_MODE`.
- Stale scheduled task (`task-1774473253862-qans6c`) that was spawning the
  agent every minute for email checks is deleted. The pipe handles this
  correctly in real time now.
- `discord_main/CLAUDE.md` email instructions match `main/CLAUDE.md` —
  "just say nothing" when filtering, no announcing silent completions.

## What's pending

- Pipe log → Discord webhook forwarder. User said yes; webhook URL is in
  `.env` as `DISCORD_PIPE_LOG_WEBHOOK`. Intended scope: pipe runtime logs
  only (load/run/error, not the full nanoclaw.log firehose).
- Confirm (via a test email) that the `pipeOnly` flag is behaving correctly
  end-to-end: real person email → pipe notifies → no agent spawn; junk email
  → pipe drops → no agent spawn, no message.

## Invariants to preserve going forward

- Pipes must not depend on any channel being registered as the main group to
  function.
- A channel should be either user-facing (you talk to the agent through it)
  or pipe-source (it feeds events) — never both by default.
- The agent triggers on user messages and explicit pipe `trigger` actions.
  Nothing else. No cron, no email, no source fallthrough.
- Pipe files live under `groups/<folder>/pipes/`. The authoring agent is
  whichever agent owns that group (usually main).
