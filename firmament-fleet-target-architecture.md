# Firmament Fleet — Target Architecture Specification

**Purpose of this document:** This is a *target state* specification, derived
from a design conversation. It has **not** been checked against the running
implementation. A reviewing model should treat every section as a proposal to
be diffed against reality, not as a description of what exists.

**How to use this document:**
1. Read §1 (Ground Truth) to understand what is asserted vs. assumed.
2. For each numbered section, establish current state, then record the delta.
3. Use §12 (Gap Analysis Template) to structure findings.
4. Use §13 (Migration Sequencing) as a starting order, not a fixed plan.

**Status legend used throughout:**
- `[DECIDED]` — user made an explicit choice
- `[PROPOSED]` — design recommendation, not yet ratified
- `[UNKNOWN]` — needs discovery against the live system
- `[RISK]` — flagged concern requiring validation

---

## 1. Ground Truth vs. Assumption

### 1.1 Asserted by the operator (treat as fact)

| Item | Value |
|---|---|
| Fleet name | Firmament |
| Compute | 2× NVIDIA DGX Spark (GB10 Grace Blackwell, 128 GB unified each) |
| Third node | Dedicated ComfyUI endpoint, NVIDIA GPU (RTX 3060 **or** 5090 — not confirmed which) |
| Agent↔agent transport | "Buzz" — currently **targeted addressing** |
| Fleet↔user transport | Matrix |
| Interconnect | Gigabit LAN **and** dedicated 200/400 Gbps link |
| Agent topology | Specialized (not identical) agents per node |
| Empirical finding | MoE models test better than dense for responsiveness on this hardware |
| Requirement | Memory continuity across the fleet |
| Preference | Abliterated models preferred |
| Dispatcher failover | Desirable, **not** a blocker |
| Base agent framework | Nous Research Hermes |

### 1.2 Assumed by this document (verify before acting)

- Buzz is modifiable ("we can do what we want with buzz") — assumed to mean
  its transport/addressing model can be changed without a rewrite.
- No existing dispatcher/presenter split — assumed the current system routes
  by some other means.
- Matrix stack is Conduit-based with federation disabled (from prior context;
  **confirm**).
- Memory backend is currently filesystem-based (Hermes default `MEMORY.md` /
  `USER.md`) rather than a database. **This is the single most important thing
  to verify** — it determines whether §7 is a config change or a migration.
- The ComfyUI node is x86; the Sparks are ARM64. Assumed, not confirmed.

### 1.3 Explicitly unknown

- `[UNKNOWN]` Which GPU is in the ComfyUI node
- `[UNKNOWN]` What Buzz is built on (MQTT / NATS / Redis / custom)
- `[UNKNOWN]` How many agents currently exist and what they do
- `[UNKNOWN]` Current model set and quantization per role
- `[UNKNOWN]` Whether the 200G link is cabled and validated
- `[UNKNOWN]` Whether RDMA is currently functional
- `[UNKNOWN]` Current Matrix bot account topology (one account or many)

---

## 2. Hardware Topology

### 2.1 Node roles `[DECIDED: separate, not merged]`

Three nodes, asymmetric, **not** a merged/pooled cluster by default.

```
┌─────────────────┐   200/400G DAC    ┌─────────────────┐
│  Node A "Watch" │═══════════════════│  Node B "Forge" │
│  DGX Spark      │   (data plane)    │  DGX Spark      │
│  128 GB unified │                   │  128 GB unified │
└────────┬────────┘                   └────────┬────────┘
         │                                     │
         └──────────── Gigabit LAN ────────────┘
                    (control plane)
                            │
                   ┌────────┴────────┐
                   │  Node C "Kiln"  │
                   │  ComfyUI (x86)  │
                   │  Tooling only   │
                   └─────────────────┘
```

### 2.2 Rationale for separate over merged `[DECIDED]`

The 200 Gbps ConnectX-7 link does not deliver 200 Gbps in practice:

- Both physical ports share two PCIe Gen5 x4 lanes
- Measured TCP throughput lands near ~100 Gbps single cable
- Two cables reach ~208 Gbps / ~252 Gbps theoretical before PCIe saturates
- Local unified memory bandwidth is ~273 GB/s per node

**Therefore the interconnect is roughly 10–20× slower than local memory.**
Tensor-parallel inference across the link destroys exactly the bandwidth
advantage that makes MoE models responsive. Generation speed ≈ memory
bandwidth ÷ active parameter bytes; splitting the model across the cable
converts a local-memory problem into a network problem.

**Worked example (validate against real measurement):**
- 3B active @ Q8 ≈ 3 GB/token-pass → ~90 tok/s theoretical local
- 35B active @ FP4 ≈ 17 GB/token-pass → ~15 tok/s theoretical local
- Same models tensor-parallel across the link: order-of-magnitude worse

This directly explains the operator's empirical MoE finding and is the load-
bearing argument for the whole architecture. **If the reviewing model finds the
existing implementation uses merged/tensor-parallel serving as its default,
that is the highest-priority finding in this document.**

### 2.3 Merged mode `[PROPOSED]` — exception path only

Justified only for:
1. Models that cannot fit 128 GB (e.g. MiniMax M3 428B @ NVFP4 ≈ 215 GB)
2. Fine-tuning runs requiring pooled memory

Implementation: vLLM + Ray, `tensor_parallel_size=2`, NCCL over the 200G link.

`[RISK]` NCCL on this hardware has been reported falling back to socket
transport rather than RDMA, with all-reduce bus bandwidth around 2 GB/s.
GPU Direct RDMA on ARM64 has been an open issue. **Validate RDMA actually
engages before planning any latency-sensitive work around merged mode.**

Operational contract for entering merged mode:
- Drain and pause Node B agents
- Post fleet-status notice to Matrix
- Node A remains fully operational throughout (not part of the pool)
- Explicit exit procedure restoring Node B residency

### 2.4 Cabling `[PROPOSED]`

- One 0.5 m QSFP112 400G passive DAC, port 0 to port 0
- NVIDIA Spark Stacking spec: Amphenol NJAAKK0006 / Luxshare LMTQF022-SD-R
- Second cable optional: buys ~52 Gbit/s before PCIe becomes the bottleneck.
  Worth it only if merged mode is frequent.
- Node C stays **off** the ConnectX-7 topology — GigE only

---

## 3. Network Plane Separation `[PROPOSED]`

**This is a hard split, not a preference.**

| Plane | Physical | Carries |
|---|---|---|
| Control | Gigabit LAN | Buzz dispatch, Matrix, SSH, health checks, monitoring, ComfyUI API |
| Data | 200/400G link | Model weight staging, bulk context/memory pulls, merged-mode NCCL, fine-tune datasets |

**Failure mode this prevents:** a 60 GB weight transfer on the fast link
stalling dispatcher messages queued behind it. If Buzz currently runs over the
fast link, moving it is a low-cost, high-value change.

`[UNKNOWN]` Which interface does Buzz currently bind to?

---

## 4. Model Allocation

### 4.1 Node A — "Watch" (always-resident, latency-critical)

Nothing on this node swaps. It is the node that must never stall.

| Role | Model | ~Footprint | Notes |
|---|---|---|---|
| Dispatcher | Qwen3.6-35B-A3B (Q8) | ~35 GB | 35B total / 3B active, 256 experts (8 routed + 1 shared) |
| Presenter | small instruct model | ~8–15 GB | See §6 |
| Embeddings + reranker | Qwen3-Embedding class | ~6 GB | |
| Screener | small classifier | ~8 GB | See §8 |
| Transcription | Whisper-large class | ~3 GB | |
| Log analysis | shares dispatcher model, long-context config | — | Or dedicated; see §4.3 |
| KV cache + headroom | | ~40 GB | |

The 3B active parameter count is *why* Qwen3.6-35B-A3B is the dispatcher pick.
Routing latency needs to disappear into the noise.

### 4.2 Node B — "Forge" (swappable, throughput-tolerant)

With image generation moved to Node C, ~24 GB is freed. This is enough to keep
the coding model **and** the vision evaluator resident simultaneously rather
than thrashing.

| Role | Model | ~Footprint |
|---|---|---|
| Coding / skill improvement | Mistral Small 4 (119B-A6.5B) @ NVFP4 | ~60 GB |
| Image + video evaluation | Step 3.7 Flash or Gemma 4 31B | ~20–35 GB |
| Abliterated variant hold | second copy of analyst model @ NVFP4 | ~40–60 GB |
| Fine-tuning | (takes whole node when active) | — |

Mistral Small 4: 119B MoE activating 6.5B/token; instruction following,
reasoning, vision, and agentic coding in one model at small-model speed. Full
FP8 needs ~111 GB — too tight to share a node — hence NVFP4.

### 4.3 Models explicitly rejected

| Model | Why not |
|---|---|
| GLM-5.2 (753B) | ~376 GB @ FP4 — doesn't fit even pooled |
| Kimi K3 (2.8T) | Not remotely close |
| Qwen3-Coder-480B-A35B | Fits pooled @ FP4 (~240 GB) but 35B active is slow *and* forces permanent merged mode |

`[UNKNOWN]` What is currently loaded, at what quantization, on which node?
This table exists so the reviewer can identify whether the current
implementation has already made a rejected choice.

### 4.4 Residency management `[PROPOSED]`

Node A: static residency, no controller needed.
Node B: residency controller required. Must know:
- Which checkpoint version is current per role (from model registry, §7)
- Which models are co-resident-compatible
- How to drain for merged mode / fine-tuning

---

## 5. Agent Topology & Personas

### 5.1 Internal personas (Buzz-side): ~6–8

| Agent | Node | Thin or full? |
|---|---|---|
| Dispatcher | A | Full — owns routing |
| Retriever | A | Full — docs/pages, owns embed+rerank |
| Screener | A | Full — see §8 |
| Log analyst | A | Full |
| Transcriber | A | Thin — near tool-wrapper |
| Coder / skill-improver | B | Full |
| Vision evaluator | B | Full |
| Media agent | B | Full — owns Node C endpoint, §9 |
| Trainer | B | Full, intermittent |

**Test for whether something deserves persona status:** does it need its own
system prompt and reasoning, or is it just an endpoint? Thin ones can collapse
into their caller.

`[UNKNOWN]` Current agent inventory. Expect the delta here to be substantial.

### 5.2 Visible personas (Matrix-side): 1 `[PROPOSED]`

**One fleet voice by default.** Rationale:

- Preserves the Buzz/Matrix split. Multiple Matrix presences push routing back
  onto the user.
- N bots = N credential sets, N device verifications, N read-receipt sources.
- Handoffs stay invisible. A single voice just answers; multi-persona produces
  a visible relay.

Where multiple visible identities *do* earn their place:
- **Per-room, not per-agent** — `#fleet-ops`, `#build`, `#alerts`. Same bot
  account, different rooms. Context separation without persona sprawl.
- **Scheduled reporter** — periodic email/report output is push, not reply.
  A distinct sender is appropriate.
- **Debug mode** — toggle to annotate replies with handling agent
  (`[coder→retriever]`). Essential for chasing misroutes, noise otherwise.

`[UNKNOWN]` Current Matrix account topology.

---

## 6. Presenter / Dispatcher Split `[PROPOSED]`

The Matrix connection is owned by a **thin presenter**, not the dispatcher.

### 6.1 Why

- Keeps the latency-critical router out of response formatting
- Personality becomes a config file, not baked into N agents' prompts
- Failover story improves: presenter can post "fleet degraded, dispatcher
  restarting" when the router itself is what died
- Voice can be swapped (e.g. terse mode at 3am during an incident) without
  redeploying anything that affects routing

### 6.2 The insulation contract — **stylist outbound, dumb pipe inbound**

The separation only holds if the presenter touches outbound text only. Four
documented leak paths:

1. **Inbound normalization.** Presenter receives user messages first. It must
   pass raw text verbatim to the dispatcher. Any paraphrase puts persona
   framing into the routing decision.
2. **Conversation history.** If the dispatcher routes using prior-turn
   context, it must read *raw* agent output, not presented output. Store both
   channels in shared memory, linked by task ID.
3. **Clarifying questions.** A question asked in-character returns an answer
   shaped by that framing — and that answer is routing input. Either route
   clarifications through the dispatcher, or use a deliberately flat voice for
   those turns.
4. **Fidelity drift.** A confident persona smooths "the coder agent errored
   out" into something that reads fine. This is the silent one.

**Hard contract:** the presenter may restyle, compress, and add voice. It may
**not** omit failures, invent certainty, or resolve ambiguity the underlying
agent left open. Failures escalate verbatim.

### 6.3 Cost control

Every response costs an extra model pass. `[PROPOSED]` passthrough-by-default:
technical output (log dumps, stack traces, structured data) goes out unstyled;
only chat-shaped replies get the voice. Small models doing personality *plus*
faithful technical summarization is exactly where distortion appears.

---

## 7. Memory Continuity `[DECIDED as requirement]`

### 7.1 Placement

Host on **Node A** — the always-on node.

### 7.2 Substrate `[PROPOSED]`

- **Postgres + pgvector** as the durable store: conversation history, agent
  state, retrieval index, model registry, screening decisions
- Honcho on top if ambient/user-modeling is wanted; Mem0 for simpler recall
  primitives. Either way pgvector underneath avoids lock-in.
- Both Spark nodes read/write the same store. Small queries over GigE, bulk
  context pulls over the 200G link.
- Scheduled disk snapshots. Models are re-downloadable; accumulated fleet
  state is not.

### 7.3 The critical invariant

**Buzz messages carry pointers, not payloads.** Task ID + memory reference.
The receiving agent hydrates its own context. This is what makes handoffs
survive a node restart, and it is what keeps the fast link from being
saturated by control traffic.

`[UNKNOWN]` **Highest-priority discovery item.** If memory is currently
per-node filesystem (`MEMORY.md` / `USER.md` per Hermes default), cross-node
handoffs are silently losing context today, and this becomes the first
migration step rather than a later one.

### 7.4 Dual-channel storage requirement

Per §6.2, store raw agent output and presented output separately, linked by
task ID. Dispatcher reads raw; Matrix shows presented.

---

## 8. Screening / Attack-Method Evaluation

### 8.1 Pipeline order `[PROPOSED]`

1. **Deterministic checks first** — file type / magic-byte validation, size
   limits, archive-bomb detection, URL/domain allowlists. Cheap, catches most.
2. **Classifier model second** — prompt-injection patterns in retrieved
   documents and pasted context.
3. **Log every decision** to the shared store. Also becomes training data if
   the classifier is later tuned on real traffic.

### 8.2 Placement invariant

**Screening happens before content reaches the dispatcher, not after.**
If injected instructions land in dispatcher context, they can influence
routing itself — the highest-leverage compromise available in this
architecture.

`[UNKNOWN]` Where does screening sit in the current pipeline? If it is
downstream of routing, this is a security finding, not a design preference.

### 8.3 Scope

Applies to: uploaded files, retrieved web pages/documents, pasted context,
**and images returned from Node C** (§9.3).

---

## 9. Node C — ComfyUI Tooling Endpoint

### 9.1 Classification `[DECIDED]`

Node C is a **tooling endpoint, not an agent.** It returns a requested image.
It has no persona, no Buzz identity of its own, no Matrix presence.

### 9.2 Ownership `[PROPOSED]`

A thin **media agent on Node B** owns the endpoint. It:
- Builds the ComfyUI workflow graph from templates
- Submits, polls, retrieves
- Can loop with the co-resident vision evaluator: generate → evaluate →
  regenerate

Rejected alternatives: dispatcher calls directly (turns the router into a
workflow author and blocks it on slow external calls); presenter handles it
(presenter stays a stylist).

### 9.3 Trust boundary `[RISK]`

Node C is a third machine with a permissive attack surface — ComfyUI custom
nodes execute arbitrary Python and its API is typically unauthenticated by
default.

Required controls:
- Isolated VLAN, reachable only from Node B
- No outbound internet except for deliberate model pulls
- **Returned images pass through the §8 screener.** A rendered image is a file
  arriving from a machine running third-party node code. No exception.
- **Workflow JSON is injectable.** If any part of a graph is built from user
  text or retrieved document content, that is a prompt-injection route into a
  code-executing service. Assemble from templates with parameterized slots;
  never pass through a user-supplied graph.

### 9.4 Async contract

Image generation is seconds to minutes. The media agent must **ack the task
immediately and post completion separately**, not hold a Buzz claim open.
Otherwise a long render is indistinguishable from a dead agent to health
checks.

### 9.5 GPU-dependent capability `[UNKNOWN — resolve first]`

**RTX 3060 (12 GB, Ampere):**
- SDXL: 6–8 GB basic, 10–12 GB with ControlNet — at the ceiling
- FLUX.1 dev: 10–12 GB minimum, 24 GB recommended — runs slowly, quantized
- Better fit: FLUX.2 klein (4B, Apache 2.0, ~13 GB, 4-step, sub-second on
  3090/4070-class) or Z-Image Turbo (6B)
- **No video generation.** One model resident; cold-swap between checkpoints.
  ControlNet/LoRA stacking is the OOM risk.
- Media agent should queue serially; expect tens of seconds per image

**RTX 5090 (32 GB, Blackwell):**
- FLUX.1 dev at full precision with room to spare; multiple checkpoints
  resident; video generation viable
- Native FP4/FP8 — same generation as GB10
- Current candidates: Krea 2 (photorealism/speed), Ideogram 4.0 (in-image
  text/typography), FLUX.2 and Qwen-Image 2.0 (multi-reference consistency)
- `[RISK]` Check licenses on Krea 2 and Ideogram 4.0 — both have terms that
  constrain use
- The generate → evaluate → regenerate loop becomes practical here

### 9.6 Architecture portability `[RISK]`

Sparks are ARM64 (Grace); Node C is x86. Container images, compiled CUDA
extensions, and custom-node wheels are **not portable between them**.
Maintain separate build pipelines. Do not assume a working environment on one
transfers to the other.

---

## 10. Buzz Transport `[PROPOSED — currently targeted]`

### 10.1 Target model

Move from targeted addressing to **topic-based pub/sub with claim-based
handoff.**

- **Topics per specialization, not per agent instance** — `code`, `research`,
  `network-ops`, `media`, not `agent-b`. Dispatcher publishes to a topic.
  Lets you add/remove/relocate specialists without touching dispatcher logic.
- **Claim-based handoff** — the agent watching a topic picks up and acks.
  Gives the dispatcher confirmation the handoff landed, and prevents double-
  processing if two agents ever share a specialization.
- **Task envelope** — task ID + routing topic + memory pointer. Never inline
  context. (Ties to §7.3.)
- **Results path back through the dispatcher** — specialists publish
  completion to a `results` topic rather than replying to Matrix directly.
  Keeps one place that knows what is in flight; a replacement dispatcher can
  resync fleet state by listening.

### 10.2 Why this ordering matters

Targeted addressing couples the dispatcher to a static endpoint list, which
directly fights the dynamic-dispatcher design. It also blocks the cheap
failover path in §11.

`[UNKNOWN]` What Buzz is built on determines whether this is a config change
(NATS/MQTT/Redis already have these primitives) or new development.

---

## 11. Failover `[DECIDED: desirable, not a blocker]`

### 11.1 Accepted current state

Dispatcher runs as a single process on Node A. If Node A goes down, routing
stops until it returns. This is acceptable.

### 11.2 Cheap escalation path, in order of effort

1. systemd auto-restart (handles crashes, not node loss)
2. Idle standby dispatcher on Node B, activating on heartbeat loss —
   active/passive, no consensus needed for a 2-node fleet
3. Dispatcher designed as *just another Buzz subscriber* rather than a
   privileged service, so any node can spin up a replacement that resyncs from
   the `results` topic (§10.1)

### 11.3 Design-now, implement-later

Option 3 costs almost nothing **if designed in from the start** and is
expensive to retrofit. The relevant constraint: dispatcher must not hold
routing state that exists nowhere else.

---

## 12. Abliterated Models `[DECIDED as preference — scoped here]`

### 12.1 Scope by role, not fleet-wide

| Role | Recommendation | Reason |
|---|---|---|
| Log analyst | Abliterated | Refusals on payload/exploit analysis break automated pipelines and create silent coverage gaps |
| Attack-method evaluation | Abliterated | Same — defensive security is the canonical false-refusal case |
| Coder | Either — test | Capability tax may outweigh benefit |
| Vision evaluator | Either — test | |
| **Screener** | **Stock** | Its job is receiving adversarial input and not complying. Removing refusal disposition from the component whose function is refusal-under-pressure works against the design; measurably more likely to follow injected instructions |
| **Dispatcher** | **Stock** | Reads user text and decides routing. Injectable routing is the highest-leverage compromise in this architecture |
| Presenter | Stock | Outbound only; no benefit |

**Control plane stays stock. Analyst roles may be abliterated.** The Buzz
topic split (§10) provides the seam to do this cleanly.

### 12.2 Capability tax `[RISK]`

Abliteration is blunt — it degrades general capability, not just refusals.
Instruction-following, long-context coherence, and structured-output
reliability all take a hit, non-uniformly across tasks. For any agent
producing JSON the dispatcher parses, this matters more than refusal
reduction.

**Required mitigation:** a per-role eval set of 50–100 real tasks with
known-good outputs, run stock vs. abliterated head-to-head before promoting a
checkpoint. Store results in the model registry alongside the checkpoint.
Without this, degradation appears as intermittent weirdness rather than
obvious failure.

### 12.3 MoE-specific caveat `[RISK]`

Abliteration on MoE is less reliable than on dense models — refusal behavior
is not cleanly localized when routing sends different tokens to different
experts. Expect: more variable results, sometimes partial abliteration,
sometimes disproportionate capability loss, and availability lagging mainline
releases. Since the entire responsiveness argument rests on MoE, budget more
validation time here than a dense-model plan would.

### 12.4 Supply chain `[RISK]`

Community checkpoints mean loading third-party weights into a fleet with a
security function. Weights are opaque — a checkpoint cannot be audited the way
code can, and a maliciously tuned model is a real supply-chain vector.

If using community checkpoints:
- Pin to specific revision hashes, never a floating branch
- Verify checksums; prefer publishers with a track record
- Run on Node B, never as always-resident Node A control plane
- Treat their output as untrusted input to other agents — same screening path

Self-produced abliteration on Node B avoids the trust problem entirely at the
cost of compute and tuning effort. Given fine-tuning capacity is already
planned, this is likely the better path for anything load-bearing.

### 12.5 Resource impact

Hold **both variants** for roles where abliterated is preferred — stock as
fallback when the abliterated model produces garbage on structured-output
tasks. ~40–60 GB extra on Node B at NVFP4. Affordable now that image
generation moved to Node C.

---

## 13. Gap Analysis Template

For each section above, the reviewing model should produce:

```
### §N — <Section name>
**Current state:**  <what the implementation actually does>
**Target state:**   <from this document>
**Delta:**          <specific difference>
**Classification:** [no-change | config | refactor | rebuild | security-finding]
**Blocking:**       <what must change first>
**Effort:**         [trivial | hours | days | weeks]
**Risk if skipped:** <consequence of leaving as-is>
```

### 13.1 Discovery checklist — run before any planning

- [ ] Is serving currently merged/tensor-parallel or per-node? (§2.2 — highest priority)
- [ ] Is memory per-node filesystem or shared? (§7.3 — highest priority)
- [ ] Does screening run before or after routing? (§8.2 — security finding if after)
- [ ] What is Buzz built on? (§10.2 — determines effort class)
- [ ] Which GPU is in Node C? (§9.5 — determines capability envelope)
- [ ] Is the 200G link cabled, and does RDMA engage? (§2.3)
- [ ] Which interface does Buzz bind to? (§3)
- [ ] Current agent inventory and Matrix account topology (§5)
- [ ] Current model set, quantization, and node placement (§4.3)
- [ ] Are any abliterated checkpoints already in the control plane? (§12.1)

---

## 14. Migration Sequencing `[PROPOSED — reorder against findings]`

This order is chosen so that each step is independently valuable and does not
depend on later steps.

**Phase 0 — Discovery**
Run §13.1 in full. Do not plan past this until the two highest-priority
unknowns (§2.2, §7.3) are resolved.

**Phase 1 — Foundation (nothing clever yet)**
1. Cable and validate the 200G link — `iperf3`, then `nccl-tests`. Record what
   transport you actually get. This number constrains everything downstream.
2. Stand up the shared memory store on Node A. Migrate from per-node
   filesystem memory if applicable.
3. Enforce the plane split (§3): move Buzz to GigE if it isn't already.

*Rationale: memory continuity is the requirement that cannot be reconstructed
later, and the link measurement invalidates or confirms §2.2.*

**Phase 2 — Control plane**
4. Buzz topic migration (§10) — targeted → pub/sub with claims
5. Screener in front of the dispatcher (§8.2) — before, not after
6. Dispatcher on stock weights, reading raw context (§12.1, §6.2)

*Rationale: routing and screening are prerequisites for trusting anything
downstream. Doing the abliteration work before this means testing analyst
models against an untrustworthy router.*

**Phase 3 — Presentation**
7. Presenter split from dispatcher (§6), with the insulation contract enforced
8. Matrix consolidation to one account + room-based separation (§5.2)
9. Debug-mode attribution toggle

**Phase 4 — Node residency**
10. Node A static residency lock-in
11. Node B residency controller + model registry
12. Node C isolation (§9.3) and media agent ownership (§9.2)

**Phase 5 — Model work**
13. Per-role eval sets (§12.2) — build before promoting any abliterated checkpoint
14. Abliterated variants for analyst roles only, with stock fallback held
15. Fine-tuning pipeline

**Phase 6 — Deferred**
16. Merged mode as a documented, scriptable procedure
17. Dispatcher failover (§11.2 escalation path)

### 14.1 Ordering constraints (hard)

- Memory store (2) **before** Buzz pointer-based envelopes (4)
- Buzz topics (4) **before** any per-role model differentiation (14)
- Screener placement (5) **before** Node C integration (12)
- Eval sets (13) **before** abliterated promotion (14)
- Link measurement (1) **before** any merged-mode work (16)

---

## 15. Open Questions for the Operator

1. Which GPU is in Node C? Determines §9.5 entirely.
2. What is Buzz built on? Determines whether §10 is config or development.
3. Is memory currently shared or per-node? Determines whether §7 is Phase 1 or
   a later refinement.
4. Should the log analyst be a distinct model on Node A, or share the
   dispatcher checkpoint with a long-context config? (Affects §4.1 budget.)
5. Is periodic email reporting a distinct agent, or an orchestrator-scheduled
   task using the reporter persona from §5.2?
6. Preference on self-abliteration (§12.4) vs. community checkpoints? This is
   a build-vs-buy decision with a real security dimension.

---

## 16. Provenance

Derived from a design conversation, not from inspection of a running system.
Hardware figures, model specifications, and VRAM numbers come from published
sources current as of August 2026 and should be re-verified — the local model
landscape moves fast, and several cited models were released within the
preceding quarter.

Sections marked `[DECIDED]` reflect explicit operator choices. Sections marked
`[PROPOSED]` are design recommendations that the operator has not ratified and
that a reviewing model should feel free to challenge on contact with the real
implementation.
