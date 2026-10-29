/**
 * MongoDB schemas.
 *
 * NO ACCOUNTS, NO PERSONAL DATA: a player document is keyed by an opaque,
 * server-generated `sessionToken` held in the browser's localStorage. There is
 * no email, no password, no IP and no device fingerprint stored anywhere. The
 * only human-supplied field is the display name. A player who signs in with a
 * NEAR wallet also carries its public `nearAccountId` (see auth/near.js).
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const ChestSchema = new Schema(
  {
    id: { type: String, required: true },
    tier: { type: String, required: true },
    at: { type: Number, default: () => Date.now() },
  },
  { _id: false },
);

const UncutGemSchema = new Schema(
  {
    id: { type: String, required: true },
    tier: { type: String, required: true },
    at: { type: Number, default: () => Date.now() },
  },
  { _id: false },
);

/**
 * One caught fish waiting in the bag to be cashed in for Fishing Power XP.
 *
 * `xp` is frozen at catch time (see `resolveCast` in game/fishing.js), not
 * recomputed on cash-in, so a stake change after the catch cannot change what
 * an already-caught fish is worth.
 */
const CaughtFishSchema = new Schema(
  {
    id: { type: String, required: true },
    speciesId: { type: String, required: true },
    xp: { type: Number, default: 0, min: 0 },
    at: { type: Number, default: () => Date.now() },
  },
  { _id: false },
);

const RewardLogSchema = new Schema(
  {
    type: { type: String, required: true },
    name: String,
    amount: { type: Number, default: 0 },
    speciesId: String,
    chestTier: String,
    gemTier: String,
    at: { type: Number, default: () => Date.now() },
  },
  { _id: false },
);

/**
 * World state shared by every player, keyed by a fixed id.
 *
 * One document, not one per player: the shop's bait reservoir belongs to the
 * harbour rather than to anybody in it, and it has to survive a restart or the
 * shelves silently refill themselves every deploy.
 */
/**
 * Lifetime currency emission for the harbour.
 *
 * Kept beside the bait reservoir for the same reason it is: it belongs to the
 * world rather than to anyone in it, and it is worthless if a deploy resets it
 * -- the whole value of an emission total is being able to compare it with
 * yesterday's. `windowStartedAt` is when counting began, without which the
 * totals are three numbers with no scale attached.
 *
 * These are cumulative and only ever go up. The short window the tripwire
 * actually compares against theory lives in memory (see game/metrics.js); this
 * is the running total those windows are added into.
 */
const EmissionSchema = new Schema(
  {
    goldMinted: { type: Number, default: 0, min: 0 },
    pearlsMinted: { type: Number, default: 0, min: 0 },
    baitMinted: { type: Number, default: 0, min: 0 },
    windowStartedAt: { type: Number, default: () => Date.now() },
  },
  { _id: false },
);

export const WorldSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    baitStock: { type: Number, default: 0, min: 0 },
    emission: { type: EmissionSchema, default: () => ({}) },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { versionKey: false },
);

export const PlayerSchema = new Schema(
  {
    sessionToken: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    // Set once by NEAR wallet sign-in; unique so one wallet owns one player.
    nearAccountId: { type: String, unique: true, sparse: true },

    rodLevel: { type: Number, default: 1, min: 1 },
    xp: { type: Number, default: 0, min: 0 },
    totalXp: { type: Number, default: 0, min: 0 },

    bait: { type: Number, default: 0, min: 0 },
    gold: { type: Number, default: 0, min: 0 },
    // Named Pearl, not Gems, so this wallet balance stops colliding with the
    // uncut gems below -- those are graded items, this is a currency.
    pearls: { type: Number, default: 0, min: 0 },
    // The cash side of the wallet, in dollars to the cent. Credited directly
    // by `depositUsdg` (game/economy.js) -- there is no payment backend behind
    // it yet, see that function's own note -- and spent buying Gold at the
    // locked GOLD_DOLLAR_RATE anchor.
    usdg: { type: Number, default: 0, min: 0 },

    stake: { type: Number, default: 1 },
    autoFishing: { type: Boolean, default: true },

    totalCasts: { type: Number, default: 0, min: 0 },
    totalCatches: { type: Number, default: 0, min: 0 },

    // Plain objects keyed by species/consumable id -> count.
    catchCounts: { type: Schema.Types.Mixed, default: () => ({}) },
    inventory: { type: Schema.Types.Mixed, default: () => ({}) },
    buffs: { type: Schema.Types.Mixed, default: () => ({}) },

    chests: { type: [ChestSchema], default: () => [] },
    uncutGems: { type: [UncutGemSchema], default: () => [] },
    fish: { type: [CaughtFishSchema], default: () => [] },
    rewardLog: { type: [RewardLogSchema], default: () => [] },

    lastBaitRegenAt: { type: Number, default: () => Date.now() },
    createdAt: { type: Number, default: () => Date.now() },
    lastSeenAt: { type: Number, default: () => Date.now() },
  },
  { versionKey: false, minimize: false },
);

// Leaderboard: level first, then total catches. Indexed so the periodic refresh
// stays cheap as the collection grows.
PlayerSchema.index({ rodLevel: -1, totalCatches: -1 });

export const ChatMessageSchema = new Schema(
  {
    name: { type: String, required: true },
    text: { type: String, required: true },
    at: { type: Number, default: () => Date.now(), index: true },
  },
  { versionKey: false },
);

export const Player = mongoose.model('Player', PlayerSchema);
export const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);
export const World = mongoose.model('World', WorldSchema);
