# hermes-nous-judge — Nous Portal external judge + failsafe

**Version:** 1.3.0

See `IMPLEMENTATION_PLAN.md` Stage 18 for the full design account and the live-verification history
behind every decision here. This file is setup/ops notes only — the reasoning lives in the plan doc,
per constraint 7 (§5).

## Status

Fully exercised live on `spark` 2026-08-26 (ad hoc copy for the test, not committed/pushed): real
Vaultwarden fetch, real `/v1/models` call, real `/v1/chat/completions` call (free model, real
completion returned), real ledger write confirmed correct by direct `sqlite3` query. Two real bugs
found and fixed the same day — see `tools/hermes-nous-judge.py`'s own 1.1.0/1.2.0 header notes:
Nous Portal's edge blocklists urllib's default `Python-urllib/3.x` User-Agent with a bare 403; and a
free model's response omits `usage.cost` entirely, which briefly caused a false "ledger under-counts"
warning on every free-tier call. **Still not done:** nothing committed/pushed yet, and this isn't
wired into any live skill or persona flow.

## One-time setup, per node this runs on

1. Vaultwarden item `Hermes-NousPortalKey` must exist with the real Nous Portal API key
   (`sk-nous-...`) in its `password` field — same convention every other credential in this fleet
   uses. Fetch path: `tools/vault-get-secret.sh Hermes-NousPortalKey password`.
2. **`NOUS_BILLING_ANCHOR_DAY=26`** — confirmed 2026-08-26 against the real account
   (`portal.nousresearch.com/manage-subscription` showed the current cycle ending 2026-09-26,
   consistent with a monthly renewal anchored on the 26th). Set this explicitly wherever the
   script runs; the code still defaults to `1` and warns loudly if the env var is left unset, so an
   unset deployment fails visibly rather than silently under-tracking the cycle.
3. Optionally set `NOUS_PREFERRED_FREE_MODELS` (comma-separated exact `/v1/models` ids) once a real
   preference is known — absent that, model selection falls back to "largest `context_length` among
   $0/token models," a crude proxy, not a real capability ranking (Stage 18 §6 gate 5).
4. Reuses the fleet's existing `FLEETOPS_MATRIX_TOKEN`/`FLEETOPS_ROOM`/`MATRIX_HOMESERVER` env vars
   for the Matrix side of the budget-exhausted notice, and the existing `email-sintra` Vaultwarden
   item for the email side — no new credentials needed for notification.

## Config reference

See the module docstring at the top of `tools/hermes-nous-judge.py` for the full environment-variable
list and defaults — kept in one place rather than duplicated here to avoid the two drifting apart.

## Open items (Stage 18 §6, as of 2026-08-26)

- Whether every `/v1/models` entry follows the `~provider/model-name` convention seen in the
  Portal's own sample request, vs. the plain `provider/model[:variant]` shape seen in the live
  `/v1/models` listing gathered afterward — unexplained, not yet investigated further.
- Whether the missing-`usage.cost` behavior seen on `meituan/longcat-2.0:free` is universal to every
  free model or specific to that one — only one free model has been exercised live so far.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-26 | Initial version, alongside `tools/hermes-nous-judge.py`/`hermes_nous_usage_log.py` — design written and live-verified against Nous's real API, not yet deployed or end-to-end tested. |
| 1.1.0 | 2026-08-26 | Real billing-cycle anchor day confirmed against the account: day 26 (current cycle observed ending 2026-09-26). Removed from open items; documented as the concrete value to set rather than a placeholder. |
| 1.2.0 | 2026-08-26 | `--dry-run` verified live on `spark` — real Vaultwarden fetch, real `/v1/models` call, correct free-model selection. One real bug found and fixed same-day (urllib's default User-Agent blocked by Nous's edge, see `hermes-nous-judge.py` 1.1.0). Real chat-completion call still not exercised. |
| 1.3.0 | 2026-08-26 | First real `/v1/chat/completions` call, live on `spark` — real completion returned from the real free model. Second real bug found and fixed same-day (missing `usage.cost` on a free model's response falsely tripped the under-counting warning, see `hermes-nous-judge.py` 1.2.0); fix confirmed correct by direct `sqlite3` query against the real ledger, not just the script's own log output. Stage 18 is now fully exercised end to end; nothing committed/pushed yet. |
