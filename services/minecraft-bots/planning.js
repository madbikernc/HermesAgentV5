// Version: 1.0.0
//
// 1.0.0 (2026-11-10) -- split out of index.js (2.142.0) unchanged: planning -- runAction, the
// goal-step parser, planNextStep and goal-conflict arbitration. Its own file, under the
// self-repair pipeline's 40000-char whole-file limit. bot, USERNAME and the rest are read back
// from index.js, only inside functions; the two index.js variables it changes go through
// setActiveDirectSpeaker()/setSurplusCleanupDueAt().

import { SCOUT_FEATURE_BLOCKS, performAction } from "./actions.js";
import * as arbiter from "./arbiter.js";
import { narrateAction } from "./chat.js";
import { describeGear } from "./equipment.js";
import { searchMemory } from "./longterm.js";
import { recordTurn } from "./memory.js";
import { callRole } from "./router.js";
import { AGENT_ID, SURPLUS_CLEANUP_QUIET_MS, TASK_ID, USERNAME, activeDirectSpeaker, bot, convId, goals, isAnotherBot, otherBotGoals, otherGoalsNote, setActiveDirectSpeaker, setSurplusCleanupDueAt } from "./index.js";

// Runs an action in the background and reports back -- deliberately NOT inside the `busy`
// window (see handleIncoming): a mine/follow/attack action can take up to ACTION_TIMEOUT_MS
// (actions.js), and holding the classify/reply mutex for that whole span would make the bot
// go unresponsive to chat while she works. `busy` only ever guards the fast classify step.
export async function runAction(action, speaker, message, send) {
  // Real bug found live (2026-09-06): this used to record a generic "[requested action:
  // mine]" label, discarding the actual message text and parsed params (block/count) -- when
  // a mining request went to the wrong block, there was no way to tell from memory alone
  // whether the classifier misheard the request or the player's own message was ambiguous.
  // Recording the full parsed action alongside the original text fixes that for next time.
  const actionDesc = action.type === "mine" ? `mine ${action.block} x${action.count}`
    : action.type === "craft" ? `craft ${action.item} x${action.count}`
    : action.type === "smelt" ? `smelt ${action.item} x${action.count}`
    : action.type === "place" ? `place ${action.item}`
    : action.type === "give" ? `give ${action.player} ${action.item} x${action.count}`
    : action.type === "store" ? `store ${action.item}`
    : action.type === "breed" ? `breed ${action.species}`
    : action.type === "enchant" ? `enchant ${action.item}` : action.type;
  // Coherence arbiter Phase 3 (2026-09-10): a live player asked for this by name, so it should
  // win over any routine/goal-step activity but still legitimately yield to a genuine emergency
  // (self-defense, health, drowning) already in flight -- OWNERS.DIRECT_COMMAND sits above
  // ROUTINE/GOAL_STEP for exactly that "a live player command always wins immediately" reason
  // (goalTick's own long-standing comment), while still ranking below the reflex tiers.
  const handle = await arbiter.requestControl(bot, arbiter.OWNERS.DIRECT_COMMAND,
    { preemptEqual: !isAnotherBot(speaker) }); // MB-06: a newer PLAYER command replaces an older one
  if (!handle) {
    console.log(`[${USERNAME}] action '${action.type}' yielded to something more urgent ` +
                `(${arbiter.currentOwner()})`);
    send(`hang on, I'm dealing with something urgent first.`);
    return;
  }
  // Same post-craft-cleanup trigger as goalTick's own -- see storeSurplusNearHome's header.
  let craftedOk = false;
  setActiveDirectSpeaker(speaker);
  try {
    const startLine = {
      goto: `heading to ${speaker}.`, follow: `following ${speaker} now.`, stop: "stopping.",
      mine: `off to gather some ${action.block}.`, attack: "engaging.", flee: "getting out of here!",
      loot: action.item ? `checking a nearby chest for ${action.item}.` : "checking a nearby chest.",
      craft: `let's see about crafting ${action.item}.`,
      sleep: "heading to bed.", smelt: `time to smelt some ${action.item}.`,
      place: `let's set up a ${action.item} here.`, eat: "grabbing a bite.", fish: "let's try fishing.",
      give: `bringing you some ${action.item}.`, store: `putting away some ${action.item}.`,
      trade: "let's see what the villager has.", harvest: "checking on the crops.",
      breed: `let's get some ${action.species}s together.`, enchant: `let's enchant this ${action.item}.`,
    }[action.type];
    // Review MB-21, 2026-09-24: the body used to stay locked through BOTH narration model calls
    // and the memory writes. The opening line is now narrated in parallel with the action, and
    // control is released as soon as the physical action ends.
    if (startLine) {
      narrateAction(startLine).then(send)
        .catch((err) => console.error(`[${USERNAME}] start narration failed:`, err.message));
    }

    const result = await performAction(bot, action, speaker, handle);
    handle.release();
    // Direct request, 2026-09-17 ("put any leftovers... in a chest"): a targeted loot that
    // actually withdrew something (action.item set) is just as worth an immediate cleanup pass
    // as a craft/smelt -- new inventory contents that might not all still be needed. A bare,
    // item-less inspect-only loot never changes her inventory at all, so it's deliberately
    // excluded here.
    craftedOk = result.ok && (action.type === "craft" || action.type === "smelt" ||
      (action.type === "loot" && action.item));
    send(await narrateAction(result.text));

    // Actions are conversational events too -- worth the same continuity as a chat exchange.
    const conv = convId(speaker);
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "user",
                        raw: `<${speaker}> ${message} [parsed as: ${actionDesc}]` });
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "assistant", raw: result.text });
  } catch (err) {
    console.error(`[${USERNAME}] action '${action.type}' failed:`, err.message);
    send(`something went wrong trying to do that.`);
  } finally {
    handle.release();
    if (activeDirectSpeaker === speaker) setActiveDirectSpeaker(null);
    if (craftedOk) setSurplusCleanupDueAt(Date.now() + SURPLUS_CLEANUP_QUIET_MS); // MB-09: deferred
  }
}

// Parses the goal planner's verdict -- deliberately separate from classifyIntent's own
// ACTION-line parser above, even though they overlap: the goal loop's vocabulary is narrower
// (no goto/follow/stop, which are speaker-relative and don't mean anything for a standing goal
// pursued alone) and has two extra terminal states classifyIntent has no use for (DONE/BLOCKED).
//
// Real gap found live (2026-09-07): the first version required the WHOLE reply to start with a
// known keyword, forcing a bare one-line answer with no room to reason -- dispatch is actually a
// full 35B model (same family as muse, just the stock quant, confirmed against hermes-router.py's
// own ROLES table), not a tiny classifier, but a one-line-only format meant it never connected
// "craft failed, no ingredients" back to "mine the raw material first": a live goal ("get a chest
// and some armor") burned all 3 retries on different CRAFT targets that all failed for the same
// underlying reason (no logs at all) and gave up, when mining logs first would have worked.
// Scanning from the LAST non-empty line for a known keyword lets the model reason for a
// sentence first (planNextStep's prompt now explicitly invites that) while still parsing
// reliably -- direct instruction: correctness/reasoning over minimizing tokens, since this all
// runs on local compute with no per-call cost.
export function parseGoalStep(text) {
  const lines = text.trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.toUpperCase();
    if (trimmed.startsWith("DONE")) {
      const item = (trimmed.split(/\s+/)[1] || "NONE").toLowerCase();
      return { type: "done", item: item === "none" ? null : item };
    }
    if (trimmed.startsWith("BLOCKED")) return { type: "blocked", reason: line.slice(7).trim() || "stuck" };
    if (trimmed.startsWith("ACTION")) {
      const parts = trimmed.split(/\s+/);
      const verb = parts[1];
      // Direct request, 2026-09-17 ("they loot EVERYTHING instead of what they need"): item/
      // count are now optional parameters, matching CRAFT/MINE/SMELT's own shape, instead of a
      // bare no-argument verb -- see actions.js's own "loot" case (1.54.0) for what changed on
      // the execution side. A bare "ACTION LOOT" (no item named) is still valid and means
      // "just look" -- inspect the chest, snapshot its real contents into known_chests.json for
      // the whole fleet, take nothing. Naming an item withdraws up to <count> of exactly that
      // one, never more.
      if (verb === "LOOT") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        return { type: "step", action: { type: "loot", item: item || null, count: count > 0 ? count : 1 } };
      }
      if (verb === "ATTACK") return { type: "step", action: { type: "attack" } };
      if (verb === "CRAFT") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "step", action: { type: "craft", item, count: count > 0 ? count : 1 } };
      }
      if (verb === "SMELT") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "step", action: { type: "smelt", item, count: count > 0 ? count : 1 } };
      }
      if (verb === "PLACE") {
        const item = (parts[2] || "").toLowerCase();
        if (item) return { type: "step", action: { type: "place", item } };
      }
      if (verb === "MINE") {
        const block = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (block) return { type: "step", action: { type: "mine", block, count: count > 0 ? count : 4 } };
      }
      // Direct request, 2026-09-07 ("next set of autonomy" -> goal-planner vocabulary gap):
      // harvest/breed/enchant/fish existed since the last two rounds but were only ever reachable
      // via a direct player command -- classifyIntent had them, this parser (a standing goal
      // reasoning on her own) never did, so a self-proposed goal could never actually choose to
      // farm, breed, enchant, or fish. Same parsing shape as every verb above.
      if (verb === "HARVEST") return { type: "step", action: { type: "harvest" } };
      if (verb === "BUILD") return { type: "step", action: { type: "build" } };
      if (verb === "EXPLORE") {
        const feature = (parts[2] || "").toLowerCase();
        return { type: "step", action: SCOUT_FEATURE_BLOCKS[feature] ? { type: "explore", feature } : { type: "explore" } };
      }
      // Review MB-08: Builder goals say "go home and place X" -- the planner needs the verb for it.
      if (verb === "GOHOME") return { type: "step", action: { type: "gohome" } };
      if (verb === "BREED") {
        const species = (parts[2] || "").toLowerCase();
        if (species) return { type: "step", action: { type: "breed", species } };
      }
      if (verb === "HARVEST_HIVE") {
        const tool = (parts[2] || "bottle").toLowerCase();
        return { type: "step", action: { type: "harvest_hive", tool } };
      }
      if (verb === "SHEAR") return { type: "step", action: { type: "shear" } };
      if (verb === "MILK") return { type: "step", action: { type: "milk" } };
      if (verb === "BUILD_PEN") return { type: "step", action: { type: "build_pen" } };
      if (verb === "HERD_TO_PEN") {
        const species = (parts[2] || "").toLowerCase();
        if (species) return { type: "step", action: { type: "herd_to_pen", species } };
      }
      if (verb === "ENCHANT") {
        const item = (parts[2] || "").toLowerCase();
        if (item) return { type: "step", action: { type: "enchant", item } };
      }
      if (verb === "FISH") return { type: "step", action: { type: "fish" } };
      // Not a "step" like the others above -- REQUEST never touches the game world, only Buzz,
      // so goalTick handles it as its own sibling type rather than routing it through
      // performAction (direct follow-up, 2026-09-07: "look for more ways to improve their
      // autonomy" -> bot-to-bot help).
      if (verb === "REQUEST") {
        const item = (parts[2] || "").toLowerCase();
        const count = parseInt(parts[3], 10);
        if (item) return { type: "request", item, count: count > 0 ? count : 1 };
      }
    }
  }
  // Direct request, 2026-09-08 ("watch their behavior... look for misbehaviors"): this fallback
  // still fired 4 times in one 25-minute live capture, across 4 different bots, even after the
  // maxTokens bump to 500 (2026-09-07) meant to fix exactly this -- but nothing has ever logged
  // the actual raw reply that failed to parse, so there was no way to tell whether that fix
  // genuinely wasn't enough or something else entirely is going on. Logged here (truncated,
  // real replies from a misbehaving planner could in principle be long) purely for future
  // diagnosis -- this function still returns the same fallback either way.
  console.log(`[${USERNAME}] unparseable planNextStep reply: ${text.slice(0, 300)}`);
  return { type: "blocked", reason: "couldn't decide what to do next" };
}

// One dispatch call per tick, grounded in real state (describeGear -- never guessed) and the
// goal's own recent log, not just the description -- so a repeated failure actually steers the
// next choice instead of retrying the same dead end forever (MAX_CONSECUTIVE_FAILURES is the
// hard backstop if reasoning alone doesn't catch it). maxTokens is deliberately generous (not
// the old 24) -- see parseGoalStep's comment on why a one-line-only format was the real problem.
export async function planNextStep(goal) {
  const gearNote = describeGear(bot);
  const recentLog = goal.log.length ? goal.log.slice(-6).join("\n") : "(nothing done yet)";

  // Environmental memory (direct follow-up, 2026-09-07: "look for more ways to improve their
  // autonomy"). Real gap found live earlier tonight: "no oak_log nearby" got rediscovered from
  // scratch, independently, by both bots, across many separate goal cycles -- that knowledge
  // died with each goal instead of persisting. Reuses the EXISTING long-term memory (the same
  // "minecraft" hermes-rag corpus generateReply already searches for chat), not a new store.
  let environmentNote = "";
  try {
    const hits = await searchMemory(goal.description, { topK: 3 });
    if (hits.length) {
      environmentNote = "\n\nThings you remember about this area (may save you from repeating a " +
        "dead end):\n" + hits.map((h) => `- ${h.text}`).join("\n");
    }
  } catch (err) {
    console.error(`[${USERNAME}] memory recall for planning failed:`, err.message);
  }

  const otherGoalNote = otherGoalsNote(
    "Other bots currently working on something (if your goal would mean competing for the " +
    "same scarce thing, consider whether ACTION REQUEST -- ask one of them directly, she may " +
    "already have some -- beats duplicating her work):");

  const reply = await callRole(
    "dispatch",
    [
      {
        role: "system",
        content:
          `You are the planner for a Minecraft bot named ${USERNAME} working toward a standing ` +
          `goal on her own, unprompted by anyone right now.\n\n` +
          `Real limits on what she can do: she can craft via a crafting-table/hand-crafting grid ` +
          `recipe (bot.craft), AND she can smelt at a furnace (ACTION SMELT) -- she is NOT stuck ` +
          `without ingots. An item normally obtained by smelting (iron_ingot, copper_ingot, ` +
          `gold_ingot, glass, stone from cobblestone) needs raw material first (raw_iron, ` +
          `raw_copper, raw_gold, sand, cobblestone -- mine it if she doesn't have any), THEN ` +
          `ACTION SMELT, not ACTION CRAFT -- crafting-table recipes can never produce a smelted ` +
          `item. SMELT also needs FUEL (coal, charcoal, or any log/planks) -- if it fails for ` +
          `lack of fuel and she has no coal/charcoal, mine a log (ACTION MINE oak_log or ` +
          `whatever log is nearby) rather than repeating the same smelt attempt; any log works ` +
          `as furnace fuel. If SMELT/CRAFT fails specifically because no furnace/crafting table ` +
          `is reachable, check her inventory for a spare one first -- ACTION PLACE it rather than ` +
          `giving up or looting, since placing a utility block she already made is faster and ` +
          `more reliable than hoping a chest has what she needs. Only fall back to ACTION LOOT if ` +
          `she has the raw material and fuel but SMELT still fails, or has no furnace reachable ` +
          `and none to place.\n` +
          `Common material chain: sticks and a crafting table both need planks; planks come from ` +
          `logs. If a craft fails for missing ingredients, check whether she's missing the raw ` +
          `material (e.g. no logs at all) rather than the item itself -- mine the raw material ` +
          `first instead of retrying the same craft.\n` +
          `She can place ONE utility block she's carrying (a furnace or crafting table, ACTION ` +
          `PLACE) for her own use, AND she can build a small fixed shelter (walls, a doorway, a ` +
          `roof -- ACTION BUILD, see its own entry below) out of whatever solid block she has ` +
          `the most of -- this is a REAL, working capability, do not claim otherwise or respond ` +
          `BLOCKED for a goal ACTION BUILD can satisfy. Only respond BLOCKED for building if the ` +
          `goal genuinely needs something bigger or differently-shaped than that one fixed ` +
          `shelter (a real house, a base, a custom wall layout) -- that specific kind of building ` +
          `is what's actually out of scope, not building in general.\n\n` +
          `Given the goal, her current gear/inventory, and what she's already tried below, you ` +
          `may reason briefly first -- AT MOST one short sentence, no matter how confusing or ` +
          `factually off the goal description sounds (reinterpret it charitably as the closest ` +
          `realistic Minecraft objective rather than dwelling on why it's worded oddly) -- then ` +
          `on its own final line you MUST respond with EXACTLY ONE of these forms, no exceptions:\n` +
          `DONE <item_id or NONE> - the goal is already fully achieved given her current gear/` +
          `inventory. <item_id> is the exact modern Minecraft item id she now owns or has ` +
          `equipped that proves it (e.g. "bow", "iron_chestplate") -- never invent or assume one ` +
          `is there without checking the inventory/gear given above. Use NONE only when the goal ` +
          `genuinely isn't about owning one specific item (e.g. "explore the area").\n` +
          `BLOCKED <short reason> - she cannot make progress right now and should give up\n` +
          `ACTION MINE <block_id> <count> - gather a resource. <block_id> must be the exact ` +
          `modern Minecraft block id -- never invent one. For a material class rather than one ` +
          `exact species/color (any wood, any wool, any ore), any real example works -- she'll ` +
          `automatically gather whatever matching variant is actually nearby. If she hasn't ` +
          `already checked a chest THIS goal, try ACTION LOOT <that same item_id> <count> first ` +
          `-- a nearby chest may already have exactly what she needs, saving a trip. Go straight ` +
          `to MINE only once LOOT has already come up empty for this same need, or the recent ` +
          `progress below already shows a LOOT attempt.\n` +
          `ACTION CRAFT <item_id> <count> - craft an item via a crafting-table/grid recipe only. ` +
          `<item_id> must be the exact modern Minecraft item id -- never invent one. She handles ` +
          `simple intermediate steps herself automatically (logs into planks, planks into sticks ` +
          `or a crafting_table) -- name the FINAL item you actually want, not the raw material; ` +
          `no need to plan out "craft planks, then craft sticks" yourself first.\n` +
          `ACTION EXPLORE <feature> - scout for a map feature instead of gathering; <feature> is ` +
          `one of: ${Object.keys(SCOUT_FEATURE_BLOCKS).join(", ")}. Succeeds only if it's actually found.\n` +
          `ACTION GOHOME - walk back to home (your bed or spawn point). Use it first whenever the ` +
          `goal says to do something at or near home, before PLACE or BUILD.\n` +
          `ACTION EXPLORE - go looking for any useful raw material (wood, ore) when CRAFT/MINE ` +
          `failed because a needed resource isn't nearby and you don't have a more specific ` +
          `block to try -- gathers whatever's found, worth doing before giving up or asking the ` +
          `other bot for help.\n` +
          `ACTION SMELT <item_id> <count> - smelt raw material into an ingot (or similar) at a ` +
          `furnace. <item_id> is the OUTPUT (e.g. iron_ingot), the exact modern Minecraft item ` +
          `id -- never invent one.\n` +
          `ACTION PLACE <item_id> - place a furnace or crafting_table she's already carrying, ` +
          `right next to herself. Use this both when SMELT/CRAFT needs one and none is reachable, ` +
          `AND whenever a goal asks her to set one up in a specific spot (e.g. "at home") -- ` +
          `crafting or already carrying the item is NOT the same as the goal being done if it ` +
          `says to place it somewhere; that only happens once PLACE actually succeeds there.\n` +
          `ACTION LOOT <item_id> <count> - check the nearest chest for a SPECIFIC item you ` +
          `actually need right now for this goal. <item_id> must be the exact modern Minecraft ` +
          `item id -- never invent one, and never a generic guess just to "see what's there." ` +
          `<count> is exactly how many you need, not a full stack by default -- she takes up to ` +
          `that many and no more, never sweeps the rest of the chest's contents. Whatever chest ` +
          `she opens gets fully remembered for the whole fleet either way, so a miss still helps ` +
          `later. Only omit both parameters if the goal genuinely isn't about one specific item ` +
          `(rare) -- that inspects the chest and remembers its contents without taking anything.\n` +
          `ACTION ATTACK - fight a nearby hostile mob\n` +
          `ACTION HARVEST - pick a ripe crop nearby and replant it, or till open ground and plant ` +
          `seeds to start a new farm if nothing is ripe yet, if the goal is about food or farming\n` +
          `ACTION BREED <species> - breed two nearby animals of the same kind (cow, sheep, pig, ` +
          `chicken, or bee) using the right food, if the goal is about animals or farming\n` +
          `ACTION HARVEST_HIVE <tool> - collect from a nearby full beehive/bee nest, if the goal ` +
          `is about honey/bees/beeswax. <tool> is "bottle" (default, honey, calm) or "shears" ` +
          `(honeycomb -- needed to ever craft a NEW beehive -- but angers the bees).\n` +
          `ACTION SHEAR - shear a nearby sheep for wool, if the goal is about wool and she has shears\n` +
          `ACTION MILK - milk a nearby cow, if the goal is about milk/food and she has an empty bucket\n` +
          `ACTION BUILD_PEN - fence in a small pen (with a gate) around herself, if the goal is ` +
          `about containing/keeping animals and she has fence blocks and a fence gate\n` +
          `ACTION HERD_TO_PEN <species> - lure a nearby loose animal into the already-built pen ` +
          `using the right food, if the goal is about penning/containing that species\n` +
          `ACTION ENCHANT <item_id> - enchant an item she's carrying at a nearby enchanting table ` +
          `(needs lapis lazuli and enough XP levels), if the goal is about gear upgrades\n` +
          `ACTION FISH - fish at nearby water with a fishing rod, if the goal is about food and ` +
          `no crops/animals are a better fit\n` +
          `ACTION BUILD - build a small shelter (walls, a doorway, a roof) around herself using ` +
          `whatever solid block she has the most of, if the goal is about shelter/safety and she ` +
          `hasn't got one nearby already\n` +
          `ACTION REQUEST <item_id> <count> - ask the other bot (over Buzz) for an item she might ` +
          `already have. Only after LOOT has already failed for the same need, or the item is ` +
          `also fine to just ask for directly (e.g. borrowing fuel/food rather than gathering ` +
          `your own from scratch).\n` +
          `Pick the single most useful next step toward the goal. If the same step already ` +
          `failed more than once in a row (see recent progress below), you must try a genuinely ` +
          `different step that addresses the actual missing ingredient, or respond BLOCKED.`,
      },
      { role: "user", content: `Goal: ${goal.description}\n${gearNote}\nRecent progress:\n${recentLog}` +
          `${environmentNote}${otherGoalNote}` },
    ],
    // Real bug found live (2026-09-07), TWICE -- once at 120 tokens, again at 220: the model
    // does not reliably obey "at most one short sentence" and sometimes writes a long run-on
    // reasoning sentence with parenthetical asides, getting cut off before its required final
    // decision line -- parseGoalStep's fallback ("couldn't decide what to do next") then counts
    // as a real strike toward MAX_CONSECUTIVE_FAILURES for a goal that was never actually given a
    // fair evaluation. Fighting the model's verbosity with prompt wording alone hasn't held up
    // twice in a row -- a genuinely generous budget is the robust fix instead of a third guess at
    // a slightly bigger number. This runs on local compute with no per-call cost, so there's no
    // real reason to be stingy here.
    { maxTokens: 500, temperature: 0, analysis: true },   // planNextStep: goal + gear + the bot's own action log
  );
  return reply.trim();
}

// Fires once a bot has had no active goal and heard from no one (chat/whisper/Matrix/a goal
// being set) for IDLE_BEFORE_SELF_GOAL_MS -- the "self-proposed" half of the operator's chosen
// autonomy design (the alternative, user-assigned-only, was explicitly not chosen). Uses `muse`,
// not `dispatch`: this is the one place autonomy calls for personality/creativity rather than
// mechanical classification -- what a bot chooses to do with idle time should sound like her,
// grounded in her real gear (never invented) and whatever long-term memory might suggest
// something worth pursuing.
// Direct request, 2026-09-07 ("what other behavior rules have any other sources published or
// suggested" -> MINECRAFT_BOTS_DESIGN.md's own §6 table: "Cross-bot conflict arbitration (two
// bots claim the same sub-goal) -> super (rare, not per-tick -- an occasional top-tier call, not
// a standing cost)"). Decided and documented back when this was designed (2026-09-06), never
// actually built -- what existed until tonight was only the soft otherGoalsNote() prompt nudge
// below, which depends entirely on THIS bot's own model voluntarily noticing and avoiding a
// collision, with nothing that actually resolves one if it doesn't. Only fires when there's
// something to arbitrate (an active other-bot goal exists AND this bot is about to commit to a
// new self-proposed one) -- rare by construction, matching the design doc's own "not per-tick."
// Deliberately scoped to self-proposed goals only, not player-assigned ones (ACTION GOAL) -- a
// human's direct instruction should never get silently overridden by an arbitration call.
export async function arbitrateGoalConflict(proposedDescription) {
  if (!otherBotGoals.size) return proposedDescription;
  const othersText = [...otherBotGoals.entries()].map(([agent, desc]) => `${agent}: ${desc}`).join("\n");
  try {
    const reply = await callRole("super", [
      {
        role: "system",
        content:
          "You arbitrate goal conflicts between autonomous Minecraft bots sharing one world " +
          "and its scarce resources. Given one bot's proposed new goal and what other bots are " +
          "already actively doing, decide whether it's a REAL conflict worth avoiding (both " +
          "need the same scarce, limited resource or location right now), not just a loose " +
          "topical overlap -- two bots both wanting \"some iron\" isn't automatically a " +
          "conflict if iron ore is common. Respond in EXACTLY this format, two lines:\n" +
          "CONFLICT: yes|no\n" +
          "GOAL: <if yes, a different, still-concrete goal for this bot to pursue instead; if " +
          "no, repeat the original goal unchanged>",
      },
      {
        role: "user",
        content: `This bot's proposed goal: "${proposedDescription}"\n\nOther bots already ` +
          `active:\n${othersText}`,
      },
    ], { maxTokens: 100, temperature: 0, analysis: true });   // goal arbitration: bot-proposed goals
    if (!/CONFLICT:\s*yes/i.test(reply)) return proposedDescription;
    const goalMatch = reply.match(/GOAL:\s*(.+)/i);
    const alternative = goalMatch ? goalMatch[1].trim().replace(/^["']|["']$/g, "").slice(0, 120) : "";
    if (!alternative) return proposedDescription; // flagged a conflict but gave nothing usable -- don't block on it
    console.log(`[${USERNAME}] goal conflict arbitrated: "${proposedDescription}" -> "${alternative}"`);
    return alternative;
  } catch (err) {
    console.error(`[${USERNAME}] goal arbitration failed:`, err.message);
    return proposedDescription; // arbitration is a refinement, not a hard gate -- never block a goal on it failing
  }
}

