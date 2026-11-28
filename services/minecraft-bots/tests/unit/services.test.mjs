// Version: 1.3.0
//
// 1.3.0 (2026-11-28): direct instruction ("make sure minecraft traffic is exempt from the
// HermesGuard injection detection systems") -- router.js 1.3.0 now sends
// X-Hermes-Screening: analysis unconditionally, on every call, regardless of the `analysis` flag
// a call site passes. Rewrote the S27f/S34 check's router-level assertions to match (they
// previously required the header to be ABSENT by default and on `analysis: false` -- now true
// unconditionally for ALL three). Dropped the chatSites source-scan half of that same check: it
// asserted classifyIntent()/generateReply()/maybeRemember() (chat.js, archived along with the rest
// of the pre-4.0.0 engine -- confirmed missing from the live services/minecraft-bots/ entirely)
// gate their `analysis` flag on `fromVerifiedBot`, never a bare literal. That requirement is now
// moot regardless: no call site needs gating when Layer 2 never blocks anything from this service.
// Already-dead code aside, this scan could never have run anyway -- see
// tests/unit/stuck-burst.test.mjs's header for how much further tests/unit/_harness.mjs's own
// breakage goes than previously documented.
//
// 1.2.0 (2026-11-16): narrateAction() check -- it no longer calls muse (chat.js 1.1.0,
// HermesAgentV6/IMPLEMENTATION_PLAN.md §5a/§9.7). Imports chatSrc from the harness.
// 1.1.0 (2026-11-10): slices read the split modules (actions/*.js via actionCases/actionHandlerSrc, the modules out of index.js via index/indexOnly), and sandboxes stub guardedInterval.
//
// Unit checks: fleet services: RAG, Buzz and analysis mode.
// Split out of ../unit.test.mjs on 2026-11-10. Run every file: node tests/unit.test.mjs;
// this one alone: node tests/unit/services.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { root, skills, between, sleep, check, router, ragContext, slice, chatSrc, passedCount } from './_harness.mjs';


await check('router.js 1.3.0: every minecraft-bots call is unconditionally exempt from a Layer 2 block', async () => {
  // Direct instruction, 2026-11-28: "make sure minecraft traffic is exempt from the HermesGuard
  // injection detection systems." Supersedes the S27f/S34 per-call-site design this check used to
  // verify (every call now declares analysis mode, full stop -- see router.js's own 1.3.0 header
  // for the real tradeoff this accepts and why).
  const seen = [];
  const c = vm.createContext({
    process: { env: {} }, AbortSignal, JSON,
    fetch: (_url, opts) => { seen.push(opts.headers); return Promise.resolve({
      ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }); },
  });
  vm.runInContext(between(router, 'const ROUTER_URL').replace(/export /g, ''), c);

  await c.callRole('dispatch', [], {});
  await c.callRole('dispatch', [], { analysis: true });
  await c.callRole('dispatch', [], { analysis: false });
  assert.deepEqual(seen.map((h) => h['X-Hermes-Screening']), ['analysis', 'analysis', 'analysis'],
    'the header must be set on every call, regardless of what (if anything) the caller passes');
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

await check('narrateAction is a deterministic pass-through, capped at MAX_CHAT_LEN, no router call (HermesAgentV6 IMPLEMENTATION_PLAN.md §5a/§9.7)', async () => {
  // narrateAction was the highest-frequency muse caller in the whole service (goal-tick.js alone
  // has nine call sites). It used to ask muse to restate its argument "without changing its
  // meaning" -- every caller already writes chat-ready text, so the call only ever bought wording
  // variation. callRole/persona are stubbed here (not omitted) so a regression that calls either
  // is caught as "called the router", not just as a ReferenceError on an undefined name.
  let called = false;
  const c = vm.createContext({
    MAX_CHAT_LEN: 50, persona: 'stub persona',
    callRole: async () => { called = true; return 'rephrased by muse'; },
  });
  vm.runInContext(between(chatSrc, 'export async function narrateAction(', '// Direct request, 2026-09-11'), c);

  const short = await c.narrateAction('goal complete: get a stone pickaxe.');
  assert.equal(short, 'goal complete: get a stone pickaxe.',
    'text must pass through unchanged -- no rephrasing call to make');
  assert.equal(called, false,
    'narrateAction must not call the router at all');

  const long = await c.narrateAction('x'.repeat(80));
  assert.equal(long.length, 50, 'still caps at MAX_CHAT_LEN, the same contract callers already rely on');
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${passedCount()} unit checks passed.`);
