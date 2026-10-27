/**
 * The core fishing loop, resolved entirely server-side.
 *
 * A cast has two phases so that a client cannot game the roll by changing the
 * stake while a cast is in flight:
 *
 *   beginCast()   -- validates bait, spends it, decrements buff charges and
 *                    freezes every modifier into an immutable `plan`
 *   resolveCast() -- rolls against the frozen plan only
 *
 * The client is told the plan's duration so it can animate, and is told the
 * result when it lands. It is never told the odds and never sends an outcome.
 *
 * A landed catch does not pay out by itself. It is dropped into the player's
 * bag as a fish (`addCaughtFish`), and only becomes Fishing Power XP once the
 * player deliberately cashes it in (`cashOutSpecies` / `cashOutAllFish`) --
 * the catch loop and the reward loop are separate on purpose, so a chest and
 * a gem are not the only things worth clicking on in the bag.
 */

import { fishBagIsFull, hasRoomForFish, speciesForLevel } from '../config/fish.config.js';
import { getRod } from '../config/rods.config.js';
import { CONSUMABLE_EFFECTS } from '../config/rewards.config.js';
import {
  BAIT_PER_CAST,
  DEFAULT_STAKE,
  STAKE_BY_LEVEL,
  STAKE_RULES,
  isStakeUnlockedAt,
  highestStakeUnlockedAt,
} from '../config/game.config.js';
import { chance, token, weightedPick } from '../util/rng.js';
import { rollChest } from './chests.js';
import { grantXp } from './progression.js';

/** Catch rate is clamped so no combination of modifiers reaches 0% or a guaranteed 100%. */
const MIN_CATCH_RATE = 0.02;
const MAX_CATCH_RATE = 0.98;

/**
 * The player's current Stake, as its full config entry -- every modifier a
 * cast needs now hangs off this one object. Falls back to the default rather
 * than throwing: a record carrying a stake that a config change has since
 * retired should keep fishing at the bottom of the ladder, not stop dead.
 *
 * Also re-checks the Stake unlock gate (`STAKE_LEVELS[*].unlockLevel`) here,
 * not just in `validateStake` at `set_stake` time: a record saved before that
 * gate existed can carry a stake its current rod level no longer qualifies
 * for, and a rod level can in principle only fall via a config change, never
 * play, so this only ever needs to *lower* a stored stake, never raise one.
 * Clamping to the highest currently-unlocked rung (rather than dropping all
 * the way to DEFAULT_STAKE) keeps a returning player as close to where they
 * left off as the gate allows.
 */
function stakeFor(player) {
  const stake = Number(player.stake);
  if (isStakeUnlockedAt(stake, player.rodLevel)) {
    return STAKE_BY_LEVEL[stake] ?? STAKE_BY_LEVEL[DEFAULT_STAKE];
  }
  return STAKE_BY_LEVEL[highestStakeUnlockedAt(player.rodLevel)] ?? STAKE_BY_LEVEL[DEFAULT_STAKE];
}

/** Bait a single cast will cost right now, at the player's current stake. */
export function baitCostFor(player) {
  const { stake } = stakeFor(player);
  return STAKE_RULES.scalesBaitCost ? BAIT_PER_CAST * stake : BAIT_PER_CAST;
}

/** Which consumables have charges left. Read-only -- does not spend anything. */
export function activeBuffs(player) {
  const buffs = player.buffs ?? {};
  return Object.keys(CONSUMABLE_EFFECTS).filter((id) => (buffs[id] ?? 0) > 0);
}

/**
 * Spends one charge of every active consumable and returns their combined
 * multipliers. Called once per cast, at cast start.
 */
function consumeBuffCharges(player) {
  const combined = { rarityBias: 1, catchRateMult: 1, xpMult: 1, consumed: [] };
  if (!player.buffs) player.buffs = {};

  for (const [id, effect] of Object.entries(CONSUMABLE_EFFECTS)) {
    const remaining = player.buffs[id] ?? 0;
    if (remaining <= 0) continue;

    player.buffs[id] = remaining - 1;
    combined.rarityBias *= effect.rarityBias;
    combined.catchRateMult *= effect.catchRateMult;
    combined.xpMult *= effect.xpMult;
    combined.consumed.push({ id, remaining: player.buffs[id] });
  }
  return combined;
}

/**
 * Validates and starts a cast. Mutates `player` (spends bait, spends buff
 * charges). Returns { ok: false, code } if the cast cannot start -- the caller
 * decides whether that means "show an error" or "pause the idle loop".
 */
export function beginCast(player, now = Date.now()) {
  // A catch no longer pays out on the spot -- it waits in the bag until the
  // player cashes it in (see `cashOutSpecies` / `cashOutAllFish` below), so a
  // full bag has nowhere to put the fish a cast might land. Checked before
  // bait is even touched, the same way NO_BAIT is: a cast that cannot be
  // completed must not cost anything.
  if (!Array.isArray(player.fish)) player.fish = [];
  if (fishBagIsFull(player.fish, speciesForLevel(player.rodLevel))) {
    return { ok: false, code: 'FISH_BAG_FULL', fishCount: player.fish.length };
  }

  const level = stakeFor(player);
  const baitCost = baitCostFor(player);

  if (player.bait < baitCost) {
    return { ok: false, code: 'NO_BAIT', baitCost, bait: player.bait };
  }

  player.bait -= baitCost;

  const rod = getRod(player.rodLevel);
  const buffs = consumeBuffCharges(player);

  // Raising the stake LOWERS the catch rate -- that is the price the rarer
  // fish and better chests below are bought with. Bounded at both ends so no
  // combination of rod, stake and buffs reaches either 0% or a certainty.
  const catchRate = Math.min(
    MAX_CATCH_RATE,
    Math.max(
      MIN_CATCH_RATE,
      rod.catchRate * level.catchRateMult * buffs.catchRateMult,
    ),
  );

  const plan = Object.freeze({
    startedAt: now,
    durationMs: rod.castMs,
    endsAt: now + rod.castMs,
    stake: level.stake,
    baitCost,
    rodLevel: rod.level,
    catchRate,
    rarityBias: rod.rarityBias * level.rarityBias * buffs.rarityBias,
    xpMult: level.xpMult * buffs.xpMult,
    chestChance: rod.chestChance * level.chestChanceMult,
    buffsConsumed: buffs.consumed,
  });

  return { ok: true, plan };
}

/**
 * Abandons a cast that is still in flight and puts back everything
 * `beginCast` took: the bait, and one charge of each consumable it burned.
 *
 * A refund is safe here because the outcome is not rolled until `resolveCast`.
 * There is no information to act on mid-cast, so a player cannot profitably
 * start casts and cancel the ones they dislike -- they would only be moving
 * bait back and forth.
 *
 * Returns what was returned, so the caller can tell the client.
 */
export function cancelCast(player, plan) {
  if (!plan) return null;

  player.bait += plan.baitCost;

  if (!player.buffs) player.buffs = {};
  for (const { id } of plan.buffsConsumed ?? []) {
    player.buffs[id] = (player.buffs[id] ?? 0) + 1;
  }

  return {
    baitRefunded: plan.baitCost,
    buffsRestored: (plan.buffsConsumed ?? []).map(({ id }) => id),
  };
}

/**
 * Picks a species using the plan's frozen rarity bias. Weight is tilted
 * exponentially by rarityIndex, so bias > 1 lifts the rarity ceiling and
 * bias < 1 compresses the pool toward commons.
 */
function rollSpecies(rarityBias, rodLevel) {
  const bias = Number.isFinite(rarityBias) && rarityBias > 0 ? rarityBias : 1;
  // GDD: species are gated behind rod levels, so a rod can only ever hook what
  // it has unlocked. This is what makes levelling change the catch table rather
  // than just the numbers on it.
  const pool = speciesForLevel(rodLevel);
  return weightedPick(pool, (fish) => fish.weight * bias ** fish.rarityIndex);
}

/**
 * Resolves a cast against its frozen plan. Mutates `player` (catch counters,
 * the fish bag, chest inventory) and returns everything the client needs to
 * render the outcome.
 *
 * A landed fish no longer pays Gold or Fishing Power XP here -- it is dropped
 * into the bag as an item (`addCaughtFish`) and only pays out once the player
 * cashes it in from there. The XP the fish is *worth* is still rolled and
 * frozen at catch time, exactly as before (still shaped by the plan's stake),
 * so cashing in later cannot pay more or less than an instant grant would
 * have -- it only moves *when* that XP lands. Gold is not involved at all any
 * more: it comes from appraising gems and from chests.
 */
export function resolveCast(player, plan, now = Date.now()) {
  const hooked = chance(plan.catchRate);

  if (!hooked) {
    player.totalCasts += 1;
    return {
      success: false,
      stake: plan.stake,
      baitSpent: plan.baitCost,
      xp: 0,
      fish: null,
      levelUp: null,
      chest: null,
      at: now,
    };
  }

  const species = rollSpecies(plan.rarityBias, plan.rodLevel);
  const xpAmount = Math.max(1, Math.round(species.baseXp * plan.xpMult));

  player.totalCasts += 1;
  player.totalCatches += 1;
  recordCatch(player, species.id);

  // Guarded rather than assumed: beginCast already refused to start this cast
  // if the bag was full, so this should always succeed, but a null here (not
  // a crash) is the safe fallback if that guard is ever bypassed.
  const fish = addCaughtFish(player, species.id, xpAmount, now);

  // Rarer fish pull the chest tier roll upward, so a high stake pays off
  // twice: it hooks rarer fish, and those fish drop better chests.
  const chest = chance(plan.chestChance)
    ? rollChest(player, { rarityIndex: species.rarityIndex, stake: plan.stake, now })
    : null;

  return {
    success: true,
    species: { id: species.id, name: species.name, tier: species.tier, color: species.color },
    stake: plan.stake,
    baitSpent: plan.baitCost,
    // What the fish is worth in Fishing Power once cashed in -- informational
    // only here, the bag entry (`fish`) is what actually holds the claim.
    xp: xpAmount,
    fish: fish ? { id: fish.id, speciesId: fish.speciesId, xp: fish.xp } : null,
    levelUp: null,
    chest,
    at: now,
  };
}

/** Increments the per-species tally used by the catch log in the inventory view. */
export function recordCatch(player, speciesId) {
  if (!player.catchCounts) player.catchCounts = {};
  player.catchCounts[speciesId] = (player.catchCounts[speciesId] ?? 0) + 1;
}

/* ------------------------------------------------------------- the bag -- */

/**
 * Drops one caught fish into the bag, into that species' open stack or a
 * fresh slot when the stack is full. Returns null when the bag has no room
 * left for this species -- `beginCast` is what actually enforces the cap (see
 * there), so this is a defensive fallback rather than the normal path to "no
 * room".
 */
export function addCaughtFish(player, speciesId, xp, now = Date.now()) {
  if (!Array.isArray(player.fish)) player.fish = [];
  if (!hasRoomForFish(player.fish, speciesId)) return null;

  const item = { id: token(12), speciesId, xp, at: now };
  player.fish.push(item);
  return item;
}

/**
 * Cashes in every fish of one species, paying the exact Fishing Power XP each
 * of them was rolled for when it was caught.
 *
 * Refuses rather than no-ops on an empty match, so a stale click from a
 * reconnecting client reports nothing to cash in instead of silently landing
 * a zero-XP grant.
 */
export function cashOutSpecies(player, speciesId, now = Date.now()) {
  if (!Array.isArray(player.fish)) player.fish = [];

  const matching = player.fish.filter((item) => item.speciesId === speciesId);
  if (matching.length === 0) return { ok: false, code: 'FISH_NONE' };

  player.fish = player.fish.filter((item) => item.speciesId !== speciesId);

  const totalXp = matching.reduce((sum, item) => sum + item.xp, 0);
  const levelResult = grantXp(player, totalXp);

  return {
    ok: true,
    speciesId,
    count: matching.length,
    xp: totalXp,
    levelUp: levelResult.levelsGained > 0 ? levelResult : null,
    at: now,
  };
}

/** Cashes in every fish in the bag at once, across every species held. */
export function cashOutAllFish(player, now = Date.now()) {
  if (!Array.isArray(player.fish)) player.fish = [];
  if (player.fish.length === 0) return { ok: false, code: 'FISH_NONE' };

  const cashed = player.fish;
  player.fish = [];

  const totalXp = cashed.reduce((sum, item) => sum + item.xp, 0);
  const bySpecies = new Map();
  for (const item of cashed) {
    bySpecies.set(item.speciesId, (bySpecies.get(item.speciesId) ?? 0) + 1);
  }

  const levelResult = grantXp(player, totalXp);

  return {
    ok: true,
    count: cashed.length,
    xp: totalXp,
    bySpecies: [...bySpecies.entries()].map(([speciesId, count]) => ({ speciesId, count })),
    levelUp: levelResult.levelsGained > 0 ? levelResult : null,
    at: now,
  };
}
