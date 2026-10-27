/**
 * Fishing Power XP and automatic rod level-up.
 *
 * `player` here is the plain persistence shape (see db/models.js): it carries
 * `rodLevel`, `xp` (progress inside the current level) and `totalXp`.
 */

import { MAX_ROD_LEVEL, getRod, xpToNext } from '../config/rods.config.js';

/**
 * Grants XP and applies every level-up the grant earns. A single legendary
 * chest can cross more than one threshold, so this loops rather than
 * incrementing once.
 *
 * Returns { gained, levelsGained, fromLevel, toLevel, xp, xpToNext }.
 */
export function grantXp(player, amount) {
  const gained = Math.max(0, Math.floor(Number(amount) || 0));
  const fromLevel = player.rodLevel;

  player.xp += gained;
  player.totalXp += gained;

  let levelsGained = 0;
  while (player.rodLevel < MAX_ROD_LEVEL) {
    const threshold = xpToNext(player.rodLevel);
    if (player.xp < threshold) break;
    player.xp -= threshold;
    player.rodLevel += 1;
    levelsGained += 1;
  }

  // At max level XP has nowhere to go; pin the bar full instead of letting it
  // grow unbounded, so the client can render a sane "MAX" state.
  if (player.rodLevel >= MAX_ROD_LEVEL) player.xp = 0;

  return {
    gained,
    levelsGained,
    fromLevel,
    toLevel: player.rodLevel,
    xp: player.xp,
    xpToNext: progressTarget(player.rodLevel),
  };
}

/** XP needed to finish the current level, or null at max level. */
export function progressTarget(level) {
  const rod = getRod(level);
  return rod.xpToNext;
}

/** 0..1 fill for the XP bar. Always 1 at max level. */
export function progressRatio(player) {
  const target = progressTarget(player.rodLevel);
  if (target === null) return 1;
  return Math.min(1, Math.max(0, player.xp / target));
}

export function rodFor(player) {
  return getRod(player.rodLevel);
}

/* ----------------------------------------------------- instant upgrades -- */

/**
 * What one rod level costs to buy outright.
 *
 * The GDD gives two skip-the-grind paths -- Sparks from chests, and Gold --
 * but no prices (ASSUMPTION A11). Sparks have since been removed from the game
 * entirely (they were only ever granted by a chest table that no longer
 * grants them), so Gold is the only skip-the-grind path now. The price is
 * derived from the XP actually being skipped rather than invented per level,
 * so it stays honest if the XP curve is retuned.
 */
export function upgradeCost(level) {
  if (level >= MAX_ROD_LEVEL) return null;

  const remaining = Math.max(0, xpToNext(level) - 0);
  return {
    level,
    toLevel: level + 1,
    gold: Math.max(1, Math.ceil(remaining * GOLD_PER_XP)),
  };
}

/**
 * Gold charged per point of XP skipped.
 *
 * FLAGGED, NOT DECIDED (2026-09-08): this rate was left unchanged when
 * rods.config.js's xpToNext curve was stretched ~29x at the top end (level 1
 * skip: 30 -> 672 Gold; level 9 skip: 2,196 -> 77,700 Gold, at an empty XP
 * bar). Because this price is deliberately *derived* from xpToNext rather
 * than pinned per level, it moved with the curve automatically -- which kept
 * skip pricing internally consistent, but nobody has checked whether 672-
 * 77,700 Gold is still an affordable, meaningful choice against how fast the
 * new economy actually mints Gold. Re-run `node server/tools/gdd-balance.js
 * --write` and read the "Hourly economy" table before shipping this rate as-
 * is -- it may need its own pass, separate from the XP curve.
 */
const GOLD_PER_XP = 0.6;

/** Cost to finish the *current* level, discounted by XP already earned. */
export function upgradeCostFor(player) {
  const cost = upgradeCost(player.rodLevel);
  if (!cost) return null;

  const remaining = Math.max(0, xpToNext(player.rodLevel) - player.xp);
  return { ...cost, gold: Math.max(1, Math.ceil(remaining * GOLD_PER_XP)) };
}

/**
 * Buys the next rod level outright with Gold.
 *
 * Charges only if the whole purchase can be afforded, and levels up through
 * grantXp so a bought level takes exactly the same path as an earned one --
 * including the max-level clamp.
 */
export function buyLevel(player) {
  const cost = upgradeCostFor(player);
  if (!cost) return { ok: false, code: 'MAX_LEVEL' };

  if (player.gold < cost.gold) {
    return { ok: false, code: 'NOT_ENOUGH_GOLD', needed: cost.gold, held: player.gold };
  }
  player.gold -= cost.gold;

  const remaining = Math.max(0, xpToNext(player.rodLevel) - player.xp);
  const result = grantXp(player, remaining);

  return {
    ok: true,
    currency: 'gold',
    spent: cost.gold,
    levelUp: result,
  };
}
