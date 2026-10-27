/**
 * The odds, as the player is allowed to read them.
 *
 * This module reverses a rule the rest of the server was written under: the
 * client used to be told what a chest *could* contain and never how likely any
 * of it was (see the notes on CLIENT_CATALOG in config/index.js and on the
 * plan in game/fishing.js). Disclosure is now a deliberate design choice --
 * "1 in 121" reads as an event in a way "0.83%" does not, and a player who can
 * see the ladder can see what raising their Stake actually buys.
 *
 * Publishing odds does not weaken the server's authority over a roll. Every
 * outcome is still rolled here, from `util/rng.js`, and knowing a probability
 * tells a client nothing about the next draw from it. What a client must still
 * never receive is a *seed* or an unresolved outcome, and neither passes
 * through this file.
 *
 * Everything here reads through `balanceModel.js` rather than restating the
 * arithmetic. That is the whole point: the figure on the panel, the figure in
 * `design/balance-tables.md` and the figure the emission monitor checks against
 * are then one computation with three readers, and a balance change moves all
 * three or none.
 */

import { CHEST_TIERS, chestContentOdds } from '../config/rewards.config.js';
import { STAKE_LEVELS } from '../config/game.config.js';
import { castExpectation } from './balanceModel.js';

export { chestContentOdds };

/**
 * How the client is told to caption an odds figure it cannot fully account
 * for. The suffix is printed on every odds line in the UI.
 *
 * What it honestly stands for, per surface:
 *
 *   drop rates    active tackle (Lucky Charm, Power Lure) is not folded in,
 *                 and the tier a chest lands on is biased by the rarity of the
 *                 fish that dropped it -- so a single roll genuinely deviates
 *                 from this average in both directions.
 *
 *   chest contents  nothing is hidden. A tier's reward table is fixed and
 *                 these probabilities are exact.
 *
 * It is printed on both because the design asks for one consistent marker.
 * Scoping it to the drop rates alone is a one-line change: see `ODDS_SUFFIX`
 * in client/src/ui/hud.js, which is the only place it is rendered.
 */
export const ODDS_ARE_PARTIAL = true;

/**
 * Chance one cast ends in a gem of each tier, and in any gem at all.
 *
 * A gem is two independent gates deep -- the chest has to drop, then its one
 * roll has to land on the stone -- which is exactly why it wants stating: at
 * rod 10 a chest is roughly 1 in 4 casts and a Diamond is roughly 1 in 900,
 * and no player is going to compose those two numbers in their head.
 */
function gemOdds(perCastTier) {
  const gems = {};
  for (const tier of CHEST_TIERS) {
    const gem = chestContentOdds(tier.rewardTable).find((entry) => entry.type === 'uncut_gem');
    if (!gem) continue;
    gems[gem.gemTier] = (perCastTier[tier.id] ?? 0) * gem.chance;
  }
  return gems;
}

/**
 * Memoised per rod-and-stake. The config is frozen at module load and there
 * are only MAX_ROD_LEVEL x STAKE_LEVELS combinations, so this fills to at most
 * a few dozen entries and never invalidates -- which matters because `meView`
 * calls it on every state push, and `castExpectation` walks every species and
 * every tier each time it runs.
 */
const cache = new Map();

/**
 * What a single cast is worth in odds, at this rod and stake.
 *
 * Deliberately buff-free: `castExpectation` plans a cast for a player with no
 * consumables running, so this is the baseline the "+ ???" marker is measured
 * against rather than a figure that flickers as charges burn down.
 *
 * `tiers` is the chance per *cast*, not per chest -- it already has the catch
 * gate and the chest gate folded in, so the four values sum to `chest` rather
 * than to 1. That is the number a player is actually asking for when they ask
 * how rare a Legendary is.
 */
export function castOdds(rodLevel, stake) {
  const key = `${rodLevel}:${stake}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { hit: catchRate, chest, tiers } = castExpectation({ rodLevel, stake });

  const perCastTier = {};
  for (const tier of CHEST_TIERS) perCastTier[tier.id] = chest * (tiers[tier.id] ?? 0);

  const gems = gemOdds(perCastTier);

  const view = Object.freeze({
    rodLevel,
    stake,
    // Chance a cast hooks anything at all.
    catch: catchRate,
    // Chance a cast produces a chest of any tier.
    chest,
    tiers: Object.freeze(perCastTier),
    gems: Object.freeze(gems),
    anyGem: Object.values(gems).reduce((sum, probability) => sum + probability, 0),
  });

  cache.set(key, view);
  return view;
}

/**
 * The same figures for every rung of the Stake ladder at one rod, so a panel
 * can show a player what moving the lever would do without them having to move
 * it and watch. Cheap: every entry is memoised by `castOdds`.
 */
export function stakeLadderOdds(rodLevel) {
  return STAKE_LEVELS.map((level) => castOdds(rodLevel, level.stake));
}

/**
 * For every chest tier, the odds it has at the lowest Stake where it is
 * allowed at all -- so the Odds tab has a real number to print for a tier the
 * player's *current* Stake cannot reach, instead of "never".
 *
 * "Never" was correct as far as it went (this Stake truly cannot produce this
 * tier -- see `allowedChestTiers` in game/chests.js, which this deliberately
 * does not touch) but it threw away the one thing a player looking at a locked
 * tier actually wants to know: how rare is it once Stake gets me there. This
 * answers that instead, without changing what any Stake can actually roll.
 *
 * Not `stakeLadderOdds` -- a locked card only needs the one rung it unlocks
 * at, not the full ladder's worth of figures for tiers the player has no use
 * for yet.
 */
export function chestTierUnlockOdds(rodLevel) {
  const unlock = {};
  for (const tier of CHEST_TIERS) {
    const level = STAKE_LEVELS.find((entry) => (entry.chestTiers ?? []).includes(tier.id))
      ?? STAKE_LEVELS[0];
    unlock[tier.id] = {
      stake: level.stake,
      probability: castOdds(rodLevel, level.stake).tiers[tier.id] ?? 0,
    };
  }
  return unlock;
}
