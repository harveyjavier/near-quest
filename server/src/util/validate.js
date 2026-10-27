/**
 * Input validation for everything that crosses the network boundary.
 *
 * The rule this file enforces: a client message is untrusted data. Every
 * handler in HarborRoom runs its payload through here before it can touch
 * player state, and anything that fails is rejected with a code the client can
 * render -- never silently coerced into something that mutates the economy.
 */

import {
  DISPLAY_NAME,
  FISH_BY_ID,
  STAKE_VALUES,
  CHAT,
  WORLD,
  isStakeUnlockedAt,
} from '../config/index.js';
import { MAX_PURCHASE_QUANTITY, SHOP_ITEMS_BY_ID, USDG_LIMITS } from '../config/economy.config.js';

export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new ValidationError(code, message);
};

/** Payloads must be plain objects; arrays and primitives are rejected outright. */
export function asObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('BAD_PAYLOAD', 'Expected an object payload.');
  }
  return payload;
}

/** Strips control characters and zero-width joiners used to spoof or break layout. */
function stripUnsafeCharacters(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
}

/**
 * Display name: 3-16 chars, letters/digits/space/underscore/hyphen.
 * Returns a cleaned name, or throws with a code the name screen can show.
 */
export function validateDisplayName(raw) {
  if (typeof raw !== 'string') fail('NAME_INVALID', 'Display name must be text.');

  const cleaned = stripUnsafeCharacters(raw).replace(/\s+/g, ' ').trim();

  if (cleaned.length < DISPLAY_NAME.minLength) {
    fail('NAME_TOO_SHORT', `Name must be at least ${DISPLAY_NAME.minLength} characters.`);
  }
  if (cleaned.length > DISPLAY_NAME.maxLength) {
    fail('NAME_TOO_LONG', `Name must be at most ${DISPLAY_NAME.maxLength} characters.`);
  }
  if (!DISPLAY_NAME.pattern.test(cleaned)) {
    fail('NAME_CHARS', 'Use letters, numbers, spaces, hyphens or underscores only.');
  }
  return cleaned;
}

/** Falls back to a generated guest name rather than rejecting a join outright. */
export function coerceDisplayName(raw, fallbackSuffix) {
  try {
    return validateDisplayName(raw);
  } catch {
    return `${DISPLAY_NAME.fallbackPrefix}${fallbackSuffix}`;
  }
}

/**
 * Stake is the game's only risk lever, so this is the one gate on it: a stake
 * the ladder does not name is rejected outright rather than clamped, because
 * every cast modifier is looked up by this number.
 *
 * `rodLevel` is a second, independent gate added alongside the Stake unlock
 * ladder (see `STAKE_LEVELS[*].unlockLevel` in game.config.js): a stake the
 * ladder does name but the player's current rod has not reached yet is
 * rejected the same way, with its own code so the HUD can say "come back at
 * a higher rod level" rather than "that Stake doesn't exist". Optional and
 * defaulted to Infinity (i.e. no gate) so callers that only care about shape
 * -- there are none left in this codebase, but future ones may exist -- are
 * not forced to thread a rod level through.
 */
export function validateStake(raw, rodLevel = Infinity) {
  const stake = Number(raw);
  if (!STAKE_VALUES.includes(stake)) {
    fail('STAKE_INVALID', `Stake must be one of ${STAKE_VALUES.join('x, ')}x.`);
  }
  if (!isStakeUnlockedAt(stake, rodLevel)) {
    fail('STAKE_LOCKED', `Stake ${stake} is not unlocked yet.`);
  }
  return stake;
}

export function validateChatMessage(raw) {
  if (typeof raw !== 'string') fail('CHAT_INVALID', 'Message must be text.');

  const cleaned = stripUnsafeCharacters(raw).trim();
  if (cleaned.length === 0) fail('CHAT_EMPTY', 'Message is empty.');
  if (cleaned.length > CHAT.maxLength) {
    fail('CHAT_TOO_LONG', `Messages are limited to ${CHAT.maxLength} characters.`);
  }
  return cleaned;
}

export function validateShopItem(raw) {
  if (typeof raw !== 'string' || !Object.hasOwn(SHOP_ITEMS_BY_ID, raw)) {
    fail('ITEM_UNKNOWN', 'That shop item does not exist.');
  }
  return SHOP_ITEMS_BY_ID[raw];
}

export function validateQuantity(raw) {
  const quantity = Math.floor(Number(raw ?? 1));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
    fail('QTY_INVALID', `Quantity must be between 1 and ${MAX_PURCHASE_QUANTITY}.`);
  }
  return quantity;
}

/** Chest ids are server-generated hex tokens; anything else is a forgery attempt. */
export function validateChestId(raw) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{16,64}$/.test(raw)) {
    fail('CHEST_INVALID', 'Unknown chest.');
  }
  return raw;
}

/** Gem ids are server-generated hex tokens, same shape as chest ids. */
export function validateGemId(raw) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{16,64}$/.test(raw)) {
    fail('GEM_INVALID', 'Unknown gem.');
  }
  return raw;
}

/** A fish species id must name a real entry in the species catalog. */
export function validateSpeciesId(raw) {
  if (typeof raw !== 'string' || !Object.hasOwn(FISH_BY_ID, raw)) {
    fail('SPECIES_INVALID', 'Unknown fish species.');
  }
  return raw;
}

/** Session tokens are 32-byte hex handed out by the server on first join. */
export function isValidSessionToken(raw) {
  return typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw);
}

const FACINGS = new Set(['up', 'down', 'left', 'right']);

/**
 * Avatar position. Clamped rather than rejected: a position is cosmetic, and
 * dropping the whole update over a rounding error would make other players see
 * an avatar freeze. Non-numeric input still throws.
 */
export function validatePosition(payload) {
  const x = Number(payload.x);
  const y = Number(payload.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    fail('POS_INVALID', 'Position must be numeric.');
  }

  return {
    x: Math.min(WORLD.width, Math.max(0, x)),
    y: Math.min(WORLD.height, Math.max(0, y)),
    facing: FACINGS.has(payload.facing) ? payload.facing : 'down',
    moving: payload.moving === true,
  };
}

/** USDG amounts are dollars to the cent; anything outside the deposit bounds is rejected. */
export function validateUsdgAmount(raw) {
  const amount = Math.round((Number(raw) + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(amount) || amount < USDG_LIMITS.minDeposit) {
    fail('AMOUNT_INVALID', `Enter at least $${USDG_LIMITS.minDeposit.toFixed(2)}.`);
  }
  if (amount > USDG_LIMITS.maxDeposit) {
    fail('AMOUNT_TOO_LARGE', `Deposits are capped at $${USDG_LIMITS.maxDeposit.toLocaleString('en-US')} at a time.`);
  }
  return amount;
}

/** Gold purchase amounts are whole coins, capped the same way a sell-back is. */
export function validateGoldPurchaseAmount(raw) {
  const gold = Math.floor(Number(raw));
  if (!Number.isFinite(gold) || gold < 1) {
    fail('AMOUNT_INVALID', 'Enter how much Gold to buy.');
  }
  if (gold > USDG_LIMITS.maxGoldPurchase) {
    fail('AMOUNT_TOO_LARGE', `You can buy at most ${USDG_LIMITS.maxGoldPurchase.toLocaleString('en-US')} Gold at a time.`);
  }
  return gold;
}

export function validateBoolean(raw, fallback = false) {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}
