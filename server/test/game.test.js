/**
 * Unit tests for the server-authoritative game logic.
 *
 * These run without a database, a socket or a browser: every module under
 * src/game/ operates on a plain player record, which is exactly why the room
 * can stay a thin transport layer over them.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPlayerRecord } from '../src/db/repo.js';
import {
  addCaughtFish,
  beginCast,
  cancelCast,
  cashOutAllFish,
  cashOutSpecies,
  resolveCast,
  baitCostFor,
  activeBuffs,
} from '../src/game/fishing.js';
import { openChest, appraiseGem, rollChest, useConsumable, applyRewards, allowedChestTiers } from '../src/game/chests.js';
import {
  purchase,
  applyBaitRegen,
  buyGoldWithUsdg,
  createBaitStock,
  depositUsdg,
  packsInStock,
  returnBaitToStock,
} from '../src/game/economy.js';
import { grantXp, progressTarget, upgradeCostFor, buyLevel } from '../src/game/progression.js';
import {
  FISH,
  MAX_FISH_SLOTS,
  MAX_FISH_STACK,
  fishSlotsUsed,
  speciesForLevel,
} from '../src/config/fish.config.js';
import { RODS, MAX_ROD_LEVEL, getRod } from '../src/config/rods.config.js';
import { GEM_MEAN_GOLD } from '../src/game/balanceModel.js';
import {
  APPRAISAL_GRADES,
  APPRAISAL_TRAITS,
  CHEST_TIERS,
  CHEST_TIER_WEIGHTS,
  REWARD_TYPES,
  CONSUMABLE_EFFECTS,
  GEM_TIERS,
  GOLD_DOLLAR_RATE,
  MAX_APPRAISAL_SCORE,
  MAX_UNCUT_GEMS,
} from '../src/config/rewards.config.js';
import { BAIT_STOCK, SHOP_ITEMS_BY_ID, USDG_LIMITS } from '../src/config/economy.config.js';
import {
  BAIT_REGEN,
  RISK_BANDS,
  RISK_BAND_IDS,
  STAKE_LEVELS,
  STAKE_VALUES,
} from '../src/config/game.config.js';
import { weightedPick, chance, randomIntInclusive } from '../src/util/rng.js';

/** A player with enough bait to run thousands of casts. */
function player(overrides = {}) {
  // Rod 10 by default: most tests are about odds, and species are gated behind
  // rod levels, so a level-1 record would only ever hook the starting fish.
  return { ...createPlayerRecord('Tester'), bait: 1_000_000, rodLevel: 10, ...overrides };
}

/** A brand-new player, for the tests that are about levelling itself. */
function rookie(overrides = {}) {
  return player({ rodLevel: 1, xp: 0, totalXp: 0, ...overrides });
}

/** `count` caught fish of one species, as the bag stores them. */
function caughtFish(speciesId, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index).padStart(16, '0'), speciesId, xp: 4, at: Date.now(),
  }));
}

/**
 * Runs `count` full casts and returns every outcome.
 *
 * A catch now waits in the fish bag rather than paying out immediately (see
 * game/fishing.js), so a long run here cashes each one in on the spot, the
 * way an attentive player would -- otherwise the bag would hit its cap partway
 * through and start refusing casts, which is its own behaviour (covered
 * separately below) rather than something these odds/pacing tests care about.
 */
function runCasts(record, count) {
  const outcomes = [];
  for (let i = 0; i < count; i += 1) {
    const started = beginCast(record);
    if (!started.ok) break;
    const outcome = resolveCast(record, started.plan);
    outcomes.push(outcome);
    if (outcome.success) cashOutAllFish(record);
  }
  return outcomes;
}

describe('contract shape', () => {
  it('defines exactly 6 fish species', () => {
    assert.equal(FISH.length, 6);
    assert.equal(new Set(FISH.map((fish) => fish.id)).size, 6);
  });

  it('defines exactly 10 rod levels', () => {
    assert.equal(RODS.length, 10);
    assert.equal(MAX_ROD_LEVEL, 10);
    assert.equal(RODS.at(-1).xpToNext, null, 'max level must have no next threshold');
  });

  it('defines exactly 4 chest tiers and 5 reward types', () => {
    assert.equal(CHEST_TIERS.length, 4);
    assert.equal(REWARD_TYPES.length, 5);
    assert.equal(new Set(REWARD_TYPES.map((reward) => reward.id)).size, 5);
  });

  it('defines the 5 contracted stake levels', () => {
    assert.deepEqual(STAKE_VALUES, [1, 5, 10, 20, 40]);
  });

  it('makes Stake a genuine trade-off in both directions, not pure upside', () => {
    // The whole point of collapsing Stake and the Dial into one lever: every
    // step up the ladder must cost catch rate and buy rarity, XP and chests.
    // A table where any of these stops moving the right way is the old
    // "higher stake is strictly better value" shape creeping back in.
    for (let i = 1; i < STAKE_LEVELS.length; i += 1) {
      const below = STAKE_LEVELS[i - 1];
      const above = STAKE_LEVELS[i];

      assert.ok(above.stake > below.stake, `stake ${above.stake} must cost more bait`);
      assert.ok(above.catchRateMult < below.catchRateMult,
        `stake ${above.stake} must bite less often than ${below.stake}`);
      assert.ok(above.rarityBias > below.rarityBias,
        `stake ${above.stake} must hook rarer fish than ${below.stake}`);
      assert.ok(above.xpMult > below.xpMult,
        `stake ${above.stake} must pay more XP than ${below.stake}`);
      assert.ok(above.chestChanceMult > below.chestChanceMult,
        `stake ${above.stake} must drop more chests than ${below.stake}`);
    }
  });

  it('keeps the three contracted Dial names as a read-out over the stake ladder', () => {
    // Steady / Balanced / Risky are named in the contract's scope list. They
    // stopped being a control when Stake absorbed the risk trade-off, but the
    // names still have to exist and still have to label the curve.
    assert.deepEqual(RISK_BAND_IDS, ['steady', 'balanced', 'risky']);
    for (const band of RISK_BANDS) {
      assert.ok(band.name && band.blurb, `band ${band.id} has nothing to render`);
    }

    for (const level of STAKE_LEVELS) {
      assert.ok(RISK_BAND_IDS.includes(level.band),
        `stake ${level.stake} names an unknown band "${level.band}"`);
    }
  });

  it('never lets the Dial read-out disagree with the odds it is describing', () => {
    // The band is presentation only -- no game rule reads it -- which is
    // exactly why it can rot silently. Pinned to catchRateMult, the number
    // that actually decides how safe a rung is: a Steady rung must be safer
    // than every Balanced one, and Balanced safer than every Risky one.
    const safest = (id) => Math.min(...STAKE_LEVELS
      .filter((level) => level.band === id)
      .map((level) => level.catchRateMult));
    const riskiest = (id) => Math.max(...STAKE_LEVELS
      .filter((level) => level.band === id)
      .map((level) => level.catchRateMult));

    for (let i = 1; i < RISK_BAND_IDS.length; i += 1) {
      const safer = RISK_BAND_IDS[i - 1];
      const riskier = RISK_BAND_IDS[i];
      assert.ok(safest(safer) > riskiest(riskier),
        `every ${safer} stake must bite more often than every ${riskier} one`);
    }
  });

  it('every chest reward table only references real reward types', () => {
    const known = new Set(REWARD_TYPES.map((reward) => reward.id));
    for (const tier of CHEST_TIERS) {
      for (const entry of tier.rewardTable) {
        assert.ok(known.has(entry.type), `${tier.id} references unknown reward "${entry.type}"`);
        assert.ok(entry.weight > 0, `${tier.id} has a "${entry.type}" entry with no weight`);
      }
    }
  });

  it('every chest gem entry names a real gem tier', () => {
    const known = new Set(GEM_TIERS.map((gem) => gem.id));
    for (const tier of CHEST_TIERS) {
      const gems = tier.rewardTable.filter((entry) => entry.type === 'uncut_gem');
      assert.equal(gems.length, 1, `${tier.id} should offer exactly one gem tier`);
      assert.ok(
        known.has(gems[0].gemTier),
        `${tier.id} references unknown gem "${gems[0].gemTier}"`,
      );
    }
  });

  it('species carry the GDD XP values and are gated across the rod levels', () => {
    assert.deepEqual(
      FISH.map((fish) => [fish.name, fish.baseXp]),
      [
        ['Muddy Carp', 4],
        ['Speckled Trout', 6],
        ['Whiskered Catfish', 8],
        ['Golden Koi', 16],
        ['Moonfish', 32],
        ['Leviathan', 64],
      ],
    );

    const levels = FISH.map((fish) => fish.unlockLevel);
    assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'unlocks must ascend with rarity');
    assert.equal(levels[0], 1, 'the starting species must be catchable at level 1');
  });

  it('every shop item costs an in-game currency and grants something real', () => {
    const grantable = new Set(['bait', 'gold', 'pearls', ...Object.keys(CONSUMABLE_EFFECTS)]);
    for (const item of Object.values(SHOP_ITEMS_BY_ID)) {
      assert.ok(['bait', 'gold', 'pearls'].includes(item.cost.currency), item.id);
      assert.ok(item.cost.amount > 0, item.id);
      for (const grantId of Object.keys(item.grants)) {
        assert.ok(grantable.has(grantId), `${item.id} grants unknown "${grantId}"`);
      }
    }
  });

  it('stocks bait and nothing else', () => {
    const items = Object.values(SHOP_ITEMS_BY_ID);
    for (const item of items) {
      assert.equal(item.type, 'bait', `${item.id} is on the shelf but is not bait`);
      assert.ok(item.grants.bait > 0, `${item.id} is on the shelf but grants no bait`);
      // Nothing is displayed-but-locked any more: what is listed is for sale.
      assert.notEqual(item.purchasable, false, `${item.id} is listed but cannot be bought`);
    }
    assert.ok(items.length > 0, 'something has to be for sale');
  });
});

describe('rng primitives', () => {
  it('weightedPick respects weights', () => {
    const entries = [{ id: 'a', weight: 90 }, { id: 'b', weight: 10 }];
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 5000; i += 1) counts[weightedPick(entries).id] += 1;

    assert.ok(counts.a > counts.b * 4, `expected a >> b, got ${JSON.stringify(counts)}`);
    assert.ok(counts.b > 0, 'a 10% branch should be reachable');
  });

  it('weightedPick survives zero, negative and NaN weights', () => {
    assert.equal(weightedPick([{ w: 0 }, { w: 5 }], (entry) => entry.w).w, 5);
    assert.equal(weightedPick([{ w: -1 }, { w: 3 }], (entry) => entry.w).w, 3);
    assert.equal(weightedPick([{ w: NaN }, { w: 2 }], (entry) => entry.w).w, 2);
    assert.equal(weightedPick([{ w: 0 }], (entry) => entry.w), null);
    assert.equal(weightedPick([]), null);
  });

  it('chance clamps out-of-range probabilities', () => {
    assert.equal(chance(0), false);
    assert.equal(chance(-5), false);
    assert.equal(chance(1), true);
    assert.equal(chance(99), true);
    assert.equal(chance(undefined), false);
  });

  it('randomIntInclusive covers both endpoints', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) seen.add(randomIntInclusive(1, 3));
    assert.deepEqual([...seen].sort(), [1, 2, 3]);
    assert.equal(randomIntInclusive(7, 7), 7);
  });
});

describe('progression', () => {
  it('levels up automatically when a threshold is crossed', () => {
    const record = rookie();
    const result = grantXp(record, progressTarget(1));

    assert.equal(result.levelsGained, 1);
    assert.equal(record.rodLevel, 2);
    assert.equal(record.xp, 0);
  });

  it('applies multiple level-ups from one large grant', () => {
    const record = rookie();
    const needed = progressTarget(1) + progressTarget(2) + progressTarget(3);
    const result = grantXp(record, needed);

    assert.equal(result.levelsGained, 3);
    assert.equal(record.rodLevel, 4);
  });

  it('never exceeds the maximum rod level', () => {
    const record = rookie();
    grantXp(record, 10_000_000);

    assert.equal(record.rodLevel, MAX_ROD_LEVEL);
    assert.equal(progressTarget(record.rodLevel), null);

    grantXp(record, 10_000_000);
    assert.equal(record.rodLevel, MAX_ROD_LEVEL, 'extra XP at max level must not overflow');
  });

  it('ignores negative and non-numeric XP grants', () => {
    const record = rookie();
    grantXp(record, -500);
    grantXp(record, 'lots');
    assert.equal(record.totalXp, 0);
    assert.equal(record.rodLevel, 1);
  });
});

describe('fishing', () => {
  it('spends bait scaled by stake and refuses a cast it cannot afford', () => {
    const record = player({ bait: 10, stake: 5 });
    assert.equal(baitCostFor(record), 5);

    assert.equal(beginCast(record).ok, true);
    assert.equal(record.bait, 5);
    assert.equal(beginCast(record).ok, true);
    assert.equal(record.bait, 0);

    const broke = beginCast(record);
    assert.equal(broke.ok, false);
    assert.equal(broke.code, 'NO_BAIT');
    assert.equal(record.bait, 0, 'a refused cast must not spend bait');
  });

  it('freezes the plan so a mid-cast stake switch cannot change the roll', () => {
    const record = player({ stake: 1 });
    const { plan } = beginCast(record);

    record.stake = 40;
    assert.equal(plan.stake, 1);
    assert.throws(() => { plan.rarityBias = 99; }, TypeError, 'plan must be frozen');
  });

  it('a high stake raises the rarity ceiling and a low stake lowers it', () => {
    const SAMPLES = 4000;
    const rarityMean = (stake) => {
      const record = player({ stake });
      const catches = runCasts(record, SAMPLES).filter((outcome) => outcome.success);
      const total = catches.reduce((sum, outcome) => {
        const species = FISH.find((fish) => fish.id === outcome.species.id);
        return sum + species.rarityIndex;
      }, 0);
      return total / catches.length;
    };

    const low = rarityMean(1);
    const mid = rarityMean(10);
    const high = rarityMean(40);

    assert.ok(low < mid, `stake 1 (${low}) should be commoner than stake 10 (${mid})`);
    assert.ok(high > mid, `stake 40 (${high}) should be rarer than stake 10 (${mid})`);
  });

  it('a low stake lands more bites than a high one', () => {
    const SAMPLES = 4000;
    const hitRate = (stake) => {
      const record = player({ stake });
      const outcomes = runCasts(record, SAMPLES);
      return outcomes.filter((outcome) => outcome.success).length / outcomes.length;
    };

    const low = hitRate(1);
    const high = hitRate(40);
    assert.ok(low > high, `stake 1 (${low}) should out-hit stake 40 (${high})`);
  });

  it('every species is reachable and none dominates absolutely', () => {
    const record = player({ stake: 40 });
    const seen = new Map();
    for (const outcome of runCasts(record, 20000)) {
      if (outcome.success) seen.set(outcome.species.id, (seen.get(outcome.species.id) ?? 0) + 1);
    }
    for (const fish of FISH) {
      assert.ok(seen.has(fish.id), `${fish.name} was never caught in 20k casts`);
    }
  });

  it('never lets Stake multiply XP outright, only tilt it', () => {
    // Stake moves XP two ways -- the xpMult column, and the rarer fish a high
    // rarityBias hooks -- and both are meant to be modest. What must never
    // happen is XP scaling *with* the stake number: 40x bait paying 40x XP
    // collapses the ten contracted rod levels into a handful of casts.
    const at = (stake) => {
      const record = player({ stake });
      const catches = runCasts(record, 4000).filter((outcome) => outcome.success);
      return catches.reduce((sum, outcome) => sum + outcome.xp, 0) / catches.length;
    };

    const one = at(1);
    const forty = at(40);

    assert.ok(forty > one, `a high stake should pay more XP per catch (${one} -> ${forty})`);
    assert.ok(forty < one * 4,
      `XP must not scale with the stake number (${one} -> ${forty} at 40x bait)`);
  });

  it('a catch waits in the bag instead of paying Gold or XP on the spot', () => {
    // Stake 1 keeps the catch rate near its ceiling, so a real catch is
    // virtually guaranteed well inside this many tries.
    const record = player({ gold: 0, stake: 1 });
    let outcome;
    for (let i = 0; i < 200 && !outcome?.success; i += 1) {
      const { plan } = beginCast(record);
      outcome = resolveCast(record, plan);
    }

    assert.ok(outcome.success, 'expected at least one catch in 200 casts at max catch rate');
    assert.equal(record.gold, 0, 'catching a fish must not pay Gold any more');
    assert.equal(record.totalXp, 0, 'catching a fish must not grant XP until it is cashed in');
    assert.equal(record.fish.length, 1);
    assert.equal(record.fish[0].speciesId, outcome.species.id);
    assert.equal(record.fish[0].xp, outcome.xp);
  });

  it('cancelling an in-flight cast puts the bait back', () => {
    const record = player({ bait: 100, stake: 5 });
    const { plan } = beginCast(record);

    assert.equal(record.bait, 95);
    const refund = cancelCast(record, plan);

    assert.equal(record.bait, 100);
    assert.equal(refund.baitRefunded, 5);
    assert.equal(record.totalCasts, 0, 'a cancelled cast is not a cast');
  });

  it('cancelling restores the consumable charges the cast burned', () => {
    const record = player({ inventory: { lucky_charm: 1, power_lure: 1 } });
    useConsumable(record, 'lucky_charm');
    useConsumable(record, 'power_lure');

    const before = { ...record.buffs };
    const { plan } = beginCast(record);

    assert.equal(record.buffs.lucky_charm, before.lucky_charm - 1);
    assert.equal(record.buffs.power_lure, before.power_lure - 1);

    cancelCast(record, plan);
    assert.deepEqual(record.buffs, before);
  });

  it('cancelling nothing is harmless', () => {
    const record = player({ bait: 50 });
    assert.equal(cancelCast(record, null), null);
    assert.equal(record.bait, 50);
  });

  it('tracks casts, catches and the per-species catch log', () => {
    const record = player();
    const outcomes = runCasts(record, 300);
    const catches = outcomes.filter((outcome) => outcome.success);

    assert.equal(record.totalCasts, outcomes.length);
    assert.equal(record.totalCatches, catches.length);

    const logged = Object.values(record.catchCounts).reduce((sum, count) => sum + count, 0);
    assert.equal(logged, catches.length);
  });
});

describe('the fish bag', () => {
  it('adds a caught fish to the bag rather than paying it out', () => {
    const record = player();
    const item = addCaughtFish(record, FISH[0].id, 4);

    assert.equal(record.fish.length, 1);
    assert.equal(record.fish[0], item);
    assert.equal(item.speciesId, FISH[0].id);
    assert.equal(item.xp, 4);
  });

  it('opens a new slot for a species that has outgrown one stack', () => {
    const record = player();
    record.fish = caughtFish(FISH[0].id, MAX_FISH_STACK);

    assert.equal(fishSlotsUsed(record.fish), 1);
    assert.ok(addCaughtFish(record, FISH[0].id, 4), 'a full stack must not block the catch');
    assert.equal(record.fish.length, MAX_FISH_STACK + 1);
    assert.equal(fishSlotsUsed(record.fish), 2, 'the extra fish starts a second stack');
  });

  it('refuses to add past the cap', () => {
    const record = player();
    record.fish = caughtFish(FISH[0].id, MAX_FISH_STACK * MAX_FISH_SLOTS);

    assert.equal(fishSlotsUsed(record.fish), MAX_FISH_SLOTS);
    assert.equal(addCaughtFish(record, FISH[0].id, 4), null);
    assert.equal(record.fish.length, MAX_FISH_STACK * MAX_FISH_SLOTS);
  });

  it('blocks casting once the bag is full, without spending bait', () => {
    const record = player({ bait: 1000 });
    record.fish = caughtFish(FISH[0].id, MAX_FISH_STACK * MAX_FISH_SLOTS);

    const blocked = beginCast(record);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'FISH_BAG_FULL');
    assert.equal(record.bait, 1000, 'a refused cast must not spend bait');
  });

  it('keeps casting while a slot is still free', () => {
    const record = player({ bait: 1000 });
    record.fish = caughtFish(FISH[0].id, MAX_FISH_STACK * (MAX_FISH_SLOTS - 1));

    assert.equal(beginCast(record).ok, true);
  });

  it('cashing in one species pays exactly what its fish are worth and leaves the rest', () => {
    const record = rookie();
    record.fish = [
      { id: 'a'.repeat(16), speciesId: 'muddy_carp', xp: 4, at: Date.now() },
      { id: 'b'.repeat(16), speciesId: 'muddy_carp', xp: 4, at: Date.now() },
      { id: 'c'.repeat(16), speciesId: 'speckled_trout', xp: 6, at: Date.now() },
    ];

    const result = cashOutSpecies(record, 'muddy_carp');

    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.equal(result.xp, 8);
    assert.equal(record.totalXp, 8);
    assert.equal(record.fish.length, 1);
    assert.equal(record.fish[0].speciesId, 'speckled_trout');
  });

  it('cashing in everything drains the whole bag, across every species, and can level up', () => {
    const record = rookie();
    const needed = progressTarget(1);
    record.fish = [
      { id: 'a'.repeat(16), speciesId: 'muddy_carp', xp: needed, at: Date.now() },
      { id: 'b'.repeat(16), speciesId: 'speckled_trout', xp: 3, at: Date.now() },
    ];

    const result = cashOutAllFish(record);

    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.equal(result.xp, needed + 3);
    assert.deepEqual(
      result.bySpecies.map((entry) => entry.speciesId).sort(),
      ['muddy_carp', 'speckled_trout'],
    );
    assert.equal(record.fish.length, 0);
    assert.ok(result.levelUp, 'a big enough cash-in should be able to level the rod');
    assert.equal(record.rodLevel, 2);
  });

  it('refuses to cash in a species, or an empty bag, with nothing to give', () => {
    const record = rookie();
    assert.equal(cashOutSpecies(record, 'muddy_carp').code, 'FISH_NONE');
    assert.equal(cashOutAllFish(record).code, 'FISH_NONE');
  });
});

describe('consumables', () => {
  it('activating a charm spends inventory and grants charges', () => {
    const record = player({ inventory: { lucky_charm: 1 } });

    assert.deepEqual(activeBuffs(record), []);
    const result = useConsumable(record, 'lucky_charm');

    assert.equal(result.ok, true);
    assert.equal(record.inventory.lucky_charm, 0);
    assert.equal(record.buffs.lucky_charm, CONSUMABLE_EFFECTS.lucky_charm.casts);
    assert.deepEqual(activeBuffs(record), ['lucky_charm']);
  });

  it('refuses a consumable the player does not hold', () => {
    const record = player();
    assert.equal(useConsumable(record, 'lucky_charm').code, 'CONSUMABLE_NONE');
    assert.equal(useConsumable(record, 'nonsense').code, 'CONSUMABLE_UNKNOWN');
  });

  it('burns exactly one charge per cast and then expires', () => {
    const record = player({ inventory: { power_lure: 1 } });
    useConsumable(record, 'power_lure');
    const charges = CONSUMABLE_EFFECTS.power_lure.casts;

    runCasts(record, charges);
    assert.equal(record.buffs.power_lure, 0);
    assert.deepEqual(activeBuffs(record), []);

    // Compared against an identical record that never held the buff, rather
    // than against a hard-coded 1: the un-buffed baseline is the stake's own
    // xpMult now, so pinning a literal here would only be asserting what
    // Stake 1 happens to be worth today.
    const { plan } = beginCast(record);
    const { plan: unbuffed } = beginCast(player());
    assert.equal(plan.xpMult, unbuffed.xpMult, 'expired buff must stop applying');
  });
});

describe('chests', () => {
  it('only drops the chest tiers the stake allows', () => {
    // Stake 1 stays Common-only, so a brand-new player grows into the higher
    // tiers rather than skipping past them; the top of the ladder gives up
    // Common and then Rare entirely, so a full-send cast has no consolation
    // prize. Legendary sits behind Stake 10, where the GDD already put it.
    const cases = [
      [1, ['common']],
      [5, ['common', 'rare']],
      [10, ['common', 'rare', 'epic', 'legendary']],
      [20, ['rare', 'epic', 'legendary']],
      [40, ['epic', 'legendary']],
    ];

    for (const [stake, expected] of cases) {
      assert.deepEqual(allowedChestTiers(stake).sort(), [...expected].sort(), `stake ${stake}x`);

      // Reachability is asserted structurally, not by sampling. Since the
      // tier weights were rescaled to a ~53:30:24-times cascade, a Legendary
      // is about 1 in 49,000 tier rolls at Stake 10 -- a 4,000-draw sample
      // misses it nine times in ten, and a sample large enough to see it
      // reliably would be both slow and still probabilistic. A positive
      // weight in the pool is what "can drop" actually means.
      for (const tier of expected) {
        assert.ok(CHEST_TIER_WEIGHTS[tier] > 0,
          `stake ${stake}x allows ${tier} but it has no weight to be rolled with`);
      }

      // Sampling still proves the direction it can prove: that nothing
      // outside the allow-list ever leaks out, however rare.
      const record = player();
      const seen = new Set();
      for (let i = 0; i < 4000; i += 1) {
        record.chests.length = 0;
        seen.add(rollChest(record, { rarityIndex: 3, stake }).tier);
      }
      for (const tier of seen) {
        assert.ok(expected.includes(tier),
          `stake ${stake}x dropped ${tier}, which it does not allow`);
      }
    }
  });

  it('gates Legendary chests behind Stake 10', () => {
    for (const stake of [1, 5]) {
      assert.ok(!allowedChestTiers(stake).includes('legendary'),
        `legendary must not drop at ${stake}x`);
    }
    for (const stake of [10, 20, 40]) {
      assert.ok(allowedChestTiers(stake).includes('legendary'),
        `legendary must drop at ${stake}x`);
    }
  });

  it('a rare catch at a high stake upgrades the tier roll', () => {
    const meanTier = (rarityIndex, stake) => {
      const order = CHEST_TIERS.map((tier) => tier.id);
      const record = player();
      let total = 0;
      const N = 20000;
      for (let i = 0; i < N; i += 1) {
        record.chests.length = 0;
        total += order.indexOf(rollChest(record, { rarityIndex, stake }).tier);
      }
      return total / N;
    };

    assert.ok(meanTier(5, 40) > meanTier(0, 1), 'rarity + a high stake should lift chest tiers');
  });

  it('opening grants rewards, consumes the chest, and cannot be replayed', () => {
    const record = player();
    const dropped = rollChest(record, { rarityIndex: 5, stake: 40 });

    const opened = openChest(record, dropped.id);
    assert.equal(opened.ok, true);
    assert.ok(opened.rewards.length > 0);
    assert.equal(record.chests.length, 0);

    const replay = openChest(record, dropped.id);
    assert.equal(replay.ok, false);
    assert.equal(replay.code, 'CHEST_NOT_OWNED');
  });

  it('rejects a chest id the player never held', () => {
    const record = player();
    assert.equal(openChest(record, 'deadbeefdeadbeef').code, 'CHEST_NOT_OWNED');
  });

  /** What a chest is allowed to contain. */
  const CHEST_REWARDS = ['uncut_gem', 'bait', 'xp', 'pearls'];
  /** Granted somewhere else (an appraisal), never by a chest. */
  const NOT_FROM_CHESTS = ['gold'];

  it('a chest only ever pays the four things it is allowed to', () => {
    for (const tier of CHEST_TIERS) {
      for (const entry of tier.rewardTable) {
        assert.ok(
          CHEST_REWARDS.includes(entry.type),
          `${tier.id} offers "${entry.type}", which chests no longer hand out`,
        );
      }
    }
  });

  it('every reward a chest offers is reachable, and nothing else drops', () => {
    const record = player();
    const seen = new Set();

    // Stake 10 is the only rung that can reach every tier at once, and
    // therefore every reward -- which is the point of the GDD's gate.
    for (let i = 0; i < 40000 && seen.size < CHEST_REWARDS.length; i += 1) {
      record.chests.length = 0;
      record.uncutGems = [];
      const dropped = rollChest(record, { rarityIndex: 5, stake: 10 });
      for (const reward of openChest(record, dropped.id).rewards) seen.add(reward.type);
    }

    for (const type of CHEST_REWARDS) {
      assert.ok(seen.has(type), `reward type "${type}" is unreachable`);
    }
    for (const type of NOT_FROM_CHESTS) {
      assert.ok(!seen.has(type), `a chest paid "${type}"`);
    }
  });

  it('Gold come from an appraisal, so the type is not orphaned', () => {
    const holder = player({ gold: 0 });
    holder.uncutGems = [{ id: 'p'.repeat(16), tier: 'emerald', at: Date.now() }];

    assert.equal(appraiseGem(holder, 'p'.repeat(16)).ok, true);
    assert.ok(holder.gold > 0, 'an appraisal paid no Gold');
  });

  it('Sparks no longer exist as a currency or a chest reward', () => {
    // Sparks were removed outright: no reward type, no chest entry, no wallet
    // field, and the rod-upgrade panel prices in Gold only.
    const granted = CHEST_TIERS.flatMap((tier) => tier.rewardTable.map((entry) => entry.type));
    assert.ok(!granted.includes('spark'), 'a chest grants Sparks -- Sparks were supposed to be removed');
    assert.ok(!REWARD_TYPES.some((reward) => reward.id === 'spark'), 'Spark is still a reward type');

    const rookieCost = upgradeCostFor(rookie());
    assert.equal(rookieCost.sparks, undefined, 'the rod panel still quotes a Spark price');
    assert.ok(rookieCost.gold > 0, 'the rod panel stopped quoting a Gold price');
  });

  it('a chest yields exactly one reward, drawn from its own table', () => {
    for (const tier of CHEST_TIERS) {
      const offered = new Set(tier.rewardTable.map((entry) => entry.type));

      // Repeated so every branch of the weighted table is exercised, not just
      // whichever one the first roll happened to land on.
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const record = player();
        record.chests.push({ id: 'a'.repeat(16), tier: tier.id, at: Date.now() });

        const opened = openChest(record, 'a'.repeat(16));

        assert.equal(opened.rewards.length, 1, `${tier.id} must yield exactly one reward`);
        assert.ok(
          offered.has(opened.rewards[0].type),
          `${tier.id} yielded "${opened.rewards[0].type}", which is not in its table`,
        );
      }
    }
  });

  it('a chest whose roll lands on a gem puts that tier of gem in the bag', () => {
    for (const tier of CHEST_TIERS) {
      const gemTier = tier.rewardTable.find((entry) => entry.type === 'uncut_gem').gemTier;
      let seen = 0;

      for (let attempt = 0; attempt < 300 && seen === 0; attempt += 1) {
        const record = player();
        record.chests.push({ id: 'a'.repeat(16), tier: tier.id, at: Date.now() });

        const opened = openChest(record, 'a'.repeat(16));
        if (opened.rewards[0].type !== 'uncut_gem') continue;

        seen += 1;
        assert.equal(opened.rewards[0].gemTier, gemTier);
        assert.equal(record.uncutGems.length, 1, 'the gem lands in the bag unappraised');
      }

      // Every tier weights its gem at a third or more, so 300 draws missing it
      // entirely means the table is not reachable rather than unlucky.
      assert.ok(seen > 0, `${tier.id} never rolled its gem in 300 opens`);
    }
  });

  it('opening a chest with a full gem bag still yields something', () => {
    const record = player();
    record.uncutGems = Array.from({ length: MAX_UNCUT_GEMS }, (_, index) => ({
      id: String(index).padStart(16, '0'),
      tier: 'emerald',
      at: Date.now(),
    }));
    record.chests.push({ id: 'c'.repeat(16), tier: 'legendary', at: Date.now() });

    const opened = openChest(record, 'c'.repeat(16));

    assert.equal(opened.ok, true);
    assert.equal(opened.rewards.length, 1, 'the chest is not consumed for nothing');
    assert.notEqual(opened.rewards[0].type, 'uncut_gem');
  });

  it('applyRewards routes each reward to the right bucket', () => {
    const record = player({ bait: 0, gold: 0, pearls: 0 });
    applyRewards(record, [
      { type: 'bait', amount: 10 },
      { type: 'gold', amount: 20 },
      { type: 'pearls', amount: 3 },
      { type: 'xp', amount: 50 },
      { type: 'lucky_charm', amount: 2 },
      { type: 'not_a_real_type', amount: 999 },
    ]);

    assert.equal(record.bait, 10);
    assert.equal(record.gold, 20);
    assert.equal(record.pearls, 3);
    assert.equal(record.totalXp, 50);
    assert.equal(record.inventory.lucky_charm, 2);
  });
});

describe('species unlocks', () => {
  it('a level 1 rod can only hook the starting species', () => {
    const record = rookie();
    const caught = new Set();

    // The level has to be pinned *inside* the loop: casting earns XP, and a
    // rod that levels mid-run would widen its own pool and pass trivially.
    // The bag is drained the same way -- this loop never cashes in, so
    // without it the bag would fill and start refusing casts partway through.
    for (let i = 0; i < 2000; i += 1) {
      record.rodLevel = 1;
      record.xp = 0;
      record.fish = [];
      const started = beginCast(record);
      const outcome = resolveCast(record, started.plan);
      if (outcome.success) caught.add(outcome.species.id);
    }

    assert.deepEqual([...caught], [FISH[0].id]);
  });

  it('each level opens exactly the species the config unlocks', () => {
    for (const fish of FISH) {
      const after = speciesForLevel(fish.unlockLevel).map((f) => f.id);
      assert.ok(after.includes(fish.id), `${fish.name} missing at its unlock level`);

      // The starting species has no "before" to test -- level 0 is not a real
      // rod level, and speciesForLevel deliberately never returns nothing.
      if (fish.unlockLevel === 1) continue;

      const before = speciesForLevel(fish.unlockLevel - 1).map((f) => f.id);
      assert.ok(!before.includes(fish.id), `${fish.name} available too early`);
    }
  });

  it('never leaves a rod with nothing to catch', () => {
    for (let level = 0; level <= 12; level += 1) {
      assert.ok(speciesForLevel(level).length > 0, `level ${level} has no species`);
    }
  });
});

describe('stake', () => {
  it('costs bait in proportion to the stake', () => {
    for (const stake of STAKE_VALUES) {
      assert.equal(baitCostFor(player({ stake })), stake, `stake ${stake} charged the wrong bait`);
    }
  });

  it('never lets the catch rate reach a certainty or bottom out at zero', () => {
    // Both ends of the ladder, at both ends of the rod range: the clamp has to
    // hold where the multipliers are most extreme.
    for (const rodLevel of [1, 10]) {
      for (const stake of STAKE_VALUES) {
        const { plan } = beginCast(player({ stake, rodLevel }));
        assert.ok(plan.catchRate < 1, `rod ${rodLevel} at ${stake}x reached ${plan.catchRate}`);
        assert.ok(plan.catchRate > 0, `rod ${rodLevel} at ${stake}x reached ${plan.catchRate}`);
      }
    }
  });

  it('names a full set of modifiers for every contracted stake level', () => {
    for (const stake of STAKE_VALUES) {
      const level = STAKE_LEVELS.find((entry) => entry.stake === stake);
      assert.ok(level, `stake ${stake} has no config entry`);
      assert.ok(level.catchRateMult > 0, `stake ${stake} has no catch multiplier`);
      assert.ok(level.rarityBias > 0, `stake ${stake} has no rarity bias`);
      assert.ok(level.xpMult > 0, `stake ${stake} has no XP multiplier`);
      assert.ok(level.chestChanceMult > 0, `stake ${stake} has no chest multiplier`);
      assert.ok(level.chestTiers.length > 0, `stake ${stake} can drop no chests at all`);
      assert.ok(level.name && level.blurb, `stake ${stake} has nothing for the HUD to render`);
    }
  });
});

describe('gem appraisal', () => {
  /** Puts one gem of `tierId` in the bag and appraises it. */
  function appraise(record, tierId, id = 'c'.repeat(16)) {
    record.uncutGems = [{ id, tier: tierId, at: Date.now() }];
    return appraiseGem(record, id);
  }

  const midpoint = (tier) => (tier.gold.min + tier.gold.max) / 2;

  it('pays gold inside the tier range and consumes the gem', () => {
    for (const tier of GEM_TIERS) {
      const record = player({ gold: 0 });
      const appraised = appraise(record, tier.id);

      assert.equal(appraised.ok, true, tier.id);
      assert.ok(appraised.gold >= tier.gold.min && appraised.gold <= tier.gold.max,
        `${tier.id} paid ${appraised.gold}, outside ${tier.gold.min}-${tier.gold.max}`);
      assert.equal(record.gold, appraised.gold);
      assert.equal(record.uncutGems.length, 0);
    }
  });

  // The tiers used to be spaced -- each floor near the tier below's ceiling, so
  // a floor-rolled Diamond still beat a ceiling-rolled Sapphire. That was
  // reversed on a design call: every tier now shares one floor and separates on
  // its ceiling, which is the shape the GDD specifies. What still has to hold
  // is that the ceilings and the *means* stay well apart, or the tiers would
  // differ in nothing a player can feel.
  it('separates the tiers on their ceilings, over one shared floor', () => {
    const floor = GEM_TIERS[0].gold.min;

    for (let i = 1; i < GEM_TIERS.length; i += 1) {
      const below = GEM_TIERS[i - 1];
      const tier = GEM_TIERS[i];

      assert.equal(tier.gold.min, floor,
        `${tier.id} starts at ${tier.gold.min}, not the shared floor of ${floor}`);
      assert.ok(tier.gold.max > below.gold.max,
        `${tier.id} tops out no higher than ${below.id}`);

      // A shared floor means a bad roll on a rare stone can pay what a common
      // one pays. That is accepted. What is not accepted is the tiers being
      // close on average -- the rarer stone has to be worth chasing.
      const step = midpoint(tier) / midpoint(below);
      assert.ok(step >= 3, `${tier.id} is only ${step.toFixed(1)}x ${below.id}`);
    }
  });

  it('cannot be appraised twice or forged', () => {
    const record = player();
    record.uncutGems = [{ id: 'd'.repeat(16), tier: 'emerald', at: Date.now() }];

    assert.equal(appraiseGem(record, 'd'.repeat(16)).ok, true);
    assert.equal(appraiseGem(record, 'd'.repeat(16)).code, 'GEM_NOT_OWNED');
    assert.equal(appraiseGem(record, 'e'.repeat(16)).code, 'GEM_NOT_OWNED');
  });

  it('grades every trait off the ladder, and reports the score they add up to', () => {
    const known = new Set(APPRAISAL_GRADES.map((grade) => grade.id));
    const record = player({ gold: 0 });

    for (let i = 0; i < 200; i += 1) {
      const { grades, score, maxScore } = appraise(record, 'sapphire');

      assert.deepEqual(
        grades.map((trait) => trait.id),
        APPRAISAL_TRAITS.map((trait) => trait.id),
        'the traits come back in the order the panel lays its rows out',
      );
      for (const trait of grades) {
        assert.ok(known.has(trait.grade), `unknown grade "${trait.grade}"`);
      }

      assert.equal(score, grades.reduce((total, trait) => total + trait.score, 0));
      assert.equal(maxScore, MAX_APPRAISAL_SCORE);
    }
  });

  it('prices a stone on what it graded at, not on a roll of its own', () => {
    const record = player({ gold: 0 });
    const tier = GEM_TIERS.find((gem) => gem.id === 'sapphire');
    const { min, max } = tier.gold;

    // Each score owns one uniform slice of the tier's range (see `appraiseGem`
    // -- `share` is `(score + random()) / (MAX_APPRAISAL_SCORE + 1)`), so what
    // "priced on the grade" means is checkable exactly rather than by
    // threshold: the payout has to land inside the slice its own score owns.
    // One coin of slack for the rounding.
    const sliceFor = (score) => ({
      lo: min + ((max - min) * score) / (MAX_APPRAISAL_SCORE + 1) - 1,
      hi: min + ((max - min) * (score + 1)) / (MAX_APPRAISAL_SCORE + 1) + 1,
    });

    // The endpoints are arithmetic, not sampling: a floor-graded stone bottoms
    // out at the tier's floor and a perfect one tops out at its ceiling. This
    // used to be asserted by requiring the 2,000-draw sample to actually
    // *reach* both ends, which the steepened grade ladder made impossible --
    // A+ and S are 3% of a trait between them, so four of them at once is not
    // something a sample this size sees.
    assert.ok(sliceFor(0).lo <= min + 1, 'a zero-graded stone must price at the floor');
    assert.ok(sliceFor(MAX_APPRAISAL_SCORE).hi >= max - 1,
      'a perfectly graded stone must price at the ceiling');

    let worst = { score: Infinity, gold: 0 };
    let best = { score: -Infinity, gold: 0 };

    for (let i = 0; i < 2000; i += 1) {
      const { score, gold } = appraise(record, tier.id);
      const slice = sliceFor(score);
      assert.ok(gold >= slice.lo && gold <= slice.hi,
        `graded ${score} paid ${gold}, outside its slice `
        + `${slice.lo.toFixed(1)}-${slice.hi.toFixed(1)}`);

      if (score < worst.score) worst = { score, gold };
      if (score > best.score) best = { score, gold };
    }

    assert.ok(best.score > worst.score, 'the sample never varied');
    assert.ok(best.gold > worst.gold,
      `graded ${best.score} paid ${best.gold}, but ${worst.score} paid ${worst.gold}`);
  });

  it('pays each tier\'s modelled mean on average, not the range midpoint', () => {
    const runs = 4000;

    for (const tier of GEM_TIERS) {
      const record = player({ gold: 0 });
      for (let i = 0; i < runs; i += 1) appraise(record, tier.id);

      const mean = record.gold / runs;
      const expected = GEM_MEAN_GOLD[tier.id];
      const drift = Math.abs(mean - expected) / (tier.gold.max - tier.gold.min);

      // The grade ladder is skewed toward D/C/B (85% of a trait), so the
      // expected payout sits well under a tier's midpoint -- balanceModel.js's
      // GEM_MEAN_GOLD is the exact target, computed off the same weights.
      // 4% of the range is many times the sampling error here.
      assert.ok(drift < 0.04,
        `${tier.id} means ${mean.toFixed(1)}, ${(drift * 100).toFixed(1)}% off modelled ${expected.toFixed(1)}`);

      // The old, flatter ladder used to land near the midpoint. The new one
      // must not -- this is the regression check that the rebalance actually
      // took effect rather than the test target quietly tracking whatever the
      // config says.
      assert.ok(mean < midpoint(tier) * 0.85,
        `${tier.id} means ${mean.toFixed(1)}, not meaningfully under midpoint ${midpoint(tier)}`);
    }
  });

  it('grade probabilities sum to exactly 100% per trait', () => {
    const total = APPRAISAL_GRADES.reduce((sum, grade) => sum + grade.weight, 0);
    assert.ok(Math.abs(total - 100) < 1e-9, `grade weights sum to ${total}, not 100`);
  });

  it('every configured grade is reachable, and lands near its configured share', () => {
    const draws = 6000; // x4 traits = 24,000 independent grade rolls
    const counts = Object.fromEntries(APPRAISAL_GRADES.map((grade) => [grade.id, 0]));
    const record = player({ gold: 0 });

    for (let i = 0; i < draws; i += 1) {
      const { grades } = appraise(record, 'diamond');
      for (const trait of grades) counts[trait.grade] += 1;
    }

    const totalRolls = draws * APPRAISAL_TRAITS.length;
    for (const grade of APPRAISAL_GRADES) {
      assert.ok(counts[grade.id] > 0, `grade "${grade.id}" never came up in ${totalRolls} rolls`);

      const expected = grade.weight / 100;
      const observed = counts[grade.id] / totalRolls;
      // A binomial standard error scaled up generously, plus a floor so the
      // rarest grades (S is 0.2%) aren't asserting sample noise is impossible.
      const stderr = Math.sqrt((expected * (1 - expected)) / totalRolls);
      const tolerance = Math.max(8 * stderr, 0.002);
      assert.ok(Math.abs(observed - expected) < tolerance,
        `grade "${grade.id}" observed ${(observed * 100).toFixed(2)}%, expected ${(expected * 100).toFixed(2)}%`);
    }
  });
});

describe('instant rod upgrades', () => {
  it('buys a level with gold, charging only for the XP still owed, at a level-scaled price', () => {
    const full = rookie({ gold: 100_000 });
    const fullPrice = upgradeCostFor(full).gold;

    const partway = rookie({ gold: 100_000 });
    grantXp(partway, Math.floor(progressTarget(1) / 2));

    assert.ok(upgradeCostFor(partway).gold < fullPrice,
      'a half-finished level must cost less to skip');

    const result = buyLevel(partway);
    assert.equal(result.ok, true);
    assert.equal(result.currency, 'gold');
    assert.equal(partway.rodLevel, 2);
    assert.ok(upgradeCostFor(partway).gold > 0, 'later levels must still have a price');
  });

  it('refuses an upgrade the player cannot afford, without charging', () => {
    const record = rookie({ gold: 0 });

    assert.equal(buyLevel(record).code, 'NOT_ENOUGH_GOLD');
    assert.equal(record.rodLevel, 1);
    assert.equal(record.gold, 0);
  });

  it('refuses to sell a level past the maximum', () => {
    const record = player({ gold: 1_000_000 });
    assert.equal(upgradeCostFor(record), null);
    assert.equal(buyLevel(record).code, 'MAX_LEVEL');
  });
});

describe('economy', () => {
  it('completes an affordable purchase and deducts exactly the cost', () => {
    // Priced off the item rather than a literal: re-pricing the shelf is a
    // balance decision, and this test is about the arithmetic being exact.
    const item = SHOP_ITEMS_BY_ID.bait;
    const record = player({ gold: item.cost.amount * 4, bait: 0 });
    const result = purchase(record, item, 2, createBaitStock());

    assert.equal(result.ok, true);
    assert.equal(record.gold, item.cost.amount * 2);
    assert.equal(record.bait, item.grants.bait * 2);
  });

  it('refuses an unaffordable purchase without touching the wallet', () => {
    const item = SHOP_ITEMS_BY_ID.bait;
    const record = player({ gold: item.cost.amount - 1, bait: 0 });
    const result = purchase(record, item, 1, createBaitStock());

    assert.equal(result.ok, false);
    assert.equal(result.code, 'INSUFFICIENT_FUNDS');
    assert.equal(record.gold, item.cost.amount - 1);
    assert.equal(record.bait, 0);
  });

  it('refuses to sell an item marked unsellable', () => {
    // The shelf carries nothing locked now that the gem-priced tackle is gone,
    // so the guard is exercised against an item made for it: the point is that
    // `purchasable: false` is enforced here rather than in the client, and it
    // has to keep holding for whatever goes up unsellable next.
    const locked = {
      id: 'display_only',
      name: 'Display Only',
      cost: { currency: 'pearls', amount: 20 },
      grants: { lucky_charm: 1 },
      purchasable: false,
      lockedReason: 'Not for sale.',
    };
    const record = player({ pearls: 40 });
    const result = purchase(record, locked, 2, createBaitStock());

    assert.equal(result.ok, false);
    assert.equal(result.code, 'ITEM_LOCKED');
    assert.equal(record.pearls, 40, 'a refused sale must not take payment');
    assert.equal(record.inventory.lucky_charm, undefined);
  });

  it('regenerates bait up to the ceiling and no further', () => {
    const now = Date.now();
    const record = player({ bait: 0, lastBaitRegenAt: now - BAIT_REGEN.intervalMs * 5 });

    const granted = applyBaitRegen(record, now);
    assert.equal(granted, 5 * BAIT_REGEN.amount);
    assert.equal(record.bait, 5 * BAIT_REGEN.amount);

    record.bait = BAIT_REGEN.ceiling;
    record.lastBaitRegenAt = now - BAIT_REGEN.intervalMs * 100;
    assert.equal(applyBaitRegen(record, now), 0, 'must not top up past the ceiling');
    assert.equal(record.bait, BAIT_REGEN.ceiling);
  });

  it('never grants bait for a partial interval', () => {
    const now = Date.now();
    const record = player({ bait: 0, lastBaitRegenAt: now - (BAIT_REGEN.intervalMs - 1) });
    assert.equal(applyBaitRegen(record, now), 0);
  });

  /* ------------------------------------------------------------ bait stock */

  it('a purchase takes its bait off the shop shelf', () => {
    // Sized off the item so re-pricing the shelf cannot break this: what is
    // under test is that the shelf loses exactly what the player gained.
    const item = SHOP_ITEMS_BY_ID.bait;
    const perPack = item.grants.bait;
    const stock = createBaitStock(perPack * 10);
    const record = player({ gold: item.cost.amount * 10, bait: 0 });

    const result = purchase(record, item, 3, stock);

    assert.equal(result.ok, true);
    assert.equal(record.bait, perPack * 3);
    assert.equal(stock.units, perPack * 7, 'the shelf must lose exactly what the player gained');
    assert.deepEqual(result.stock, { units: perPack * 7, capacity: stock.capacity });
  });

  it('refuses a purchase the shelf cannot supply, and charges nothing for it', () => {
    // Four whole packs on the shelf and an order for five: the shortfall is
    // one pack however big a pack currently is.
    const item = SHOP_ITEMS_BY_ID.bait;
    const shelf = item.grants.bait * 4;
    const stock = createBaitStock(shelf);
    const record = player({ gold: item.cost.amount * 10, bait: 0 });

    const result = purchase(record, item, 5, stock);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'OUT_OF_STOCK');
    assert.equal(result.packsAvailable, 4);
    assert.equal(record.gold, item.cost.amount * 10, 'a sale the shop cannot fill must not take payment');
    assert.equal(record.bait, 0);
    assert.equal(stock.units, shelf);
  });

  it('counts a pack as available only when the shelf holds a whole one', () => {
    // packsInStock's floor-division behaviour, exercised against synthetic
    // pack sizes rather than the live one: the shelf sells a single 100-bait
    // pack today (see SHOP_ITEMS), and this math has to hold for whatever
    // size it is re-priced to next.
    const stock = createBaitStock(199);
    assert.equal(packsInStock(stock, { grants: { bait: 200 } }), 0);
    assert.equal(packsInStock(stock, { grants: { bait: 50 } }), 3);
    assert.equal(packsInStock(stock, { grants: { bait: 10 } }), 19);
  });

  it('returns burned bait to the shelf, and never past its capacity', () => {
    const stock = createBaitStock(10, 100);

    assert.equal(returnBaitToStock(stock, 40), 40);
    assert.equal(stock.units, 50);

    assert.equal(returnBaitToStock(stock, 80), 50, 'only the headroom is taken back');
    assert.equal(stock.units, 100);
    assert.equal(returnBaitToStock(stock, 10), 0, 'a full shelf takes nothing more');
  });

  it('conserves bait around the buy-and-burn loop', () => {
    const stock = createBaitStock(BAIT_STOCK.capacity);
    const record = player({ gold: 1000, bait: 0, stake: 5 });
    const total = () => stock.units + record.bait;
    const started = total();

    // Stake 5 costs 5 Bait a cast; 10 covers it with room to spare.
    purchase(record, SHOP_ITEMS_BY_ID.bait, 10, stock);
    assert.equal(total(), started, 'buying only moves bait, it does not make any');

    // A resolved cast burns its bait; the room hands that back to the shelf.
    const { plan } = beginCast(record);
    resolveCast(record, plan);
    returnBaitToStock(stock, plan.baitCost);
    assert.equal(total(), started, 'a burned cast puts its bait back on the shelf');
  });

  it('a cancelled cast refunds the player rather than the shelf', () => {
    const stock = createBaitStock(1000);
    const record = player({ bait: 100, stake: 5 });

    const { plan } = beginCast(record);
    cancelCast(record, plan);

    assert.equal(record.bait, 100);
    assert.equal(stock.units, 1000, 'an unburned cast must not mint bait onto the shelf');
  });

  it('a player who spends to zero can always recover', () => {
    const record = player({ bait: 0, gold: 0, pearls: 0 });
    const oneHourLater = Date.now() + 3_600_000;

    applyBaitRegen(record, oneHourLater);
    assert.ok(record.bait >= baitCostFor(record), 'bait regen must unstick a broke player');
  });
});

describe('usdg wallet', () => {
  it('credits a deposit onto the wallet balance', () => {
    const record = player({ usdg: 0 });
    const result = depositUsdg(record, 25);

    assert.equal(result.ok, true);
    assert.equal(record.usdg, 25);
    assert.equal(result.deposited, 25);
  });

  it('accumulates deposits rather than overwriting the balance', () => {
    const record = player({ usdg: 10 });
    depositUsdg(record, 5.5);
    assert.equal(record.usdg, 15.5);
  });

  it('refuses a deposit below the minimum, and touches nothing', () => {
    const record = player({ usdg: 3 });
    const result = depositUsdg(record, 0);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'AMOUNT_INVALID');
    assert.equal(record.usdg, 3);
  });

  it('refuses a deposit over the per-message cap', () => {
    const record = player({ usdg: 0 });
    const result = depositUsdg(record, USDG_LIMITS.maxDeposit + 1);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'AMOUNT_TOO_LARGE');
    assert.equal(record.usdg, 0);
  });

  it('refuses a deposit that would push the balance past its cap', () => {
    const record = player({ usdg: USDG_LIMITS.maxBalance - 1 });
    const result = depositUsdg(record, 5);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'BALANCE_CAP');
    assert.equal(
      record.usdg,
      USDG_LIMITS.maxBalance - 1,
      'a refused deposit must not touch the balance',
    );
  });

  it('buys Gold at the locked GOLD_DOLLAR_RATE anchor and spends exactly that much USDG', () => {
    const record = player({ usdg: 100, gold: 0 });
    const result = buyGoldWithUsdg(record, 50);

    assert.equal(result.ok, true);
    assert.equal(result.gold, 50);
    assert.equal(result.spent, 50 * GOLD_DOLLAR_RATE);
    assert.equal(record.gold, 50);
    assert.equal(record.usdg, 100 - 50 * GOLD_DOLLAR_RATE);
  });

  it('refuses a Gold purchase the wallet cannot afford, and grants nothing', () => {
    const record = player({ usdg: 1, gold: 0 });
    const result = buyGoldWithUsdg(record, 1000);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'INSUFFICIENT_USDG');
    assert.equal(record.gold, 0, 'a refused purchase must not grant Gold');
    assert.equal(record.usdg, 1, 'a refused purchase must not touch the wallet');
  });

  it('refuses a Gold purchase over the per-message cap', () => {
    const record = player({ usdg: USDG_LIMITS.maxBalance, gold: 0 });
    const result = buyGoldWithUsdg(record, USDG_LIMITS.maxGoldPurchase + 1);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'AMOUNT_TOO_LARGE');
    assert.equal(record.gold, 0);
  });

  it('conserves value around a deposit-then-buy round trip', () => {
    const record = player({ usdg: 0, gold: 0 });
    depositUsdg(record, 40);
    const result = buyGoldWithUsdg(record, 200);

    assert.equal(result.ok, true);
    assert.equal(record.gold, 200);
    assert.equal(record.usdg, 40 - 200 * GOLD_DOLLAR_RATE);
  });
});

describe('progression pacing', () => {
  /**
   * Bounds revised 2026-09-08 alongside the rods.config.js XP-curve stretch.
   * Reaching Rod 3 used to take about fifteen minutes of casual play -- fast
   * enough that the early rods (which exist to introduce Stake, chests and
   * appraisal) were routinely skipped past before a player had used them.
   * The curve was deliberately re-tuned against the real per-rod XP/hour
   * this suite computes (not a guessed rate), targeting a *floor* -- Stake 1,
   * the only Stake available at Rod 1 and the slowest one -- of roughly 37
   * hours of continuous play to Rod 10. A player who raises Stake as it
   * unlocks (see game.config.js STAKE_LEVELS[*].unlockLevel) climbs faster
   * than this floor, never slower, so this test intentionally pins Stake 1
   * for the whole run: it is checking the slowest honest path, not a
   * realistic one. The bounds below give ~35% headroom over the ~44,800
   * casts / ~40h a full simulated run actually takes, so the test catches a
   * curve that drifts an order of magnitude in either direction without
   * being so tight it flakes on RNG variance in chest-driven XP bursts.
   */
  it('reaching max rod level takes a meaningful number of casts', () => {
    const record = rookie({ stake: 1 });
    let casts = 0;
    let elapsedMs = 0;

    while (record.rodLevel < MAX_ROD_LEVEL && casts < 200_000) {
      const rodMsBefore = getRod(record.rodLevel).castMs;
      const started = beginCast(record);
      if (!started.ok) break;
      const outcome = resolveCast(record, started.plan);
      // A catch only becomes Fishing Power once cashed in -- bank it
      // immediately, the way a player who wants to level up would, so the
      // pacing this measures is the loop's, not how long fish sat uncashed.
      if (outcome.success) cashOutAllFish(record);
      casts += 1;
      // Each cast's own rod castMs plus the fixed recast delay, summed as we
      // go -- accurate across a run that changes rod (and so cast speed)
      // partway through, unlike pricing every cast at one fixed rod's speed.
      elapsedMs += rodMsBefore + 400;
    }

    assert.equal(record.rodLevel, MAX_ROD_LEVEL, 'max level must be reachable');
    assert.ok(casts > 500, `max level in ${casts} casts is too fast to be a 10-level progression`);
    assert.ok(casts < 65_000, `max level needs ${casts} casts -- unreachably slow`);

    const hours = elapsedMs / 3_600_000;
    assert.ok(hours < 55, `~${hours.toFixed(1)}h of idling to max is too long`);
    assert.ok(hours > 15, `~${hours.toFixed(1)}h of idling to max is too fast for the intended floor`);
  });
});
