# Local Minecraft agent research and Hermes evaluation

**Version:** 1.0.0

Reviewed November 11, 2026 against HermesAgentV5 `cd7ba7e`. “Local” here means the Minecraft Java server, bot harness and model inference can all run on the operator's own machines. Published demonstrations and benchmarks use different game rules and objectives.

| Project | Evidence and relevance to Hermes |
|---|---|
| [MINDcraft](https://github.com/mindcraft-bots/mindcraft) and [MineCollab](https://mindcraft-minecollab.github.io/) | Multiple Mineflayer profiles and native Ollama support. MineCollab's cooperative cooking, crafting and construction tasks illustrate how to make each player's contribution necessary. Its leaderboard does not measure Hermes's hardware or planner. |
| [Minecraft AI Agents race](https://github.com/parkershamblin/minecraft-ai-agents/blob/main/bench/results/RACE_REPORT.md) | Six local players in a 3-vs-3 race to an iron pickaxe. Gemma 4, Llama 3.1 8B and Gemma 3 12B each completed five of five runs in the same seed-pinned protocol. Completion intervals overlap. Qwen 3.5 4B and LFM 2.5 were tested under earlier protocols. Adopt reproducible fixtures, action timings and visible failures before comparing models. |
| [Minecraft Agent Swarm](https://jesseweigel.com/workshop/minecraft-agent-swarm) and [evaluation controls](https://github.com/JesseRWeigel/minecraft-agent-swarm/blob/main/docs/research/README.md) | The author reports five local-model bots and long-running telemetry. The evaluation records a 3.373-block client-predicted movement with zero server-observed movement, and separates mining a block from picking up its drop. Those controls qualify the evaluator with scripted actors. |
| [TickingCollabBench](https://www.microsoft.com/en-us/research/publication/multi-agent-framework-for-time-sensitive-complementary-collaboration-in-minecraft/) | Heterogeneous roles, partial observability and hard deadlines expose collaboration failures even when the actions themselves are available. Use a bounded task and verify the complete dependency chain. |
| [YC Labs Civ50](https://labs.ycombinator.com/projects/games/#civ50) and [DeepMind's Ender Dragon preprint](https://arxiv.org/abs/2610.22319) | Frontier-model runs. Civ50 illustrates coordination overhead at 50 agents. DeepMind demonstrates long-horizon execution with four agents, shared memory and self-written scripts. Neither run establishes performance with local weights. |

Hermes already has a persistent multi-bot runtime with local role routing, an action arbiter, bounded skills, survival reflexes, Buzz coordination and daily regression telemetry. Its deployment defines nine bot units across two hosts. A November 11 reset initially started Bob and Dale. These records describe the deployment and reset, and this review did not query live player membership.

The September planner comparison used real prompts and found faster responses from `dispatch` and higher accuracy from `coder` in the sample. That comparison does not include pathfinding, action execution, retries or simultaneous bot load. The shelter incident made the scoring gap concrete. Hundreds of successful no-op builds per bot could accrue without changing the assigned site. The `give` action has a related distinction. A successful toss establishes the count dropped. The intended recipient's server inventory establishes pickup.

Fixture review also identified a furnace bug. A multi-item smelt moved the entire input stack into the furnace, then returned after the first ingot appeared. The next action could reject the bot for having no remaining raw input in its inventory. The executor now waits for the batch, collects partial output on timeout, and stops waiting when the window closes or the action is cancelled.

The automated checks now exercise three questions:

1. Can Babs and Amy coordinate a transfer through real Buzz, and does Amy use the received iron to craft a bucket? An acknowledgement with no transfer is the negative control. The test observes the server's inventory before and after. An SSH configuration places Amy on the second host.
2. Can a standing residence goal progress at its assigned site when a different shelter is already complete? The full-bot test verifies a missing wall block at the second site through RCON.
3. Can two and six simultaneous Hermes bots finish a smelt-and-craft workload through either planner? The disposable-world suite pairs both planners on each seed and roster size. It records per-bot completion time, planner request latency and errors, and recent action outcomes. The isolated workstations limit contention over furnaces, so the comparison primarily exercises planner and host load.

Use the same server jar, Hermes revision and router configuration for comparisons. Record exact model and quantization identifiers from the serving hosts with the results. The harness measures router round-trip time, including queueing and screening. It cannot attribute that time to model inference alone. A successful fixture does not establish unrestricted survival or generalization to other worlds.

Fleet benchmark scope. This work exercises and corrects existing Minecraft behavior. It adds no router-facing agent tool or role capability, so it does not add a scenario to `FLEET_BENCHMARK_DESIGN.md`.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-11 | Record the research, Hermes assessment, and rationale for the automated scenarios. |
