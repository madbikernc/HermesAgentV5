// Version: 1.0.0
//
// Thin client for the shared Matrix room (MINECRAFT_BOTS_DESIGN.md §10 -- a single shared room,
// operator + all bots, per the operator's own decision, not one room per bot like the
// retired Sintra/Amy pattern). Talks to Continuwuity's plain Matrix Client-Server API directly
// over HTTP -- no dependency on the fleet's old "hermes gateway" tooling, which was built
// around that different per-agent-room architecture and isn't a fit here. Best-effort: a
// Matrix outage means bots stop hearing/speaking there, never a crash.

async function syncOnce(homeserver, accessToken, since, timeoutMs) {
  const url = new URL(`${homeserver}/_matrix/client/v3/sync`);
  if (since) url.searchParams.set("since", since);
  url.searchParams.set("timeout", String(timeoutMs));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`matrix sync failed: ${res.status}`);
  return res.json();
}

// Long-polls /sync for new messages in one room. Like buzz.js's watchTopic, the first sync
// only establishes the starting cursor and never fires onMessage -- a freshly (re)started bot
// shouldn't replay the room's whole history.
export function watchRoom({ homeserver, accessToken, roomId, onMessage }) {
  let since;
  let primed = false;
  let stopped = false;

  async function loop() {
    while (!stopped) {
      try {
        const data = await syncOnce(homeserver, accessToken, since, primed ? 30000 : 0);
        since = data.next_batch;
        const events = data.rooms?.join?.[roomId]?.timeline?.events ?? [];
        if (primed) {
          for (const ev of events) {
            if (ev.type === "m.room.message" && ev.content?.body) {
              onMessage({ sender: ev.sender, body: ev.content.body });
            }
          }
        }
        primed = true;
      } catch (err) {
        console.error("[matrix] sync failed, retrying:", err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  loop();
  return () => { stopped = true; };
}

let txnCounter = 0;
export async function sendMessage({ homeserver, accessToken, roomId, body }) {
  const txn = `mc-${Date.now()}-${txnCounter++}`;
  const res = await fetch(
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body }),
    },
  );
  if (!res.ok) throw new Error(`matrix send failed: ${res.status}`);
  return res.json();
}
