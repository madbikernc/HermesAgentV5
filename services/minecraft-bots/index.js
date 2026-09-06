// Version: 2.6.0
//
// Firmament Minecraft bot orchestrator. Connects one bot and wires the first real decision
// loop: chat perception -> cheap relevance classification (dispatch role) -> in-character
// reply (muse role) -> bot chats back. See ../../MINECRAFT_BOTS_DESIGN.md.
//
// 2.6.0 (2026-09-06) -- Matrix wired (design doc §10, matrix.js): a single shared room
// (operator's own decision, not one room per bot like the retired Sintra/Amy pattern), both
// bots and the operator as members. Talks directly to Continuwuity's Client-Server API, not
// the fleet's old "hermes gateway" tool (built around the different per-agent-room
// architecture). New Matrix accounts (mc-babs, mc-amy) registered via the standard
// enable-registration/create/re-lock recipe in infra/continuwuity/README.md. Credentials in
// ~/.hermes/minecraft-matrix.env, not Vaultwarden -- see run-bot.sh 1.3.0's own note on why.
// Reuses handleIncoming() exactly as public chat/whisper already did -- the isAnotherBot()
// guard (renamed from the Buzz-era BOT_USERNAMES-only check) now also recognizes any `@mc-`
// Matrix identity, so the same bot-relaying-into-a-shared-channel feedback loop 2.5.0 fixed for
// Buzz->in-game-chat can't happen for Matrix either.
//
// 2.5.0 (2026-09-06) -- bot-to-bot coordination over hermes-buzz.py (design doc §9, buzz.js).
// Every WORLD-scoped long-term memory (see maybeRemember) is also published to the shared
// `minecraft` Buzz topic; each bot subscribes and relays what it hears from other bots into
// in-game chat, a directly observable trace that coordination happened. Real feedback-loop
// risk found and fixed while building this: every bot is just another player to mineflayer, so
// without a guard, Babs relaying a Buzz message into public chat would trigger Amy's own `chat`
// listener and send her down the normal human-reply pipeline (and vice versa) -- MC_BOT_USERNAMES
// now excludes known bot identities from that pipeline entirely; bot-to-bot traffic stays on
// Buzz, never the chat-relevance loop meant for human players.
//
// 2.4.0 (2026-09-06) -- long-term memory via the new "minecraft" hermes-rag corpus (design doc
// §7, longterm.js): before each reply, a semantic search over past notes (both this bot's own
// and shared world facts) is folded into the muse call's system message. After each reply
// (never blocking it -- see maybeRemember's own comment), a cheap dispatch call decides
// whether the exchange contained anything worth remembering long-term and writes it as a small
// markdown note, reindexed immediately (content-hash dedup keeps repeat reindexes cheap).
//
// 2.3.0 (2026-09-06) -- persistent per-bot conversation memory via hermes-memory.py (design
// doc §7): every incoming line and every reply is recorded as a turn (agent=mc-<persona>,
// conv_id=mc-<persona>:<speaker>), and recent history for that speaker is read back before
// each reply -- she now remembers a conversation across restarts, not just within one process
// lifetime. Run via run-babs.sh, which fetches MEMORY_TOKEN from Vaultwarden once at startup
// (fetch-once-at-startup, same pattern every other fleet caller of hermes-memory uses) --
// running index.js directly without it still works, just stateless (memory.js's own
// best-effort fallback), same as before this version.
//
// 2.2.0 (2026-09-06) -- Boss registration: BOSS_USERNAMES resolves a real in-game username to
// the "Boss" role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
// Behavioral Modifiers) without the persona file itself hardcoding an identity. Orchestrator's
// job, not the persona's -- CanisLupisM registered as the first Boss identity.
//
// 2.1.0 (2026-09-06) -- whisper handling: /msg, /tell, /w fire mineflayer's separate `whisper`
// event, not `chat` -- confirmed live (a real /tell produced no log line under 2.0.0). Replies
// to a whisper go back as a whisper, and skip the relevance check entirely since a whisper is
// already addressed to her by construction.
//
// 2.0.0 (2026-09-06) -- decision loop wired for the first time, replacing 1.0.0's pure
// connectivity-proof scaffolding. Deliberately minimal still: no memory (hermes-memory/
// hermes-rag), no Buzz, no Matrix -- one bot, one persona, one loop, proven end to end before
// any of that gets added. A `busy` flag serializes decisions per bot rather than letting
// concurrent chat lines pile up parallel router calls -- matches the design doc's own
// efficiency principle (§5): don't spend a model call faster than the previous one resolved.

import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { callRole } from "./router.js";
import { loadPersona } from "./persona.js";
import { recordTurn, recentTurns } from "./memory.js";
import { searchMemory, writeMemoryNote } from "./longterm.js";
import { publish as buzzPublish, watchTopic } from "./buzz.js";
import { watchRoom, sendMessage as matrixSend } from "./matrix.js";

const { pathfinder, Movements } = pathfinderPkg;

const HOST = process.env.MC_HOST || "192.168.1.221";
const PORT = parseInt(process.env.MC_PORT || "25580", 10);
const USERNAME = process.env.MC_BOT_USERNAME || "Babs";
const PERSONA_NAME = process.env.MC_BOT_PERSONA || USERNAME.toLowerCase();
const MAX_CHAT_LEN = 200;

// "The Boss" is a role a persona file can reference (see agents/minecraft-babs/PROMPT.md's
// Behavioral Modifiers) without the persona file itself needing to know a real username --
// identity resolution belongs to the orchestrator, not the persona. Registered here rather
// than in a config file since no config system exists yet; comma-separated for more than one
// in-game account later.
const BOSS_USERNAMES = (process.env.MC_BOSS_USERNAMES || "CanisLupisM,@phone1:spark")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isBoss(speaker) {
  return BOSS_USERNAMES.includes(speaker);
}

// Every bot is also just another player in mineflayer's eyes -- without this, Babs relaying a
// Buzz message into public chat (see the watchTopic handler below) would fire Amy's own `chat`
// listener and send her down the normal human-reply pipeline, and vice versa: an endless
// bot-reacts-to-bot loop. Known bot identities are excluded from that pipeline entirely;
// coordination between them happens over Buzz, not the in-game chat relevance/reply loop.
const BOT_USERNAMES = new Set(
  (process.env.MC_BOT_USERNAMES || "Babs,Amy").split(",").map((s) => s.trim()).filter(Boolean),
);

function isAnotherBot(speaker) {
  return BOT_USERNAMES.has(speaker) || speaker.startsWith("@mc-"); // Matrix bot identities
}

// Matrix (design doc §10): a single shared room, operator + all bots -- the operator's own
// decision, a deliberate deviation from the retired Sintra/Amy per-agent-room pattern. Talks
// directly to Continuwuity's Client-Server API (matrix.js), not the old "hermes gateway" tool,
// which was built around that different architecture. Optional: if MATRIX_ACCESS_TOKEN isn't
// set, the bot simply doesn't join Matrix, same as every other best-effort integration here.
const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || "http://10.129.1.15:6167";
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || `@mc-${PERSONA_NAME}:spark`;
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || "";
const MATRIX_ROOM_ID = process.env.MATRIX_ROOM_ID || "!2rXcMwykUS2yVNTLGw:spark";

// mc-<persona> matches the design doc's own Buzz-identity convention (§9) -- reused here as
// the hermes-memory agent id so the same name means the same thing everywhere this bot shows
// up. One conv_id per speaker: a bot's memory of "the conversation with CanisLupisM" spans
// both public chat and whispers, rather than splitting by channel for no real benefit.
const AGENT_ID = `mc-${PERSONA_NAME}`;
const TASK_ID = `${AGENT_ID}-chat`;
const HISTORY_TURNS = 8;

function convId(speaker) {
  return `${AGENT_ID}:${speaker}`;
}

const persona = loadPersona(PERSONA_NAME);
console.log(`[${USERNAME}] loaded persona '${PERSONA_NAME}' (${persona.length} chars)`);

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: "offline",
});

bot.loadPlugin(pathfinder);

bot.once("spawn", () => {
  console.log(`[${USERNAME}] spawned at`, bot.entity.position);
  bot.pathfinder.setMovements(new Movements(bot));
});

let busy = false;

async function isRelevant(speaker, message) {
  const reply = await callRole(
    "dispatch",
    [
      {
        role: "system",
        content:
          `You are a fast relevance classifier for a Minecraft bot named ${USERNAME}. Given ` +
          `one chat message from another player, answer with exactly one word: YES if the ` +
          `message is directed at, mentions, or clearly expects a response from ${USERNAME}; ` +
          `otherwise NO. Never explain, never add punctuation.`,
      },
      { role: "user", content: `<${speaker}> ${message}` },
    ],
    { maxTokens: 4, temperature: 0 },
  );
  return reply.trim().toUpperCase().startsWith("YES");
}

const CHAT_INSTRUCTION =
  "You are chatting in Minecraft's in-game chat, in character. Reply to the latest message " +
  "in 1-2 short sentences suitable for game chat. Do not prefix your own name.";

async function generateReply(speaker, message) {
  const conv = convId(speaker);

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
    [{ role: "system", content: `${persona}\n\n---\n\n${CHAT_INSTRUCTION}${bossNote}${memoryNote}` },
     ...history],
    { maxTokens: 80, temperature: 0.9 },
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
async function maybeRemember(speaker, message, reply) {
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

function handleIncoming(speaker, message, { alreadyAddressed, send }) {
  if (speaker === bot.username || speaker === MATRIX_USER_ID) return;
  if (isAnotherBot(speaker)) return; // another bot's own chat/Matrix message -- coordinate over Buzz, not here
  if (busy) {
    console.log(`[${USERNAME}] busy, dropping: <${speaker}> ${message}`);
    return;
  }
  busy = true;
  (async () => {
    try {
      // A whisper is already directed at her by construction -- no need to spend a dispatch
      // call asking whether it's relevant, unlike public chat where most lines aren't about her.
      const relevant = alreadyAddressed || (await isRelevant(speaker, message));
      if (!relevant) return;
      const reply = await generateReply(speaker, message);
      if (reply) {
        send(reply);
        maybeRemember(speaker, message, reply); // fire-and-forget, not awaited
      }
    } catch (err) {
      console.error(`[${USERNAME}] decision loop error:`, err.message);
    } finally {
      busy = false;
    }
  })();
}

bot.on("chat", (speaker, message) => {
  handleIncoming(speaker, message, { alreadyAddressed: false, send: (reply) => bot.chat(reply) });
});

// /msg, /tell, /w -- mineflayer fires these separately from public chat. Reply the same way
// (a private whisper back), not into public chat.
bot.on("whisper", (speaker, message) => {
  handleIncoming(speaker, message, {
    alreadyAddressed: true,
    send: (reply) => bot.whisper(speaker, reply),
  });
});

// Matrix (design doc §10): the shared room, same relevance-classification treatment as public
// in-game chat (alreadyAddressed: false) since more than one bot reads this room and a message
// may be meant for only one of them by name. Optional -- no MATRIX_ACCESS_TOKEN, no watcher.
if (MATRIX_ACCESS_TOKEN) {
  watchRoom({
    homeserver: MATRIX_HOMESERVER,
    accessToken: MATRIX_ACCESS_TOKEN,
    roomId: MATRIX_ROOM_ID,
    onMessage: ({ sender, body }) => {
      handleIncoming(sender, body, {
        alreadyAddressed: false,
        send: (reply) =>
          matrixSend({ homeserver: MATRIX_HOMESERVER, accessToken: MATRIX_ACCESS_TOKEN,
                       roomId: MATRIX_ROOM_ID, body: reply }).catch((err) =>
            console.error(`[${USERNAME}] matrix send failed:`, err.message)),
      });
    },
  });
  console.log(`[${USERNAME}] watching Matrix room ${MATRIX_ROOM_ID} as ${MATRIX_USER_ID}`);
} else {
  console.log(`[${USERNAME}] MATRIX_ACCESS_TOKEN not set -- Matrix room disabled`);
}

// Bot-to-bot coordination (design doc §9): hear what other bots have decided is worth
// remembering, and say so in-game -- a directly observable trace that coordination actually
// happened, the same reasoning BuzzLog's Matrix mirror exists for human observability.
bot.once("spawn", () => {
  watchTopic({
    topic: "minecraft",
    selfAgent: AGENT_ID,
    onMessage: (msg) => {
      console.log(`[${USERNAME}] heard on Buzz from ${msg.from_agent}: ${msg.body}`);
      bot.chat(`(heard from ${msg.from_agent}) ${msg.body}`.slice(0, MAX_CHAT_LEN));
    },
  });
});

bot.on("kicked", (reason) => console.log(`[${USERNAME}] kicked:`, reason));
bot.on("error", (err) => console.log(`[${USERNAME}] error:`, err));
bot.on("end", (reason) => console.log(`[${USERNAME}] disconnected:`, reason));
