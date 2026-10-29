/**
 * Single import surface for every tunable, plus the catalog payload the server
 * hands the client on join. The client never *computes* odds -- it renders the
 * names, icons, prices and probabilities this catalog hands it, and rolls
 * nothing itself.
 *
 * That is a change of rule, not just of wording. This payload used to strip
 * every weight on the way out, on the reasoning that a client holding the odds
 * could predict a roll it did not make. It cannot: a probability says nothing
 * about the next draw, only about the long run of them, and the draw still
 * happens server-side from a seed no client ever sees. Publishing the tables
 * is now a design choice -- see game/odds.js for what is disclosed and why.
 */

export * from './fish.config.js';
export * from './rods.config.js';
export * from './rewards.config.js';
export * from './economy.config.js';
export * from './game.config.js';
export * from './near.config.js';

import { DEPOSITS } from './near.config.js';

import { FISH, RARITY_TIERS } from './fish.config.js';
import { RODS, MAX_ROD_LEVEL } from './rods.config.js';
import {
  APPRAISAL_GRADES,
  APPRAISAL_TRAITS,
  CHEST_TIERS,
  CONSUMABLE_EFFECTS,
  GEM_TIERS,
  GOLD_DOLLAR_RATE,
  REWARD_TYPES,
  chestContentOdds,
} from './rewards.config.js';
import {
  BAIT_STOCK,
  CURRENCIES,
  MAX_PURCHASE_QUANTITY,
  PURCHASE_QUANTITIES,
  SHOP_ITEMS,
  SHOP_ITEM_TYPES,
} from './economy.config.js';
import {
  RISK_BANDS,
  STAKE_LEVELS,
  STAKE_RULES,
  BAIT_PER_CAST,
  BAIT_REGEN,
  CHAT,
  DISPLAY_NAME,
  LEADERBOARD,
  AUTO_FISHING,
} from './game.config.js';

/**
 * Built once at module load. Presentation data plus the *static* odds -- the
 * ones that depend on nothing about the player. Anything that moves with a rod
 * level or a stake is per-player and rides on `meView` instead.
 */
export const CLIENT_CATALOG = Object.freeze({
  // How the Deposit button works: on-chain USDC, the dev-only fake, or off.
  deposits: DEPOSITS,
  fish: FISH.map(({ id, name, tier, rarityIndex, color, unlockLevel, baseXp }) => ({
    id, name, tier, rarityIndex, color, unlockLevel, baseXp,
  })),
  rarityTiers: RARITY_TIERS,
  rods: RODS.map(({ level, name, xpToNext }) => ({ level, name, xpToNext })),
  maxRodLevel: MAX_ROD_LEVEL,
  // `contents` lists which reward types a tier can produce and, now, how
  // likely each one is -- so the chest-opening reel can only ever show items
  // that chest could have given, and the preview under it can say what the
  // draw is actually weighted toward.
  //
  // A chest pays exactly one reward drawn once from its table (see
  // `openChest`), so an entry's share of the table weight is its chance
  // outright. These are exact and identical for every player, which is why
  // they travel in the catalog rather than per-player state.
  //
  // Amounts are still withheld. The range a reward rolls within is the part of
  // a chest worth opening it to find out, and a preview that printed
  // "345-719 Fishing Power" would answer the question the reel exists to ask.
  chestTiers: CHEST_TIERS.map(({ id, name, color, rewardTable }) => ({
    id,
    name,
    color,
    contents: chestContentOdds(rewardTable),
  })),
  // The Gold range travels with the tier so the appraisal panel can state what
  // is at stake before the grades land. A range is not a probability: it says
  // what the stone could be worth, not where inside that it is likely to fall,
  // so it tells a client nothing it could use to predict or check a roll.
  gemTiers: GEM_TIERS.map(({ id, name, color, gold }) => ({ id, name, color, gold })),
  // What the appraiser's quote is in: the panel states a stone's worth in
  // dollars and pays it in Gold, and this is the one rate both sides of that
  // are read off, so the client never carries a conversion of its own.
  goldDollarRate: GOLD_DOLLAR_RATE,
  // Trait order and the grade ladder, so the panel can lay out its rows and
  // colour a grade without hard-coding either against the server's config.
  appraisal: {
    traits: APPRAISAL_TRAITS,
    grades: APPRAISAL_GRADES.map(({ id, color }) => ({ id, color })),
  },
  rewardTypes: REWARD_TYPES,
  consumables: Object.fromEntries(
    Object.entries(CONSUMABLE_EFFECTS).map(([id, effect]) => [id, { casts: effect.casts }]),
  ),
  shop: SHOP_ITEMS,
  shopItemTypes: SHOP_ITEM_TYPES,
  // What the quantity buttons offer and the ceiling one message may ask for.
  // The shop clamps its own buttons to what the shelf and the wallet allow;
  // this is only the shape of the row.
  purchaseQuantities: PURCHASE_QUANTITIES,
  maxPurchaseQuantity: MAX_PURCHASE_QUANTITY,
  // The shelf's ceiling, so the panel can draw how full the harbour is. The
  // live figure is in shared room state, not here -- it changes every cast.
  baitStockCapacity: BAIT_STOCK.capacity,
  currencies: CURRENCIES,
  // The whole Stake ladder, as the one risk lever the player actually turns.
  //
  // `chestTiers` travels with each rung so the HUD can say what a stake can
  // and cannot win -- the gate itself is enforced in `allowedChestTiers`, this
  // only lets the panel state it. Deliberately no catch/rarity/XP/chest
  // multipliers: those are the odds, and a client that had them could predict
  // a roll it did not make. The direction of the trade-off is spelled out in
  // `blurb` instead, which is all the UI needs to communicate it.
  //
  // `unlockLevel` travels too, so the HUD can grey out a rung the player's
  // rod hasn't reached yet and say what it takes -- the gate itself is
  // enforced in `validateStake` (server/util/validate.js), same split as
  // `chestTiers` above.
  stakes: STAKE_LEVELS.map(({ stake, band, name, blurb, chestTiers, unlockLevel }) => ({
    stake, band, name, blurb, chestTiers, unlockLevel,
  })),
  // The Steady / Balanced / Risky gauge. Read-only in the HUD: the client
  // lights whichever band the player's current Stake names, and never sends a
  // band back, because there is no longer anything to send it to.
  riskBands: RISK_BANDS,
  stakeRules: STAKE_RULES,
  baitPerCast: BAIT_PER_CAST,
  baitRegen: BAIT_REGEN,
  chat: { maxLength: CHAT.maxLength, historySize: CHAT.historySize },
  displayName: {
    minLength: DISPLAY_NAME.minLength,
    maxLength: DISPLAY_NAME.maxLength,
    pattern: DISPLAY_NAME.pattern.source,
  },
  leaderboardSize: LEADERBOARD.size,
  autoFishing: { defaultEnabled: AUTO_FISHING.defaultEnabled },
});
