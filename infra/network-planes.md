# Network plane separation — `spark` ↔ `spark-2`

**Version:** 1.2.0

HermesAgentV5's S4 and S18 (`../../HermesAgentV5/IMPLEMENTATION_PLAN.md`). Three physically separate
links exist between the Spark nodes, and they carry different kinds of traffic on purpose:

| Plane | Subnet | Interface | Carries |
|---|---|---|---|
| **Control** | `10.129.1.0/24` | GigE | Every control-plane service: router, broker, Buzz, memory, Continuwuity, model backend proxying (nano/super/coder/muse/omni), SSH for interactive/admin work |
| **Data** | `10.129.9.0/30` | `bond-fabric0` (2× ConnectX-7 `f0` ports, `balance-rr`, MTU 9000, 400 Gb/s aggregate) | **SSH only** — model weight staging, bulk memory/context pulls, fine-tune datasets. **Cannot carry RoCE** (see RDMA plane below) |
| **RDMA** | `10.129.10.0/30` | `enp1s0f1np1` (one ConnectX-7 `f1` port per node, **unbonded**, MTU 9000, 200 Gb/s) | RoCEv2 and NCCL collectives. Added S18, 2026-09-24 |

## Why this needed writing down

The split held **by accident**, not by design, until S4. Every control-plane service was reachable — and,
before this document, *actually reached* — over `bond-fabric0` as well as the GigE LAN, for a structural
reason: `llama-server` (and Continuwuity) can only bind one address per process, and several backends
(`nano`, `super`, `coder`, `muse`, `omni`) are genuinely called both from their own node via `127.0.0.1` (the
local router) *and* from the peer node / HomeD13 over the LAN. The only address that satisfies both is
`0.0.0.0` — which also happens to satisfy the fabric interface, since `bond-fabric0` had no firewall
restriction narrower than "anywhere."

**Confirmed live during S4, not assumed:** before the fix, `curl http://10.129.9.1:8088/v1/models` from
spark-2 returned `200` — spark-2 could reach spark's `nano` backend over the fast link, unauthenticated
past the network layer, with nothing distinguishing that traffic from a legitimate control-plane call.
After the fix, the same request times out; the identical call to `http://10.129.1.15:8088/v1/models` (the
LAN address every real caller already uses) is unaffected.

## The actual fix: firewall, not bind address

**Rebinding the model backends was considered and rejected.** Binding `nano` et al. to `10.129.1.15`
specifically (instead of `0.0.0.0`) would have broken spark's own router, which calls local roles via
`127.0.0.1` — a specific non-loopback bind address does not also accept loopback connections. Since
`llama-server` has no way to bind two specific addresses in one process, and rearchitecting to two
processes (`SO_REUSEPORT` or similar) for marginal gain over a firewall fix was not worth the added
complexity and risk, **the discipline is enforced at the firewall, not the application.**

Every node's `ufw` rule for `10.129.9.0/30` was narrowed from a blanket allow-anything to `22/tcp` only
(SSH — what the S1 node-to-node keys, `~/.ssh/spark2_access` / `~/.ssh/spark_access`, actually use, and
what `rsync`/`scp`-based bulk transfer rides on top of). Services that are genuinely GigE-only already
(`hermes-broker`, `hermes-buzz`, `hermes-memory` — nothing on their own node calls them via `127.0.0.1`, so
they've bound their real LAN IP explicitly since S2/S3) needed no change; they were never reachable via the
fabric interface in the first place, bind address alone already excluded it.

## Current state (verified, both directions, S4)

| From | To (fabric IP) | Result |
|---|---|---|
| spark-2 → spark | `10.129.9.1:8088` (nano) | Blocked |
| spark-2 → spark | `10.129.9.1:22` (SSH) | Allowed |
| spark → spark-2 | `10.129.9.2:8090` (muse) | Blocked |
| spark → spark-2 | `10.129.9.2:22` (SSH) | Allowed |

The LAN path (`10.129.1.15`/`10.129.1.17`) is unaffected in both directions — every existing caller
(routers, gateways, HomeD13's SWE-bench tooling) already used the LAN address, never the fabric one, so
nothing needed to change on the calling side.

## SSH aliases for the fabric (2026-09-01)

Direct request to actually set up node-to-node use of the bond, after benchmarking it for the
first time since S4 (real SSH-piped throughput: ~481 MB/s over the fabric vs. ~110 MB/s over the
regular LAN for the same transfer — a real ~4.4x speedup, both well under the 400Gb/s physical
capacity since SSH's own encryption is the bottleneck, not the link). The S1 keys
(`~/.ssh/spark2_access` on spark, `~/.ssh/spark_access` on spark-2) already existed and already
authenticate in both directions (confirmed live during S4's own verification table above) — they
just had no SSH config alias pointing at the fabric IP specifically. Added one on each node:

| Node  | Alias           | Resolves to  | Key                      |
|-------|-----------------|--------------|--------------------------|
| spark | `spark2-fabric` | `10.129.9.2` | `~/.ssh/spark2_access`   |
| spark-2 | `spark-fabric` | `10.129.9.1` | `~/.ssh/spark_access`   |

`ssh spark2-fabric` / `ssh spark-fabric` now work exactly like the existing `spark2`/`spark`
LAN-address aliases, just routed over `bond-fabric0` instead — for `scp`/`rsync`-based bulk
transfer only, per the firewall rule above (port 22 is all `10.129.9.0/30` permits). No script in
this repo uses these yet as of this writing — a real, one-time cross-node model-weight sync
(similar in shape to S1's own ~46.6GB `muse`+`omni` migration) is the clearest candidate for
actually needing this; day-to-day cross-node calls in this codebase are small config/state files
or plain HTTP API calls, neither of which benefit meaningfully from the fabric's throughput
advantage over its own connection/negotiation overhead.

## The RDMA plane (S18, 2026-09-24) — and why RoCE cannot ride the bond

`bond-fabric0` carries TCP beautifully (~117 Gbit/s measured) but **cannot carry RoCE at all.**
Enslaving both ConnectX-7 `f0` ports overwrites their distinct permanent MACs with the bond's, so
both RDMA devices derive one GID and advertise one IP — while `balance-rr` puts every other packet
of a queue pair onto the *other* card's wire, where no matching QP context exists to acknowledge it.
RDMA has no equivalent of the netdev-layer reassembly that lets TCP tolerate this. The observable
result was total failure, not degradation: `ib_write_bw` returned `status 12` with `scnt=128,
ccnt=0` — 128 writes posted, zero completed, at zero load. This is what S1 recorded from NCCL in
2026-08-29 and attributed to missing PFC/ECN; that attribution was wrong, and no lossless-fabric
work was needed to fix it.

**The fix used hardware that was already cabled and idle.** Each ConnectX-7 is dual-port and all
four ports on both nodes report `carrier=1`; only the `f0` pair was ever bonded. The `f1` pair is
now a dedicated, unbonded, point-to-point RDMA link — each port keeps its own permanent MAC and
therefore its own GID, which is exactly what the bond destroyed. **`bond-fabric0` was not modified**,
so the SSH aliases above and every existing bulk-transfer path behave identically.

| | Sustained | |
|---|---|---|
| `bond-fabric0`, RoCE | **0** | `ccnt=0` — never worked |
| `bond-fabric0`, NCCL sockets | ~2.0 GB/s | S1's baseline |
| **`10.129.10.0/30` unbonded, RoCE** | **~13.0 GB/s** | 6.5x, one of two free `f1` ports |

Persisted as a NetworkManager profile named `roce-f1` on each node (`ipv4.method manual`, MTU 9000,
`autoconnect yes`) — **not** hand-edited netplan, because these nodes render netplan *from*
NetworkManager and a hand-edit would be overwritten.

**Firewall:** one peer-scoped rule per node (`allow from 10.129.10.2` on spark, `allow from
10.129.10.1` on spark-2) rather than a port list, because NCCL's bootstrap uses dynamic ports.
Host-scoped is defensible here in a way it would not be on the LAN: this `/30` is a direct cable
between exactly these two nodes with nothing else on the segment. The `10.129.9.0/30` bond keeps its
`22/tcp`-only posture, unchanged.

**Known ceiling, recorded so nobody re-measures it by accident.** NCCL all-reduce over this plane
runs clean and genuinely uses RoCE, but reaches only ~1.4 GB/s because GPUDirect RDMA is unavailable
on GB10 (`GDR 0`, `cuMemGdrSupport 0`, `nvidia_peermem` fails to load with `EINVAL`). Collectives
stage GPU → host → NIC. **This plane is therefore excellent for host-memory bulk transfer and
currently unsuitable for tensor-parallel inference** — see `IMPLEMENTATION_PLAN.md` S18.

## Extending this later

If a future stage needs the fabric for something beyond SSH-based transfer (S12's merged-mode NCCL is the
one already flagged — NCCL's own port range, not SSH), **add an explicit, narrowly-scoped `ufw` rule for
that port when it's actually built and needed**, the same way this document's SSH rule was added — not by
reverting to a blanket allow. The whole point of this stage was making an accidental convenience into a
deliberate, auditable exception list.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-29 | Initial version — S4 executed: narrowed both nodes' `10.129.9.0/30` ufw rule from blanket-allow to `22/tcp` only, confirmed the prior cross-plane exposure live before fixing it, verified the fix both directions plus SSH continuity, documented why bind-address changes were rejected in favor of a firewall fix. |
| 1.1.0 | 2026-09-01 | Direct request: benchmarked the fabric for the first time since S4 (real ~4.4x SSH-throughput speedup over the LAN) and added `spark2-fabric`/`spark-fabric` SSH config aliases on each node so the already-existing, already-working S1 keys can actually be used over `bond-fabric0` without remembering the raw `10.129.9.x` addresses. No script uses them yet. |
| 1.2.0 | 2026-09-24 | S18: new **RDMA plane** (`10.129.10.0/30`, the previously unused unbonded ConnectX-7 `f1` port on each node, MTU 9000). Documents why RoCE cannot ride `bond-fabric0` at all — bond enslavement collapses both ports' MACs/GIDs into one while `balance-rr` sprays a queue pair across both wires, giving `ccnt=0` (zero completions at zero load), which is what S1 saw from NCCL in 2026-08-29 and misattributed to missing PFC/ECN. Fixed with hardware already cabled and idle; `bond-fabric0` untouched, so every existing SSH/rsync path is unaffected. RoCE went 0 → ~13.0 GB/s, persisted as a NetworkManager `roce-f1` profile (not hand-edited netplan — these nodes render netplan from NM). One peer-scoped ufw rule per node rather than a port list, since NCCL bootstrap uses dynamic ports and this `/30` is a direct two-node cable. Records the known ceiling: NCCL collectives reach only ~1.4 GB/s on this plane because GPUDirect RDMA is unavailable on GB10, so it suits bulk host-memory transfer but not tensor-parallel inference. |
