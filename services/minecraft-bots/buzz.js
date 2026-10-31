// Version: 1.0.1
//
// Thin client for hermes-buzz.py -- bot-to-bot coordination (MINECRAFT_BOTS_DESIGN.md §9).
// `mc-babs`/`mc-amy` (KNOWN_AGENTS) and `minecraft` (KNOWN_TOPICS) were added to
// hermes-buzz.py 2.0.16 specifically for this. Bearer-token authenticated, same fetch-once-
// at-startup pattern as memory.js's MEMORY_TOKEN (see run-bot.sh). Best-effort throughout: a
// Buzz outage means bots stop hearing each other, never a crash.

const BUZZ_URL = process.env.BUZZ_URL || "http://10.129.1.15:8101";
const BUZZ_TOKEN = process.env.BUZZ_TOKEN || "";

async function request(method, path, body) {
  const res = await fetch(`${BUZZ_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(BUZZ_TOKEN ? { Authorization: `Bearer ${BUZZ_TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hermes-buzz ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function publish(from, topic, body) {
  return request("POST", "/messages", { from, topic, body });
}

export async function pollSince(topic, since, limit = null) {
  const data = await request("GET", `/messages/poll?topic=${encodeURIComponent(topic)}&since=${since}` +
    (limit ? `&limit=${limit}` : ""));
  return data.messages ?? [];
}

// The topic's newest seq, read through without delivering anything. Paged through the poll route
// itself, the one route every bus here has -- the live-bot tests' fake bus has no GET /messages.
export async function newestSeq(topic) {
  let since = 0;
  for (;;) {
    const page = await pollSince(topic, since, 200);
    if (!page.length) return since;
    since = page[page.length - 1].seq;
  }
}

// Polls a topic on an interval, calling onMessage for every message not sent by `selfAgent`.
// The first poll only establishes the starting cursor (at whatever's currently newest) and
// never fires onMessage -- a freshly (re)started bot shouldn't replay the whole topic history,
// including messages from before it existed.
export function watchTopic({ topic, selfAgent, intervalMs = 5000, onMessage }) {
  let since = 0;
  let primed = false;
  let polling = false;

  async function tick() {
    if (polling) return; // reading through the history can outlast a tick; never run two at once
    polling = true;
    try {
      // 2026-10-30: the cursor starts at the bus's newest message. It used to start at the last of
      // the first poll's page -- but a poll returns the OLDEST 50 after `since`, so a restarted bot
      // walked the topic's whole history 50 messages per tick: two hours after Babs restarted she
      // was still "hearing" offline bots' goals and deaths, and claiming their stale item requests.
      if (!primed) {
        const startedAt = Date.now();
        since = await newestSeq(topic);
        primed = true;
        console.log(`[buzz] '${topic}': listening from seq ${since} (read past history in ${Date.now() - startedAt}ms)`);
        return;
      }
      const messages = await pollSince(topic, since);
      if (messages.length) {
        since = messages[messages.length - 1].seq;
        for (const m of messages) {
          if (m.from_agent !== selfAgent) onMessage(m);
        }
      }
    } catch (err) {
      console.error(`[buzz] poll failed for topic '${topic}':`, err.message);
    } finally {
      polling = false;
    }
  }

  tick();
  return setInterval(tick, intervalMs);
}
