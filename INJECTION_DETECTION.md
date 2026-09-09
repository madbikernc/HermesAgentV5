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

Six independent regex categories, each returning matched snippets:

| Category | Matches | Legitimate in `user` text? |
|---|---|---|
| `cmd_injection` | `$(...)`, backticks, `; rm/curl/wget/nc/bash/chmod/sudo` (case-insensitive), `curl\|sh` (flags tolerated), `nc -e`, `/etc/passwd`, `base64 -d \| sh` | Yes (debugging help) |
| `sql_injection` | `UNION...SELECT`, `' OR '1'='1`, `; DROP TABLE`, `xp_cmdshell`, `SLEEP()/BENCHMARK()`, `WAITFOR DELAY` | Yes (debugging help) |
| `role_spoof` | Fake role tags (`system:`/`assistant:`/`human:` at line start), `<\|im_start\|>`/`<\|im_end\|>`, `<\|system\|>`/`<\|user\|>`/`<\|assistant\|>`, `<<SYS>>`/`<</SYS>>`, `[INST]`/`[/INST]`, `<think>`, `### system` | **Never** |
| `unicode_smuggling` | Bidi override + isolate chars, zero-width chars (incl. word joiner), Unicode tag block (ASCII smuggling) | **Never** |
| `instruction_override` | "ignore previous/above/prior instructions", "ignore everything above", "forget your instructions", "disregard the system prompt", "new instructions:", "you are now X" | Ambiguous — see severity rule |
| `prompt_exfiltration` | "repeat/print/reveal the text above", "what are your instructions", "reveal your (system) prompt" | Ambiguous — see severity rule |

`prompt_exfiltration` is distinct from `instruction_override`: the latter
is about getting the model to behave differently going forward, the
former is about extracting the prompt/instructions verbatim. Both are
treated the same way by severity — see below.

## Python pattern matching

CMD_INJECTION = [
    r'(?i)\$\([^)]+\)',                                    # $(...) command substitution
    r'(?i)`[^`]+`',                                         # backtick substitution
    r'(?i)[;&|]{1,2}\s*(rm|curl|wget|nc|bash|sh|python[23]?|chmod|chown|sudo|dd|mkfs)\b',
    r'(?i)\b(curl|wget)\s+\S+(?:\s+\S+){0,4}\s*\|\s*(sh|bash)\b',  # curl|sh / wget|sh, flags tolerated
    r'(?i)\bnc\s+-e\b',                                     # netcat reverse shell
    r'(?i)/etc/(passwd|shadow)\b',
    r'(?i)\bbase64\s+-d\b.{0,20}\|\s*(sh|bash)',
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
    r"(?im)^\s*(system|user|assistant|tool|human)\s*:\s",  # fake role tag at line start
                                                             # ("human" catches the classic
                                                             # Anthropic completions-style
                                                             # `\n\nHuman:` injection format)
    r"<\|im_start\|>|<\|im_end\|>",
    r"<\|(system|user|assistant)\|>",                       # ChatML-adjacent role tags
    r"<<SYS>>|<</SYS>>",                                    # Llama-2 system delimiters
    r"\[INST\]|\[/INST\]",
    r"</?think>",
    r"(?i)###\s*(system|instruction)\b",
]

UNICODE_SMUGGLING = [
    r"[\u202A-\u202E\u2066-\u2069]",     # bidi override + isolate chars
    r"[\u200B-\u200D\u2060\uFEFF]",       # zero-width chars: ZWSP/ZWNJ/ZWJ/word-joiner/BOM
    r"[\U000E0000-\U000E007F]",          # Unicode tag block (ASCII smuggling)
]

# Semantic-but-still-pattern-matchable phrasing — catches the unsophisticated attacker before Layer 2 (Prompt Guard 2) would ever need to run.
INSTRUCTION_OVERRIDE = [
    r"(?i)\bignore\s+(all\s+)?(previous|above|prior)\s+instructions\b",
    r"(?i)\bignore\s+(everything|all)\s+(above|before\s+this)\b",
    r"(?i)\bdisregard\s+(the\s+)?(system\s+)?prompt\b",
    r"(?i)\bforget\s+(your|all|previous)\s+instructions\b",
    r"(?i)\bnew\s+instructions\s*:",
    r"(?i)\byou\s+are\s+now\s+\w+",
]

# System-prompt / instruction exfiltration attempts — distinct from INSTRUCTION_OVERRIDE
# (which is about behavior going forward, not extracting the prompt verbatim).
PROMPT_EXFILTRATION = [
    r"(?i)\b(repeat|print|output|show|reveal)\s+(the\s+)?(text|words|instructions|prompt|everything)\s+above\b",
    r"(?i)\bwhat\s+(are|were)\s+your\s+(system\s+)?instructions\b",
    r"(?i)\breveal\s+(your\s+)?(system\s+)?prompt\b",
    r"(?i)\brepeat\s+(everything|all)\s+(above|before\s+this)\b",
]

## Layer 2: classifier implementation

HermesAgentV5 runs Layer 2 as a small resident HTTP service wrapping
Meta's **Llama-Prompt-Guard-2-22M**, stock weights, never fine-tuned or
abliterated — deliberately: removing refusal disposition from the one
component whose entire job is refusal-under-pressure would be
self-defeating, so this is the one model in the stack that's never a
candidate for that kind of modification.

- **Architecture**: a DeBERTa-v2 sequence-classification head, not a
  causal LM — it doesn't run on a causal-LM inference server; it's served
  directly via `transformers` (`AutoModelForSequenceClassification`).
  22M params, ~283MB.
- **Compute**: CPU-only, deliberately. Classification takes low tens of
  milliseconds even without a GPU, and keeping it off-GPU means Layer 2
  costs zero accelerator/KV-cache headroom against whatever LLM backends
  share the host.
- **Output**: binary classifier per Meta's own model card — `MALICIOUS`
  (an explicit attempt to override prior instructions) or `BENIGN`, each
  with its own softmax probability as the score. No injection/jailbreak
  sub-labels in this generation of the model (v1 had them; Meta found
  that objective too broad to be useful). Note the checkpoint ships
  generic `id2label` (`LABEL_0`/`LABEL_1`) rather than named labels —
  normalize that mapping in the wrapper rather than trusting the model
  config.
- **Context window**: 512 tokens. Longer input is truncated, not split —
  a guard that fails closed on long input is worse than one that screens
  a truncated prefix. A caller wanting full-document coverage should
  chunk before calling, same scoping rule Layer 1 uses per-message.
- **Threshold**: a hit is `label == MALICIOUS and score >= THRESHOLD`,
  threshold configurable, defaulting to 0.5.
- **Service contract**: bearer-token-authenticated HTTP (`POST /classify`
  with `{"text": ...}`, `GET /health`), token compared with a
  constant-time check. The token is injected by a wrapper script that
  pulls it from a secrets vault at process start — the classifier service
  itself never has secrets touch disk.

## Severity: keyed by message role, not content alone

Scanning role-blind false-positive-blocks legitimate use (a user pasting
a shell script for review). The rule:

- `role_spoof` / `unicode_smuggling` hits → **always block**, in any
  role's content. No honest reason for a bidi override or a fake role
  tag to appear inside a message body.
- `cmd_injection` / `sql_injection` / `instruction_override` /
  `prompt_exfiltration` hits in a **tool-originated** message (RAG chunk,
  fetched page, tool/broker result — content the model is *reading*, not
  content a human typed on purpose) → **block**. A retrieved webpage has
  no legitimate reason to contain a reverse-shell one-liner, tell the
  model to ignore its instructions, or ask it to repeat its system
  prompt. This is the "adversarial content retrieved by an agent" case.
- Same categories in a **user** message → **flag only**, never a hard
  block on this signal alone. Expected and often legitimate.

```
severity(role, hits):
    if hits is empty: "clean"
    if hits ∩ {role_spoof, unicode_smuggling}: "block"
    if role == "tool" and hits ∩ {cmd_injection, sql_injection, instruction_override, prompt_exfiltration}: "block"
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
- Watch the gap between Layer 1's and Layer 2's effective reach: Layer 1
  scans the full text with no length limit, but a caller-side truncation
  (e.g. ~4000 chars) plus the classifier's own token window (512 tokens,
  roughly 2000-2600 chars) means Layer 2 only ever sees a prefix of a long
  document. An attacker can pad a tool result with enough benign filler
  to push a payload past Layer 2's real window while staying inside
  Layer 1's unbounded reach — meaning the pattern scan is the sole
  backstop for anything beyond roughly the first page of a long result.
  Not fixed here; would require chunking and scanning each chunk.
- Keep every category's patterns case-insensitive by default (`(?i)`) —
  an inconsistency here (one category case-sensitive while its siblings
  aren't) is a silent bypass, not a deliberate tightening.
- All regexes here use bounded quantifiers (`{0,N}`, `{0,N}`-style repeat
  counts) rather than unbounded nested repetition — deliberate, to keep
  the scan free of catastrophic-backtracking (ReDoS) risk on adversarial
  input. Preserve that property in any pattern you add.
