/**
 * Emission counters: how much currency this server has actually minted.
 *
 * The point is a tripwire, not an audit. Cambria's "Emerald Bug" over-minted
 * its currency for days and was caught by someone noticing an anomalous total
 * after the fact; the cheap defence is to have the server say, out loud and on
 * a schedule, how much it paid out versus how much game/balanceModel.js says
 * it should have. A future exploit or a balance regression then shows up as a
 * warn line in the deploy log instead of as a player report.
 *
 * Deliberately coarse. It compares a window's actual mint against a
 * theoretical figure built from who was online and what stake they were on,
 * and warns only past a wide ratio. It will not catch a 10% drift and is not
 * meant to -- a precision fraud detector would need per-player attribution and
 * would spend its life crying wolf at ordinary variance.
 *
 * Only the three currencies the server can mint are counted. Fishing XP is
 * progression rather than emission, and a fish in the bag is not currency
 * until it is cashed in.
 */

import { EMISSION_MONITOR } from '../config/game.config.js';

/** The currencies a mint can be recorded against. */
export const MINTED_CURRENCIES = ['gold', 'pearls', 'bait'];

const FIELD = { gold: 'goldMinted', pearls: 'pearlsMinted', bait: 'baitMinted' };

/**
 * A fresh set of counters.
 *
 * `windowStartedAt` is when this tally began, which is what makes the totals
 * readable after the fact: a number with no window attached says nothing about
 * whether it is large.
 */
export function createEmissionMetrics(now = Date.now()) {
  return { goldMinted: 0, pearlsMinted: 0, baitMinted: 0, windowStartedAt: now };
}

/**
 * The process-wide counters the mint points write to.
 *
 * A module singleton on purpose: the mint points are pure game functions that
 * take a player record and nothing else (`appraiseGem`, `applyRewards`,
 * `applyBaitRegen`), and threading a metrics handle through every one of them
 * to satisfy the monitor would put the observer into signatures that exist to
 * be easy to test. Tests pass their own counters to `recordMint` instead.
 */
export const emission = createEmissionMetrics();

/**
 * Tallies one mint. Silently ignores anything that is not a positive, finite
 * amount, so an instrumented call site can never turn a bad reward amount into
 * a crash on a path that was only supposed to be counting.
 */
export function recordMint(currency, amount, counters = emission) {
  const field = FIELD[currency];
  if (!field) return;

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return;

  counters[field] += value;
}

/**
 * Closes the current window and starts a new one.
 *
 * Returns what was minted during it, plus how long it ran -- the caller needs
 * the duration to build the theoretical figure it compares against.
 */
export function takeEmissionWindow(counters = emission, now = Date.now()) {
  const window = {
    gold: counters.goldMinted,
    pearls: counters.pearlsMinted,
    bait: counters.baitMinted,
    startedAt: counters.windowStartedAt,
    endedAt: now,
    ms: Math.max(0, now - counters.windowStartedAt),
  };

  counters.goldMinted = 0;
  counters.pearlsMinted = 0;
  counters.baitMinted = 0;
  counters.windowStartedAt = now;

  return window;
}

/**
 * Which currencies came out too far ahead of theory in a window.
 *
 * Two guards, and both matter:
 *
 *   `ratio` is the multiple of theoretical that counts as anomalous. It is
 *   wide (2x by default) because the honest sources of variance here are
 *   large: appraisal is bursty by design -- a player can sit on a bag of gems
 *   for an hour and cash the lot in one window -- and a window's theoretical
 *   figure assumes everyone online fished it end to end.
 *
 *   `minSample` is an absolute floor. Without it, a window where theory says
 *   ~0 and one chest paid 12 Gold trips the ratio, and the log fills with
 *   noise from quiet harbours.
 *
 * Returns one entry per tripped currency, empty when nothing tripped.
 */
export function emissionAlerts(actual, theoretical, {
  ratio = EMISSION_MONITOR.alertRatio,
  minSample = EMISSION_MONITOR.minSample,
} = {}) {
  const alerts = [];

  for (const currency of MINTED_CURRENCIES) {
    const minted = Number(actual?.[currency]) || 0;
    const expected = Number(theoretical?.[currency]) || 0;
    const floor = minSample?.[currency] ?? 0;

    if (minted < floor) continue;
    if (minted <= expected * ratio) continue;

    alerts.push({
      currency,
      actual: minted,
      theoretical: expected,
      // A window where theory is zero has no meaningful multiple; report it as
      // Infinity rather than dividing, and let the reader see the raw pair.
      ratio: expected > 0 ? minted / expected : Number.POSITIVE_INFINITY,
    });
  }

  return alerts;
}

/** A carry with nothing banked in it yet. */
export function createTheoryCarry() {
  return Object.fromEntries(MINTED_CURRENCIES.map((currency) => [currency, 0]));
}

/**
 * The theoretical allowance a window is judged against: what the players
 * online could have earned during it, plus whatever earlier windows were
 * entitled to and did not mint.
 */
export function theoryBudget(theory, carry) {
  return Object.fromEntries(MINTED_CURRENCIES.map((currency) => [
    currency,
    (Number(theory?.[currency]) || 0) + (Number(carry?.[currency]) || 0),
  ]));
}

/**
 * What is left of a window's budget, to be banked for the next one.
 *
 * Capped at `maxCarryWindows` windows' worth of the *current* theoretical
 * rate, which is what stops the bank growing without limit: an empty harbour
 * earns a theory of zero, so it banks nothing, and a busy one can never carry
 * more than the last half hour it actually had players for. Without that cap a
 * server left running overnight would wake up unable to notice anything.
 */
export function nextTheoryCarry(budget, actual, theory, {
  maxCarryWindows = EMISSION_MONITOR.maxCarryWindows,
} = {}) {
  return Object.fromEntries(MINTED_CURRENCIES.map((currency) => {
    const unspent = Math.max(0, (Number(budget?.[currency]) || 0) - (Number(actual?.[currency]) || 0));
    const ceiling = (Number(theory?.[currency]) || 0) * maxCarryWindows;
    return [currency, Math.min(unspent, ceiling)];
  }));
}

/**
 * Adds a closed window into a running lifetime tally.
 *
 * The lifetime figure is what gets persisted on the world document: the window
 * is the tripwire, the total is the thing you actually want in front of you the
 * morning someone asks how much Gold this harbour has ever created.
 */
export function accumulateEmission(totals, window) {
  totals.goldMinted += window.gold;
  totals.pearlsMinted += window.pearls;
  totals.baitMinted += window.bait;
  return totals;
}
