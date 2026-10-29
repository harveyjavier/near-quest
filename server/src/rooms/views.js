/**
 * Builds the private per-player payloads sent over direct messages.
 *
 * Anything in here is visible only to the one client it is addressed to. The
 * shared room state (HarborState) carries the public projection instead.
 */

import { CHEST_TIERS_BY_ID, GEM_TIERS_BY_ID } from '../config/rewards.config.js';
import {
  FISH_BY_ID,
  MAX_CAUGHT_FISH,
  MAX_FISH_SLOTS,
  MAX_FISH_STACK,
  fishBagIsFull,
  fishSlotsUsed,
  speciesForLevel,
} from '../config/fish.config.js';
import { getRod, MAX_ROD_LEVEL } from '../config/rods.config.js';
import { progressTarget, upgradeCostFor } from '../game/progression.js';
import { baitCostFor } from '../game/fishing.js';
import { castOdds, chestTierUnlockOdds } from '../game/odds.js';

/** Full private snapshot: wallet, progression, inventory, chests, catch log. */
export function meView(record, runtime = {}) {
  const rod = getRod(record.rodLevel);

  return {
    displayName: record.displayName,
    nearAccountId: record.nearAccountId ?? null,

    rodLevel: record.rodLevel,
    rodName: rod.name,
    maxRodLevel: MAX_ROD_LEVEL,
    xp: record.xp,
    xpToNext: progressTarget(record.rodLevel),
    totalXp: record.totalXp,

    bait: record.bait,
    gold: record.gold,
    pearls: record.pearls,
    // Older documents predate this field -- see db/repo.js's PERSISTED_FIELDS.
    usdg: record.usdg ?? 0,

    stake: record.stake,
    autoFishing: record.autoFishing,
    baitPerCast: baitCostFor(record),
    castMs: rod.castMs,

    totalCasts: record.totalCasts,
    totalCatches: record.totalCatches,

    // What this rod can currently hook, so the client can show the species
    // gate rather than leaving a player wondering why a Leviathan never bites.
    unlockedSpecies: speciesForLevel(record.rodLevel).map((fish) => fish.id),
    upgrade: upgradeCostFor(record),

    // Per-cast drop odds at this exact rod and stake -- the figures behind the
    // journal's Odds tab. Rides on `me` rather than the catalog because it
    // moves every time the player levels or turns the Stake dial, and is
    // memoised per rod-and-stake in game/odds.js so pushing it on every state
    // change costs a map lookup. Buff-free by design: see the note there.
    odds: castOdds(record.rodLevel, record.stake),
    // What a tier the current Stake cannot reach would read once it can --
    // see chestTierUnlockOdds's own note for why "never" alone is not enough.
    oddsUnlock: chestTierUnlockOdds(record.rodLevel),

    inventory: { ...(record.inventory ?? {}) },
    buffs: { ...(record.buffs ?? {}) },
    catchCounts: { ...(record.catchCounts ?? {}) },
    chests: chestsView(record.chests),
    uncutGems: uncutGemsView(record.uncutGems),
    // Fish waiting to be cashed in for Fishing Power XP -- see game/fishing.js.
    fish: fishView(record.fish),
    maxFish: MAX_CAUGHT_FISH,
    // The bag fills by slots, not by a flat fish count: a species spills into
    // a new slot every MAX_FISH_STACK fish, and casting stops when the last
    // slot is gone (see fishBagIsFull in config/fish.config.js).
    fishStackSize: MAX_FISH_STACK,
    fishSlots: MAX_FISH_SLOTS,
    fishSlotsUsed: fishSlotsUsed(record.fish ?? []),
    fishBagFull: fishBagIsFull(record.fish ?? [], speciesForLevel(record.rodLevel)),
    rewardLog: (record.rewardLog ?? []).slice(0, 30),

    casting: Boolean(runtime.plan),
    castEndsAt: runtime.plan?.endsAt ?? 0,
    serverTime: Date.now(),
  };
}

/** Groups unopened chests by tier for the inventory view, keeping ids intact. */
export function chestsView(chests = []) {
  return chests.map((chest) => {
    const tier = CHEST_TIERS_BY_ID[chest.tier];
    return {
      id: chest.id,
      tier: chest.tier,
      name: tier?.name ?? chest.tier,
      color: tier?.color ?? '#888888',
      at: chest.at,
    };
  });
}

/** Unappraised gems, expanded with names and colours for the bag. */
export function uncutGemsView(uncutGems = []) {
  return uncutGems.map((gem) => {
    const tier = GEM_TIERS_BY_ID[gem.tier];
    return {
      id: gem.id,
      tier: gem.tier,
      name: tier?.name ?? gem.tier,
      color: tier?.color ?? '#c9b79a',
      at: gem.at,
    };
  });
}

/** Caught fish sitting in the bag, expanded with species names/colours to render. */
export function fishView(fish = []) {
  return fish.map((item) => {
    const species = FISH_BY_ID[item.speciesId];
    return {
      id: item.id,
      speciesId: item.speciesId,
      name: species?.name ?? item.speciesId,
      tier: species?.tier ?? 'common',
      color: species?.color ?? '#888888',
      xp: item.xp,
      at: item.at,
    };
  });
}

/** Catch log expanded with species names for display. */
export function catchLogView(catchCounts = {}) {
  return Object.entries(catchCounts)
    .map(([speciesId, count]) => {
      const species = FISH_BY_ID[speciesId];
      return species
        ? { id: speciesId, name: species.name, tier: species.tier, color: species.color, count }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count);
}
