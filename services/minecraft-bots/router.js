// Version: 1.0.0
//
// Thin client for hermes-router.py's OpenAI-compatible proxy. Localhost-only by design --
// hermes-router.py binds 127.0.0.1 by default (see tools/hermes-router.py's BIND/PORT) and
// proxies to whichever node actually serves a role, so this only needs to reach the router
// instance on the SAME fleet node the orchestrator runs on (spark). Every request already gets
// hermes-router's own two-layer injection-guard screening for free -- no separate guard call
// needed here.

const ROUTER_URL = process.env.HERMES_ROUTER_URL || "http://127.0.0.1:8080/v1/chat/completions";

export async function callRole(role, messages, { maxTokens = 200, temperature = 0.9 } = {}) {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: role, messages, max_tokens: maxTokens, temperature }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`hermes-router ${role} call failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
