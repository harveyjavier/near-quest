/**
 * Treasure chests and uncut gems.
 *
 * Follows the GDD's chest model: a chest is won while fishing, and opening it
 * draws exactly one reward from its tier's table. Uncut gems are the second
 * container -- when a chest's roll lands on one it goes into the bag
 * unappraised, and is worth Gold in a range set by its tier.
 *
 * Every roll is server-side. A chest or gem is stored as an opaque id plus a
 * tier; the client can render the tier but cannot learn or influence what a
 * stone is worth until the server appraises it. `openChest` and `appraiseGem`
 * are the only places rewards are granted, and both refuse an id the player
 * does not hold.
 */

import {
  APPRAISAL_GRADES,
  APPRAISAL_TRAITS,
  CHEST_TIERS_BY_ID,
  CHEST_TIER_WEIGHTS,
  MAX_APPRAISAL_SCORE,
  MAX_UNOPENED_CHESTS,
  MAX_UNCUT_GEMS,
  CONSUMABLE_EFFECTS,
  REWARD_TYPES_BY_ID,
  GEM_TIERS_BY_ID,
} from '../config/rewards.config.js';
import { DEFAULT_STAKE, MAX_CHEST_TIER_BIAS, STAKE_BY_LEVEL } from '../config/game.config.js';
import { random, randomIntInclusive, token, weightedPick } from '../util/rng.js';
import { recordMint } from './metrics.js';
import { grantXp } from './progression.js';

/** Ordered worst-to-best, so index doubles as a tier rank for biasing. */
export const CHEST_TIER_ORDER = Object.keys(CHEST_TIER_WEIGHTS);

/** The Stake config entry for `stake`, falling back to the bottom of the ladder. */
function levelFor(stake) {
  return STAKE_BY_LEVEL[Number(stake)] ?? STAKE_BY_LEVEL[DEFAULT_STAKE];
}

/**
 * Chest tiers a stake can produce. See STAKE_LEVELS in game.config.js.
 *
 * Stake 1 only ever sees Common chests; the middle of the ladder widens out
 * through Rare and Epic; Legendary comes into reach at Stake 10 and above,
 * and the top two stakes trade Common (and then Rare) away entirely. This is
 * the one place a Stake choice changes *what* a player can win rather than
 * how much.
 */
export function allowedChestTiers(stake) {
  const tiers = levelFor(stake).chestTiers ?? [];
  // Config drift must not leave a stake unable to drop anything at all.
  return tiers.length > 0 ? [...tiers] : ['common'];
}

/**
 * How hard a catch tilts its chest roll toward the better of the tiers its
 * stake allows.
 *
 * Two inputs compound: the rarity of the fish that dropped the chest, and how
 * much the stake already favours chests. Applied as `bias ** tierRank` by the
 * callers, so it is an exponential tilt rather than a flat bonus -- which is
 * exactly why it wants a ceiling rather than being left to compound freely.
 *
 * The clamp against MAX_CHEST_TIER_BIAS is a lever with nothing pulled: the
 * live maximum this formula can reach is 2.00 (a Leviathan at Stake 40) and
 * the default ceiling sits above that, so today it changes no roll. See the
 * constant in game.config.js for what lowering it would do and why the value
 * is still an open decision.
 */
export function chestUpgradeBias({ stake = DEFAULT_STAKE, rarityIndex = 0 } = {}) {
  // 1.0 at a common catch on Stake 1, 2.0 at a Leviathan on Stake 40.
  const bias = 1 + rarityIndex * 0.14 + (levelFor(stake).chestChanceMult - 1) * 0.5;
  return Math.min(bias, MAX_CHEST_TIER_BIAS);
}

/**
 * Rolls a chest tier and pushes an unopened chest onto the player.
 *
 * The tier roll is tilted by the rarity of the fish that dropped it, so a rare
 * catch is more likely to produce the better of the tiers the stake allows.
 */
export function rollChest(player, {
  rarityIndex = 0,
  stake = DEFAULT_STAKE,
  now = Date.now(),
} = {}) {
  if (!Array.isArray(player.chests)) player.chests = [];
  if (player.chests.length >= MAX_UNOPENED_CHESTS) return null;

  const allowed = allowedChestTiers(stake);
  const upgradeBias = chestUpgradeBias({ stake, rarityIndex });

  const tierId = weightedPick(
    allowed,
    (id) => CHEST_TIER_WEIGHTS[id] * upgradeBias ** CHEST_TIER_ORDER.indexOf(id),
  );
  if (!tierId) return null;

  const chest = { id: token(12), tier: tierId, at: now };
  player.chests.push(chest);

  const tier = CHEST_TIERS_BY_ID[tierId];
  return { id: chest.id, tier: tierId, name: tier.name, color: tier.color, at: now };
}

/**
 * One reward-table entry, materialised into a concrete reward.
 *
 * `player` is only touched for gem entries, which have to be pushed into the
 * bag as an item rather than granted as an amount. Returns null when the entry
 * cannot be honoured (unknown type, or the gem bag is full), and the caller
 * falls back so that opening a chest can never yield nothing.
 */
function rollRewardEntry(entry, player, now) {
  const meta = REWARD_TYPES_BY_ID[entry.type];
  if (!meta) return null;

  if (entry.type === 'uncut_gem') {
    const gem = grantUncutGem(player, entry.gemTier, now);
    if (!gem) return null;
    return {
      type: 'uncut_gem',
      gemTier: gem.tier,
      name: gem.name,
      color: gem.color,
      amount: 1,
    };
  }

  const amount = randomIntInclusive(entry.min ?? 1, entry.max ?? entry.min ?? 1);
  if (amount <= 0) return null;

  return { type: entry.type, name: meta.name, kind: meta.kind, amount };
}

/**
 * Opens a chest the player owns.
 *
 * Returns { ok: false, code } rather than throwing, so a stale click from a
 * reconnecting client is a no-op instead of a crash.
 */
export function openChest(player, chestId, now = Date.now()) {
  if (!Array.isArray(player.chests)) player.chests = [];

  const index = player.chests.findIndex((chest) => chest.id === chestId);
  if (index === -1) return { ok: false, code: 'CHEST_NOT_OWNED' };

  const [chest] = player.chests.splice(index, 1);
  const tier = CHEST_TIERS_BY_ID[chest.tier];
  if (!tier) return { ok: false, code: 'CHEST_TIER_UNKNOWN' };

  // One roll, one reward. Entries that cannot be honoured -- a gem landing on
  // a full gem bag -- are retried against the rest of the table, so a chest
  // the player has already spent is never consumed for nothing.
  const rewards = [];
  let remaining = tier.rewardTable ?? [];

  while (rewards.length === 0 && remaining.length > 0) {
    const entry = weightedPick(remaining);
    if (!entry) break;

    const reward = rollRewardEntry(entry, player, now);
    if (reward) rewards.push(reward);
    else remaining = remaining.filter((candidate) => candidate !== entry);
  }

  const applied = applyRewards(player, rewards);
  logRewards(player, rewards, { chestTier: chest.tier, at: now });

  return {
    ok: true,
    chestId: chest.id,
    tier: chest.tier,
    tierName: tier.name,
    color: tier.color,
    rewards,
    levelUp: applied.levelUp,
    at: now,
  };
}

/** Adds an unappraised gem to the bag. Returns null when the bag is full. */
export function grantUncutGem(player, gemTierId, now = Date.now()) {
  if (!Array.isArray(player.uncutGems)) player.uncutGems = [];

  const tier = GEM_TIERS_BY_ID[gemTierId];
  if (!tier) return null;
  if (player.uncutGems.length >= MAX_UNCUT_GEMS) return null;

  const gem = { id: token(12), tier: gemTierId, at: now };
  player.uncutGems.push(gem);

  return { id: gem.id, tier: gemTierId, name: tier.name, color: tier.color, at: now };
}

/**
 * Grades one stone, trait by trait.
 *
 * Each trait is drawn independently off the same ladder, so a stone can come
 * back S on one trait and D on the next -- which is what stops the reveal
 * being four ways of saying the same thing.
 */
function rollGrades() {
  return APPRAISAL_TRAITS.map((trait) => {
    const grade = weightedPick(APPRAISAL_GRADES);
    return {
      id: trait.id,
      name: trait.name,
      grade: grade.id,
      color: grade.color,
      score: APPRAISAL_GRADES.indexOf(grade),
    };
  });
}

/**
 * Appraises a gem the player owns, paying out what it graded at.
 *
 * The ranges are deliberately wide -- an Uncut Diamond is 10-25,000 -- so
 * where in that range a stone lands is the whole point of the item. That is
 * decided here, on appraisal, not when the gem was won.
 *
 * The four grades are what place it: their combined score is scaled across the
 * tier's range, plus a fraction of a step of jitter so two stones graded alike
 * are not worth the identical amount to the coin. The client is handed the
 * grades along with the total precisely so the reveal can show its working.
 */
export function appraiseGem(player, gemId, now = Date.now()) {
  if (!Array.isArray(player.uncutGems)) player.uncutGems = [];

  const index = player.uncutGems.findIndex((gem) => gem.id === gemId);
  if (index === -1) return { ok: false, code: 'GEM_NOT_OWNED' };

  const [gem] = player.uncutGems.splice(index, 1);
  const tier = GEM_TIERS_BY_ID[gem.tier];
  if (!tier) return { ok: false, code: 'GEM_TIER_UNKNOWN' };

  const grades = rollGrades();
  const score = grades.reduce((total, trait) => total + trait.score, 0);
  const share = (score + random()) / (MAX_APPRAISAL_SCORE + 1);

  const { min, max } = tier.gold;
  const gold = Math.min(max, Math.max(min, Math.round(min + (max - min) * share)));
  player.gold += gold;
  // The single largest Gold faucet in the game, and the one an exploit would
  // aim at -- counted here, where the coin is actually created.
  recordMint('gold', gold);

  const reward = { type: 'gold', name: 'Gold Coin', kind: 'currency', amount: gold };
  logRewards(player, [reward], { gemTier: gem.tier, at: now });

  return {
    ok: true,
    gemId: gem.id,
    tier: gem.tier,
    tierName: tier.name,
    color: tier.color,
    grades,
    score,
    maxScore: MAX_APPRAISAL_SCORE,
    gold,
    goldTotal: player.gold,
    at: now,
  };
}

/**
 * Applies a rolled reward list to the player. Shared by chest opening and by
 * anything else that needs to grant a reward bundle.
 */
export function applyRewards(player, rewards) {
  let totalXp = 0;

  for (const reward of rewards) {
    switch (reward.type) {
      case 'bait':
        player.bait += reward.amount;
        recordMint('bait', reward.amount);
        break;
      case 'gold':
        player.gold += reward.amount;
        recordMint('gold', reward.amount);
        break;
      case 'pearls':
        player.pearls += reward.amount;
        recordMint('pearls', reward.amount);
        break;
      case 'xp':
        totalXp += reward.amount;
        break;
      case 'uncut_gem':
        // Already added to the bag by grantUncutGem, which owns the id.
        break;
      case 'lucky_charm':
      case 'power_lure': {
        if (!player.inventory) player.inventory = {};
        player.inventory[reward.type] = (player.inventory[reward.type] ?? 0) + reward.amount;
        break;
      }
      default:
        // Unknown reward type in a stale config: skip rather than corrupt state.
        break;
    }
  }

  const levelResult = totalXp > 0 ? grantXp(player, totalXp) : null;
  return { levelUp: levelResult && levelResult.levelsGained > 0 ? levelResult : null };
}

/** Keeps the most recent rewards for the Log panel. */
function logRewards(player, rewards, extra) {
  player.rewardLog = [
    ...rewards.map((reward) => ({ ...reward, ...extra })),
    ...(player.rewardLog ?? []),
  ].slice(0, 50);
}

/**
 * Activates one consumable from the inventory, adding its charges to the
 * player's active buffs. Charges stack additively if used repeatedly.
 */
export function useConsumable(player, consumableId) {
  const effect = CONSUMABLE_EFFECTS[consumableId];
  if (!effect) return { ok: false, code: 'CONSUMABLE_UNKNOWN' };

  if (!player.inventory) player.inventory = {};
  if ((player.inventory[consumableId] ?? 0) < 1) {
    return { ok: false, code: 'CONSUMABLE_NONE' };
  }

  player.inventory[consumableId] -= 1;
  if (!player.buffs) player.buffs = {};
  player.buffs[consumableId] = (player.buffs[consumableId] ?? 0) + effect.casts;

  return { ok: true, consumableId, castsRemaining: player.buffs[consumableId] };
}
