/**
 * Every random draw in this game happens here, on the server.
 *
 * CONTRACT REQUIREMENT: "Catch determination is server-side RNG only -- the
 * client never decides outcomes." Nothing in client/ imports or reimplements
 * any of this; the client is told results, never asked for them.
 *
 * Uses node:crypto for a non-predictable source so a player cannot observe a
 * sequence of outcomes and extrapolate the next one.
 */

import { randomBytes, randomInt } from 'node:crypto';

const UINT32_SPAN = 0x100000000;

/** Uniform float in [0, 1). */
export function random() {
  return randomBytes(4).readUInt32BE(0) / UINT32_SPAN;
}

/** Uniform integer in [min, max] inclusive. Returns min for an inverted range. */
export function randomIntInclusive(min, max) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return low || 0;
  return randomInt(low, high + 1);
}

/** True with probability `p`, clamped to [0, 1]. */
export function chance(p) {
  const probability = Math.min(1, Math.max(0, Number(p) || 0));
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  return random() < probability;
}

/**
 * Weighted pick from `entries` using `weightOf`. Ignores non-positive and
 * non-finite weights. Returns null only if every entry is unusable.
 */
export function weightedPick(entries, weightOf = (entry) => entry.weight) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  let total = 0;
  const weights = new Array(entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    const weight = Number(weightOf(entries[i]));
    weights[i] = Number.isFinite(weight) && weight > 0 ? weight : 0;
    total += weights[i];
  }
  if (total <= 0) return null;

  let roll = random() * total;
  for (let i = 0; i < entries.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return entries[i];
  }
  // Floating point drift only; fall back to the last usable entry.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (weights[i] > 0) return entries[i];
  }
  return null;
}

/** Cryptographically random hex token, used for guest session ids and chest ids. */
export function token(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}
