/**
 * Fish species catalog.
 *
 * Names and XP values come from the GDD's species table (v1.3). Each species
 * is gated behind a rod level -- the GDD lists the gate only as "Level
 * milestone", so the specific levels below are chosen (ASSUMPTION A1).
 *
 * Two things are deliberately tuned here, because the first pass made the top
 * of the table unreachable in practice (Leviathan landed on ~0.1% of catches):
 *
 *   1. Unlocks finish at rod 7, not rod 10 (moved from rod 8 on 2026-09-08,
 *      alongside the rods.config.js XP-curve stretch: Moonfish 6->5 and
 *      Leviathan 8->7, so a new species still lands on a level that doesn't
 *      already have one -- levels 1-4 introduce Carp/Trout/Catfish/Koi one
 *      per level as before, then Moonfish and Leviathan fill what used to be
 *      the empty levels 5 and 7 rather than piling both onto 6 and 8). All
 *      six species are catchable at 70% of the XP climb, so the rare fish are
 *      something you play *with* rather than a trophy handed over as the run
 *      ends.
 *   2. The weight curve is shallow enough to survive the rarity bias. Bias is
 *      applied as `bias ** rarityIndex`, so at the tail it is raised to the
 *      fifth power -- the old 520:1 spread between Carp and Leviathan cancelled
 *      that out entirely. At max rod the Leviathan share is now roughly
 *      0.9% steady / 2.2% balanced / 5.4% risky (see `node tools/balance.js`),
 *      which keeps the stake lever meaningful without making a high stake a
 *      lottery.
 *
 * weight        relative draw weight inside the species roll (before biasing)
 * rarityIndex   0 = most common .. 5 = rarest. Stake / rod / charm bias the
 *               roll by raising each weight to a power of this index, so the
 *               ordering here is what actually drives "rarity ceiling".
 * unlockLevel   rod level at which the species can be caught at all
 * baseGold      Gold granted on catch, before the Stake multiplier
 * baseXp        Fishing Power XP granted on catch (GDD figure, exact)
 */

export const RARITY_TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const FISH = [
  {
    id: 'muddy_carp',
    name: 'Muddy Carp',
    tier: 'common',
    rarityIndex: 0,
    unlockLevel: 1,
    weight: 460,
    baseGold: 2,
    baseXp: 4,
    color: '#9a8058',
  },
  {
    id: 'speckled_trout',
    name: 'Speckled Trout',
    tier: 'common',
    rarityIndex: 1,
    unlockLevel: 2,
    weight: 300,
    baseGold: 3,
    baseXp: 6,
    color: '#8fb4c9',
  },
  {
    id: 'whiskered_catfish',
    name: 'Whiskered Catfish',
    tier: 'uncommon',
    rarityIndex: 2,
    unlockLevel: 3,
    weight: 175,
    baseGold: 5,
    baseXp: 8,
    color: '#6fbf73',
  },
  {
    id: 'golden_koi',
    name: 'Golden Koi',
    tier: 'rare',
    rarityIndex: 3,
    unlockLevel: 4,
    weight: 85,
    baseGold: 12,
    baseXp: 16,
    color: '#e8a13c',
  },
  {
    id: 'moonfish',
    name: 'Moonfish',
    tier: 'epic',
    rarityIndex: 4,
    unlockLevel: 5,
    weight: 33,
    baseGold: 30,
    baseXp: 32,
    color: '#a95fd8',
  },
  {
    id: 'leviathan',
    name: 'Leviathan',
    tier: 'legendary',
    rarityIndex: 5,
    unlockLevel: 7,
    weight: 9,
    baseGold: 90,
    baseXp: 64,
    color: '#54f0c8',
  },
];

export const FISH_BY_ID = Object.freeze(
  Object.fromEntries(FISH.map((fish) => [fish.id, fish])),
);

export function getFish(id) {
  return FISH_BY_ID[id] ?? null;
}

/**
 * How many fish of one species share a bag slot.
 *
 * A catch no longer pays out on the spot -- it waits in the bag until the
 * player cashes it in from there (see `cashOutSpecies` / `cashOutAllFish` in
 * `game/fishing.js`) -- so the bag has to hold a session's worth of fishing.
 * Past this count a species spills into a second slot rather than blocking
 * the cast, the same way a stack works anywhere else.
 */
export const MAX_FISH_STACK = 999;

/**
 * How many stacks the bag holds.
 *
 * Without a ceiling an idling session would grow the fish array forever, so
 * the cap moved from a flat fish count to the slots those fish occupy: once
 * every slot is full `beginCast` refuses to start a new cast (the same shape
 * as running out of bait) until the player makes room.
 */
export const MAX_FISH_SLOTS = 25;

/** The bag's ceiling in fish, for display -- every slot filled to the brim. */
export const MAX_CAUGHT_FISH = MAX_FISH_STACK * MAX_FISH_SLOTS;

/** How many fish of each species are in the bag, keyed by species id. */
export function fishSpeciesCounts(fish = []) {
  const counts = new Map();
  for (const item of fish) {
    counts.set(item.speciesId, (counts.get(item.speciesId) ?? 0) + 1);
  }
  return counts;
}

/** Slots those fish occupy: one per started stack, per species. */
export function fishSlotsUsed(fish = []) {
  let slots = 0;
  for (const count of fishSpeciesCounts(fish).values()) {
    slots += Math.ceil(count / MAX_FISH_STACK);
  }
  return slots;
}

/**
 * Whether one more fish of `speciesId` has somewhere to go: either a stack of
 * that species with room left in it, or a free slot to open a new one.
 */
export function hasRoomForFish(fish = [], speciesId) {
  const count = fishSpeciesCounts(fish).get(speciesId) ?? 0;
  if (count > 0 && count % MAX_FISH_STACK !== 0) return true;
  return fishSlotsUsed(fish) < MAX_FISH_SLOTS;
}

/**
 * Whether the bag is too full to cast into.
 *
 * A cast does not know what it will land, so the bag only counts as having
 * room when every species the rod can hook has somewhere to go -- otherwise a
 * cast could complete with nowhere to put the fish it caught.
 */
export function fishBagIsFull(fish = [], species = FISH) {
  return species.some((entry) => !hasRoomForFish(fish, entry.id));
}

/**
 * Species a rod of `level` can catch.
 *
 * Always returns at least the starting species: a config typo that gated
 * everything behind a high level would otherwise make casting silently
 * impossible rather than merely unbalanced.
 */
export function speciesForLevel(level) {
  const unlocked = FISH.filter((fish) => fish.unlockLevel <= level);
  return unlocked.length > 0 ? unlocked : [FISH[0]];
}

/** Species that become available on reaching `level`, for the level-up notice. */
export function speciesUnlockedAt(level) {
  return FISH.filter((fish) => fish.unlockLevel === level);
}
