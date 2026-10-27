/**
 * Core loop tunables: Stake levels, starting resources, idle rules.
 * Everything the contract left undefined is a named constant here, never inline.
 */

/**
 * Stake: the game's one risk lever.
 *
 * ASSUMPTION (A5): the contract lists the Stake levels but not what Stake
 * multiplies. Stake sets bait cost per cast -- that much the GDD settles --
 * and this table decides the rest.
 *
 * WHAT CHANGED, AND WHY IT MATTERS: Stake and a separate three-way Dial used
 * to be two systems. Stake was pure upside with a price on it (a flat catch
 * bonus that only ever rose), and the Dial carried the actual trade-off. That
 * split is gone. Staking more *is* the risk now: a higher stake buys rarer
 * fish, better chests and a shot at tiers a low stake cannot reach, and pays
 * for all of it with a worse catch rate. One continuous "risk more, win more"
 * lever, which is the shape the reference game the design is chasing uses.
 *
 * WHERE THE NUMBERS COME FROM: each column is a linear interpolation across
 * the five levels between what the old Steady mode did (level 1) and what the
 * old Risky mode did (level 40), at f = 0, .25, .5, .75, 1. Interpolating the
 * shipped spread rather than inventing a curve keeps the economy in roughly
 * the neighbourhood the generated balance tables already describe while
 * moving the whole trade-off onto one axis. `design/balance-tables.md`, not
 * the arithmetic above, is what actually confirms that -- regenerate it with
 * `node server/tools/gdd-balance.js --write` after touching anything here.
 *
 * catchRateMult    multiplies the rod's base catch probability. FALLS with
 *                  stake: this is the cost side of the lever.
 * rarityBias       exponential tilt on species weight, applied as
 *                  bias ** rarityIndex, so > 1 pushes probability mass toward
 *                  rarer fish and < 1 compresses it toward commons.
 * xpMult           scales what a caught fish is worth when cashed in.
 * chestChanceMult  multiplies the rod's chest-per-catch chance, and also
 *                  feeds `chestUpgradeBias` in game/chests.js.
 * chestTiers       which chest tiers this stake can drop at all. This is the
 *                  one place a Stake choice changes *what* can be won rather
 *                  than how much, so it is the game's main progression gate.
 * band             which RISK_BANDS entry this rung falls in. Presentation
 *                  only -- no game rule reads it. See RISK_BANDS below.
 *
 * On `chestTiers` specifically: Legendary stays gated at Stake 10 and above,
 * exactly where the GDD already put it. Common and Rare fall away at the top
 * of the ladder -- a full-send cast has no consolation prize, the same way
 * the old Risky mode dropped Epic only. Common is deliberately still in reach
 * at Stake 1 and 5 so a new player grows into the higher tiers rather than
 * skipping past them.
 *
 * unlockLevel      rod level at which this Stake rung can be selected at all.
 *                  Added 2026-09-08 alongside the rods.config.js XP stretch:
 *                  before this, a brand-new Rod 1 player could set Stake 40
 *                  on their very first cast, which let them skip past the
 *                  early-game trade-off the ladder exists to teach before
 *                  they had seen any of the lower rungs. Now a new Stake
 *                  tier unlocks every couple of rod levels (2, 4, 6, 8),
 *                  giving players a second kind of milestone alongside rod
 *                  level-ups and fish-species unlocks. Enforced in
 *                  `validateStake` (server/src/util/validate.js) on every
 *                  `set_stake` message, and defensively re-checked by
 *                  `stakeFor` in game/fishing.js so a stake stored before
 *                  this gate existed still resolves to something the
 *                  player's current rod level actually permits.
 */
export const STAKE_LEVELS = [
  {
    stake: 1,
    band: 'steady',
    name: 'Shallows',
    blurb: 'Steady bites, common catches.',
    catchRateMult: 1.25,
    rarityBias: 0.78,
    xpMult: 0.95,
    chestChanceMult: 0.85,
    chestTiers: ['common'],
    unlockLevel: 1,
  },
  {
    stake: 5,
    band: 'steady',
    name: 'Inshore',
    blurb: 'A little rarer, a little less often.',
    catchRateMult: 1.11,
    rarityBias: 0.91,
    xpMult: 0.975,
    chestChanceMult: 1.04,
    chestTiers: ['common', 'rare'],
    unlockLevel: 2,
  },
  {
    stake: 10,
    band: 'balanced',
    name: 'Open water',
    blurb: 'Even odds, and Legendary comes into reach.',
    catchRateMult: 0.975,
    rarityBias: 1.04,
    xpMult: 1.0,
    chestChanceMult: 1.225,
    chestTiers: ['common', 'rare', 'epic', 'legendary'],
    unlockLevel: 4,
  },
  {
    stake: 20,
    band: 'risky',
    name: 'Deep water',
    blurb: 'Fewer bites, no more Common chests.',
    catchRateMult: 0.84,
    rarityBias: 1.17,
    xpMult: 1.025,
    chestChanceMult: 1.41,
    chestTiers: ['rare', 'epic', 'legendary'],
    unlockLevel: 6,
  },
  {
    stake: 40,
    band: 'risky',
    name: 'Full send',
    blurb: 'Rarely bites, and nothing small when it does.',
    catchRateMult: 0.7,
    rarityBias: 1.3,
    xpMult: 1.05,
    chestChanceMult: 1.6,
    chestTiers: ['epic', 'legendary'],
    unlockLevel: 8,
  },
];

export const DEFAULT_STAKE = 1;

/** Just the numbers, for validation and for anything that only needs the ladder. */
export const STAKE_VALUES = STAKE_LEVELS.map((level) => level.stake);

/** stake -> its full config entry. The only lookup `beginCast` needs. */
export const STAKE_BY_LEVEL = Object.freeze(
  Object.fromEntries(STAKE_LEVELS.map((level) => [level.stake, Object.freeze(level)])),
);

/** Stake values selectable by a rod of `rodLevel`, lowest first. Always includes Stake 1. */
export function stakesUnlockedAt(rodLevel) {
  const level = Number(rodLevel) || 1;
  const unlocked = STAKE_LEVELS.filter((entry) => entry.unlockLevel <= level).map((entry) => entry.stake);
  return unlocked.length > 0 ? unlocked : [DEFAULT_STAKE];
}

/** Whether `stake` is currently selectable by a rod of `rodLevel`. */
export function isStakeUnlockedAt(stake, rodLevel) {
  return stakesUnlockedAt(rodLevel).includes(Number(stake));
}

/** The richest Stake a rod of `rodLevel` has access to. */
export function highestStakeUnlockedAt(rodLevel) {
  const unlocked = stakesUnlockedAt(rodLevel);
  return unlocked[unlocked.length - 1];
}

/**
 * The Risk Dial: Steady / Balanced / Risky, as a *gauge* rather than a switch.
 *
 * These three names are a contracted deliverable (contract section 3.1, "Three
 * Dial modes (Steady, Balanced, Risky)") and they used to be a control the
 * player set independently of Stake. They are not a control any more -- Stake
 * is the only lever -- but they remain the clearest shorthand the game has for
 * *where on the risk curve a player currently is*, so the HUD still shows all
 * three and lights the one the current Stake falls in.
 *
 * Nothing in the game rules reads a band. `beginCast` takes every modifier
 * from the Stake entry itself, so a band cannot drift the odds even if this
 * table were wrong -- the worst a mistake here can do is mislabel the gauge.
 * `server/test/game.test.js` still cross-checks the mapping against
 * catchRateMult so the label cannot start disagreeing with the maths.
 *
 * The split follows the interpolation the ladder was built from: Stake 1 is
 * the old Steady endpoint, Stake 40 the old Risky endpoint, and Stake 10 the
 * neutral middle rung, which is the one place catchRateMult sits at roughly
 * 1.0.
 */
export const RISK_BANDS = [
  {
    id: 'steady',
    name: 'Steady',
    blurb: 'Safer bites, common catches.',
  },
  {
    id: 'balanced',
    name: 'Balanced',
    blurb: 'Even odds either way.',
  },
  {
    id: 'risky',
    name: 'Risky',
    blurb: 'Fewer bites, richer prizes.',
  },
];

export const RISK_BAND_IDS = RISK_BANDS.map((band) => band.id);

/**
 * What Stake scales beyond the table above.
 *
 * Down to one flag now. `scalesGold`, `scalesXp` and `scalesChestChance` are
 * gone: XP and chest chance are columns in STAKE_LEVELS rather than blanket
 * multipliers, and a catch has not paid Gold since fish moved into the bag
 * (Gold comes from appraising gems and from chests -- see `game/fishing.js`).
 *
 * `scalesXp` in particular stays off by intent, not omission. Letting Stake
 * multiply Fishing Power XP outright collapses the contracted 10 rod levels
 * into a handful of 40x casts (measured: rod level 5 inside 4 catches). The
 * xpMult column moves XP by 10% across the whole ladder; that is the intended
 * size of the effect.
 *
 * Kept as a flag rather than inlined because the client's stake hint reads it
 * to decide whether to claim Stake sets bait cost -- see `stakeHint` in the
 * HUD.
 */
export const STAKE_RULES = {
  scalesBaitCost: true,
};

/**
 * Ceiling on the chest-tier upgrade bias -- built, and deliberately a no-op.
 *
 * OPEN QUESTION (Q1), NOT A DECISION MADE HERE. `chestUpgradeBias` in
 * game/chests.js tilts a chest roll toward the better tiers by
 * `bias ** tierRank`, where the bias compounds catch rarity with the stake's
 * own chest multiplier. Nothing bounded it, which is the mechanism behind the
 * low-stake-to-high-stake Gold/hour gap widening in absolute terms as rod
 * level rises. Whether that widening is a problem worth capping is a design
 * call for Mike -- the *ratio* is far more stable than the gap, so this is not
 * a bug being fixed, it is a lever being made available.
 *
 * 4.0 is chosen to change nothing. The highest bias the live game can produce
 * is 2.00 -- a Leviathan (rarityIndex 5) at Stake 40 (chestChanceMult 1.6) --
 * so the clamp never binds and the generated balance tables are identical
 * with it in place. Lowering it below 2.00 is what would start biting, and
 * only where a stake can actually reach more than one tier: Stake 1 (Common
 * only) has nothing to shift between.
 *
 * Do not lower this without that decision being made deliberately: regenerate
 * `design/balance-tables.md` and read the chest-tier composition table, which
 * is where a lowered ceiling would show up.
 */
export const MAX_CHEST_TIER_BIAS = 4.0;

/** Bait burned per cast at Stake 1x. Scaled by stake when STAKE_RULES.scalesBaitCost. */
export const BAIT_PER_CAST = 1;

/** Resources a brand-new guest session starts with. */
export const STARTING_RESOURCES = {
  bait: 100,
  gold: 0,
  pearls: 0,
  usdg: 0,
};

/**
 * ASSUMPTION (A7): Nothing in the contract prevents a player from spending all
 * bait and all gold and being permanently stuck. Since there is no real-money
 * path, a slow free trickle is the only way out. Bait regenerates up to
 * `ceiling` only -- it never competes with playing actively or with the shop.
 */
export const BAIT_REGEN = {
  enabled: true,
  amount: 1,
  intervalMs: 8000,
  ceiling: 25,
};

/** Auto-fishing: the idle loop the contract calls "automatic fishing sessions". */
export const AUTO_FISHING = {
  /** New sessions start with the idle loop already running. */
  defaultEnabled: true,
  /** Server simulation granularity for cast timers. */
  tickMs: 250,
  /** Pause between resolving one cast and starting the next. */
  recastDelayMs: 400,
};

/** Display-name rules. No account, no password -- this is the only identity. */
export const DISPLAY_NAME = {
  minLength: 3,
  maxLength: 16,
  /** Letters, digits, space, underscore, hyphen. Deliberately no punctuation. */
  pattern: /^[A-Za-z0-9 _-]+$/,
  fallbackPrefix: 'Guest_',
};

/** Chat rules, per contract: real-time, history, timestamps, 200-char limit. */
export const CHAT = {
  maxLength: 200,
  historySize: 50,
  /** Minimum gap between two messages from the same client. */
  cooldownMs: 1200,
  /** Messages persisted to MongoDB for history across restarts. */
  persistedHistorySize: 200,
};

export const LEADERBOARD = {
  size: 10,
  refreshMs: 10000,
};

/** How often a dirty player document is flushed to MongoDB. */
export const PERSIST_INTERVAL_MS = 5000;

/**
 * The emission tripwire: how often the server checks what it has minted
 * against what game/balanceModel.js says it should have.
 *
 * `flushIntervalMs` is deliberately not PERSIST_INTERVAL_MS. Five seconds is
 * the right cadence for flushing a dirty player document and the wrong one for
 * this: appraisal is bursty by design -- a player can hold a bag of gems for an
 * hour and cash the lot in a single tick -- so a five-second window would spend
 * most of its life either empty or reading as a 50x spike. Five minutes is long
 * enough for those bursts to average out and still short enough that a genuine
 * runaway is in the log within one deploy's worth of attention.
 *
 * `alertRatio` is a factor, not a percentage, and it is coarse on purpose. See
 * game/metrics.js for why this is a tripwire rather than a fraud detector.
 *
 * `minSample` stops a quiet harbour from filling the log: below these amounts
 * in a window, the ratio is not worth reporting whatever it says.
 *
 * `maxCarryWindows` exists because the two big faucets are bursty against a
 * fixed window, and measurement said so: a five-minute window of ordinary,
 * honest play tripped the Pearl wire in two runs out of four before this was
 * added. Nothing was wrong with the play. A gem sits in the bag until the
 * player takes it to be appraised, and Pearl arrives in chunks of ~19 from
 * roughly one Epic chest in nine -- so a player can earn across six windows
 * and mint in the seventh, and a per-window comparison reads that as a 6x
 * over-mint.
 *
 * So theory is a budget rather than a quota: what a window does not mint is
 * carried into the next one, up to this many windows' worth. A player stashing
 * gems banks the Gold budget they were entitled to and spends it when they
 * finally visit the appraiser, and only mint that outruns what the harbour
 * could have earned over the last half hour trips the wire.
 */
export const EMISSION_MONITOR = {
  enabled: true,
  flushIntervalMs: 300_000,
  alertRatio: 2,
  maxCarryWindows: 6,
  minSample: { gold: 500, pearls: 200, bait: 500 },
};

/** Per-client message rate limit (all message types combined). */
export const RATE_LIMIT = {
  windowMs: 1000,
  maxMessages: 20,
};

/**
 * How long a connection may go quiet before the harbour gives up on it.
 *
 * Two settings that compose, and they are here together because reading either
 * one alone gives the wrong answer for how long a player can be away:
 *
 * `pingIntervalMs` x `pingMaxRetries` is how long the WebSocket transport lets
 * a socket go unanswered before terminating it. The transport's own defaults
 * are 3s x 2 -- about six seconds -- which is far too strict for a game whose
 * players leave it running: a backgrounded tab, a laptop closing its lid or a
 * phone changing networks all blow past six seconds and lose the socket. These
 * values give it a minute.
 *
 * `reconnectGraceSeconds` is how long the room then holds the player's dock
 * slot and idle loop waiting for them to come back, before the seat is cleaned
 * up and their next visit starts as a fresh join.
 *
 * The cost of both being generous is that a genuinely dead connection keeps a
 * seat for longer, and there are only MAX_CLIENTS_PER_ROOM of them. A player
 * returning on the same session token evicts their own stale seat on the way
 * in (see `evictDuplicateSession`), so this only ever holds a seat against
 * *other* people, and only for as long as it takes to notice.
 */
export const CONNECTION = {
  pingIntervalMs: 15000,
  pingMaxRetries: 4,
  reconnectGraceSeconds: 180,
};

export const ROOM_NAME = 'harbor';

/** Single shared world -- the contract explicitly scopes this to one area. */
export const MAX_CLIENTS_PER_ROOM = 8;

/**
 * The shared world is a 48x32 grid of 32px tiles. The server needs the bounds
 * to sanity-check avatar positions and to seat joining players; the actual map
 * lives in client/src/world/level.js.
 *
 * COUPLING: these dimensions mirror WORLD_COLUMNS/WORLD_ROWS in that file. They
 * are not cosmetic -- `validatePosition` clamps to them, so a world that is
 * smaller here than on the client walls players out of the far edge of the map.
 */
export const WORLD = {
  columns: 48,
  rows: 32,
  tileSize: 32,
  get width() { return this.columns * this.tileSize; },
  get height() { return this.rows * this.tileSize; },
};

/**
 * Where a joining player is seated, in tile coordinates.
 *
 * `seats` are hand-picked tiles distributed along the pier edges. Each one is
 * decking with open water orthogonally adjacent, so a player can cast the
 * moment they arrive instead of having to walk somewhere first.
 *
 * They are listed rather than computed from an origin and a stride, which is
 * what this used to do. The arithmetic version silently stopped describing the
 * map the first time the harbour was redrawn and seated everybody in the lake.
 * A list is wrong loudly: `client/test/level.test.js` cross-checks every tile
 * named here against the real map and fails if one stops being fishable.
 *
 * `lanes` seat everyone past the named seats. They are runs of decking rather
 * than one rectangle because the centre pier is *not* fishable where it
 * crosses the boardwalk -- both are decking there, so no water is adjacent --
 * and a rectangle spanning the crossing would seat four players somewhere they
 * could not cast. The lanes skip those two rows.
 *
 * The single painted dock has eight clear fishing spots, so the room capacity
 * matches the readable seating in the baked environment.
 */
export const SPAWN = {
  seats: [
    { tx: 12, ty: 12 },
    { tx: 14, ty: 12 },
    { tx: 16, ty: 12 },
    { tx: 18, ty: 12 },
    { tx: 28, ty: 12 },
    { tx: 30, ty: 12 },
    { tx: 32, ty: 12 },
    { tx: 34, ty: 12 },
  ],
  lanes: [],
};

/**
 * Where a standing avatar sits on a tile, in world pixels.
 *
 * The client anchors a sprite on its feet row, so standing on a tile puts the
 * feet on that tile's bottom edge. Seating an arrival on the tile *centre*
 * instead drew them half a tile high -- on a pier edge, out over the water --
 * until their first step snapped them down. `client/test/level.test.js`
 * asserts this stays the same anchor the client walks to.
 */
export function tileStand(tx, ty) {
  return {
    x: tx * WORLD.tileSize + WORLD.tileSize / 2,
    y: ty * WORLD.tileSize + WORLD.tileSize - 1,
  };
}

/** Avatar position updates are frequent; they get their own looser budget. */
export const MOVE_RATE_LIMIT = {
  windowMs: 1000,
  maxMessages: 15,
};
