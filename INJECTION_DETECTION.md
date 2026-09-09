# Prompt-Injection Detection: Design Summary

A portable, two-layer screen for untrusted text flowing through an LLM
pipeline — applies to any proxy/gateway in front of a model, or any tool
(RAG, web fetch, broker) that hands retrieved text back to a model.

## Core principle

Screen every non-clean role, and screen every string a tool returns, not
just user input. The two layers trade off cost vs. coverage:

- **Layer 1 — deterministic pattern scan.** Regex over literal attack
  syntax (shell metacharacters, SQL tautologies, fake role tags, Unicode
  smuggling). No model call, sub-millisecond, no network I/O. Catches an
  attacker who doesn't need semantically convincing text — just literal
  syntax that survives verbatim into whatever executes downstream.
- **Layer 2 — ML classifier** (e.g. Prompt Guard 2). Catches paraphrased
  or semantic manipulation Layer 1 can't enumerate via regex. Costs a
  model call; only worth running on Layer-1-clean text.

Layer 1 always runs (no network dependency). Layer 2 is optional per call
and fails **open** on infrastructure failure — an unreachable classifier
degrades to "Layer 1 only," never blocks every request or treats
unreachability as malicious. A missing/unset Layer 2 config produces a
one-time warning, not a hard failure.

## Layer 1: pattern categories

Five independent regex categories, each returning matched snippets:

| Category | Matches | Legitimate in `user` text? |
|---|---|---|
| `cmd_injection` | `$(...)`, backticks, `; rm/curl/wget/nc/bash/chmod/sudo`, `curl\|sh`, `nc -e`, `/etc/passwd`, `base64 -d \| sh` | Yes (debugging help) |
| `sql_injection` | `UNION...SELECT`, `' OR '1'='1`, `; DROP TABLE`, `xp_cmdshell`, `SLEEP()/BENCHMARK()`, `WAITFOR DELAY` | Yes (debugging help) |
| `role_spoof` | Fake role tags (`system:`, `assistant:` at line start), `<\|im_start\|>`/`<\|im_end\|>`, `[INST]`/`[/INST]`, `<think>`, `### system` | **Never** |
| `unicode_smuggling` | Bidi override chars, zero-width chars, Unicode tag block (ASCII smuggling) | **Never** |
| `instruction_override` | "ignore previous/above/prior instructions", "disregard the system prompt", "new instructions:", "you are now X" | Ambiguous — see severity rule |

## Python pattern matching

CMD_INJECTION = [
    r'\$\([^)]+\)',                                    # $(...) command substitution
    r'`[^`]+`',                                         # backtick substitution
    r'[;&|]{1,2}\s*(rm|curl|wget|nc|bash|sh|python[23]?|chmod|chown|sudo|dd|mkfs)\b',
    r'\b(curl|wget)\s+\S+\s*\|\s*(sh|bash)\b',          # curl|sh / wget|sh
    r'\bnc\s+-e\b',                                     # netcat reverse shell
    r'/etc/(passwd|shadow)\b',
    r'\bbase64\s+-d\b.{0,20}\|\s*(sh|bash)',
]

SQL_INJECTION = [
    r"(?i)\bunion\b.{0,40}\bselect\b",
    r"(?i)['\"]\s*or\s+['\"]?\d+['\"]?\s*=\s*['\"]?\d+['\"]?",   # ' OR '1'='1
    r"(?i);\s*drop\s+table\b",
    r"(?i)\bxp_cmdshell\b",
    r"(?i)\b(sleep|benchmark)\s*\(\s*\d+",
    r"(?i)\bwaitfor\s+delay\b",
]

### Structural spoofing — never legitimate in a message's content string, regardless of what role sent it.
ROLE_SPOOF = [
    r"(?im)^\s*(system|user|assistant|tool)\s*:\s",     # fake role tag at line start
    r"<\|im_start\|>|<\|im_end\|>",
    r"\[INST\]|\[/INST\]",
    r"</?think>",
    r"(?i)###\s*(system|instruction)\b",
]

UNICODE_SMUGGLING = [
    r"[‪-‮]",                  # bidi override chars
    r"[​‌‍﻿]",       # zero-width chars
    r"[\U000E0000-\U000E007F]",          # Unicode tag block (ASCII smuggling)
]

# Semantic-but-still-pattern-matchable phrasing — catches the unsophisticated, attacker before Layer 2 (Prompt Guard 2) would ever need to run.
INSTRUCTION_OVERRIDE = [
    r"(?i)\bignore\s+(all\s+)?(previous|above|prior)\s+instructions\b",
    r"(?i)\bdisregard\s+(the\s+)?(system\s+)?prompt\b",
    r"(?i)\bnew\s+instructions\s*:",
    r"(?i)\byou\s+are\s+now\s+\w+",
]

## Severity: keyed by message role, not content alone

Scanning role-blind false-positive-blocks legitimate use (a user pasting
a shell script for review). The rule:

- `role_spoof` / `unicode_smuggling` hits → **always block**, in any
  role's content. No honest reason for a bidi override or a fake role
  tag to appear inside a message body.
- `cmd_injection` / `sql_injection` / `instruction_override` hits in a
  **tool-originated** message (RAG chunk, fetched page, tool/broker
  result — content the model is *reading*, not content a human typed on
  purpose) → **block**. A retrieved webpage has no legitimate reason to
  contain a reverse-shell one-liner or tell the model to ignore its
  instructions. This is the "adversarial content retrieved by an agent"
  case.
- Same categories in a **user** message → **flag only**, never a hard
  block on this signal alone. Expected and often legitimate.

```
severity(role, hits):
    if hits is empty: "clean"
    if hits ∩ {role_spoof, unicode_smuggling}: "block"
    if role == "tool" and hits ∩ {cmd_injection, sql_injection, instruction_override}: "block"
    else: "flag"
```

Batch scans (a full message list) collapse to one overall verdict:
`block` if any message blocked, else `flag` if any flagged, else `clean`.

## Applying the screen to outbound tool results

Any tool that returns text pulled from an external/untrusted source
(search results, fetched pages, retrieved documents) should screen every
returned string before it reaches the caller, scored with role="tool" —
this is exactly the adversarial-content case Layer 1 is built for:

1. Run Layer 1 on the text. If it blocks, redact — withhold the text but
   keep any citation/pointer and the block reason, so the result stays
   auditable.
2. If Layer 1 is clean and Layer 2 is available, run the classifier. If
   it returns a malicious label above threshold, redact the same way.
3. If Layer 2 is unreachable, proceed on Layer 1 alone and report that
   only partial screening ran — don't silently imply full coverage.
4. Otherwise return the (sanitized) text.

Redacting rather than dropping the result lets an operator follow up
without silently losing the fact that something was found.

## Logging

Log only non-clean verdicts (block/flag) — clean traffic volume belongs
in ordinary request logging, not duplicated here. Each event: timestamp,
severity, roles involved, categories hit. Keep the write best-effort and
wrapped — a logging failure must never affect the actual request/response
path. Aggregate counts (rolling window, by category, recent blocks) feed
an operational digest without needing to query raw logs per host.

## Design notes worth keeping

- Layer 1 has zero network dependency by design — it must never be the
  reason a request fails to route.
- Layer 2 is a strict enhancement: it can only turn a Layer-1-clean
  result into a block, never override a Layer-1 block, and its own
  unavailability must never be treated as a positive signal.
- Truncate text sent to a classifier (e.g. first ~4000 chars) — cost and
  latency control, not a security boundary.
- The severity split by role is the load-bearing design decision: without
  it, this either blocks legitimate technical conversation or misses the
  actual attack surface (tool-retrieved content), depending on which way
  you tune it.
