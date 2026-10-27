/**
 * Colyseus synchronised state for the single shared harbor.
 *
 * WHAT LIVES HERE: only what every client is allowed to see -- the online
 * player list, chat history, the leaderboard, and how much bait the shop has
 * left on the shelf. Deliberately absent: bait, gold, pearls, XP, chests and
 * inventory. Those are private per player and go out over a direct `me`
 * message to that client alone, so one player cannot read another's wallet off
 * the wire.
 */

import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';

/**
 * One player visible in the shared world and the online list.
 *
 * `x`, `y`, `facing` and `moving` are cosmetic: they position an avatar for
 * other players to see. Nothing a player earns depends on where they stand, so
 * these are validated for range and rate but are not treated as authoritative.
 * See the `move` handler in HarborRoom for the reasoning.
 */
export class PlayerState extends Schema {
  constructor(init = {}) {
    super();
    this.name = init.name ?? 'Guest';
    this.rodLevel = init.rodLevel ?? 1;
    this.totalCatches = init.totalCatches ?? 0;
    this.dockSlot = init.dockSlot ?? 0;
    this.casting = false;
    this.castProgress = 0;
    this.stake = init.stake ?? 1;
    this.online = true;
    this.x = init.x ?? 0;
    this.y = init.y ?? 0;
    this.facing = init.facing ?? 'down';
    this.moving = false;
  }
}

defineTypes(PlayerState, {
  name: 'string',
  rodLevel: 'uint8',
  totalCatches: 'uint32',
  dockSlot: 'uint8',
  casting: 'boolean',
  castProgress: 'float32',
  stake: 'uint8',
  online: 'boolean',
  x: 'float32',
  y: 'float32',
  facing: 'string',
  moving: 'boolean',
});

/** A chat line. Timestamps are server clock, never client-supplied. */
export class ChatEntry extends Schema {
  constructor(init = {}) {
    super();
    this.name = init.name ?? '';
    this.text = init.text ?? '';
    this.at = init.at ?? Date.now();
  }
}

defineTypes(ChatEntry, {
  name: 'string',
  text: 'string',
  at: 'number',
});

/** One leaderboard row, recomputed periodically from MongoDB. */
export class LeaderEntry extends Schema {
  constructor(init = {}) {
    super();
    this.rank = init.rank ?? 0;
    this.name = init.name ?? '';
    this.rodLevel = init.rodLevel ?? 1;
    this.totalCatches = init.totalCatches ?? 0;
  }
}

defineTypes(LeaderEntry, {
  rank: 'uint8',
  name: 'string',
  rodLevel: 'uint8',
  totalCatches: 'uint32',
});

export class HarborState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.messages = new ArraySchema();
    this.leaderboard = new ArraySchema();
    this.onlineCount = 0;
    this.serverTime = Date.now();
    // Public on purpose. The shop's bait shelf belongs to the harbour, not to
    // any one player, and everyone buying out of it has to see it move.
    this.baitStock = 0;
    this.baitStockCapacity = 0;
  }
}

defineTypes(HarborState, {
  players: { map: PlayerState },
  messages: [ChatEntry],
  leaderboard: [LeaderEntry],
  onlineCount: 'uint16',
  serverTime: 'number',
  baitStock: 'uint32',
  baitStockCapacity: 'uint32',
});
