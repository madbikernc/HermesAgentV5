#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes_egress_guard.py — Layer 3: constrains what a real outbound network call is allowed to
target. Symmetric to Layer 1 (hermes_injection_guard.py) and Layer 2 (hermes-guard.py)'s INPUT
screens; this one screens OUTPUT — any destination a real call site is about to reach. Target
design: EGRESS_GUARD_DESIGN.md (IMPLEMENTATION_PLAN.md S40). This file is Tier A only (design
doc §7) — the egress-destination guard real call sites import and use directly. Tier B (a
router-level structural tripwire for a future real tool-calling surface) does not exist yet —
there is nothing for it to do until some future change gives the fleet real function-calling
(design doc §7/§9); this module makes no attempt at that half.

One function real call sites use:

    check_destination(url_or_host, caller) -> None   # raises EgressDenied if not allowed

Logic (design doc §7): resolve the destination; if it is fleet-internal (§4), allow. Otherwise,
look it up in the tool registry (§6) — allow only if `caller` is named in that entry's
allowed_callers. An entry does not grant access to a sibling script that happens to share the
same destination.

Fail-safe, not fail-open (§7): if the registry file is missing or fails to parse, this denies
every non-internal destination rather than letting it through unchecked — the same discipline
hermes-dispatch.py's own VALID_TARGETS check already holds to ("a bad response is a failure to
route, never a silent guess").

Internal ranges (§4) are anchored to infra/network-planes.md's own documented planes, not a
blanket 10.0.0.0/8 (16 million addresses wider than anything this fleet's numbering actually
uses): control plane 10.129.1.0/24, data plane 10.129.9.0/30, RDMA plane 10.129.10.0/30, the
tailscale tailnet 100.64.0.0/10, plus loopback 127.0.0.0/8 (always — that is just "this same
host," not a plane). The fuller 10.0.0.0/8 is available only as an explicit, named opt-in
(HERMES_EGRESS_ALLOW_FULL_10_8=1), never the silent default — narrowing the original request's
own stated range is itself a decision worth surfacing, not one to make quietly (design doc §4).

Known, stated limitation (never overclaimed — design doc §9's own discipline): internal-ness is
decided from a literal IP address only, never a hostname lookup. Every real internal call site in
this fleet today already uses a raw IP (or "127.0.0.1"/"localhost") rather than a resolvable
hostname, so this costs no real coverage and keeps the check fully offline and deterministic — no
DNS dependency on this module's own hot path. A future internal destination reached only by
hostname would need either a literal-IP caller change or a registry row of its own; it would NOT
be silently misclassified as external-and-denied without a human noticing (the registry lookup
below still runs, and still denies clearly, naming the unrecognized host).

The Matrix homeserver (Continuwuity) needs no registry entry: confirmed via
infra/continuwuity/continuwuity.toml.template (binds 0.0.0.0:6167) and that directory's own
README (ufw-scoped to allow only from 10.129.1.0/24) — it is control-plane-internal, not one of
the real external exceptions in design doc §5. This resolved one of S40a's two open gates.

No PyYAML: infra/firmament-tool-registry.yaml keeps the .yaml extension for continuity with the
design doc's own illustrative syntax, but — same precedent as infra/hermes-feed-reader/feeds.yaml
and infra/hermes-news-digest/topics.yaml — no YAML is actually parsed. It is a flat `|`-delimited
line per entry, deliberately, so every real caller (most run under the bare system python3, no
venv) needs no PyYAML just to make this check.
"""
import ipaddress
import os
from pathlib import Path
from urllib.parse import urlparse

REGISTRY_PATH = Path(os.environ.get(
    "HERMES_TOOL_REGISTRY",
    str(Path(__file__).resolve().parent.parent / "infra" / "firmament-tool-registry.yaml")))

_INTERNAL_NETWORKS = [
    ipaddress.ip_network("10.129.1.0/24"),    # control plane
    ipaddress.ip_network("10.129.9.0/30"),    # data plane (bond-fabric0)
    ipaddress.ip_network("10.129.10.0/30"),   # RDMA plane
    ipaddress.ip_network("100.64.0.0/10"),    # tailscale tailnet (CGNAT range)
    ipaddress.ip_network("127.0.0.0/8"),      # loopback -- this same host, not a plane
]
if os.environ.get("HERMES_EGRESS_ALLOW_FULL_10_8", "").strip() == "1":
    _INTERNAL_NETWORKS.append(ipaddress.ip_network("10.0.0.0/8"))


class EgressDenied(Exception):
    """Raised by check_destination() for a destination that is neither fleet-internal nor on the
    calling script's own registry entry. Every wrapped call site treats this as a hard failure of
    that one outbound request -- never a silent fallback to making it anyway (design doc §8.1)."""


def _extract_host(url_or_host):
    """Accepts either a full URL (http(s), used by every real call site today) or a bare
    hostname/SSH-alias string (hermes-linodemercury-watch.py's ssh/scp target, which has no
    scheme). Returns None if no host could be parsed out."""
    if "://" in url_or_host:
        return urlparse(url_or_host).hostname
    return url_or_host.split("/")[0].split(":")[0] or None


def _is_internal(host):
    if host == "localhost":
        host = "127.0.0.1"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # Not a literal IP -- can't be proven internal from the address alone. See the module
        # docstring's "known, stated limitation": the registry decides from here.
        return False
    return any(ip in net for net in _INTERNAL_NETWORKS)


def _load_registry(path=None):
    """Returns {destination_hostname: {"name", "kind", "allowed_callers": set(...)}}. Raises on a
    missing or malformed file -- check_destination() treats that as a reason to deny, never a
    reason to skip the check (§7's fail-safe rule)."""
    path = Path(path or REGISTRY_PATH)
    text = path.read_text(encoding="utf-8")  # raises FileNotFoundError if missing -- on purpose
    entries = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 4 or not all(parts):
            raise ValueError(f"{path} line {lineno}: expected "
                              f"'name | kind | allowed_callers | destination', got {raw!r}")
        name, kind, callers, destination = parts
        entries[destination.lower()] = {
            "name": name,
            "kind": kind,
            "allowed_callers": {c.strip() for c in callers.split(",") if c.strip()},
        }
    return entries


def check_destination(url_or_host, caller):
    """Raises EgressDenied if `url_or_host` is neither fleet-internal (§4) nor on `caller`'s own
    whitelist entry in the tool registry (§6). `caller` is the script actually making the
    outbound call (its own basename, e.g. "hermes-websearch.py") -- not whoever invoked it, for a
    shared module like hermes_alert_common.py that several scripts import."""
    host = _extract_host(url_or_host)
    if not host:
        raise EgressDenied(f"{caller}: could not parse a destination host out of {url_or_host!r}")
    if _is_internal(host):
        return
    try:
        registry = _load_registry()
    except Exception as exc:
        raise EgressDenied(
            f"{caller}: tool registry unavailable ({exc}) -- denying non-internal egress to "
            f"{host} fail-safe"
        ) from exc
    entry = registry.get(host.lower())
    if entry is None or caller not in entry["allowed_callers"]:
        raise EgressDenied(f"{caller}: {host!r} is not on this caller's egress whitelist")
