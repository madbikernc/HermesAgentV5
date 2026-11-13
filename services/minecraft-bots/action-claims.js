// Version: 1.0.0
//
// 1.0.0 (2026-11-13) -- split out of actions.js (2.0.0) unchanged: builder item claims, the guard anchor, nearby beds.
// Its own file, under the self-repair pipeline's 40000-char whole-file limit. actions.js imports
// it; this file reads actions.js's state through live imports, so nothing here may touch it
// before actions.js has run (only declarations live here).

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { listState, setState } from "./memory.js";
import { bedHalves } from "./shelter.js";
import { bedNearHazard } from "./action-world.js";


// Direct request, 2026-10-18: bed claiming (the shared hermes-memory "minecraft-beds" agent_state
// plus BEDS_DIR per-host fallback that used to live here -- loadClaimedBed/saveClaimedBed/
// clearClaimedBed/readBedClaims/writeBedClaim and their local-file counterparts) is removed
// entirely. "Home" for lighting/surplus/rally (index.js) is bot.spawnPoint now, same as everywhere
// else in that file; "sleep" (below) just tries any bed that isn't actually occupied.

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md Tier 2 -- "ownable by whichever bot is idle
// and able, not pinned to whoever's primary role happens to be Builder"). Same shape as
// BED_CLAIMS_AGENT above -- a shared hermes-memory agent_state row per bot, the same per-host
// fallback file and MC_*_SHARED escape hatch for when hermes-memory is unreachable -- so a second
// idle bot sees an infrastructure item is already being worked and picks a different one instead
// of converging on the same gap. Short-lived (BUILDER_CLAIM_TTL_MS), unlike a bed claim: a bot
// claiming "furnace" and then dying, getting stuck, or disconnecting mid-task shouldn't block the
// fleet's infrastructure forever -- the store has no per-row expiry, so staleness is checked
// against `claimedAt` here, on read, rather than trusted from the store.
const BUILDER_CLAIMS_DIR = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/builder-claims`;
const BUILDER_CLAIMS_AGENT = "minecraft-builder-claims";
const BUILDER_CLAIMS_SHARED = (process.env.MC_BUILDER_CLAIMS_SHARED ?? "true") !== "false";
const BUILDER_CLAIMS_TIMEOUT_MS = 5000;
const BUILDER_CLAIM_TTL_MS = 10 * 60_000;
let builderClaimsSharedDown = false;

const toBuilderClaim = (v) => (typeof v?.item === "string" && Number.isFinite(v?.claimedAt) ? v : null);

async function readLocalBuilderClaims() {
  const claims = {};
  let files = [];
  try {
    files = await readdir(BUILDER_CLAIMS_DIR);
  } catch {}
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const claim = toBuilderClaim(JSON.parse(await readFile(path.join(BUILDER_CLAIMS_DIR, file), "utf8")));
      if (claim) claims[file.slice(0, -5)] = claim;
    } catch {} // a half-written or corrupt claim just doesn't count
  }
  return claims;
}

async function writeLocalBuilderClaim(username, claim) {
  const file = path.join(BUILDER_CLAIMS_DIR, `${username}.json`);
  try {
    if (!claim) return await unlink(file).catch(() => {});
    await mkdir(BUILDER_CLAIMS_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(claim), "utf8");
  } catch (err) {
    console.error("builder claims: failed to write local claim:", err.message);
  }
}

// Every bot's claim, { username: {item, claimedAt} } -- the shared store when reachable, else
// this host's copy. Stale claims (older than BUILDER_CLAIM_TTL_MS) are dropped before the caller
// ever sees them, same "don't trust a claim forever" principle readBedClaims applies by other
// means (a destroyed/reassigned bed).
async function readBuilderClaims(bot) {
  const local = await readLocalBuilderClaims();
  let claims = local;
  if (BUILDER_CLAIMS_SHARED) {
    try {
      const rows = await listState(BUILDER_CLAIMS_AGENT, BUILDER_CLAIMS_TIMEOUT_MS);
      if (builderClaimsSharedDown) console.log("[builder claims] shared claims reachable again.");
      builderClaimsSharedDown = false;
      claims = {};
      for (const row of rows) {
        const claim = toBuilderClaim(row.value);
        if (claim) claims[row.key] = claim;
      }
      const mine = local[bot.username];
      if (!rows.some((r) => r.key === bot.username)) {
        if (mine) { // first read since sharing began: publish this host's claim
          await setState(BUILDER_CLAIMS_AGENT, bot.username, mine, BUILDER_CLAIMS_TIMEOUT_MS)
            .catch((err) => console.error("builder claims: failed to publish claim:", err.message));
          claims[bot.username] = mine;
        }
      } else {
        const shared = claims[bot.username] || null; // keep the fallback copy in step with the store
        const same = mine && shared ? mine.item === shared.item && mine.claimedAt === shared.claimedAt : !mine && !shared;
        if (!same) await writeLocalBuilderClaim(bot.username, shared);
      }
    } catch (err) {
      if (!builderClaimsSharedDown) console.log(`[builder claims] shared claims unreachable, using this host's: ${err.message}`);
      builderClaimsSharedDown = true;
      claims = local;
    }
  }
  const now = Date.now();
  for (const [username, claim] of Object.entries(claims)) {
    if (now - claim.claimedAt > BUILDER_CLAIM_TTL_MS) delete claims[username];
  }
  return claims;
}

async function writeBuilderClaim(bot, claim) {
  await writeLocalBuilderClaim(bot.username, claim);
  if (!BUILDER_CLAIMS_SHARED) return;
  await setState(BUILDER_CLAIMS_AGENT, bot.username, claim || {}, BUILDER_CLAIMS_TIMEOUT_MS)
    .catch((err) => console.error("builder claims: failed to share claim:", err.message));
}

// Claims `item` for `bot`, refreshing her own existing claim on the same item (so a long,
// multi-step item doesn't expire out from under her mid-work just because BUILDER_CLAIM_TTL_MS
// elapsed since she first took it). Returns false, claiming nothing, if a DIFFERENT bot already
// holds a live claim on it -- the caller picks its next unclaimed candidate instead.
export async function claimBuilderItem(bot, item) {
  const claims = await readBuilderClaims(bot);
  const holder = Object.entries(claims).find(([username, c]) => c.item === item && username !== bot.username);
  if (holder) return false;
  await writeBuilderClaim(bot, { item, claimedAt: Date.now() });
  return true;
}

// Whichever item (if any) `bot` herself currently holds a live claim on.
export async function myBuilderClaim(bot) {
  return (await readBuilderClaims(bot))[bot.username]?.item || null;
}

export async function releaseBuilderItem(bot) {
  await writeBuilderClaim(bot, null);
}

// Direct request, 2026-10-11 (PRIORITIES_PROPOSAL.md §2a -- "arbitrate which Soldier holds which
// sub-role the same way bed claims are already arbitrated, rather than inventing a new
// mechanism"). Same shared-agent_state-plus-per-host-fallback shape as BED_CLAIMS_AGENT/
// BUILDER_CLAIMS_AGENT above, but ONE row, not one per bot: there's a single anchor slot to
// contend for, not N beds or M infrastructure items.
const GUARD_ANCHOR_AGENT = "minecraft-guard-anchor";
const GUARD_ANCHOR_KEY = "anchor"; // the one row this agent ever holds
const GUARD_ANCHOR_SHARED = (process.env.MC_GUARD_ANCHOR_SHARED ?? "true") !== "false";
const GUARD_ANCHOR_TIMEOUT_MS = 5000;
const GUARD_ANCHOR_FILE = `${(process.env.MC_MEMORY_ROOT || "/mnt/hermes-data/minecraft-memory")}/guard-anchor.json`;
let guardAnchorSharedDown = false;

const toGuardAnchor = (v) => (typeof v?.holder === "string" && Number.isFinite(v?.claimedAt) ? v : null);

async function readLocalGuardAnchor() {
  try {
    return toGuardAnchor(JSON.parse(await readFile(GUARD_ANCHOR_FILE, "utf8")));
  } catch {
    return null; // missing or corrupt -- no local claim on record
  }
}

async function writeLocalGuardAnchor(value) {
  try {
    if (!value) return await unlink(GUARD_ANCHOR_FILE).catch(() => {});
    await mkdir(path.dirname(GUARD_ANCHOR_FILE), { recursive: true });
    await writeFile(GUARD_ANCHOR_FILE, JSON.stringify(value), "utf8");
  } catch (err) {
    console.error("guard anchor: failed to write local claim:", err.message);
  }
}

// The current anchor holder, { holder, claimedAt } or null -- the shared store when reachable,
// else this host's own copy, published on first read the same way a bed claim is.
async function readGuardAnchor() {
  const local = await readLocalGuardAnchor();
  if (!GUARD_ANCHOR_SHARED) return local;
  try {
    const rows = await listState(GUARD_ANCHOR_AGENT, GUARD_ANCHOR_TIMEOUT_MS);
    if (guardAnchorSharedDown) console.log("[guard anchor] shared claim reachable again.");
    guardAnchorSharedDown = false;
    const row = rows.find((r) => r.key === GUARD_ANCHOR_KEY);
    if (!row) {
      if (local) {
        await setState(GUARD_ANCHOR_AGENT, GUARD_ANCHOR_KEY, local, GUARD_ANCHOR_TIMEOUT_MS)
          .catch((err) => console.error("guard anchor: failed to publish claim:", err.message));
      }
      return local;
    }
    const shared = toGuardAnchor(row.value);
    const same = local && shared ? local.holder === shared.holder && local.claimedAt === shared.claimedAt : !local && !shared;
    if (!same) await writeLocalGuardAnchor(shared);
    return shared;
  } catch (err) {
    if (!guardAnchorSharedDown) console.log(`[guard anchor] shared claim unreachable, using this host's: ${err.message}`);
    guardAnchorSharedDown = true;
    return local;
  }
}

async function writeGuardAnchor(value) {
  await writeLocalGuardAnchor(value);
  if (!GUARD_ANCHOR_SHARED) return;
  await setState(GUARD_ANCHOR_AGENT, GUARD_ANCHOR_KEY, value || {}, GUARD_ANCHOR_TIMEOUT_MS)
    .catch((err) => console.error("guard anchor: failed to share claim:", err.message));
}

// True once `bot` holds the anchor -- claiming it herself first if it's empty, or its current
// holder is no longer a live Soldier (dead, disconnected, reassigned; `isLiveSoldier(name)` is
// index.js's own call, since this file has no view of the fleet roster or who's actually
// connected). With one live Soldier, this trivially claims it on her first check and is never
// contested again. With two or more, whichever doesn't hold it checks every cycle and takes it
// the moment it frees up -- no permanent anchorless gap.
export async function holdsGuardAnchor(bot, isLiveSoldier) {
  const current = await readGuardAnchor();
  if (current?.holder === bot.username) return true;
  if (current && isLiveSoldier(current.holder)) return false; // someone else genuinely holds it
  await writeGuardAnchor({ holder: bot.username, claimedAt: Date.now() });
  return true;
}

// A bed is two blocks; bedHalves() (shelter.js, as FACING_STEP, shared with doors and fence gates
// which carry the same `facing` property) resolves either half to the head, so every caller here
// compares/stores against one canonical position per bed regardless of which half findBlocks or
// the server happened to hand back.

// Direct request, 2026-10-18: no more claiming -- "any bed not already occupied" is fair game, so
// this is now just every usable bed (one entry per bed, its head block), nearest to `near` first.
// bot.sleep() itself is what actually tells a real occupied bed apart from a free one (its own
// specific "occupied" rejection); this is just the candidate order "sleep" tries them in.
export function nearbyBeds(bot, near) {
  const seen = [];
  for (const pos of bot.findBlocks({ matching: (block) => bot.isABed(block), maxDistance: 32, count: 64 })) {
    const block = bot.blockAt(pos);
    if (!block) continue;
    const head = bedHalves(block)[0];
    if (seen.some((p) => p.equals(head)) || bedNearHazard(bot, head)) continue;
    seen.push(head);
  }
  const origin = near || bot.entity.position;
  return seen.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
}
