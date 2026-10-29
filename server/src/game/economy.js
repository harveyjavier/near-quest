/**
 * Shop purchases, the harbour's bait reservoir, and passive bait regeneration.
 *
 * Prices and grants come from config; this file only enforces them. Costs are
 * checked and deducted in one place so a client cannot buy on credit, and every
 * cost is an in-game currency -- there is no real-money path by contract.
 */

import { BAIT_REGEN, STARTING_RESOURCES } from '../config/game.config.js';
import { BAIT_STOCK, CURRENCY_IDS, USDG_LIMITS } from '../config/economy.config.js';
import { CONSUMABLE_EFFECTS, GOLD_DOLLAR_RATE } from '../config/rewards.config.js';
import { recordMint } from './metrics.js';

/** Rounds to the nearest cent, so USDG arithmetic never drifts on float error. */
function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/* ------------------------------------------------------------ bait stock -- */

/**
 * The shop's bait reservoir, shared by everyone at the dock.
 *
 * Bait is a closed loop rather than a faucet: the shop opens with a finite
 * amount, selling hands it to a player, and burning it on a cast puts it back
 * on the shelf. What a player is holding is therefore bait the shop does not
 * have, which is the whole point -- a bulk buyer visibly empties the shelves
 * until they have fished their stock back into them.
 *
 * The ceiling is the same number the shop opened with, so the loop cannot
 * inflate: the bait a chest pays out and the free trickle both enter the world
 * from outside the reservoir, and once it is full again any further returns
 * spoil on the counter rather than growing the supply forever.
 */
export function createBaitStock(units = BAIT_STOCK.initial, capacity = BAIT_STOCK.capacity) {
  return {
    capacity,
    units: clampStock(units, capacity),
  };
}

function clampStock(units, capacity) {
  const value = Math.floor(Number(units));
  if (!Number.isFinite(value)) return capacity;
  return Math.min(capacity, Math.max(0, value));
}

/** How many bait one purchase of `item` x `quantity` draws out of the shop. */
export function baitUnitsFor(item, quantity = 1) {
  return (item.grants?.bait ?? 0) * quantity;
}

/**
 * How many of `item` the shop could sell right now, stock alone -- what the
 * player can afford is a separate question and is asked separately.
 */
export function packsInStock(stock, item) {
  const perPack = item.grants?.bait ?? 0;
  if (perPack <= 0) return Number.POSITIVE_INFINITY; // not a bait item; unlimited
  return Math.floor(stock.units / perPack);
}

/**
 * Puts burned bait back on the shelf, up to the reservoir's ceiling. Returns
 * the amount actually taken back, which is less than `units` when the shop is
 * already full.
 *
 * Called when a cast *resolves*, never when one starts: a cast that is
 * cancelled refunds its bait to the player, and returning it here as well
 * would mint bait out of a walk away from the water.
 */
export function returnBaitToStock(stock, units) {
  const amount = Math.max(0, Math.floor(Number(units) || 0));
  const accepted = Math.min(amount, stock.capacity - stock.units);
  stock.units += accepted;
  return accepted;
}

/* ------------------------------------------------------------- purchases -- */

/**
 * Buys `quantity` of `item` out of `stock`. Returns { ok, code } on failure and
 * never mutates the player or the stock unless the whole purchase can be
 * afforded and the shop can actually supply it.
 */
export function purchase(player, item, quantity = 1, stock) {
  if (item.purchasable === false) {
    return { ok: false, code: 'ITEM_LOCKED', reason: item.lockedReason ?? null };
  }

  const totalCost = item.cost.amount * quantity;
  const currency = item.cost.currency;

  if (!CURRENCY_IDS.includes(currency)) {
    return { ok: false, code: 'CURRENCY_UNKNOWN' };
  }
  if ((player[currency] ?? 0) < totalCost) {
    return {
      ok: false,
      code: 'INSUFFICIENT_FUNDS',
      currency,
      needed: totalCost,
      held: player[currency] ?? 0,
    };
  }

  // Bait comes off the shelf, so the shop can be sold out of it. Checked
  // before a single coin moves.
  const baitUnits = baitUnitsFor(item, quantity);
  if (baitUnits > 0) {
    if (!stock) return { ok: false, code: 'STOCK_UNAVAILABLE' };
    if (stock.units < baitUnits) {
      return {
        ok: false,
        code: 'OUT_OF_STOCK',
        needed: baitUnits,
        available: stock.units,
        packsAvailable: packsInStock(stock, item),
      };
    }
  }

  player[currency] -= totalCost;

  const granted = {};
  for (const [grantId, perUnit] of Object.entries(item.grants)) {
    const amount = perUnit * quantity;
    granted[grantId] = amount;

    if (CURRENCY_IDS.includes(grantId)) {
      player[grantId] = (player[grantId] ?? 0) + amount;
    } else if (Object.hasOwn(CONSUMABLE_EFFECTS, grantId)) {
      if (!player.inventory) player.inventory = {};
      player.inventory[grantId] = (player.inventory[grantId] ?? 0) + amount;
    } else {
      // Config drift: refund and bail rather than take payment for nothing.
      player[currency] += totalCost;
      return { ok: false, code: 'GRANT_UNKNOWN' };
    }
  }

  if (baitUnits > 0) stock.units -= baitUnits;

  return {
    ok: true,
    itemId: item.id,
    quantity,
    spent: { currency, amount: totalCost },
    granted,
    stock: baitUnits > 0 ? { units: stock.units, capacity: stock.capacity } : null,
  };
}

/**
 * Free bait trickle, so a player who spends down to zero is never permanently
 * stuck (see ASSUMPTION A7). Tops up toward BAIT_REGEN.ceiling only, and awards
 * whole intervals elapsed since the last tick so it stays correct across a
 * disconnect or a server restart.
 *
 * Deliberately NOT drawn from the shop's reservoir. It is the one guarantee
 * that a broke player can fish again, so it must hold even on the day the
 * harbour has sold out -- and a shop that could starve a player of their
 * recovery trickle would be a soft-lock with extra steps.
 *
 * Returns the amount granted (0 if nothing was due).
 */
export function applyBaitRegen(player, now = Date.now()) {
  if (!BAIT_REGEN.enabled) return 0;
  if (player.bait >= BAIT_REGEN.ceiling) {
    player.lastBaitRegenAt = now;
    return 0;
  }

  const since = Number(player.lastBaitRegenAt) || now;
  const intervals = Math.floor((now - since) / BAIT_REGEN.intervalMs);
  if (intervals <= 0) return 0;

  const headroom = BAIT_REGEN.ceiling - player.bait;
  const granted = Math.min(headroom, intervals * BAIT_REGEN.amount);

  player.bait += granted;
  player.lastBaitRegenAt = since + intervals * BAIT_REGEN.intervalMs;

  // Counted as emission because it is: unlike a shop purchase, the trickle
  // comes from outside the harbour's reservoir rather than off its shelf.
  recordMint('bait', granted);

  return granted;
}

/** Default wallet for a brand-new guest session. */
export function startingResources() {
  return { ...STARTING_RESOURCES };
}

/* ------------------------------------------------------------------ USDG -- */

/**
 * Credits USDG straight to the wallet balance.
 *
 * There is no payment backend behind this -- the wallet panel's own comments
 * (client/src/ui/hud.js) describe exactly that gap. This is the "simulated
 * deposit" that screen was built ahead of: it credits the balance directly
 * rather than waiting on a chain or a processor, bounded by USDG_LIMITS so a
 * single message cannot hand out an unbounded balance while that remains true.
 */
export function depositUsdg(player, amount) {
  const value = round2(Number(amount));

  if (!Number.isFinite(value) || value < USDG_LIMITS.minDeposit) {
    return { ok: false, code: 'AMOUNT_INVALID' };
  }
  if (value > USDG_LIMITS.maxDeposit) {
    return { ok: false, code: 'AMOUNT_TOO_LARGE', max: USDG_LIMITS.maxDeposit };
  }

  const before = player.usdg ?? 0;
  const after = round2(before + value);
  if (after > USDG_LIMITS.maxBalance) {
    return { ok: false, code: 'BALANCE_CAP', max: USDG_LIMITS.maxBalance, held: before };
  }

  player.usdg = after;
  return { ok: true, deposited: value, usdg: after };
}

/**
 * Credits a verified on-chain deposit. No limits: the money has already moved,
 * so refusing it here would only strand it.
 */
export function creditUsdg(player, amount) {
  player.usdg = round2((player.usdg ?? 0) + amount);
  return player.usdg;
}

/**
 * Converts USDG into Gold at the locked `GOLD_DOLLAR_RATE` anchor -- the same
 * rate the gem appraiser already quotes against, so a dollar buys the same
 * Gold however it entered the wallet.
 */
export function buyGoldWithUsdg(player, goldAmount) {
  const gold = Math.floor(Number(goldAmount));

  if (!Number.isFinite(gold) || gold < 1) {
    return { ok: false, code: 'AMOUNT_INVALID' };
  }
  if (gold > USDG_LIMITS.maxGoldPurchase) {
    return { ok: false, code: 'AMOUNT_TOO_LARGE', max: USDG_LIMITS.maxGoldPurchase };
  }

  const cost = round2(gold * GOLD_DOLLAR_RATE);
  const held = player.usdg ?? 0;
  if (held < cost) {
    return { ok: false, code: 'INSUFFICIENT_USDG', needed: cost, held };
  }

  player.usdg = round2(held - cost);
  player.gold = (player.gold ?? 0) + gold;
  // Bought rather than earned, but it is still new Gold entering a player's
  // wallet -- counted the same way every other Gold faucet is (see chests.js)
  // so the emission monitor's totals still add up to the real supply.
  recordMint('gold', gold);

  return { ok: true, spent: cost, gold, usdg: player.usdg, goldHeld: player.gold };
}
