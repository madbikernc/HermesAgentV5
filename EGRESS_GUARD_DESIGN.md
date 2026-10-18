# Firmament Layer 3 — Tool-Call & Egress Guard: Target Design

**Version:** 1.4.0

**Status:** All four phases executed, 2026-10-18 (§10). `tools/hermes_egress_guard.py` (Tier A) and
`infra/firmament-tool-registry.yaml` exist; the five real call sites §5 named (plus two more real ones
found while wrapping them, §3's revision note below) call `check_destination()` before reaching their
destination, and every deny path now also runs §8's Matrix+email+record pipeline. Three real duplicate
`send_email`/`matrix_notice` implementations Phase A's own wrapping touched are consolidated onto
`hermes_alert_common.py`. `hermes-fleetops-ui.py`'s new `/egress-blocks` page reads the report-page record
directly out of `hermes-memory`'s SQLite file, the same way `/recommendations` already does — which made
Phase C's own originally-planned gate (§8.4) moot; see that section's correction note. `hermes-router.py`
now buffers and validates any response to a request that actually asked for tool-calling (§7 Tier B) —
real traffic, which never does, is completely unaffected. Still open: the `hermes-memory` write itself is
unit-tested but not verified against a live instance (no fleet node reached this session); S33 (the
underlying HTTP-API cap) remains unresolved as its own stage; the optional Phase E (egress-firewall
defense-in-depth, §10) was never in scope for this pass. `IMPLEMENTATION_PLAN.md`'s **S40** is the stage
that tracks this and points back here for the full spec, the same split S23/S38/S39 use for their own
design docs.

**Purpose:** add a third screening layer, symmetric to the existing Layer 1 (`hermes_injection_guard.py`)
and Layer 2 (`hermes-guard.py`) **input** screens, that constrains what a model's **output** is allowed to
cause: any tool/function call or outbound network action a model's response asks for must target either
(a) fleet-internal infrastructure, or (b) a destination on an explicit, operator-maintained whitelist of
tools/endpoints The Firmament has actually built and published. Anything else is denied, reported to the
Fleet Matrix room, sent as a high-priority email alert, and recorded in a form the `hermes-fleetops-ui`
oversight UI can surface on a report page.

**Status legend**, same convention as `firmament-fleet-target-architecture.md`:
- `[DECIDED]` — operator made an explicit choice
- `[PROPOSED]` — design recommendation, not yet ratified
- `[UNKNOWN]` — needs discovery/research before building
- `[RISK]` — flagged concern requiring validation or an operator decision

---

## 1. The ask, restated precisely

1. Evaluate the existing `hermes-guard` system as it stands today.
2. Add a new check on model **output**: any tool call a model's response makes must target an "internal"
   tool, defined as either (a) hosted within the fleet's local networks — stated as `10.x.x.x/8` plus the
   tailscale network's nodes — or (b) a whitelisted tool call known to have been created and published
   within The Firmament.
3. Anything that looks foreign/external must be: denied; reported in the Matrix channel; sent as a
   high-priority email alert; recorded in a way that surfaces on a report page in the FleetOps oversight
   UI.

---

## 2. Evaluation of `hermes-guard` as it exists today

The Firmament already runs two real, live, well-measured input-screening layers, both audited in full for
this proposal:

- **Layer 1 — `tools/hermes_injection_guard.py` (v1.5.0).** A pure regex/heuristic scanner over message
  text: command injection, SQL injection, role-spoofing, role-tag smuggling, unicode smuggling, instruction
  override, and prompt-exfiltration patterns, with severity scaled by the message's declared role (a
  `tool`/`function`/`ipython`-role message is held to a stricter bar than a `user`-role one). It is a pure
  function over `(text, role)` — it never looks at anything resembling a structured tool call.
- **Layer 2 — `tools/hermes-guard.py` (v2.2.0).** Either a local classifier (`mdeberta-prompt-injection`,
  with `Prompt-Guard-2-22M` kept as a one-line rollback) or, in production today, a stock LLM (`omni`) asked
  one fixed yes/no question about a single string of text. Measured hard against a 36-case hand-labelled
  set (S22): the deployed LLM-mode arm scores 18/18 on the malicious set including 6/6 indirect and 6/6
  paraphrased injections, against the classifier-only incumbent's 4/18.
- **Both layers are invoked from exactly one place — `hermes-router.py`'s `do_POST()`.** It finds the
  *newest* `user`/`tool` message in the request, runs Layer 1 then Layer 2 on that one message's content,
  and then proxies to the backend. **The backend's response is streamed straight back to the caller,
  unexamined — there is no post-generation hook anywhere in the router.** This is confirmed by reading the
  response-handling path directly: chunks are read from upstream and written to the client with no scan
  call in between.

**This is not a defect in Layer 1/2 — it is a categorical gap.** Both layers were built, and are measured,
to do one job: decide whether a request is safe to let reach a model. Neither was ever designed to look at
what a model's response *asks to happen next*. There is currently **no Layer 3** — nothing in this
codebase inspects, constrains, or screens a model's output for an action it wants performed. This proposal
is that missing layer, not a fix to the first two.

---

## 3. The load-bearing finding: this attack surface doesn't exist yet in production

Before designing the control, it is worth being exact about what it would actually be defending, because
the honest answer changes the design. A full audit of every real network-call site in the codebase
(`tools/`, `services/`, `skills/`) found **zero places where a model's output currently supplies or
influences a network destination.** Specifically:

| Call site | Destination | Model/user influence |
|---|---|---|
| `hermes-router.py` → backend | `ROLES` dict, 6 fixed `host:port` entries, operator-edited | None — a closed enum |
| `hermes-dispatch.py` routing | `VALID_TARGETS`, a fixed Python `set` of 12 topic names | LLM picks *from* the enum; anything else is discarded, never executed as a destination |
| `hermes-websearch.py` → Tavily | `TAVILY_URL` (`api.tavily.com`), fixed, operator/env-set | User's question text travels as a *payload* field, never the URL |
| `hermes-media.py`/render-worker → ComfyUI | `COMFY_URL`/`BROKER_URL`, hardcoded per-node | Prompt text lands inside an already-JSON-escaped string field; a *different* field (`resolution`/`frames`/`engine`) was once spliced unvalidated and fixed with allowlist regexes (`hermes-render-worker.py` 1.2.0) — the precedent this proposal generalizes |
| Minecraft `skills.js` skill authoring | N/A — skills are `{action, args}` data validated against `SKILL_ACTION_VERBS` (~28 game-action verbs, no network primitive among them), never raw code or `eval` | The LLM only ever *names* an already-executed action sequence; it cannot author new steps |
| `hermes-dualcoder.py` | N/A | Purely advisory text output; nothing it produces is ever executed |
| BFCL (function-calling benchmark) | A role's own fixed `llama-server` port, bypassing the router entirely | Test-only; a returned function-call's arguments are scored, never executed against real infrastructure |
| `hermes-model-scout`/`-scan`/`-watch` → HuggingFace Hub | `huggingface.co`, fixed | Model-id string comes from a fixed discovery listing, never free-text model output |

No OpenAI-style `tools`/`tool_calls`/`function_call` field is ever sent to a backend or parsed from one,
anywhere in production. The fleet's entire "routing" surface is LLM-chosen-from-a-closed-enum
(`VALID_TARGETS`, `ROLES`), which is structurally incapable of producing a destination outside that fixed
set — a materially different, and already materially safer, pattern than open-ended function-calling with
a model-filled URL/host argument.

**This changes the framing but not the value of the request.** The right way to read this is: now is
exactly the time to build this control, before — not after — some future capability (a real OpenAI `tools`
schema for a skill, the kind of agentic tool-use S37 is already evaluating for its own harness-ablation
question, or a new skill type that isn't `skills.js`'s deliberately data-only design) introduces a path
where a model's output *could* pick a destination. Building the guard now, with nothing yet to catch, also
means it gets to be exercised and trusted on the fleet's five legitimate existing external destinations
(§5) before it is ever relied on to catch something adversarial.

**Revision note (Phase A, 2026-10-18): this table's own `hermes-model-scout`/`-scan`/`-watch` row was
incomplete.** Wrapping `hermes-model-watch.py` for real (§10 Phase A) found it also calls
`raw.githubusercontent.com` (`upstream_arch_set()`, diffing this fleet's local llama.cpp build against
upstream) and `api.github.com` (`search_llama_cpp_prs()`, GitHub's search API) — neither is HuggingFace Hub,
and neither was in this table or in §5's whitelist. Both are now wrapped and registered (`infra/firmament-
tool-registry.yaml`). Separately, a broader sweep of every literal `https://` string under `tools/` (not
repeated for `services/`/`skills/`) found this audit was scoped to the *model/tool-call* surface this
proposal is actually about, not a complete inventory of every external destination the fleet's operational
scripts reach: `hermes-vivint.py`, `hermes-generac.py`, `hermes-wyze.py`, `hermes-podcast-retriever.py`,
`hermes_botnet_intel.py`, `hermes-nous-judge.py`, `hermes-nfsensei-watch.py`, `hermes-bakeoff-typesafe.py`,
`hermes-feed-reader.py`, and `mediawiki.py` each reach their own real external service/feed, none of them
wrapped by Phase A and none on the registry. None of these carry model-output-influenced destinations
either (same closed-enum/fixed-URL pattern as everything else in this table), so the finding above still
holds. But "Phase A hardens the fleet's real external call sites" should be read as scoped to the ones this
proposal named, not as a claim that every external destination in the codebase is now covered —
extending the registry/wrapping to this wider list is an open follow-up, not assumed here.

---

## 4. Defining "internal" — anchored to the fleet's actual documented ranges, not a blanket `/8`

The request's own framing (`10.x.x.x/8` plus the tailscale network's nodes) is directionally right but
broader than anything this fleet's own network design (`infra/network-planes.md`, v1.2.0) actually uses.
The fleet's real internal numbering is:

- **Control plane:** `10.129.1.0/24` (GigE — router, broker, Buzz, memory, Continuwuity, model-proxy,
  SSH; every node including Anvil/PMWIN11 is reachable here)
- **Data plane:** `10.129.9.0/30` (`bond-fabric0`, spark↔spark-2 only, ufw-restricted to SSH)
- **RDMA plane:** `10.129.10.0/30` (spark↔spark-2 only, RoCEv2/NCCL traffic)
- **Tailscale tailnet:** CGNAT range `100.64.0.0/10`, tailnet `tail1a534.ts.net` (spark, spark-2, HomeD13,
  and Vaultwarden's own tailnet exposure — explicitly *not* extended to every node, "don't mix trust
  pools")

`[DECIDED]` (Phase A, 2026-10-18): the four ranges above are the default, loopback (`127.0.0.0/8`) is
always internal (that is just "this same host," not a plane), and the full `10.0.0.0/8` is available only
as an explicit, named opt-in (`HERMES_EGRESS_ALLOW_FULL_10_8=1`), never the silent default —
`tools/hermes_egress_guard.py` implements exactly this. The reasoning stands as originally written: a
blanket `10.0.0.0/8` allow is roughly 16 million addresses wider than anything this fleet's own documented
plane model uses, and a stray call to some unrelated `10.x` address — a misconfigured container bridge, an
unrelated VPN peer, a future cloud peering — would pass a literal `/8` check without ever being a
Firmament node.

---

## 5. Named external exceptions that already exist and must not break

A whitelist that only encodes "internal" would break real, legitimate, already-running fleet behavior. Five
destinations are genuinely external today and must be carried forward as explicit, caller-scoped allowlist
entries rather than lost to a naive "internal-only" rule:

| Destination | Used by | Scope |
|---|---|---|
| `api.tavily.com` | `hermes-websearch.py` only | Web-search fallback, confirmed-only-on-user-confirmation |
| `huggingface.co` | `hermes-model-scout.py`/`-scan.py`/`-watch.py` only | Model discovery metadata |
| LinodeMercury's fixed IP | `hermes-linodemercury-watch.py` / its own ssh config only | Explicitly one-way — the fleet reaches it, it can never reach back |
| `mail.hover.com:587` | `hermes_alert_common.py` (and its not-yet-consolidated duplicates) | SMTP relay for every email alert, including this proposal's own hi-pri alert |
| The Matrix homeserver | `hermes_alert_common.py`'s `matrix_notice()`, `hermes-presenter.py` | `[DECIDED]` (Phase A) — **not an external exception after all.** Confirmed via `infra/continuwuity/continuwuity.toml.template` (binds `0.0.0.0:6167`) and that directory's own README (`ufw allow from 10.129.1.0/24 to any port 6167`): Continuwuity is control-plane-internal, reachable only from `10.129.1.0/24` (or `127.0.0.1` for a caller on the same node, which is every current caller's default). It needs no registry row at all — §4's internal check already allows it before the registry is ever consulted. This resolves S40a's second open gate. |

Each entry is scoped to the specific caller(s) that legitimately use it — a tool-registry entry granting
`huggingface.co` access to `hermes-websearch.py`, say, would be wrong even though the host itself is
"known," which is why §6 ties allowlist entries to caller identity, not just destination.

---

## 6. The missing piece: a real "published tools" registry

The request's second clause — "a whitelist of tool calls known to have been created and published within
The Firmament" — has no existing equivalent to extend. A full search confirmed there is no manifest
enumerating this fleet's own tools/skills anywhere: `skills/*/SKILL.md` files are operator/Claude-Code-facing
documentation of individual fixed CLI invocations, not a model-facing function registry, and nothing
indexes them collectively. The closest existing "closed-enum whitelist" concepts (`VALID_TARGETS`,
`ROLES`, `SKILL_ACTION_VERBS`) are all namespaces for "which internal handler," not "which external
destination" — a structurally different problem.

`[PROPOSED]`: build `infra/firmament-tool-registry.yaml`, one row per real callable surface, in the same
"operator edits a fixed file by hand, code checks membership, no match is a failure to route rather than a
silent guess" spirit `VALID_TARGETS`/`ROLES` already establish:

```yaml
# name: human-readable identity of the tool/action
# kind: topic | game-verb | external-endpoint | future-function-call
# allowed_callers: which script(s)/role(s) may invoke it
# destination: internal (no further check) | a §5 named external host
- name: rag-retrieve
  kind: topic
  allowed_callers: [hermes-dispatch.py]
  destination: internal
- name: web-search-fallback
  kind: external-endpoint
  allowed_callers: [hermes-websearch.py]
  destination: api.tavily.com
- name: model-discovery-lookup
  kind: external-endpoint
  allowed_callers: [hermes-model-scout.py, hermes-model-scan.py, hermes-model-watch.py]
  destination: huggingface.co
# ... one row per VALID_TARGETS topic, per SKILL_ACTION_VERBS game verb (kind: game-verb,
#     internal by definition — it never leaves the Minecraft server process), and per §5 exception.
```

This file becomes the single authoritative source both halves of §7's design check against — it is the
literal whitelist the request asks for, versioned and reviewable the same way every other fleet config is,
rather than something inferred at runtime from scattered code.

---

## 7. The control: two tiers

### Tier A — Egress-destination guard (the buildable, load-bearing half)

A new shared module, named to match the existing convention (`hermes_alert_common.py`,
`hermes_injection_guard.py`): **`hermes_egress_guard.py`**, exposing one function real call sites import and
use before making an outbound request:

```python
check_destination(url, caller: str) -> None   # raises EgressDenied if not allowed
```

Logic: resolve the destination host; if it falls in one of §4's internal ranges, allow. Otherwise, look it
up in §6's registry — allow only if the entry's `allowed_callers` includes the actual caller. Anything else
denies, and triggers §8's pipeline.

**Fail-safe, not fail-open** — if the registry file is missing or fails to parse, deny all non-internal
egress rather than let it through unchecked, the same discipline `hermes-dispatch.py`'s own docstring
states for its routing check ("a bad response is a failure to route, never a silent guess").

**Rollout order:** wrap the five real existing call sites first (§5's table) — `hermes-websearch.py`,
`hermes-model-scout.py`/`-scan.py`/`-watch.py`, `hermes-linodemercury-watch.py`, and
`hermes_alert_common.py`'s own SMTP/Matrix calls. This is pure hardening with nothing new to catch on day
one (§3), which is exactly the point — it proves the control against real, known-good traffic before it is
ever relied on for anything adversarial.

### Tier B — Structural tool-call tripwire at `hermes-router.py`

Forward-looking, explicitly labeled as such rather than claimed as a live fix (matching this repo's own
discipline — e.g. S18's exit gate framing — of never overclaiming what a change defends against today).
`[DECIDED]`, executed Phase D, 2026-10-18.

**The real fail-closed constraint, found while building this, not assumed.** `hermes-router.py` relays a
backend's response chunk-by-chunk the instant each one is read from upstream (confirmed by reading the
write loop directly) — so by the time a full response is available to scan for a tool call, the caller
already has it. "Strip the tool call from the response" is only actually possible *before* the first byte
goes out, which means a real implementation cannot be a passive scan bolted onto the existing live-relay
loop; it has to change *when* bytes are written, for at least some requests.

**The fix: gate the buffered path on `tools`/`functions` being present in the request, not on every
request.** `do_POST()` now computes `wants_tools = bool(payload.get("tools") or payload.get("functions"))`
once, up front. When false — every real request today, confirmed (§3) — the relay loop is byte-for-byte
unchanged: live chunk-by-chunk streaming, same latency, same everything. When true, the router instead
reads the *entire* upstream response into memory first, validates it, and only then either relays the
buffered bytes in one shot (allowed) or sends a 400 instead (denied) — a real, working fail-closed gate,
paid for only by the one request shape nothing in this fleet produces yet. The alternative (buffer and
scan every response, always) was rejected: it would cost every real request its current low-TTFB streaming
to guard a condition that cannot occur today, a materially worse trade for zero added protection.

**Validation, in `tools/hermes_egress_guard.py`'s new `check_tool_call(name, arguments_json, caller=
"hermes-router.py")`:**
1. `name` must be a published tool — some registry row's own `name` field, any `kind`, checked
   unconditionally (so an unregistered tool with no URL-shaped argument at all still denies).
2. `extract_tool_calls()` (new, in `hermes-router.py`) reconstructs every call found, whether the response
   was a plain JSON object or an SSE stream — the streaming case means replaying OpenAI's own
   delta-accumulation wire format (`function.name`/`id` arrive once per `index`; `function.arguments`
   arrives as string fragments concatenated in order across many chunks), done once over the now-complete
   buffered body rather than incrementally.
3. Every string found anywhere inside the parsed `arguments` (walked recursively — arguments have no fixed
   shape) that looks host/URL-shaped is run through Tier A's own `check_destination(value, name)` — **the
   tool's own name is the caller identity**, not the router process. A registry row's `allowed_callers`
   therefore has to name the function explicitly before that function can reach the row's destination; it
   is not implicitly granted by the row existing, the same non-transferable-grant rule §5 already holds
   Tier A's own callers to.

**Consequence, confirmed rather than assumed: this denies 100% of real invocations today, correctly.** No
registry row lists a function name among its own `allowed_callers` (every row today lists script
basenames, Tier A's concern) — so a hypothetical tool call naming an otherwise-real published destination
(e.g. `web-search-fallback` with a `url` argument pointing at `api.tavily.com`) still denies, verified live
in this session, not assumed: the function name is registered, but is not *itself* an allowed caller of
that destination. This is exactly the "nothing to catch yet" state the design has claimed since §3 — now
asserted by a test rather than taken on faith (`infra/hermes-router/tests/test_tier_b.py`). The day a real
tool is actually published for a model to call, its registry row's `allowed_callers` needs the function's
own name added explicitly — an authoring step, not a code change.

**Known, stated limitation.** The host/URL heuristic (`_looks_like_host_or_url()`) requires a dotted,
TLD-shaped label or a plain IPv4 address — deliberately, so an ordinary decimal argument ("3.14") or a
version string ("1.2.3") never false-positives into a destination check, found by testing it against
exactly those two shapes before trusting it. The cost: a bare single-label hostname with no TLD shape
(e.g. "localhost") inside an argument is not caught. Every real internal call site in this fleet already
uses a literal IP rather than a bare hostname (§4's own note), so this is not believed to cost real
coverage today — stated as a real gap in the heuristic, not quietly treated as a complete one.

This tier has nothing to do until some future change gives the fleet real function-calling — its value is
closing the gap *before* that happens, not patching anything live today.

---

## 8. Deny → report → alert → record — mapped to what already exists

The request's four required actions, each mapped to a real mechanism already live in the fleet rather than
a new channel invented from scratch:

1. **Deny.** `check_destination()` raises; every wrapped caller treats this as a hard failure — explicitly
   never a silent fallback to making the request anyway. `[DECIDED]`, executed Phase B: implemented
   directly inside `check_destination()` itself (every deny path runs the report pipeline below before it
   raises), so a wrapped call site gets §8's whole pipeline for free — nothing to review or add per call
   site, which turned out simpler than the per-site review this bullet originally expected.
2. **Matrix report.** Reuse `hermes_alert_common.matrix_notice()` — the fleet's one existing
   direct-to-Matrix-room pattern that bypasses `hermes-presenter.py`'s normal reply path, already used by
   `hermes-router.py` for guard block/unreachable alerts. `[DECIDED]`, executed Phase B.
   **Correction to this bullet's original "three duplicate implementations" claim:** neither
   `hermes-fleet-health.py` nor `hermes-model-scout.py` turned out to have their own `matrix_notice()` (a
   full `def matrix_notice(` sweep found 11 real independent implementations fleet-wide, not 3, and neither
   named file is among them). The real, in-scope duplicate — the one Phase A's own wrapping had already
   touched — was `hermes-linodemercury-watch.py`'s; it's now consolidated onto `hermes_alert_common.py`,
   also gaining `MATRIX_HOMESERVER` configurability its own hardcoded `127.0.0.1:6167` never had. The
   other ~10 fleet-wide `matrix_notice()` duplicates are an explicit, separate, out-of-scope finding (same
   shape as §3's external-destination survey) — Phase B does not touch them.
3. **Hi-pri email.** `hermes_alert_common.send_email()` has no priority concept today — every call goes to
   the same recipient at the same urgency. `[DECIDED]`, executed Phase B: `send_email()` gained a
   `priority="critical"` kwarg that prefixes the subject and sets an `Importance: high`/`X-Priority: 1`
   header, reusing the `[CRITICAL] ...` subject convention `hermes-node-health.py`'s own severity tagging
   already uses live, and now returns `True`/`False` (sent vs. skipped-or-failed) rather than nothing, so a
   consolidating caller's own `if send_email(...)` check keeps working. **Same correction as above
   applies**: a `smtplib` sweep found 24 independent implementations fleet-wide, not the "three" originally
   assumed. The three actually in scope — `hermes-model-scan.py`, `hermes-model-watch.py`, and
   `hermes-linodemercury-watch.py`, each already touched by Phase A's own `check_destination()` wrapping —
   are now consolidated onto this module; the other ~20 are the same kind of explicit, out-of-scope finding
   as the Matrix duplicates above.
4. **Report-page record.** Write one row via the generic `turns` table in `hermes-memory.py`, using the
   same `task_id`-sentinel convention every existing guard-verdict logger already follows (`task_id=
   "egress-block"`, `agent="egress-guard"`, `role="system"`, a JSON blob in `raw`: caller, attempted
   host/URL, reason, timestamp). `[DECIDED]`, executed Phase B (the write) and Phase C (the page). Added
   `/egress-blocks` to `hermes-fleetops-ui.py`'s `ROUTES` dict, modeled directly on `/recommendations` as
   planned.
   - **Correction: this bullet's own gate turned out moot, not satisfied by either of its two named
     options.** `/recommendations` (and `/backlog`) don't call `hermes-memory`'s HTTP API at all — they
     read its SQLite file directly via a read-only connection (`ro_sqlite()`), because that service has no
     list-by-task_id HTTP route and `/usr/bin/python3` can't load the `sqlite-vec` extension
     `hermes-memory.py`'s own `connect()` needs. S33's 500-row cap lives only in the HTTP JSON layer
     (`_list_turns()`), which `/egress-blocks` never touches, the same way `/recommendations` never did. A
     direct SQL `COUNT(*)` has no such cap, so "showing N of true-total" is exact from day one — neither
     landing a `since` filter nor building a truncation flag was needed to satisfy the real requirement
     (never silently report a count that might be cut off). **S33 itself remains open** — this finding
     resolves Phase C's own gate, not S33 as a stage; `hermes-guard-report.py` still calls the capped HTTP
     endpoint and would still benefit from S33's fix.

---

## 9. What this does and doesn't protect against, stated plainly

On the day Tier A first deploys, it has nothing live to block (§3) — every real egress point already
targets a fixed, hardcoded destination. Its value is twofold, and both halves should be stated honestly
rather than oversold:

- It **hardens the five real existing external call sites** against a *future* bug that makes their
  destination attacker-influenced — the same class of near-miss `hermes-render-worker.py` 1.2.0 already
  found and fixed once for a *payload* field (`resolution`/`frames`/`engine` spliced unvalidated into a
  JSON workflow). This proposal applies the identical discipline one level up, to the *destination* rather
  than the payload.
- It **closes the gap before it exists**, for whenever the fleet's architecture changes to actually give a
  model a real tool-calling surface — a plausible trigger being S37's own harness-ablation work, which is
  already asking whether tools/skills meaningfully change agent behavior, or any future skill that isn't
  built on `skills.js`'s deliberately data-only pattern.

It does **not** retroactively prove any past request was safe, and it does not replace Layer 1/2's job of
screening what reaches a model in the first place — it is a new, independent layer, not a stronger version
of the existing ones.

---

## 10. Rollout phasing

- **Phase A — registry + shared guard module + wrap existing real egress points. Executed 2026-10-18.**
  Built `infra/firmament-tool-registry.yaml` (§6, deliberately not real YAML — see that file's own header
  for why, same precedent as `feeds.yaml`/`topics.yaml`) and `tools/hermes_egress_guard.py` (§7, Tier A,
  with offline unit tests at `infra/hermes-egress-guard/tests/test_egress_guard.py`); wrapped the five real
  call sites from §5 plus the two §3-revision-note additions found in `hermes-model-watch.py` while
  wrapping it. Pure hardening — nothing denies today; every wrapped destination is on its caller's own
  registry entry or resolves internal. The wider external-destination surface named in §3's revision note
  (Vivint, Generac, Wyze, podcast/RSS feeds, botnet-intel lists, etc.) is explicitly NOT wrapped by this
  phase.
- **Phase B — the deny→Matrix→email→record pipeline (§8). Executed 2026-10-18, except the report-page
  record's `hermes-memory` write.** `check_destination()` now runs the whole report pipeline (Matrix +
  hi-pri email) itself before it ever raises, guarded against the one real recursion risk this creates (a
  registry-load failure denies the hi-pri email's own destination too — see `hermes_egress_guard.py`'s
  `_report_denial()` docstring for the single in-flight flag that stops it looping). `send_email()` gained
  the `priority="critical"` kwarg (§8.3) and now returns `True`/`False`. Consolidated the three real
  duplicate implementations Phase A's own wrapping had already touched (`hermes-model-scan.py`,
  `hermes-model-watch.py`, `hermes-linodemercury-watch.py`'s `send_email`s, plus
  `hermes-linodemercury-watch.py`'s own `matrix_notice`) onto `hermes_alert_common.py` — not
  `hermes-fleet-health.py`/`hermes-model-scout.py` as §8.2 originally named; see that section's own
  correction note for why, and for the much larger fleet-wide duplication this phase found and
  deliberately left alone (24 independent `smtplib` users, 11 independent `matrix_notice()`s). The
  `hermes-memory` `turns`-table write (`_record_denial()`) is implemented and unit-tested but unverified
  against a live `hermes-memory` instance — no fleet node was reached this session.
- **Phase C — the `hermes-fleetops-ui` report page. Executed 2026-10-18.** Added `/egress-blocks`,
  modeled on `/recommendations`. Its own planned gate (land `/turns`' `since` filter, or build an
  explicit truncation flag) turned out moot — see §8.4's correction note — because this page reads
  `hermes-memory`'s SQLite file directly, the same way `/recommendations`/`/backlog` already do, and
  never touches the HTTP API S33's cap lives in. S33 itself is still open.
- **Phase D — the router-level structural tripwire (§7, Tier B). Executed 2026-10-18.** Gated the new
  buffered/validated response path on `tools`/`functions` being present in the request, so today's real
  traffic (none of which sets either) takes the exact unchanged live-streaming path — see §7 Tier B's own
  revision note for why a passive always-on scan was rejected instead. Verified live, not assumed: every
  real invocation denies today, because no registry row lists a function name as its own allowed caller
  yet (`infra/hermes-router/tests/test_tier_b.py`, 12 checks).

`[RISK]`: whether to also add outbound ufw/firewall rules as network-layer
defense-in-depth alongside this application-layer guard — no egress-firewall precedent exists in this
fleet today (every existing ufw rule found is inbound), so this would be new infrastructure on top of new
infrastructure; `[PROPOSED]` to treat it as optional, a Phase E, independent of whether Phases A-D ship.

---

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-18 | Initial proposal: audited Layer 1/2's actual scope (input-only, no post-generation hook anywhere) and every real network-call site in the codebase, found that no production path today lets a model's output pick a network destination, anchored "internal" to the fleet's actual documented ranges (`10.129.1.0/24` + two `/30` links + tailnet `100.64.0.0/10`) rather than a blanket `/8`, named the five real external exceptions that must survive the check (Tavily, HuggingFace Hub, LinodeMercury, SMTP relay, Matrix homeserver pending confirmation), proposed the missing tool-call registry, and designed a two-tier guard (egress-destination wrapper now; a router-level structural tripwire for whenever real tool-calling arrives) with the deny/Matrix/email/report pipeline mapped onto mechanisms that already exist in the fleet rather than new ones. |
| 1.1.0 | 2026-10-18 | **Phase A executed**, resolving both of S40a's open gates: adopted §4's own narrower internal-range recommendation as `[DECIDED]` (four ranges + always-internal loopback; full `10.0.0.0/8` is an explicit opt-in, never the default), and confirmed the Matrix homeserver is control-plane-internal, not a §5 external exception, by reading `infra/continuwuity`'s own config/README. Built `tools/hermes_egress_guard.py`, `infra/firmament-tool-registry.yaml`, and offline unit tests; wrapped `hermes-websearch.py`, `hermes-model-scout.py`, `hermes-model-scan.py`, `hermes-model-watch.py`, `hermes-linodemercury-watch.py`, and `hermes_alert_common.py`. Found and recorded a real gap in §3's own audit table while doing it: `hermes-model-watch.py` also reaches `raw.githubusercontent.com`/`api.github.com`, neither previously named — both are now wrapped and registered. Also surveyed the wider fleet and found roughly ten more scripts with their own real external destinations that §3's original audit never claimed to cover and this phase deliberately does not wrap (§3's revision note) — an explicit scope boundary, not an oversight repeated twice. |
| 1.2.0 | 2026-10-18 | **Phase B executed** (§8, §10), except the report-page record's live verification. `check_destination()` now runs the Matrix+email report pipeline itself on every deny path, with a single in-flight recursion guard for the one real loop this creates (a registry-load failure denies the hi-pri email's own destination too). `hermes_alert_common.send_email()` gained `priority="critical"` (subject prefix + `Importance`/`X-Priority` headers) and now returns `True`/`False`. Corrected §8.2's "three duplicate implementations" claim after actually counting: a fleet-wide sweep found 24 independent `smtplib` users and 11 independent `matrix_notice()`s, not 3, and neither `hermes-fleet-health.py` nor `hermes-model-scout.py` (the two §8.2 originally named) turned out to have its own — the three real, in-scope duplicates were the ones Phase A's own wrapping had already touched (`hermes-model-scan.py`, `hermes-model-watch.py`, `hermes-linodemercury-watch.py`'s `send_email`s, plus that last file's own `matrix_notice`), now consolidated onto `hermes_alert_common.py`. The other ~20/~10 duplicates are recorded as an explicit, separate, out-of-scope finding, same shape as 1.1.0's external-destination survey. Extended the offline test suite (33 → 43 checks) to cover the report pipeline, the recursion guard, and the new `send_email()` behavior; the `hermes-memory` write itself (`_record_denial()`) is unit-tested but not exercised against a live `hermes-memory` instance. |
| 1.3.0 | 2026-10-18 | **Phase C executed** (§8.4, §10). Added `/egress-blocks` to `hermes-fleetops-ui.py`, modeled on `/recommendations` as planned. Correction: §8.4's own planned gate (land `hermes-memory`'s `/turns` `since` filter, or build a truncation flag, before this page could be trusted) turned out moot, not satisfied by either option — `/recommendations` and `/backlog` never call the capped HTTP API at all, they read `hermes-memory`'s SQLite file directly via a read-only connection, and `/egress-blocks` does the same. S33's 500-row cap lives only in the HTTP JSON layer, so a direct SQL `COUNT(*)` gives an exact total with no prerequisite stage needed. S33 itself remains open as its own stage — `hermes-guard-report.py` still calls the capped endpoint and would still benefit from that fix; this finding only closes Phase C's own gate, not S33. Extended the offline test suite (`infra/hermes-fleetops-ui/tests/test_fleetops_ui.py`, 226 → 234 checks) covering ordering, an honest true-total, escaping, and a malformed/empty `raw` row degrading instead of crashing the page. |
| 1.4.0 | 2026-10-18 | **Phase D executed** (§7 Tier B, §10) — all four phases now done. Found while building it that the router's own live chunk-by-chunk relay makes a passive post-hoc scan unable to actually "strip the tool call... fail closed" as originally written, since bytes are already gone by the time a full response exists to scan — fixed by gating a buffered/validate-then-relay path on `tools`/`functions` being present in the *request*, not by scanning every response; real traffic (which never sets either) takes the exact unchanged streaming path, paying nothing for a condition that cannot occur today. Added `hermes-router.py`'s `extract_tool_calls()` (plain JSON and OpenAI's own SSE delta-accumulation shape, reconstructed by index) and `check_tool_calls()`, plus `hermes_egress_guard.py`'s `check_tool_call()`/`is_registered_function()`/`report_denial()`. Verified live, not assumed: every real invocation denies today, because the tool's own name is the caller identity for Tier A's `check_destination()` and no registry row lists a function name among its own `allowed_callers` yet — asserted by a new offline suite (`infra/hermes-router/tests/test_tier_b.py`, 12 checks), not left as a claim. Named a real, stated limitation in the host/URL heuristic (misses a bare single-label hostname with no TLD shape) rather than silently treating it as complete. |
