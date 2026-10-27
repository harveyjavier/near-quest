/**
 * Unit tests for the emission tripwire.
 *
 * This is a monitoring feature, so it earns regression coverage the same way a
 * game rule does: a tripwire that has quietly stopped firing looks exactly like
 * a healthy server.
 *
 * Every test drives its own counters object rather than the module singleton,
 * so these stay independent of whatever the rest of the suite has minted.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accumulateEmission,
  createEmissionMetrics,
  createTheoryCarry,
  emissionAlerts,
  emission,
  MINTED_CURRENCIES,
  nextTheoryCarry,
  recordMint,
  takeEmissionWindow,
  theoryBudget,
} from '../src/game/metrics.js';
import { appraiseGem, applyRewards } from '../src/game/chests.js';
import { applyBaitRegen } from '../src/game/economy.js';
import { castExpectation, expectedMintPerSecond, GEM_MEAN_GOLD } from '../src/game/balanceModel.js';
import { createPlayerRecord } from '../src/db/repo.js';
import { BAIT_REGEN, EMISSION_MONITOR } from '../src/config/game.config.js';
import { GEM_TIERS } from '../src/config/rewards.config.js';

/** Thresholds small enough to write exact expectations against. */
const BOUNDS = { ratio: 2, minSample: { gold: 100, pearls: 5, bait: 100 } };

describe('emission counters', () => {
  it('tallies each currency separately', () => {
    const counters = createEmissionMetrics(0);

    recordMint('gold', 40, counters);
    recordMint('gold', 60, counters);
    recordMint('pearls', 3, counters);
    recordMint('bait', 12, counters);

    assert.equal(counters.goldMinted, 100);
    assert.equal(counters.pearlsMinted, 3);
    assert.equal(counters.baitMinted, 12);
  });

  it('ignores amounts that are not positive and finite', () => {
    const counters = createEmissionMetrics(0);

    recordMint('gold', 0, counters);
    recordMint('gold', -50, counters);
    recordMint('gold', Number.NaN, counters);
    recordMint('gold', Number.POSITIVE_INFINITY, counters);
    recordMint('gold', undefined, counters);

    assert.equal(counters.goldMinted, 0, 'a bad amount must not corrupt the tally');
  });

  it('ignores a currency the server does not mint', () => {
    const counters = createEmissionMetrics(0);
    recordMint('doubloons', 1000, counters);

    assert.deepEqual(
      MINTED_CURRENCIES.map((currency) => counters[`${currency}Minted`]),
      MINTED_CURRENCIES.map(() => 0),
    );
  });

  it('taking a window returns it and resets the counters', () => {
    const counters = createEmissionMetrics(1000);
    recordMint('gold', 250, counters);
    recordMint('bait', 5, counters);

    const window = takeEmissionWindow(counters, 61_000);

    assert.equal(window.gold, 250);
    assert.equal(window.bait, 5);
    assert.equal(window.pearls, 0);
    assert.equal(window.ms, 60_000);
    assert.equal(window.startedAt, 1000);

    assert.equal(counters.goldMinted, 0, 'the next window starts empty');
    assert.equal(counters.baitMinted, 0);
    assert.equal(counters.windowStartedAt, 61_000, 'and starts where the last one ended');
  });

  it('folds closed windows into a lifetime total', () => {
    const counters = createEmissionMetrics(0);
    const totals = createEmissionMetrics(0);

    recordMint('gold', 100, counters);
    accumulateEmission(totals, takeEmissionWindow(counters, 1000));
    recordMint('gold', 150, counters);
    recordMint('pearls', 2, counters);
    accumulateEmission(totals, takeEmissionWindow(counters, 2000));

    assert.equal(totals.goldMinted, 250);
    assert.equal(totals.pearlsMinted, 2);
  });
});

describe('emission alerts', () => {
  it('stays quiet when actual mint tracks theory', () => {
    const actual = { gold: 1000, pearls: 20, bait: 800 };
    const theoretical = { gold: 900, pearls: 18, bait: 700 };

    assert.deepEqual(emissionAlerts(actual, theoretical, BOUNDS), []);
  });

  it('stays quiet right up to the threshold, and fires just past it', () => {
    const theoretical = { gold: 500, pearls: 0, bait: 0 };

    assert.deepEqual(
      emissionAlerts({ gold: 1000, pearls: 0, bait: 0 }, theoretical, BOUNDS),
      [],
      'exactly 2x is within the threshold, not past it',
    );

    const alerts = emissionAlerts({ gold: 1001, pearls: 0, bait: 0 }, theoretical, BOUNDS);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].currency, 'gold');
    assert.equal(alerts[0].actual, 1001);
    assert.equal(alerts[0].theoretical, 500);
    assert.ok(alerts[0].ratio > 2);
  });

  it('fires per currency, and only for the ones that ran hot', () => {
    const actual = { gold: 10_000, pearls: 6, bait: 300 };
    const theoretical = { gold: 500, pearls: 20, bait: 400 };

    const alerts = emissionAlerts(actual, theoretical, BOUNDS);

    assert.deepEqual(alerts.map((alert) => alert.currency), ['gold']);
  });

  it('does not fire below the minimum sample, whatever the ratio', () => {
    // 99 Gold against a theoretical 1 is a 99x ratio and still not news: a
    // quiet harbour where theory rounds to nothing must not fill the log.
    const alerts = emissionAlerts({ gold: 99, pearls: 0, bait: 0 }, { gold: 1 }, BOUNDS);
    assert.deepEqual(alerts, []);

    const loud = emissionAlerts({ gold: 100, pearls: 0, bait: 0 }, { gold: 1 }, BOUNDS);
    assert.deepEqual(loud.map((alert) => alert.currency), ['gold']);
  });

  it('reports a mint with no theoretical baseline rather than dividing by zero', () => {
    const alerts = emissionAlerts({ gold: 5000, pearls: 0, bait: 0 }, { gold: 0 }, BOUNDS);

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].ratio, Number.POSITIVE_INFINITY);
    assert.equal(alerts[0].theoretical, 0);
  });

  it('a missing theoretical figure is treated as zero, not as a pass', () => {
    const alerts = emissionAlerts({ gold: 5000, pearls: 0, bait: 0 }, {}, BOUNDS);
    assert.deepEqual(alerts.map((alert) => alert.currency), ['gold']);
  });

  it('defaults to the configured threshold when none is passed', () => {
    const theoretical = { gold: 1000 };
    const justUnder = { gold: 1000 * EMISSION_MONITOR.alertRatio };
    const justOver = { gold: justUnder.gold + 1 };

    assert.deepEqual(emissionAlerts(justUnder, theoretical), []);
    assert.equal(emissionAlerts(justOver, theoretical).length, 1);
  });
});

describe('theoretical carry', () => {
  const CARRY = { maxCarryWindows: 6 };

  it('starts with nothing banked', () => {
    assert.deepEqual(createTheoryCarry(), { gold: 0, pearls: 0, bait: 0 });
  });

  it('an unspent window banks its remainder for the next one', () => {
    const theory = { gold: 1000, pearls: 50, bait: 200 };
    const budget = theoryBudget(theory, createTheoryCarry());
    assert.deepEqual(budget, theory);

    const carry = nextTheoryCarry(budget, { gold: 400, pearls: 0, bait: 200 }, theory, CARRY);

    assert.equal(carry.gold, 600);
    assert.equal(carry.pearls, 50);
    assert.equal(carry.bait, 0, 'a window that spent its whole budget banks nothing');
  });

  it('a saved-up burst spends the bank instead of tripping the wire', () => {
    // The case the carry exists for: six quiet windows of fishing, then the
    // player finally visits the appraiser and cashes the lot in one go.
    const theory = { gold: 1000, pearls: 0, bait: 0 };
    let carry = createTheoryCarry();

    for (let window = 0; window < 6; window += 1) {
      const budget = theoryBudget(theory, carry);
      assert.deepEqual(emissionAlerts({ gold: 0 }, budget), [], 'minting nothing is never an anomaly');
      carry = nextTheoryCarry(budget, { gold: 0 }, theory, CARRY);
    }

    const budget = theoryBudget(theory, carry);
    assert.equal(budget.gold, 7000, 'six banked windows plus the current one');
    assert.deepEqual(
      emissionAlerts({ gold: 6500, pearls: 0, bait: 0 }, budget),
      [],
      'cashing in six windows of honest earnings must not warn',
    );
    // The same burst without the bank would have been a 6.5x anomaly.
    assert.equal(emissionAlerts({ gold: 6500, pearls: 0, bait: 0 }, theory).length, 1);
  });

  it('the bank is capped, so a long-idle server can still notice an anomaly', () => {
    const theory = { gold: 1000, pearls: 50, bait: 200 };
    let carry = createTheoryCarry();

    for (let window = 0; window < 40; window += 1) {
      carry = nextTheoryCarry(theoryBudget(theory, carry), { gold: 0 }, theory, CARRY);
    }

    assert.equal(carry.gold, 6000, 'never more than maxCarryWindows worth');
    assert.equal(theoryBudget(theory, carry).gold, 7000);
  });

  it('an empty harbour banks nothing, whatever it carried in', () => {
    // Theory is zero with nobody online, so the ceiling is zero: a server left
    // running overnight must not wake up with an unlimited allowance.
    const carried = { gold: 5000, pearls: 100, bait: 900 };
    const carry = nextTheoryCarry(carried, { gold: 0 }, { gold: 0, pearls: 0, bait: 0 }, CARRY);

    assert.deepEqual(carry, { gold: 0, pearls: 0, bait: 0 });
  });
});

describe('emission instrumentation', () => {
  /** Runs `body` and reports what the shared counters moved by. */
  function minted(body) {
    takeEmissionWindow(emission);
    body();
    return takeEmissionWindow(emission);
  }

  it('counts the Gold an appraisal pays, exactly', () => {
    const record = { ...createPlayerRecord('Tester'), gold: 0 };
    record.uncutGems = [{ id: 'g'.repeat(12), tier: 'diamond', at: 0 }];

    const window = minted(() => {
      const result = appraiseGem(record, 'g'.repeat(12));
      assert.equal(result.ok, true);
    });

    assert.equal(window.gold, record.gold, 'every coin paid out is a coin counted');
    assert.ok(window.gold > 0);
  });

  it('counts a chest reward bundle, and only its currencies', () => {
    const record = { ...createPlayerRecord('Tester'), bait: 0, gold: 0, pearls: 0 };

    const window = minted(() => {
      applyRewards(record, [
        { type: 'bait', amount: 25 },
        { type: 'gold', amount: 40 },
        { type: 'pearls', amount: 3 },
        { type: 'xp', amount: 500 },
        { type: 'lucky_charm', amount: 1 },
      ]);
    });

    assert.equal(window.bait, 25);
    assert.equal(window.gold, 40);
    assert.equal(window.pearls, 3);
  });

  it('counts the free bait trickle', () => {
    const now = Date.now();
    const record = {
      ...createPlayerRecord('Tester'),
      bait: 0,
      lastBaitRegenAt: now - BAIT_REGEN.intervalMs * 4,
    };

    const window = minted(() => {
      const granted = applyBaitRegen(record, now);
      assert.equal(granted, BAIT_REGEN.amount * 4);
    });

    assert.equal(window.bait, BAIT_REGEN.amount * 4);
  });

  it('counts nothing when the trickle grants nothing', () => {
    const now = Date.now();
    const record = { ...createPlayerRecord('Tester'), bait: BAIT_REGEN.ceiling, lastBaitRegenAt: 0 };

    const window = minted(() => assert.equal(applyBaitRegen(record, now), 0));

    assert.equal(window.bait, 0);
  });
});

describe('emission theory, against the shared balance model', () => {
  it('a window of real appraisals lands near the model, not orders away from it', () => {
    // The end-to-end sanity check the tripwire depends on: mint a known number
    // of Emeralds through the real appraiser and confirm the counter agrees
    // with the mean this module publishes. Wide bounds -- 400 appraisals of a
    // 10-80 Gold stone is still a random sample, and the tripwire's own
    // threshold is 2x.
    const draws = 400;
    const record = { ...createPlayerRecord('Tester'), gold: 0 };
    record.uncutGems = Array.from({ length: draws }, (_, index) => ({
      id: String(index).padStart(12, '0'),
      tier: 'emerald',
      at: 0,
    }));

    takeEmissionWindow(emission);
    for (let index = 0; index < draws; index += 1) {
      appraiseGem(record, String(index).padStart(12, '0'));
    }
    const window = takeEmissionWindow(emission);

    const theoretical = GEM_MEAN_GOLD.emerald * draws;
    const ratio = window.gold / theoretical;

    assert.ok(ratio > 0.8 && ratio < 1.25, `minted ${window.gold} against a theoretical ${theoretical}`);
    assert.deepEqual(emissionAlerts(window, { gold: theoretical }), [], 'honest play must not trip the wire');
  });

  it('an over-minting exploit does trip the wire', () => {
    // The same window, with the appraiser paying ten times over.
    const theoretical = GEM_MEAN_GOLD.emerald * 400;
    const window = { gold: theoretical * 10, pearls: 0, bait: 0 };

    const alerts = emissionAlerts(window, { gold: theoretical });

    assert.deepEqual(alerts.map((alert) => alert.currency), ['gold']);
    assert.ok(alerts[0].ratio > 9);
  });

  it('publishes a per-second mint rate for every rod and stake', () => {
    for (const tier of GEM_TIERS) assert.ok(GEM_MEAN_GOLD[tier.id] > 0);

    const rate = expectedMintPerSecond({ rodLevel: 10, stake: 40 });
    const { ev, seconds } = castExpectation({ rodLevel: 10, stake: 40 });

    assert.ok(rate.gold > 0 && rate.pearls > 0);
    assert.equal(rate.gold, ev.gold / seconds);
    assert.ok(
      expectedMintPerSecond({ rodLevel: 10, stake: 1 }).gold < rate.gold,
      'a low stake mints less Gold per second than a high one at the same rod',
    );
  });
});
