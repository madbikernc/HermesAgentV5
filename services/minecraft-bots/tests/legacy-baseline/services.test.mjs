// Version: 1.0.0
//
// Legacy baseline: ported from tests/unit/services.test.mjs against the Mindcraft-ported
// architecture. router.js and buzz.js are kept, real imports here (no vm-slicing); rag-backend.js
// and chat.js are archived (services/minecraft-bots-archive-11-2026/), so their old checks become
// test.todo rather than a misleading fail. See services/minecraft-bots-archive-11-2026/ for what
// this measures against. Run: node --test services/minecraft-bots/tests/legacy-baseline/services.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { callRole } from "../../router.js";
import { watchTopic } from "../../buzz.js";
import { sleep } from "./_mockbot.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const indexSrc = await readFile(root + "index.js", "utf8");

test('[legacy:services] S27f analysis mode is opt-in on router.js\'s callRole (the X-Hermes-Screening header)', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url, opts) => {
    seen.push(opts.headers);
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) });
  };
  try {
    await callRole("dispatch", [], {});
    assert.equal(seen[0]["X-Hermes-Screening"], undefined,
      "screening must be the default -- an omitted flag must never mean \"skip Layer 2\"");
    await callRole("dispatch", [], { analysis: true });
    assert.equal(seen[1]["X-Hermes-Screening"], "analysis", "analysis: true must set the header");
    await callRole("dispatch", [], { analysis: false });
    assert.equal(seen[2]["X-Hermes-Screening"], undefined, "analysis: false must not set it");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("[legacy:services] S34 security invariant: index.js's player-facing callRole site never carries a literal analysis:true", async () => {
  // index.js has exactly two callRole("muse", ...) sites: decisionTick() and handleChatMessage().
  // decisionTick()'s messages include conversationHistory, which handleChatMessage() can fill with
  // raw, untrusted player/whisper/Matrix text -- so decisionTick must never hand it a bare
  // analysis:true literal (found live during this suite's own porting, 2026-11-27, and fixed in
  // index.js 4.2.0: analysis is now `conversationHistory.every((h) => h.trusted)`, computed fresh
  // every call; see tests/legacy-baseline/control.test.mjs's MB-23/S34 check for the full account).
  // handleChatMessage() itself carries `${speaker}: ${message}` directly and must stay screened,
  // unchanged from before.
  const sites = [...indexSrc.matchAll(/callRole\("muse",\s*messages,\s*\{[^}]*\}\)/g)];
  assert.equal(sites.length, 2, `expected exactly 2 callRole("muse", ...) call sites, found ${sites.length}`);
  assert.equal(sites.filter((m) => /analysis:\s*true\b/.test(m[0])).length, 0,
    "no callRole(\"muse\", ...) site may carry a bare analysis:true literal -- decisionTick's messages can include untrusted history");

  const decisionTickBody = indexSrc.slice(
    indexSrc.indexOf("async function decisionTick("), indexSrc.indexOf("async function handleChatMessage("));
  const chatBody = indexSrc.slice(indexSrc.indexOf("async function handleChatMessage("));
  assert.match(decisionTickBody, /analysis:\s*allTrusted\b/,
    "decisionTick's analysis flag must be computed from history's actual trust, not a literal");
  assert.doesNotMatch(chatBody.slice(0, chatBody.indexOf("bot.on(\"chat\"")), /analysis:\s*true\b/,
    "handleChatMessage carries `${speaker}: ${message}` (player/whisper/Matrix text) and must stay screened");
});

test("[legacy:services] spark2 RAG: remote mode sends search/read/write/ingest to spark with the bot token",
  { todo: "NOT PORTED: rag-backend.js is archived (services/minecraft-bots-archive-11-2026/rag-backend.js) -- long-term/RAG memory was deliberately replaced with a bounded in-process rolling chat history (index.js 4.0.0 header); there is no remote-RAG mode left to test." },
  () => {});

test("[legacy:services] Buzz: a (re)started bot starts reading at the newest message, never replaying the topic's history", async () => {
  const history = Array.from({ length: 450 }, (_, k) => ({ seq: k + 1, from_agent: "mc-amy", body: "{}" }));
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    if (u.pathname !== "/messages/poll") return { ok: false, status: 404, text: async () => "{}" };
    const since = Number(u.searchParams.get("since") ?? 0);
    const limit = Math.min(Number(u.searchParams.get("limit") ?? 50), 200);
    const messages = history.filter((m) => m.seq > since).slice(0, limit);
    return { ok: true, json: async () => ({ messages }) };
  };
  let timer = null;
  try {
    const heard = [];
    timer = watchTopic({ topic: "minecraft-coordination", selfAgent: "mc-babs", intervalMs: 5, onMessage: (m) => heard.push(m.seq) });
    await sleep(60);
    assert.deepEqual(heard, [], "none of the 450 old messages is replayed (more than one page of history)");
    history.push({ seq: 451, from_agent: "mc-amy", body: "{}" }, { seq: 452, from_agent: "mc-babs", body: "{}" });
    await sleep(40);
    assert.deepEqual(heard, [451], "a message sent after the start is heard; her own is not");
    assert(asked.every((a) => a.startsWith("/messages/poll?")), "only the poll route, which every deployed bus has");
  } finally {
    clearInterval(timer);
    globalThis.fetch = realFetch;
  }
});

test("[legacy:services] narrateAction is a deterministic pass-through, capped at MAX_CHAT_LEN, no router call",
  { todo: "NOT PORTED: chat.js (narrateAction) is archived (services/minecraft-bots-archive-11-2026/chat.js). index.js 4.0.0 chats the model's own reply text directly (stripped of !command tokens) -- there is no separate narration-rephrasing call left to test." },
  () => {});
