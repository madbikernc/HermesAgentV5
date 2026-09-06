// Version: 1.0.0
//
// Thin client for hermes-memory.py -- persistent per-bot conversation memory (the design doc's
// "per-bot working state", see ../../MINECRAFT_BOTS_DESIGN.md §7). Bearer-token authenticated
// (see ../../infra/hermes-memory/README.md); MEMORY_TOKEN is fetched once at process start by
// run-babs.sh, the same fetch-once-at-startup pattern every other fleet caller of this service
// already uses -- not fetched per-call here.
//
// Every call is best-effort: a hermes-memory outage degrades a bot to stateless single-message
// replies (still functional, per generateReply's own fallback), never a crash -- same
// fail-open-on-infra-unavailability rule hermes-router.py's own guard calls already follow.

// hermes-memory.py binds MEMORY_BIND (default 0.0.0.0 in its own source, but this fleet's
// actual live instance on spark is configured to bind its LAN IP specifically, confirmed via
// `ss` -- 127.0.0.1 does not reach it, unlike hermes-router.py's genuinely loopback-bound
// instance). Default here matches the real live binding rather than the service's own
// documented default, which this deployment doesn't actually use.
const MEMORY_URL = process.env.MEMORY_URL || "http://10.129.1.15:8102";
const MEMORY_TOKEN = process.env.MEMORY_TOKEN || "";

async function request(method, path, body) {
  const res = await fetch(`${MEMORY_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(MEMORY_TOKEN ? { Authorization: `Bearer ${MEMORY_TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hermes-memory ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function recordTurn({ agent, taskId, convId, role, raw }) {
  return request("POST", "/turns", { agent, task_id: taskId, conv_id: convId, role, raw });
}

export async function recentTurns({ agent, convId, limit = 10 }) {
  const qs = new URLSearchParams({ agent, conv_id: convId, limit: String(limit) });
  const data = await request("GET", `/turns?${qs.toString()}`);
  return data.turns ?? [];
}
