#!/usr/bin/env python3
# Version: 1.2.1
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default and the judge-model
# User-Agent string repointed from HermesAgentV4 to HermesAgentV5.
#
# 1.2.0 (2026-08-26) -- real bug found on the first real chat-completion call (spark, free model
# meituan/longcat-2.0:free): the response carried no `usage.cost` field at all, tripping the
# generic "ledger under-counts" warning even though a free model's real cost genuinely is 0, not
# unknown. Confirmed live that a free model's response omits the field entirely rather than
# sending 0, so "missing" alone can't be read as "definitely free." Fixed: missing cost now
# resolves to 0.0 (no warning) when the model was selected as free; when a PAID model's response
# is missing usage.cost -- the real gap this warning exists for -- it now falls back to logging
# the pre-flight cost estimate instead of silently under-counting, and still warns loudly.
#
# 1.1.0 (2026-08-26) -- real bug found on first live exercise on `spark`: Nous Portal's edge
# (Cloudflare or similar) returns a bare 403 for urllib's default `User-Agent: Python-urllib/3.x`
# specifically -- confirmed live by curl comparison: curl's own default UA got a real 200, the
# same request re-sent with `-A 'Python-urllib/3.12'` got the same 403 this script hit, and both
# a plain honest custom UA and `python-requests/2.31.0` got a clean 200. Not a credential problem
# (the real key, fetched live from Vaultwarden, was confirmed correct by prefix before this was
# root-caused) and not a blanket anti-scripting block (python-requests passes) -- just that one
# specific default string. Fixed by setting an explicit, honest User-Agent below.
"""
hermes-nous-judge.py — Nous Research Portal as an external code-judge and failsafe
(IMPLEMENTATION_PLAN.md Stage 18).

Two independent call paths, sharing one ledger and one circuit breaker:

  judge     — grade/compare locally-generated code candidates (`coder`, or any sibling
              candidates) via a neutral outside model, specifically because a sibling model
              grading another has the same self-grading-bias problem `coder`'s own bake-off
              (hermes-router.py 2.1.0) already showed can't be trusted from self-report alone.
              This is a fallback for what execution can't settle (several candidates that all
              pass, no test harness, style/approach calls) — it does NOT replace Stage 14/16's
              real execution-verified benchmarking anywhere that's available. Constraint 6 (§5)
              applies here just as much as anywhere else: this is one more model's opinion, not
              ground truth.
  failsafe  — stand in when nano/super/coder are unreachable, so a request degrades to a real
              answer instead of a dead 502.

Deliberately NOT a hermes-router.py role. That router's ROLES map is for fleet-hosted,
broker-wakeable backends — Stage 11's Hindsight trial already found it correctly rejects a cloud
model name for exactly that reason (no cloud key, no new Vaultwarden entry needed for that
router at all). Constraint 2 (§5, narrow purpose-built tools over general-purpose ones) is the
same reason this is its own small script rather than a new ROLES entry. Talks straight to Nous's
OpenAI-compatible endpoint, the same way Weaver's own direct Tailscale exposure already bypasses
hermes-router for a different reason.

Rule of engagement, enforced here: prefer $0/token Nous-published models first, cheap ones next
under a fixed per-call ceiling, real money never above that ceiling regardless of remaining
budget headroom — "prefer free" only means something if there's no back-door escalation to an
expensive model. Hard-capped at $22.00/mo (user-confirmed 2026-08-26, matches the Portal's own
"Plus" tier's native monthly credit allotment). Over cap -> hard stop for the REST OF THE CYCLE,
no exceptions, including the failsafe path: if local models are also down when the cycle is
already exhausted, the caller gets a clean error, never a silent escalation to some other paid
provider.

Credential: tools/vault-get-secret.sh Hermes-NousPortalKey password — a plain static API key
(confirmed live 2026-08-26 directly from the Portal's own admin page: `Authorization: Bearer
sk-nous-...` against a real sample request), same flock-serialized fetch path every other
credential in this fleet already uses (§2b). No OAuth/JWT step needed — that mechanism, found in
Hermes Agent's own `hermes setup --portal` integration doc, turned out to be that product's
higher-level onboarding flow, not the raw Portal API this script calls directly.

Model selection: GET /v1/models is OpenRouter-shaped (confirmed live 2026-08-26) — each entry
carries `pricing: {prompt, completion, ...}` as decimal-string $/token; a real free entry
(`meituan/longcat-2.0:free`) had both `pricing.prompt`/`pricing.completion` == "0.0000000000" AND
an id ending `:free`. Treat the numeric pricing fields as authoritative (parse as float, check
== 0); the `:free` suffix is a redundant secondary signal, not the primary one. There is no
capability ranking available for "which free model is best" — PREFERRED_FREE_MODELS below is a
plain ordered override list for when a real preference is known; absent that, this falls back to
the crudest available proxy (largest context_length among $0 models) and says so loudly rather
than pretending it's a real quality ranking.

Notification — both channels reuse existing plumbing, nothing new:
  - Email: the exact path hermes-canary-health.py / hermes-usage-report.py / hermes-nfsensei-
    watch.py already share — vault-get-secret.sh email-sintra password, mail.hover.com:587, from
    mercury@canislupisnc.net to notifications@canislupisnc.net.
  - Matrix: the same best-effort matrix_notice() shape hermes-router.py already implements —
    post into FleetOps, never raises, degrades to a skipped notice if the token's unset.
  - Notify-once: tools/hermes-session-cap-guard.sh's own poll/cap/state-file pattern — a small
    JSON file remembers whether this cycle's exhaustion notice already fired, so the alert fires
    once on the crossing, not on every blocked call after.

STILL OPEN, not yet live-verified (Stage 18 §6 lists these as of 2026-08-26):
  - The Portal's real billing-cycle reset date — NOUS_BILLING_ANCHOR_DAY below defaults to 1 and
    prints a loud warning every run until a real value is confirmed and set. Do not trust the
    cycle math against the real subscription until this is fixed.
  - Whether every /v1/models entry follows the `~provider/model-name` convention seen in the
    original sample vs. the plain `provider/model[:variant]` shape seen in the live models-list
    evidence gathered afterward — this script uses ids exactly as /v1/models returns them and
    never invents a `~` prefix, but that discrepancy itself is unexplained.
  - Never exercised against a real call end to end. Written to design, not deployed
    (IMPLEMENTATION_PLAN.md §0 S18) — run tools/hermes-nous-judge.py --dry-run first, then one
    real --path failsafe smoke test, before wiring this into any live skill/persona flow.

Config, all from the environment (same convention as hermes-router.py):
  HERMES_REPO_DIR         default ~/HermesAgentV5
  NOUS_BASE_URL           default https://inference-api.nousresearch.com
  NOUS_VAULT_ITEM         default Hermes-NousPortalKey
  NOUS_MONTHLY_CAP_USD    default 22.00 (user-confirmed 2026-08-26)
  NOUS_BILLING_ANCHOR_DAY default 1 -- UNVERIFIED, see above, set the real renewal day-of-month
  NOUS_MAX_CALL_CEILING_USD  default 0.05 -- never spend more than this on a single paid-tier
                             call regardless of remaining budget; the user's own dial to tune,
                             not a value verified against real usage patterns
  NOUS_PREFERRED_FREE_MODELS  optional, comma-separated ordered list of exact /v1/models ids to
                             prefer over the largest-context_length fallback heuristic
  MATRIX_HOMESERVER      default http://127.0.0.1:6167 (same default hermes-router.py uses)
  FLEETOPS_MATRIX_TOKEN  optional -- notices skipped with a one-time warning if unset
  FLEETOPS_ROOM          optional
  HERMES_NOUS_STATE_FILE default ~/.hermes/state/nous-budget-state.json
  HERMES_NOUS_USAGE_DB   see hermes_nous_usage_log.py, default ~/.hermes/state/nous_usage.db
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_nous_usage_log as ledger  # noqa: E402

REPO_DIR = os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5"))
VAULT_GET = f"{REPO_DIR}/tools/vault-get-secret.sh"

BASE_URL = os.environ.get("NOUS_BASE_URL", "https://inference-api.nousresearch.com").rstrip("/")
VAULT_ITEM = os.environ.get("NOUS_VAULT_ITEM", "Hermes-NousPortalKey")

MONTHLY_CAP_USD = float(os.environ.get("NOUS_MONTHLY_CAP_USD", "22.00"))
BILLING_ANCHOR_DAY = int(os.environ.get("NOUS_BILLING_ANCHOR_DAY", "1"))
MAX_CALL_CEILING_USD = float(os.environ.get("NOUS_MAX_CALL_CEILING_USD", "0.05"))
PREFERRED_FREE_MODELS = [
    m.strip() for m in os.environ.get("NOUS_PREFERRED_FREE_MODELS", "").split(",") if m.strip()
]

MATRIX_HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "http://127.0.0.1:6167")
FLEETOPS_TOKEN = os.environ.get("FLEETOPS_MATRIX_TOKEN", "")
FLEETOPS_ROOM = os.environ.get("FLEETOPS_ROOM", "")

STATE_FILE = Path(os.environ.get("HERMES_NOUS_STATE_FILE", str(Path.home() / ".hermes" / "state" / "nous-budget-state.json")))

REQUEST_TIMEOUT_S = 120

# Nous Portal's edge blocks urllib's own default User-Agent (Python-urllib/3.x) with a bare 403 --
# confirmed live 2026-08-26 by curl comparison (see 1.1.0 note above). Any honest, non-default
# string clears it; this just identifies the tool rather than spoofing another client.
USER_AGENT = "HermesAgentV5-hermes-nous-judge/1.2.0"


def log(msg):
    print(f"[hermes-nous-judge] {msg}", flush=True)


if BILLING_ANCHOR_DAY == 1 and "NOUS_BILLING_ANCHOR_DAY" not in os.environ:
    log("WARNING: NOUS_BILLING_ANCHOR_DAY not set, defaulting to day 1 -- this is a PLACEHOLDER, "
        "not confirmed against the real Nous Portal subscription (Stage 18 §6 gate 4). Cycle "
        "totals below may not line up with the real billing cycle until this is fixed.")


# ---------------------------------------------------------------------------
# Vaultwarden credential fetch -- same subprocess-wrapped pattern
# hermes-nfsensei-watch.py's vault_get() already uses, including the
# TimeoutExpired handling its own 1.1.0 fix added after a real Vaultwarden
# outage crashed a caller that assumed the fetch would always return quickly.
# ---------------------------------------------------------------------------
def vault_get(item: str, field: str = "password") -> str:
    try:
        result = subprocess.run(
            [VAULT_GET, item, field], capture_output=True, text=True, timeout=150,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"vault-get-secret.sh timed out fetching {item!r}/{field!r}")
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"vault-get-secret.sh failed for {item!r}/{field!r}: {result.stderr.strip()}")
    return result.stdout.strip()


# ---------------------------------------------------------------------------
# Notification -- both channels reuse existing fleet plumbing verbatim.
# ---------------------------------------------------------------------------
def send_email(subject: str, body: str) -> bool:
    import smtplib
    from email.mime.text import MIMEText

    try:
        password = vault_get("email-sintra", "password")
        msg = MIMEText(body)
        msg["From"], msg["To"], msg["Subject"] = (
            "mercury@canislupisnc.net", "notifications@canislupisnc.net", subject,
        )
        with smtplib.SMTP("mail.hover.com", 587, timeout=30) as s:
            s.starttls()
            s.login("mercury@canislupisnc.net", password)
            s.sendmail("mercury@canislupisnc.net", ["notifications@canislupisnc.net"], msg.as_string())
        return True
    except Exception as exc:
        log(f"email notification failed: {exc}")
        return False


def matrix_notice(text: str) -> None:
    """Best-effort real-time notice to FleetOps -- copied from hermes-router.py's own
    matrix_notice(). Never raises; a notice failure must not affect the caller."""
    if not FLEETOPS_TOKEN or not FLEETOPS_ROOM:
        log("Matrix notice skipped -- FLEETOPS_MATRIX_TOKEN/FLEETOPS_ROOM not set")
        return
    try:
        txn = f"nous-judge-note-{int(time.time() * 1000)}"
        req = urllib.request.Request(
            f"{MATRIX_HOMESERVER}/_matrix/client/v3/rooms/"
            f"{urllib.parse.quote(FLEETOPS_ROOM)}/send/m.room.message/{txn}",
            data=json.dumps({"msgtype": "m.notice", "body": text}).encode(),
            method="PUT",
            headers={"Authorization": f"Bearer {FLEETOPS_TOKEN}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as exc:
        log(f"Matrix notice delivery failed: {exc}")


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def _save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state))


def notify_budget_exhausted_once(cycle_start_iso: str, cycle_total: float, path: str, model: str) -> None:
    """Fires the exhaustion notice exactly once per billing cycle -- tracked by cycle-start date
    in the state file, same idempotent-notify shape hermes-session-cap-guard.sh already uses for
    session rotation. Cleared automatically once a new cycle's start date differs from the
    recorded one."""
    state = _load_state()
    if state.get("last_notified_cycle") == cycle_start_iso:
        return  # already notified for this cycle

    subject = f"Nous Portal budget exhausted -- ${cycle_total:.2f} of ${MONTHLY_CAP_USD:.2f}"
    body = (
        f"Nous Research Portal spend for the cycle starting {cycle_start_iso} has reached "
        f"${cycle_total:.2f} against the ${MONTHLY_CAP_USD:.2f}/mo hard cap.\n\n"
        f"Triggering call: path={path}, model={model}\n\n"
        f"No further Nous Portal calls (judge or failsafe) will be made until the next billing "
        f"cycle. This is by design (IMPLEMENTATION_PLAN.md Stage 18) -- 'prefer free' only means "
        f"something if there's no back-door escalation once the cap is hit."
    )
    emailed = send_email(subject, body)
    matrix_notice(f"[nous-judge] BUDGET EXHAUSTED: ${cycle_total:.2f}/${MONTHLY_CAP_USD:.2f} this "
                  f"cycle (triggered by {path}/{model}). No further Nous calls until next cycle. "
                  f"Email {'sent' if emailed else 'FAILED, check logs'}.")
    state["last_notified_cycle"] = cycle_start_iso
    _save_state(state)


# ---------------------------------------------------------------------------
# Nous Portal HTTP calls
# ---------------------------------------------------------------------------
def _nous_request(method: str, path: str, api_key: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
                 "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_models(api_key: str) -> list:
    return _nous_request("GET", "/v1/models", api_key).get("data", [])


def _price_per_token(model: dict, kind: str) -> float:
    try:
        return float(model.get("pricing", {}).get(kind, "0"))
    except (TypeError, ValueError):
        return 0.0


def pick_model(models: list) -> dict:
    """Free-first selection (Stage 18 §6 gate 5): $0/token models ranked by
    NOUS_PREFERRED_FREE_MODELS first, else the crudest available proxy (largest context_length --
    NOT a real capability ranking, flagged loudly rather than silently trusted). Falls back to the
    cheapest paid model whose estimated per-call cost clears NOUS_MAX_CALL_CEILING_USD only if no
    free model is available at all."""
    free = [m for m in models if _price_per_token(m, "prompt") == 0.0 and _price_per_token(m, "completion") == 0.0]

    if free:
        for preferred_id in PREFERRED_FREE_MODELS:
            match = next((m for m in free if m.get("id") == preferred_id), None)
            if match:
                return match
        log("NOUS_PREFERRED_FREE_MODELS unset or no match -- falling back to largest "
            "context_length among free models as a heuristic, NOT a real capability ranking")
        return max(free, key=lambda m: m.get("context_length", 0))

    log("WARNING: no $0/token model currently available on this Portal account -- "
        "falling back to cheapest paid model under the per-call ceiling")
    paid = sorted(models, key=lambda m: _price_per_token(m, "prompt") + _price_per_token(m, "completion"))
    if not paid:
        raise RuntimeError("Nous Portal /v1/models returned no models at all")
    return paid[0]


def _estimate_call_cost_usd(model: dict, prompt_chars: int, max_tokens: int) -> float:
    """Rough pre-flight estimate (chars/4 as a token proxy, same crude approximation this fleet's
    own tools use elsewhere when a real tokenizer isn't available) -- used only to keep a paid-tier
    call under NOUS_MAX_CALL_CEILING_USD before spending real money; the real cost logged
    afterward always comes from Nous's own `usage.cost`, never this estimate."""
    est_prompt_tokens = max(1, prompt_chars // 4)
    return est_prompt_tokens * _price_per_token(model, "prompt") + max_tokens * _price_per_token(model, "completion")


def call_nous(messages: list, path: str, max_tokens: int = 1024) -> dict:
    """Main entry point. `path` is "judge" or "failsafe" -- logged for cost attribution only,
    both share the same budget ledger and circuit breaker. Raises RuntimeError on any
    circuit-breaker trip or hard failure; callers on the failsafe path must treat that as a clean
    error, never a silent escalation to some other paid provider (Stage 18's whole point)."""
    cycle_start = ledger.current_cycle_start(BILLING_ANCHOR_DAY)
    cycle_total = ledger.cycle_total_usd(BILLING_ANCHOR_DAY)

    if cycle_total >= MONTHLY_CAP_USD:
        notify_budget_exhausted_once(cycle_start.isoformat(), cycle_total, path, model="(pre-flight, none picked)")
        raise RuntimeError(
            f"Nous Portal ${MONTHLY_CAP_USD:.2f}/mo cap already reached this cycle "
            f"(${cycle_total:.2f} spent since {cycle_start.isoformat()}) -- no more calls until "
            f"the next cycle. Not falling back to any other paid provider, by design."
        )

    api_key = vault_get(VAULT_ITEM, "password")
    models = fetch_models(api_key)
    model = pick_model(models)
    model_id = model["id"]

    prompt_chars = sum(len(str(m.get("content", ""))) for m in messages)
    is_free = _price_per_token(model, "prompt") == 0.0 and _price_per_token(model, "completion") == 0.0
    # Computed unconditionally (naturally 0.0 for a free model, since both pricing fields are 0)
    # so it's available below as a conservative fallback if the real response omits usage.cost --
    # confirmed live 2026-08-26 that a free model's response omits the field entirely rather than
    # sending 0, so "missing" alone can't be trusted to mean "definitely free."
    est_cost = _estimate_call_cost_usd(model, prompt_chars, max_tokens)
    if not is_free:
        if est_cost > MAX_CALL_CEILING_USD:
            raise RuntimeError(
                f"cheapest available model {model_id!r} estimated at ${est_cost:.4f} for this "
                f"call, over the ${MAX_CALL_CEILING_USD:.2f} per-call ceiling -- refusing rather "
                f"than silently spending more than configured"
            )
        remaining = MONTHLY_CAP_USD - cycle_total
        if est_cost > remaining:
            notify_budget_exhausted_once(cycle_start.isoformat(), cycle_total, path, model_id)
            raise RuntimeError(
                f"estimated cost ${est_cost:.4f} would exceed the ${remaining:.2f} left in this "
                f"cycle's ${MONTHLY_CAP_USD:.2f} cap -- refusing rather than risk overshoot"
            )

    body = {"model": model_id, "messages": messages, "max_tokens": max_tokens}
    try:
        response = _nous_request("POST", "/v1/chat/completions", api_key, body)
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        ledger.log_request(path=path, model=model_id, status="error", error_message=str(exc))
        raise RuntimeError(f"Nous Portal call failed: {exc}") from exc

    usage = response.get("usage", {}) or {}
    cost_usd = usage.get("cost")
    if cost_usd is None:
        if is_free:
            # Confirmed live 2026-08-26 (meituan/longcat-2.0:free): a genuinely free model's
            # response omits usage.cost entirely rather than sending 0 -- real cost is 0, this
            # isn't a gap, just log it plainly rather than the estimate below.
            cost_usd = 0.0
        else:
            # A PAID model with no usage.cost in its response is the real gap this once-uniform
            # warning used to fire on for both cases -- fall back to the pre-flight estimate
            # (conservative-ish, real tokens weren't known yet when it was computed) rather than
            # silently logging 0 and under-counting real spend against the cap.
            cost_usd = est_cost
            log(f"WARNING: paid model {model_id!r} response carried no usage.cost -- logged the "
                f"pre-flight estimate (${est_cost:.4f}) instead; investigate before trusting "
                f"cycle totals near the cap")

    ledger.log_request(
        path=path, model=model_id, status="ok",
        prompt_tokens=usage.get("prompt_tokens"), completion_tokens=usage.get("completion_tokens"),
        total_tokens=usage.get("total_tokens"), cost_usd=cost_usd,
    )

    new_total = cycle_total + cost_usd
    if new_total >= MONTHLY_CAP_USD:
        notify_budget_exhausted_once(cycle_start.isoformat(), new_total, path, model_id)

    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--path", choices=["judge", "failsafe"], default="failsafe")
    parser.add_argument("--prompt", default="How much wood would a theoretical 80kg woodchuck "
                                             "chuck? Assume a competitive environment.")
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--dry-run", action="store_true",
                         help="show cycle status and picked model, make no real API call")
    args = parser.parse_args()

    ledger.init_db()
    cycle_start = ledger.current_cycle_start(BILLING_ANCHOR_DAY)
    cycle_total = ledger.cycle_total_usd(BILLING_ANCHOR_DAY)
    log(f"billing cycle started {cycle_start.isoformat()}: ${cycle_total:.2f} of "
        f"${MONTHLY_CAP_USD:.2f} spent")

    if args.dry_run:
        api_key = vault_get(VAULT_ITEM, "password")
        models = fetch_models(api_key)
        model = pick_model(models)
        log(f"dry run only -- would call model {model['id']!r} "
            f"(free={_price_per_token(model, 'prompt') == 0.0})")
        return

    response = call_nous([{"role": "user", "content": args.prompt}], path=args.path,
                          max_tokens=args.max_tokens)
    print(json.dumps(response, indent=2))


if __name__ == "__main__":
    main()
