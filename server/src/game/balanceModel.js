/**
 * The game's theoretical expected value, in one place.
 *
 * Two callers need the same arithmetic and must not be allowed to drift apart:
 *
 *   `server/tools/gdd-balance.js` -- the offline tool that regenerates
 *   `design/balance-tables.md`, i.e. what the design documents claim the
 *   economy pays out.
 *
 *   `game/metrics.js` + the room's emission monitor -- the live check that
 *   what the server *actually* mints is in the same neighbourhood as what
 *   this file says it should.
 *
 * That second caller is the reason this module exists at all. A monitor that
 * carries its own copy of the EV maths only tells you the two copies agree; it
 * has to read from the same source the design tables do, or a balance change
 * silently moves the tables and leaves the tripwire measuring the old game.
 *
 * Everything here is pure: it reads config and rolls nothing. `castExpectation`
 * runs `beginCast` against a throwaway record purely to reuse the real plan
 * maths rather than restate it -- the record it mutates is discarded.
 */

import { FISH, speciesForLevel } from '../config/fish.config.js';
import {
  APPRAISAL_GRADES,
  APPRAISAL_TRAITS,
  CHEST_TIERS,
  CHEST_TIER_WEIGHTS,
  GEM_TIERS,
} from '../config/rewards.config.js';
import { AUTO_FISHING } from '../config/game.config.js';
import { getRod } from '../config/rods.config.js';
import { allowedChestTiers, chestUpgradeBias, CHEST_TIER_ORDER } from './chests.js';
import { beginCast } from './fishing.js';

/**
 * The distribution of an appraisal's combined score, 0 .. MAX_APPRAISAL_SCORE.
 *
 * `appraiseGem` grades four traits independently off the same ladder and adds
 * their indices, so the total is the 4-fold convolution of the grade weights.
 * Index into this array by score; the value is that score's probability.
 */
export const APPRAISAL_SCORE_WEIGHTS = (() => {
  let scores = [1];
  for (let trait = 0; trait < APPRAISAL_TRAITS.length; trait += 1) {
    const next = Array(scores.length + APPRAISAL_GRADES.length - 1).fill(0);
    scores.forEach((probability, score) => {
      APPRAISAL_GRADES.forEach((grade, index) => {
        next[score + index] += probability * grade.weight / 100;
      });
    });
    scores = next;
  }
  return scores;
})();

/**
 * Mean Gold one gem of `tier` appraises for, rounding included.
 *
 * `appraiseGem` turns a score into a share -- (score + jitter) / (max + 1) --
 * and scales it across the tier's Gold range, then rounds. So each score owns
 * one uniform slice of the range, and the tier's mean is the probability-
 * weighted mean of `round(U[lo, hi])` over those slices. The rounding is worth
 * modelling rather than ignoring: at Emerald the range is only 90 Gold wide,
 * so half a coin per slice is not noise.
 */
export function gemMeanGold(tier) {
  const { min, max } = tier.gold;
  const slices = APPRAISAL_SCORE_WEIGHTS.length;

  return APPRAISAL_SCORE_WEIGHTS.reduce((total, probability, score) => {
    const lo = min + (max - min) * score / slices;
    const hi = min + (max - min) * (score + 1) / slices;
    let mean = 0;
    for (let coin = Math.floor(lo); coin <= Math.ceil(hi); coin += 1) {
      const overlap = Math.max(0, Math.min(hi, coin + 0.5) - Math.max(lo, coin - 0.5));
      mean += coin * overlap / (hi - lo);
    }
    return total + probability * mean;
  }, 0);
}

/** gemTierId -> mean Gold an appraisal of it pays. */
export const GEM_MEAN_GOLD = Object.freeze(
  Object.fromEntries(GEM_TIERS.map((tier) => [tier.id, gemMeanGold(tier)])),
);

/**
 * Expected value of opening one chest of `tier`, by currency.
 *
 * A chest pays exactly one reward drawn from its weighted table, so this is a
 * plain weighted mean over the table. Gem entries are folded in at the gem's
 * own appraised mean, because a gem is only ever Gold with a delay -- the
 * monitor counts the Gold when the appraiser pays it, and this has to agree.
 */
export function chestExpectedValue(tier) {
  const total = tier.rewardTable.reduce((sum, entry) => sum + entry.weight, 0);
  const ev = { gold: 0, xp: 0, bait: 0, pearls: 0 };

  for (const entry of tier.rewardTable) {
    const probability = entry.weight / total;
    if (entry.type === 'uncut_gem') ev.gold += probability * GEM_MEAN_GOLD[entry.gemTier];
    else ev[entry.type] += probability * (entry.min + entry.max) / 2;
  }
  return ev;
}

/** chestTierId -> { gold, xp, bait, pearls } expected from one open. */
export const CHEST_EV = Object.freeze(
  Object.fromEntries(CHEST_TIERS.map((tier) => [tier.id, chestExpectedValue(tier)])),
);

/**
 * Which chest tier a catch of `rarityIndex` produces, as probabilities.
 *
 * Mirrors `rollChest`'s weighted pick exactly -- same allowed set, same
 * upgrade bias, same exponent -- so the tier mix in the design tables is the
 * one the server actually rolls.
 */
export function chestTierMix({ stake, rarityIndex }) {
  const allowed = allowedChestTiers(stake);
  const bias = chestUpgradeBias({ stake, rarityIndex });
  const weightOf = (id) => CHEST_TIER_WEIGHTS[id] * bias ** CHEST_TIER_ORDER.indexOf(id);
  const total = allowed.reduce((sum, id) => sum + weightOf(id), 0);

  const mix = Object.fromEntries(CHEST_TIERS.map((tier) => [tier.id, 0]));
  for (const id of allowed) mix[id] = weightOf(id) / total;
  return mix;
}

/**
 * How long one cast occupies the idle loop, in seconds.
 *
 * The room resolves casts on a fixed tick and waits before recasting, so the
 * real cadence is the cast rounded up to a whole tick plus the recast delay
 * rounded up the same way -- not the rod's nominal cast time.
 */
export function castSeconds(rodLevel) {
  const { tickMs, recastDelayMs } = AUTO_FISHING;
  const rod = getRod(rodLevel);
  return (Math.ceil(rod.castMs / tickMs) + Math.ceil(recastDelayMs / tickMs)) * (tickMs / 1000);
}

/**
 * Everything one cast is expected to produce, for a given rod and stake.
 *
 * Returns the per-cast figures (`ev`), the composition behind them (`species`,
 * `tiers`) and the cadence (`seconds`) they should be divided by to get a
 * rate. Assumes no buffs, a bag with room in it and bait in hand -- the same
 * assumptions the generated tables state up front.
 */
export function castExpectation({ rodLevel, stake }) {
  // A throwaway record: `beginCast` is the only authority on how rod, stake
  // and clamps combine, and restating that here is how the tables would come
  // to describe a game the server no longer runs.
  const { plan } = beginCast(
    { rodLevel, stake, bait: Number.MAX_SAFE_INTEGER, fish: [], buffs: {} },
    0,
  );

  const pool = speciesForLevel(rodLevel);
  const total = pool.reduce((sum, fish) => sum + fish.weight * plan.rarityBias ** fish.rarityIndex, 0);

  const species = Object.fromEntries(FISH.map((fish) => [fish.id, 0]));
  const tiers = Object.fromEntries(CHEST_TIERS.map((tier) => [tier.id, 0]));
  let fishXp = 0;

  for (const fish of pool) {
    const share = fish.weight * plan.rarityBias ** fish.rarityIndex / total;
    species[fish.id] = share;
    fishXp += share * Math.round(fish.baseXp * plan.xpMult);

    // Chest tier is biased by the rarity of the fish that dropped it, so the
    // mix has to be accumulated per species rather than taken once.
    const mix = chestTierMix({ stake, rarityIndex: fish.rarityIndex });
    for (const [id, probability] of Object.entries(mix)) tiers[id] += share * probability;
  }

  const chest = plan.catchRate * plan.chestChance;
  const ev = { gold: 0, xp: plan.catchRate * fishXp, bait: 0, pearls: 0 };
  for (const [id, probability] of Object.entries(tiers)) {
    for (const key of Object.keys(ev)) ev[key] += chest * probability * CHEST_EV[id][key];
  }

  return {
    hit: plan.catchRate,
    chest,
    ev,
    species,
    tiers,
    seconds: castSeconds(rodLevel),
    fishXp: plan.catchRate * fishXp,
  };
}

/**
 * Expected mint rate, per second, for one player fishing continuously.
 *
 * This is the figure the emission monitor multiplies by a window length. Only
 * the currencies the server can actually mint are reported: XP is progression,
 * not emission, and fish in the bag are not currency until they are cashed in.
 */
export function expectedMintPerSecond({ rodLevel, stake }) {
  const { ev, seconds } = castExpectation({ rodLevel, stake });
  return {
    gold: ev.gold / seconds,
    pearls: ev.pearls / seconds,
    bait: ev.bait / seconds,
  };
}
