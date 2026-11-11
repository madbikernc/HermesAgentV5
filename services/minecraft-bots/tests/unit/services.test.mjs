// Version: 1.0.0
//
// Unit checks: fleet services: RAG, Buzz and analysis mode.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/services.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { root, index, skills, between, sleep, check, router, ragContext, slice, passedCount } from './_harness.mjs';


await check('S27f analysis mode is opt-in, and the chat paths only opt in for a verified bot sender (S34)', async () => {
  // Regression for the 2026-10-09 breakage: S22d gave Layer 2 a screener that actually detects
  // injections, and it scored the bots' own planning prompt as malicious -- 189 blocked planning
  // calls in six hours. callRole() can now declare the payload is bot state, but player chat
  // must keep being screened, which is the half that is easy to get wrong silently.
  //
  // Widened 2026-10-21 (S34): classifyIntent()/generateReply() now conditionally pass
  // analysis: fromVerifiedBot (isAnotherBot(speaker)) at their own <speaker> content site --
  // this must stay tied to that verified-bot variable, never a bare `analysis: true` literal,
  // which would silently re-open "a player can type anything" for every one of these sites.
  const seen = [];
  const mkContext = () => vm.createContext({
    process: { env: {} }, AbortSignal, JSON,
    fetch: (_url, opts) => { seen.push(opts.headers); return Promise.resolve({
      ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }); },
  });

  const c = mkContext();
  vm.runInContext(between(router, 'const ROUTER_URL').replace(/export /g, ''), c);

  await c.callRole('dispatch', [], {});
  assert.equal(seen[0]['X-Hermes-Screening'], undefined,
    'screening must be the default -- an omitted flag must never mean "skip Layer 2"');

  await c.callRole('dispatch', [], { analysis: true });
  assert.equal(seen[1]['X-Hermes-Screening'], 'analysis', 'analysis: true must set the header');

  await c.callRole('dispatch', [], { analysis: false });
  assert.equal(seen[2]['X-Hermes-Screening'], undefined, 'analysis: false must not set it');

  // And the real call sites: every one that carries `<speaker> message` must either stay
  // unflagged (player chat, screened in full) or flag only via `fromVerifiedBot` -- never a
  // literal `analysis: true`, which has no way to tell a verified bot sender from a player.
  const src = await readFile(root + 'index.js', 'utf8');
  const lines = src.split(String.fromCharCode(10));
  const chatSites = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /\{ role: "user", content: `<\$\{speaker\}>/.test(l));
  assert(chatSites.length >= 3, 'expected to find the player-chat call sites');
  let conditionalSites = 0;
  for (const { i } of chatSites) {
    // the options object for a call site sits within ~40 lines after its user message --
    // generateReply()'s is the farthest, 36 lines away (its <speaker> content line builds
    // `history`, which the real callRole() invocation only joins in later, after the
    // memory-lookup/bossNote work in between); classifyIntent()'s and maybeRemember()'s are
    // both within 2. Found live on spark (2026-10-21): a 25-line window missed generateReply()
    // entirely and crashed the whole suite on an uncaught assertion -- the fix itself was
    // already correct, only this scan's window was too short.
    const window = lines.slice(i, i + 40).join(String.fromCharCode(10));
    const opts = window.match(/\{ *maxTokens:[^}]*\}/);
    if (!opts || !/analysis/.test(opts[0])) continue;
    assert(!/analysis:\s*true\b/.test(opts[0]),
      `index.js line ${i + 1}: a literal analysis:true on a <speaker> content site cannot tell a player from a bot -- found: ${opts[0]}`);
    assert(/analysis:\s*fromVerifiedBot\b/.test(opts[0]),
      `index.js line ${i + 1}: expected analysis tied to fromVerifiedBot, found: ${opts[0]}`);
    conditionalSites++;
  }
  assert.equal(conditionalSites, 2,
    'expected exactly classifyIntent() and generateReply() to carry the S34 verified-bot exemption; maybeRemember() deliberately stays unflagged');
});


await check('spark2 RAG: remote mode sends search/read/write/ingest to spark with the bot token', async () => {
  const sent = [];
  const c = ragContext({ RAG_URL: 'http://spark:8105', execFileAsync: async () => { throw new Error('must not run locally'); },
    fetch: async (url, opts) => {
      sent.push([url, JSON.parse(opts.body), opts.headers.Authorization]);
      const reply = url.endsWith('/search') ? { results: [{ text: 't', source_path: 'a.md', distance: 0.1 }] }
        : url.endsWith('/read') ? { content: '{"name":"x"}' } : { ok: true };
      return { ok: true, json: async () => reply };
    } });
  assert.equal((await c.ragSearch('oak', { corpus: 'minecraft', topK: 1 }))[0].source_path, 'a.md');
  assert.equal(await c.memRead('skills/x.json'), '{"name":"x"}');
  await c.memWrite('world/1-note.md', 'hi\n');
  await c.ragIngest('minecraft');
  assert.deepEqual(sent.map(([u, b, a]) => [u.split('/').pop(), a]),
    [['search', 'Bearer tok'], ['read', 'Bearer tok'], ['write', 'Bearer tok'], ['ingest', 'Bearer tok']]);
  assert.deepEqual({ ...sent[2][1] }, { path: 'world/1-note.md', content: 'hi\n' });
});


await check('Buzz: a (re)started bot starts reading at the newest message, never replaying the topic\'s history', async () => {
  // 2026-10-30: two hours after a restart Babs was still "hearing" offline bots' goals and deaths.
  // A poll returns the oldest 50 after `since`; the cursor started at the last of the first page.
  const history = Array.from({ length: 450 }, (_, k) => ({ seq: k + 1, from_agent: 'mc-amy', body: '{}' }));
  const realFetch = globalThis.fetch;
  const asked = [];
  // A bus with the poll route only (like live-bot's fake: GET /messages is a 404), oldest first, `limit` up to 200.
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    if (u.pathname !== '/messages/poll') return { ok: false, status: 404, text: async () => '{}' };
    const since = Number(u.searchParams.get('since') ?? 0);
    const limit = Math.min(Number(u.searchParams.get('limit') ?? 50), 200);
    const messages = history.filter((m) => m.seq > since).slice(0, limit);
    return { ok: true, json: async () => ({ messages }) };
  };
  let timer = null;
  try {
    const buzz = await import(pathToFileURL(root + 'buzz.js').href + '?t=' + Date.now());
    const heard = [];
    timer = buzz.watchTopic({ topic: 'minecraft-coordination', selfAgent: 'mc-babs', intervalMs: 5, onMessage: (m) => heard.push(m.seq) });
    await sleep(60);
    assert.deepEqual(heard, [], 'none of the 450 old messages is replayed (more than one page of history)');
    history.push({ seq: 451, from_agent: 'mc-amy', body: '{}' }, { seq: 452, from_agent: 'mc-babs', body: '{}' });
    await sleep(40);
    assert.deepEqual(heard, [451], 'a message sent after the start is heard; her own is not');
    assert(asked.every((a) => a.startsWith('/messages/poll?')), 'only the poll route, which every deployed bus has');
  } finally {
    clearInterval(timer);
    globalThis.fetch = realFetch;
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
