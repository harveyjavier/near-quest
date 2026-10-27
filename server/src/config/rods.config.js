/**
 * Fishing rod progression: 10 levels, automatic level-up on XP threshold.
 *
 * ASSUMPTION (A2): The contract fixes "10 fishing rod levels" and "Fishing power
 * XP earned per catch; automatic level-up when thresholds are hit" but does not
 * define the curve or what a level actually buys you. The escalating curve and
 * per-level stat bumps below are invented defaults.
 *
 * xpToNext        XP needed to go from this level to the next (null at max level)
 * castMs          base duration of one cast at this rod level
 * catchRate       base probability a cast produces a fish (before stake/buffs)
 * rarityBias      exponential tilt applied to species weights (>1 favours rare)
 * chestChance     probability a successful catch also yields a treasure chest
 *
 * 2026-09-08: every `chestChance` here was scaled down by ~0.1283x (e.g. Rod
 * 1's 0.10 -> 0.0128), in lockstep with the CHEST_TIER_WEIGHTS rescale in
 * rewards.config.js -- the two together are one change, not two, aimed at
 * landing Rod 1 / Stake 10's chest odds near a reference "Sacks of Treasure"
 * screenshot (Common 1-in-121 down to Legendary in the millions). Scaling
 * `chestChance` uniformly across every rod keeps the existing rod-to-rod
 * shape (a Leviathan Rod still finds chests ~1.7x more often than a Bamboo
 * one) while making chests overall ~8x rarer than before at every rod and
 * stake. See the note on CHEST_TIER_WEIGHTS for what this moves downstream
 * (`design/balance-tables.md`, the emission monitor).
 *
 * 2026-09-08 (later same day): `xpToNext` for levels 1-9 was raised, on
 * purpose, to slow the early game down. Measured play showed a brand-new
 * player reaching Rod 3 in about fifteen minutes of casual cashing-in -- the
 * curve let the tutorial-adjacent rods (Bamboo/Willow/Oak) fly by before a
 * player had toured the systems those levels exist to introduce (Stake,
 * chests, appraisal).
 *
 * IMPORTANT ARITHMETIC NOTE, so this mistake isn't repeated: a first pass at
 * this change (same day) multiplied the *old* thresholds by roughly 4x-1.3x
 * and shipped 200/350/500/.../4800 -- which looked right on paper but was
 * calibrated against a guessed XP/hour figure (~380/hr) that was never
 * actually run against `game/balanceModel.js#castExpectation`. The real,
 * simulated throughput at Rod 1 / Stake 1 is ~2,231 XP/hour -- fish alone pay
 * far more than the guess assumed -- so that first pass only bought 5-28
 * minutes per level, not the 0.5-12.6 hours intended. These are the
 * corrected values: each `xpToNext` below is `targetHours * XP-per-hour at
 * that rod, Stake 1` (Stake 1 chosen as the floor because it's the only
 * Stake available at Rod 1 and stays selectable throughout -- a player who
 * unlocks and uses a higher Stake levels faster than this table, not
 * slower). Total XP to max: 289,190 (was 10,000 before either change). See
 * `design/balance-tables.md` (regenerate with
 * `node server/tools/gdd-balance.js --write`) and `design/GDD.md` Section 3
 * for the resulting hours-per-level table. Skip pricing (GOLD_PER_XP in
 * game/progression.js) is untouched and rescales automatically since it is
 * derived from xpToNext, not a fixed table -- but at this XP scale the skip
 * price also grows by ~29x, which is worth a second look before shipping
 * (see the note in game/progression.js).
 */

export const MAX_ROD_LEVEL = 10;

export const RODS = [
  { level: 1,  name: 'Bamboo Rod',      xpToNext: 1120,   castMs: 4000, catchRate: 0.55, rarityBias: 1.00, chestChance: 0.0128 },
  { level: 2,  name: 'Willow Rod',      xpToNext: 2520,   castMs: 3800, catchRate: 0.59, rarityBias: 1.03, chestChance: 0.0141 },
  { level: 3,  name: 'Oak Rod',         xpToNext: 4550,   castMs: 3600, catchRate: 0.63, rarityBias: 1.06, chestChance: 0.0154 },
  { level: 4,  name: 'Fiberglass Rod',  xpToNext: 7800,   castMs: 3400, catchRate: 0.66, rarityBias: 1.09, chestChance: 0.0167 },
  { level: 5,  name: 'Reinforced Rod',  xpToNext: 13500,  castMs: 3150, catchRate: 0.70, rarityBias: 1.12, chestChance: 0.0186 },
  { level: 6,  name: 'Carbon Rod',      xpToNext: 21500,  castMs: 2900, catchRate: 0.73, rarityBias: 1.15, chestChance: 0.0205 },
  { level: 7,  name: 'Steelcore Rod',   xpToNext: 38200,  castMs: 2650, catchRate: 0.76, rarityBias: 1.18, chestChance: 0.0225 },
  { level: 8,  name: 'Tidecaller Rod',  xpToNext: 70500,  castMs: 2350, catchRate: 0.79, rarityBias: 1.21, chestChance: 0.0244 },
  { level: 9,  name: 'Stormbreaker Rod',xpToNext: 129500, castMs: 2000, catchRate: 0.82, rarityBias: 1.24, chestChance: 0.0263 },
  { level: 10, name: 'Leviathan Rod',   xpToNext: null,   castMs: 1600, catchRate: 0.86, rarityBias: 1.28, chestChance: 0.0282 },
];

const RODS_BY_LEVEL = Object.freeze(
  Object.fromEntries(RODS.map((rod) => [rod.level, rod])),
);

/** Always returns a valid rod, clamping out-of-range input defensively. */
export function getRod(level) {
  const clamped = Math.min(MAX_ROD_LEVEL, Math.max(1, Math.floor(Number(level) || 1)));
  return RODS_BY_LEVEL[clamped];
}

/** XP required to leave `level`. Returns Infinity at max level so level-up can never trigger. */
export function xpToNext(level) {
  const rod = getRod(level);
  return rod.xpToNext === null ? Infinity : rod.xpToNext;
}
