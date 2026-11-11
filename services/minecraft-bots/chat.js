// Version: 1.0.0
//
// 1.0.0 (2026-11-10) -- split out of index.js (2.141.0) unchanged: chat and intent --
// classifyIntent, the chat reply, narration, and what gets remembered. Its own file, under the
// self-repair pipeline's 40000-char whole-file limit. index.js calls installChat() once at
// startup; bot, USERNAME and the rest are read back from index.js only after that.

import { SCOUT_FEATURE_BLOCKS } from "./actions.js";
import { publish as buzzPublish } from "./buzz.js";
import { searchMemory, writeMemoryNote } from "./longterm.js";
import { recentTurns, recordTurn } from "./memory.js";
import { callRole } from "./router.js";
import { AGENT_ID, BOT_USERNAMES, HISTORY_TURNS, MAX_CHAT_LEN, PERSONA_NAME, TASK_ID, USERNAME, bot, convId, currentGoal, isAnotherBot, isBoss, persona } from "./index.js";

// One dispatch call classifies relevance AND detects an action request together, replacing
// the old plain YES/NO relevance check -- same "keep it to one cheap call" efficiency
// discipline the rest of this file already follows (maybeRemember, the old isRelevant this
// replaces). Real verbs only (actions.js): navigate, gather, fight -- no building/placement,
// a deliberately separate, much bigger feature not attempted here.
//
// Real bug found live (2026-09-06): a message addressed to Babs by name also made Amy start
// mining -- each bot's own classifier only ever knew about itself, with no way to recognize
// "this names a DIFFERENT bot" and stand down. OTHER_BOTS below fixes that. Same incident also
// surfaced a second bug: both bots mined "stone" despite neither being asked for it -- with no
// instruction covering "no specific block was actually named," the classifier had to invent
// *something* for ACTION MINE's required <block_id> rather than falling back to CHAT.
let OTHER_BOTS; // set by installChat(): it reads index.js state at startup

export async function classifyIntent(speaker, message) {
  const otherBotsNote = OTHER_BOTS.length
    ? ` Other bots who may also be in this chat: ${OTHER_BOTS.join(", ")} -- if the message ` +
      `clearly names one of them instead of ${USERNAME}, respond NONE even if it looks like an ` +
      `action request.`
    : "";
  // S34 fix (2026-10-21): handleIncoming()'s own isAnotherBot()/isActingCoordinator() gate
  // (above, before classifyIntent() is ever called) already guarantees that whenever
  // isAnotherBot(speaker) is true here, it's a verified bot coordinator -- Mayor's real
  // directive, or Mark's fallback-coordinator directive -- never an arbitrary other bot's
  // chatter and never a player's text, since isAnotherBot() checks the authenticated mineflayer
  // `speaker`, never the message body. proposeDirectiveForOthers()/proposeFallbackDirective()
  // already mark their own generation calls analysis:true ("bot-to-bot message, no player
  // input"); this was the one place the matching receive side still took the full-screening
  // path, and Layer 2 blocked 8 of Mayor's real directives at 0.970 on 2026-10-13
  // (IMPLEMENTATION_PLAN.md S34). Layer 1 still runs and still blocks regardless of this flag --
  // hermes-router.py's analysis mode only ever relaxes Layer 2's hard block, per its own S27f
  // doctrine that the router has no bearer auth and must never trust a caller's identity claim
  // on its own; the actual verification happens here, upstream, against the real speaker.
  const fromVerifiedBot = isAnotherBot(speaker);
  const reply = await callRole(
    "dispatch",
    [
      {
        role: "system",
        content:
          `You are an intent classifier for a Minecraft bot named ${USERNAME}, who has real ` +
          `in-game abilities: moving, following, mining/gathering blocks, fighting hostile ` +
          `mobs, checking chests for gear, and crafting items.${otherBotsNote} Given one chat ` +
          `message from another player, respond with EXACTLY ONE line, no explanation, no ` +
          `extra punctuation, in one of these forms:\n` +
          `NONE - not directed at ${USERNAME}, no response needed\n` +
          `CHAT - directed at ${USERNAME} but just conversation, not a request to do something\n` +
          `ACTION GOTO - asks ${USERNAME} to come to the speaker\n` +
          `ACTION FOLLOW - asks ${USERNAME} to follow the speaker\n` +
          `ACTION STOP - asks ${USERNAME} to stop what she is doing\n` +
          `ACTION MINE <block_id> <count> - asks ${USERNAME} to gather/mine a resource, ONLY ` +
          `if a specific resource/block was actually named or clearly implied. <block_id> must ` +
          `be the exact modern Minecraft block id (e.g. oak_log, stone, iron_ore, cobblestone). ` +
          `For a general material class rather than one exact species/color (any wood, any ` +
          `wool, any ore), naming ANY real example of that class is enough -- she'll ` +
          `automatically gather whatever matching variant is actually nearby, not just that ` +
          `exact one. <count> is a small positive integer, default 4 if unstated. If no ` +
          `specific block is named, respond CHAT instead -- never invent a block.\n` +
          `ACTION ATTACK - asks ${USERNAME} to fight a nearby hostile mob\n` +
          `ACTION FLEE - asks ${USERNAME} to run away from a nearby hostile mob instead of fighting it\n` +
          `ACTION LOOT <item_id> <count> - asks ${USERNAME} to check a nearby chest for a ` +
          `SPECIFIC item, ONLY if one was actually named or clearly implied (e.g. "check the ` +
          `chest for arrows" or "see if there's a sword in there"). <count> is a small positive ` +
          `integer, default 1 if unstated. She takes up to that many and no more -- never ` +
          `everything in the chest. If no item was named (e.g. "check that chest" with no ` +
          `specifics), omit both parameters -- she'll inspect it and remember what's inside for ` +
          `the whole fleet without taking anything.\n` +
          `ACTION SLEEP - asks ${USERNAME} to go find a bed and sleep (only makes sense at ` +
          `night or during a thunderstorm)\n` +
          `ACTION EAT - asks ${USERNAME} to eat some food from her inventory\n` +
          `ACTION FISH - asks ${USERNAME} to fish at nearby water with a fishing rod\n` +
          `ACTION GIVE <item_id> <count> - asks ${USERNAME} to give the speaker some of an item ` +
          `she's carrying (e.g. "give me some bread"). <count> is a small positive integer, ` +
          `default 1 if unstated.\n` +
          `ACTION STORE <item_id> <count> - asks ${USERNAME} to put some of an item she's ` +
          `carrying into a nearby chest. <count> is a small positive integer, default all of it ` +
          `if unstated.\n` +
          `ACTION TRADE <item_id> - asks ${USERNAME} to trade with a nearby villager for a ` +
          `specific item she wants\n` +
          `ACTION HARVEST - asks ${USERNAME} to pick a ripe crop nearby and replant it, or, if ` +
          `nothing is ripe yet, till open ground and plant seeds she's carrying to start a new ` +
          `farm\n` +
          `ACTION EXPLORE - asks ${USERNAME} to go looking for any useful raw material (wood, ` +
          `ore) when no specific one was named. No parameters.\n` +
          `ACTION BREED <species> - asks ${USERNAME} to breed two nearby animals of the same ` +
          `kind (e.g. cow, sheep, pig, chicken, bee) using the right food\n` +
          `ACTION HARVEST_HIVE <tool> - asks ${USERNAME} to collect from a nearby full beehive/` +
          `bee nest. <tool> is "bottle" (default, honey, calm) or "shears" (honeycomb, but ` +
          `angers the bees) -- only use shears if honeycomb was specifically asked for.\n` +
          `ACTION SHEAR - asks ${USERNAME} to shear a nearby sheep for wool, if she has shears\n` +
          `ACTION MILK - asks ${USERNAME} to milk a nearby cow, if she has an empty bucket\n` +
          `ACTION BUILD_PEN - asks ${USERNAME} to fence in a small pen (with a gate) around ` +
          `herself, if she has fence blocks and a fence gate. No parameters.\n` +
          `ACTION HERD_TO_PEN <species> - asks ${USERNAME} to lure a nearby loose animal (e.g. ` +
          `cow, sheep, pig, chicken) into the already-built pen using the right food. Only if a ` +
          `pen already exists and she has that food.\n` +
          `ACTION ENCHANT <item_id> - asks ${USERNAME} to enchant an item she's carrying at a ` +
          `nearby enchanting table (needs lapis lazuli)\n` +
          `ACTION CRAFT <item_id> <count> - asks ${USERNAME} to craft/make an item, ONLY if a ` +
          `specific item was actually named or clearly implied. <item_id> must be the exact ` +
          `modern Minecraft item id (e.g. stick, oak_planks, wooden_pickaxe, crafting_table). ` +
          `<count> is a small positive integer, default 1 if unstated. If no specific item is ` +
          `named, respond CHAT instead -- never invent one.\n` +
          `ACTION SMELT <item_id> <count> - asks ${USERNAME} to smelt ore into an ingot (or ` +
          `similar) at a furnace, ONLY if a specific output was actually named or clearly ` +
          `implied (e.g. iron_ingot, copper_ingot, gold_ingot, glass, stone). <count> is a small ` +
          `positive integer, default 1 if unstated.\n` +
          `ACTION PLACE <item_id> - asks ${USERNAME} to place ONE block she's carrying right next ` +
          `to herself (e.g. a furnace or crafting_table she crafted). For a single utility block, ` +
          `not a structure -- use ACTION BUILD for that instead.\n` +
          `ACTION BUILD - asks ${USERNAME} to build a small shelter (walls, a doorway, a roof) ` +
          `around herself using whatever solid block she has the most of. No parameters.\n` +
          `ACTION GOAL <description> - gives ${USERNAME} a standing objective to keep working ` +
          `on by herself over time (not a single one-off task), e.g. "get full iron armor" or ` +
          `"stock up on wood". Only use this if the speaker is clearly assigning an ongoing ` +
          `objective, not just asking for one immediate thing. <description> is a short phrase.`,
      },
      { role: "user", content: `<${speaker}> ${message}` },
    ],
    { maxTokens: 16, temperature: 0, analysis: fromVerifiedBot },
  );
  const trimmed = reply.trim().toUpperCase();
  if (trimmed.startsWith("ACTION")) {
    const parts = trimmed.split(/\s+/);
    const verb = parts[1];
    if (verb === "GOTO") return { type: "action", action: { type: "goto" } };
    if (verb === "FOLLOW") return { type: "action", action: { type: "follow" } };
    if (verb === "STOP") return { type: "action", action: { type: "stop" } };
    if (verb === "ATTACK") return { type: "action", action: { type: "attack" } };
    if (verb === "FLEE") return { type: "action", action: { type: "flee" } };
    if (verb === "EAT") return { type: "action", action: { type: "eat" } };
    if (verb === "FISH") return { type: "action", action: { type: "fish" } };
    if (verb === "LOOT") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      return { type: "action", action: { type: "loot", item: item || null, count: count > 0 ? count : 1 } };
    }
    if (verb === "SLEEP") return { type: "action", action: { type: "sleep" } };
    if (verb === "CRAFT") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "craft", item, count: count > 0 ? count : 1 } };
    }
    if (verb === "SMELT") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "smelt", item, count: count > 0 ? count : 1 } };
    }
    if (verb === "PLACE") {
      const item = (parts[2] || "").toLowerCase();
      if (item) return { type: "action", action: { type: "place", item } };
    }
    if (verb === "GIVE") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (item) return { type: "action", action: { type: "give", player: speaker, item, count: count > 0 ? count : 1 } };
    }
    if (verb === "STORE") {
      const item = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      // Unlike every other count default (1), this defaults to "all of it" -- performAction's
      // "store" already caps at however much she actually has via Math.min().
      if (item) return { type: "action", action: { type: "store", item, count: count > 0 ? count : Infinity } };
    }
    if (verb === "TRADE") {
      const item = (parts[2] || "").toLowerCase();
      if (item) return { type: "action", action: { type: "trade", item } };
    }
    if (verb === "HARVEST") return { type: "action", action: { type: "harvest" } };
    if (verb === "BUILD") return { type: "action", action: { type: "build" } };
    if (verb === "EXPLORE") {
      const feature = (parts[2] || "").toLowerCase();
      return { type: "action", action: SCOUT_FEATURE_BLOCKS[feature] ? { type: "explore", feature } : { type: "explore" } };
    }
    if (verb === "BREED") {
      const species = (parts[2] || "").toLowerCase();
      if (species) return { type: "action", action: { type: "breed", species } };
    }
    if (verb === "HARVEST_HIVE") {
      const tool = (parts[2] || "bottle").toLowerCase();
      return { type: "action", action: { type: "harvest_hive", tool } };
    }
    if (verb === "SHEAR") return { type: "action", action: { type: "shear" } };
    if (verb === "MILK") return { type: "action", action: { type: "milk" } };
    if (verb === "BUILD_PEN") return { type: "action", action: { type: "build_pen" } };
    if (verb === "HERD_TO_PEN") {
      const species = (parts[2] || "").toLowerCase();
      if (species) return { type: "action", action: { type: "herd_to_pen", species } };
    }
    if (verb === "ENCHANT") {
      const item = (parts[2] || "").toLowerCase();
      if (item) return { type: "action", action: { type: "enchant", item } };
    }
    if (verb === "MINE") {
      const block = (parts[2] || "").toLowerCase();
      const count = parseInt(parts[3], 10);
      if (block) return { type: "action", action: { type: "mine", block, count: count > 0 ? count : 4 } };
    }
    if (verb === "GOAL") {
      // Re-extracted from the original (non-uppercased) reply so the description keeps its
      // natural casing/spacing rather than the all-caps, single-spaced tokens `parts` has.
      const match = reply.trim().match(/^ACTION\s+GOAL\s+(.+)$/i);
      const description = match ? match[1].trim() : "";
      if (description) return { type: "action", action: { type: "goal", description } };
    }
    return { type: "chat" }; // unparseable ACTION line -- fall back to a normal reply
  }
  if (trimmed.startsWith("CHAT")) return { type: "chat" };
  return { type: "none" };
}

// Short in-character line for an action's start/outcome -- same persona voice as a normal
// chat reply, just a much shorter, single-purpose prompt (no history/long-term recall: an
// action's own result text is already all the context worth having).
export async function narrateAction(text) {
  const reply = await callRole(
    "muse",
    [
      { role: "system", content: `${persona}\n\n---\n\nYou are chatting in Minecraft's in-game ` +
          `chat, in character. State the following in one short sentence, in your own voice, ` +
          `without changing its meaning: "${text}"` },
      { role: "user", content: text },
    ],
    { maxTokens: 40, temperature: 0.9, analysis: true },   // narrateAction: the bot's own action text
  );
  return reply.trim().slice(0, MAX_CHAT_LEN) || text;
}

// Direct request, 2026-09-11 ("chat/action coherence fix" -- a research pass into Project Sid's
// PIANO architecture surfaced this as the one real analog to a problem this codebase already
// fixed elsewhere: Sid's Cognitive Controller broadcasts its own real decisions to "condition
// talk-related modules," specifically to stop agents promising things they never act on.
// classifyIntent's ACTION/GOAL branches already ground chat in a real queued action; this file's
// OTHER reply path -- generateReply(), for anything classifyIntent scores as plain CHAT -- had no
// such grounding. A borderline request classifyIntent doesn't recognize as actionable could still
// get an in-character "sure, I'll get right on that!" with no goal ever actually queued -- the
// exact talk-vs-action mismatch Sid's own architecture exists to prevent, just never audited for
// here until asked to look. currentActivityNote() (below) grounds every CHAT reply in the bot's
// REAL, live goal state (or its real absence) the same way every other prompt in this file already
// grounds itself in real gear/inventory rather than a remembered belief that could drift.
const CHAT_INSTRUCTION =
  "You are chatting in Minecraft's in-game chat, in character. Reply to the latest message " +
  "in 1-2 short sentences suitable for game chat. Do not prefix your own name. This is a plain " +
  "conversational reply -- no goal or action is queued by sending it. Never promise a specific " +
  "future action (\"I'll get you that,\" \"I'll do that now,\" \"on it\") unless it's covered by " +
  "what you're ACTUALLY doing right now (see below) -- if someone asks for something you're not " +
  "already working on, acknowledge the ask honestly without implying it's already happening " +
  "(e.g. \"ask me directly and I'll get started\").";

function currentActivityNote() {
  return currentGoal
    ? `\n\nWhat you're actually doing right now: "${currentGoal.description}." Only imply you're ` +
      `on something if this genuinely covers it.`
    : "\n\nYou have no active goal right now -- don't imply you're already working on anything.";
}

export async function generateReply(speaker, message) {
  const conv = convId(speaker);
  // S34: same verified-bot exemption as classifyIntent() above -- a non-action utterance from
  // Mayor/Mark's fallback-coordinator path (isAnotherBot(speaker), already gated upstream in
  // handleIncoming before generateReply is ever reached with a bot speaker) must not take the
  // full-screening path either, same reasoning, same safety argument.
  const fromVerifiedBot = isAnotherBot(speaker);

  // Best-effort: record the incoming line, then read back recent history for this speaker
  // (this call already includes the line just recorded, oldest-first -- see
  // hermes-memory.py's _list_turns). A hermes-memory outage degrades to a single-message
  // reply rather than failing the interaction -- never a hard dependency for chatting at all.
  let history = [{ role: "user", content: `<${speaker}> ${message}` }];
  try {
    await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "user",
                        raw: `<${speaker}> ${message}` });
    const turns = await recentTurns({ agent: AGENT_ID, convId: conv, limit: HISTORY_TURNS });
    if (turns.length) {
      history = turns.map((t) => ({ role: t.role, content: t.raw }));
    }
  } catch (err) {
    console.error(`[${USERNAME}] memory unavailable, replying without history:`, err.message,
                  err.cause ?? "");
  }

  // Long-term recall (design doc §7): a handful of semantically relevant notes from the
  // "minecraft" corpus -- both this bot's own personal memory and shared world facts, not
  // filtered by scope here since the corpus is still small and an instruction-following model
  // handles a little irrelevant context fine. Best-effort like everything else memory-related.
  let memoryNote = "";
  const hits = await searchMemory(message, { topK: 3 });
  if (hits.length) {
    memoryNote = "\n\nRelevant things you remember:\n" +
      hits.map((h) => `- ${h.text}`).join("\n");
  }

  // muse's chat template rejects a second system-role message anywhere but position 0
  // ("System message must be at the beginning") -- confirmed live, not assumed -- so persona,
  // the per-call instruction, the Boss note (when it applies), and any recalled long-term
  // memory are all merged into one system message, not sent separately.
  const bossNote = isBoss(speaker)
    ? ` The speaker (${speaker}) is The Boss -- respond accordingly to her Behavioral Modifiers.`
    : "";
  const text = await callRole(
    "muse",
    [{ role: "system", content:
        `${persona}\n\n---\n\n${CHAT_INSTRUCTION}${bossNote}${memoryNote}${currentActivityNote()}` },
     ...history],
    { maxTokens: 80, temperature: 0.9, analysis: fromVerifiedBot },
  );
  const reply = text.slice(0, MAX_CHAT_LEN);

  if (reply) {
    try {
      await recordTurn({ agent: AGENT_ID, taskId: TASK_ID, convId: conv, role: "assistant",
                          raw: reply });
    } catch (err) {
      console.error(`[${USERNAME}] failed to record reply to memory:`, err.message, err.cause ?? "");
    }
  }
  return reply;
}

// Runs after a reply has already been sent -- never on the critical path a player is waiting
// on. Uses the same cheap `dispatch` tier the relevance check uses (design doc §6: dispatch is
// for reactive classification, not creative generation), asking it to decide whether anything
// in the exchange is worth long-term memory and, if so, whether it's a shared world fact or
// personal to this bot. A hermes-rag outage here just means nothing gets remembered long-term
// this turn -- never affects the chat itself.
export async function maybeRemember(speaker, message, reply) {
  try {
    const verdict = await callRole(
      "dispatch",
      [
        {
          role: "system",
          content:
            "Given this Minecraft chat exchange, is there a concrete fact worth remembering " +
            "long-term (a discovery, location, stated preference, promise, or plan)? If yes, " +
            "respond exactly as 'WORLD: <one-sentence fact>' for an objective fact about the " +
            "world (locations, builds, shared knowledge), or 'PERSONAL: <one-sentence fact>' " +
            "for something about this specific speaker. If nothing is worth remembering, " +
            "respond exactly 'NONE'. Never explain, never add anything else.",
        },
        { role: "user", content: `<${speaker}> ${message}\n<bot reply> ${reply}` },
      ],
      { maxTokens: 60, temperature: 0 },
    );
    const trimmed = verdict.trim();
    if (trimmed.toUpperCase().startsWith("WORLD:")) {
      const fact = trimmed.slice(6).trim();
      await writeMemoryNote({ scope: "world", persona: PERSONA_NAME, text: fact });
      // Buzz coordination (design doc §9): other bots hear about a new world fact within one
      // poll interval, not only whenever they next happen to searchMemory() something related.
      try {
        await buzzPublish(AGENT_ID, "minecraft", fact);
      } catch (err) {
        console.error(`[${USERNAME}] buzz publish failed:`, err.message);
      }
    } else if (trimmed.toUpperCase().startsWith("PERSONAL:")) {
      await writeMemoryNote({ scope: "bot", persona: PERSONA_NAME,
                              text: `(about ${speaker}) ${trimmed.slice(9).trim()}` });
    }
  } catch (err) {
    console.error(`[${USERNAME}] maybeRemember failed:`, err.message);
  }
}


// Runs once, from index.js, where this code used to sit: registers this module's listeners and
// ticks, and sets the constants that read index.js state.
export function installChat() {
  OTHER_BOTS = [...BOT_USERNAMES].filter((n) => n !== USERNAME);
}
