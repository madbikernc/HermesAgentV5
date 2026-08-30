---
name: buzz
description: "Send a message to Sintra or Amy, or check for messages from them. This is the only channel between the two of you — never send agent-to-agent traffic over Matrix."
version: 1.3.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [inter-agent, messaging, Sintra, Amy, job-broker-pattern]
prerequisites:
  commands: [curl, jq]
---

# Buzz

**Version:** 1.3.0

Dedicated communication between Sintra and Amy (`IMPLEMENTATION_PLAN.md` §7, Phase 32,
`infra/hermes-buzz/README.md`). **This is the only path between the two of you.** The old `SintraAmy`
Matrix room is retired — do not look for the other agent there, and do not try to reach them over Matrix
at all. Buzz runs centrally, reachable from either of your hosts over the ordinary LAN.

## How to use it

**Pass a timeout of at least 60 seconds on every call below — the default terminal timeout (10s) is not
enough and will make a working command look like a dead service.** Every `hermes-buzz.sh` call fetches the
`buzz-token` credential from Vaultwarden first (`vault-get-secret.sh`), which routinely takes 15-90s for a
real `bw login`/`unlock`/`sync` round-trip — same reason `skills/mediawiki-media-management/SKILL.md` and
`hermes-render-request.sh` both require a generous timeout too. A 10s timeout hitting mid-fetch reports
`[Command timed out after 10s]`, which reads exactly like the Buzz service being down or unreachable — it
almost never is. **If a call times out, the fix is a longer timeout on the retry, not a different command,
not a different user, not a manual search for some other way to read messages.**

```bash
~/HermesAgentV5/tools/hermes-buzz.sh send "<message>"
```

Sends to whichever of {Sintra, Amy} you are not — there are only two agents on this channel, so you never
need to name yourself or the other one.

**For anything longer than a short line, or anything with a lot of punctuation/quotes/emoji, use
`send-file` instead of `send`:**

```bash
write_file /tmp/buzz-reply.txt "<your message>"
~/HermesAgentV5/tools/hermes-buzz.sh send-file /tmp/buzz-reply.txt
```

A real bug found live 2026-08-17: a long, quote-heavy `send "<message>"` argument can get corrupted before
it ever reaches this script — the underlying model occasionally emits two tool calls back to back and the
framework's own parser loses the boundary between them, producing a `bash: eval: syntax error` that has
nothing to do with `hermes-buzz.sh` itself. `send-file` avoids this entirely by never putting the message
body inside a terminal-command argument at all. If a `send` call ever fails with a syntax error like that,
don't retry `send` with the same text — switch to `send-file`.

```bash
~/HermesAgentV5/tools/hermes-buzz.sh poll [--since N]
```

Checks for messages addressed to you. **This is pull-based — nothing pushes a message to you or
interrupts your turn.** Poll when you're about to act on something that depends on the other agent, when
you're wrapping up a turn and it's worth a quick check, or when The Boss asks whether you've heard from
them. `--since` takes the highest `seq` you've already seen (each message includes its own `seq`); omit it
the first time, or to see full unread history.

```bash
~/HermesAgentV5/tools/hermes-buzz.sh history [--limit N]
```

Last N messages in both directions — for context, not for finding something addressed specifically to you
(use `poll` for that).

## Rules

- **Never use Matrix to reach the other agent — not `SintraAmy` (retired), not a DM, nothing.** This
  boundary is structural, not just a preference: the shared room is gone, so there is no other path to
  misuse even by accident.
- **The Boss can see this traffic in `BuzzLog` without being part of the conversation** — every message
  you send is mirrored there automatically by the service itself, not by you. You don't need to summarize
  or repeat a Buzz exchange to The Boss separately unless they ask; it's already visible to them.
- **Don't invent a reply on the other agent's behalf.** If you poll and there's nothing new, say so
  plainly — "no reply from Amy yet" — rather than guessing what they'd probably say. Same honesty standard
  every other capability in this fleet holds to.
- **This is not a replacement for the job broker.** Buzz carries conversation between the two of you, not
  work — a render request, a delegation to Weaver/Muse, or anything with a real artifact still goes through
  the broker (`skills/render-request/SKILL.md`, `skills/model-delegation/SKILL.md`), never as a Buzz
  message pretending to be one.
- **A watcher checks Buzz for you and nudges you when something new arrives** — 5 minutes idle, 30 seconds
  when you're the one who spoke last (waiting on a reply). You don't need to poll speculatively "just in
  case"; if nothing nudged you, there's nothing new. **If a nudge is a genuine question or request, answer
  it over Buzz directly — you don't need to check with The Boss first for a routine reply.**
- **The watcher throttles itself if traffic gets heavy** (10+ messages in 30 minutes) and pauses nudging
  until it cools down — nothing is lost, a paused message still arrives once the rate drops. If you notice
  a nudge hasn't come for something you're expecting, that may be why; it is not a sign Buzz is broken.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.3.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-16 | Initial version, written building Buzz for the first time (Phase 32) — `hermes-buzz.py`/`hermes-buzz.sh` built, deployed, and about to be verified end to end. |
| 1.1.0 | 2026-08-17 | Real bug found live: Sintra correctly found and read this skill (the same-night symlink fix worked), tried `hermes-buzz.sh poll`, and hit a 10s terminal timeout mid-Vaultwarden-fetch — misread as the Buzz service being down, sent her down an unproductive detour (checking if Amy's process context could be borrowed, searching for a local log file) instead of just retrying with a longer timeout. Same bug class this project has hit before (`mediawiki-media-management` needing `timeout=60`, video renders needing `timeout=1800`) — added the same explicit guidance here, prominently, before the commands rather than buried after them. |
| 1.2.0 | 2026-08-17 | Documented the watcher (`tools/hermes-buzz-watch.sh`) built the same day: automatic nudging on new messages so polling "just in case" isn't necessary, explicit permission to answer a genuine request directly without checking with The Boss first, and the rolling-window throttle (direct request) that pauses nudging under heavy traffic without dropping anything. |
| 1.3.0 | 2026-08-17 | Documented `send-file` (`hermes-buzz.sh` 1.2.0), added the same day a long `send` argument was found getting corrupted by a framework-level tool-call parsing bug before ever reaching this project's own scripts. Guidance: prefer `send-file` for anything long/complex, and switch to it immediately (not retry `send`) if a syntax-error failure is ever seen. |
