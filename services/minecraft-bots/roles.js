// Version: 1.2.0
//
// 1.2.0 (2026-09-11) -- direct follow-up ("what's next" -> "2"): four roles (Miner, Artist,
// Explorer, Soldier) gained a `priorities` array, closing §15.8's "whether the other roles get
// their own priorities lists" open question -- for these four, not the same shape as Builder's
// (§15.6). Builder's list is a deterministic, world-checked ladder that OVERRIDES freeform
// self-propose ahead of the curriculum -- that shape was only ever built because the operator
// specified concrete, checkable items (crafting table, furnace, ...) directly. These four were
// never operator-specified the same way, so inventing an equally rigid ladder here would risk
// exactly what §15.6 itself warned against: "a list that looks authoritative but wasn't actually
// decided." Instead `priorities` here is plain ADVISORY text -- an ordered suggestion folded
// into proposeOwnGoal()'s freeform prompt via roleBiasNote() (index.js), never a hard override,
// never checked against real world state. A bot is free to ignore it if something better fits
// what's actually in front of her.
//
// 1.1.0 (2026-09-11) -- direct follow-up ("nest" -> "bee nests/hives"): HERDER's domain text now
// names honey/beekeeping explicitly, matching actions.js's new "harvest_hive" case (1.47.0) and
// "breed"'s new bee entry -- narrows, doesn't close, §15.11's own capability-gap note (pen/fence
// containment and shear/milk for non-bee livestock are still open).
//
// Per-bot role taxonomy (MINECRAFT_BOTS_DESIGN.md §15). Deliberately data, not a class hierarchy
// or a behavior-tree -- matches this codebase's own existing convention for arbiter.js's OWNERS
// and goals.js's plain-JSON shape: a small lookup table other modules branch on, nothing here
// interprets or acts on it. index.js is the one place that reads this to bias proposeOwnGoal()'s
// self-propose prompt, proposeDirectiveForOthers()'s target/content selection, and Builder's own
// infrastructure priority checklist (§15.6).
//
// Role does NOT touch arbiter.js's OWNERS interrupt ordering (§15.1) -- that stays a pure urgency
// hierarchy, identical for every bot regardless of role. Role only changes what a bot chooses to
// do when nothing urgent is happening.

export const ROLES = Object.freeze({
  LEADER:   Object.freeze({ name: "Leader",   domain: "coordinates the group, assigns tasks, tracks fleet progress" }),
  SOLDIER:  Object.freeze({
    name: "Soldier", domain: "fights, defends itself and others, responds to alarm calls",
    priorities: [
      "get a full set of armor, any tier",
      "get a real weapon (sword or axe), not bare hands",
      "stand guard near the shared spawn point and respond to threats -- ongoing, never \"done\"",
    ],
  }),
  ARTIST:   Object.freeze({
    name: "Artist", domain: "plants flowers, trees, and gardens; decorative building; repairs terrain damage near home",
    priorities: [
      "plant at least a few trees (saplings) near home",
      "start a small flower garden near home",
      "keep the ground near home free of unrepaired pits -- ongoing (checkTerrainDamage handles this automatically, not a goal to self-propose)",
    ],
  }),
  BUILDER:  Object.freeze({ name: "Builder",  domain: "crafts beds, buildings, chests, weapons; stores gear in chests; repairs terrain damage near home" }),
  MINER:    Object.freeze({
    name: "Miner", domain: "finds and accumulates raw materials, stores them in chests",
    priorities: [
      "stock up on fuel (coal) first -- everything else depends on it",
      "then iron, then copper -- the metals most goals actually need",
      "general stone/cobblestone for building material",
      "rarer ores (gold, diamond, redstone, lapis) once the basics are stocked",
    ],
  }),
  EXPLORER: Object.freeze({
    name: "Explorer", domain: "finds resources and map features, scouts territory",
    priorities: [
      "locate a village (trading, food, beds)",
      "locate a natural bee nest (feeds Herder's own honey work)",
      "locate a notable feature -- a ravine, mineshaft, or stronghold -- once the basics above are found",
    ],
  }),
  FARMER:   Object.freeze({ name: "Farmer",   domain: "tills, plants, and harvests food crops for the fleet" }),
  HERDER:   Object.freeze({ name: "Herder",   domain: "breeds and tends livestock (including bees -- honey via harvest_hive) for a sustainable food/material source" }),
});

// persona (USERNAME.toLowerCase(), matching PERSONA_NAME's own default in index.js) -> { primary, secondary }
export const BOT_ROLES = Object.freeze({
  mayor: { primary: ROLES.LEADER,  secondary: null },
  mark:  { primary: ROLES.SOLDIER, secondary: ROLES.LEADER },
  luke:  { primary: ROLES.SOLDIER, secondary: null },
  babs:  { primary: ROLES.MINER,   secondary: ROLES.EXPLORER },
  amy:   { primary: ROLES.BUILDER, secondary: ROLES.ARTIST },
  bob:   { primary: ROLES.FARMER,  secondary: ROLES.HERDER },
});
