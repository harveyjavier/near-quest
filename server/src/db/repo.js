/**
 * Persistence layer.
 *
 * MongoDB is the contracted store and the only one used in production. When
 * MONGO_URL is absent the process falls back to an in-process store so the game
 * still boots for local development and automated tests -- it logs a loud
 * warning and persists nothing across restarts. `ALLOW_MEMORY_DB=false` (the
 * production default via Procfile/railway config) turns that fallback into a
 * hard startup failure so a misconfigured deploy cannot silently lose data.
 */

import mongoose from 'mongoose';

import { LEADERBOARD, CHAT, STARTING_RESOURCES, DEFAULT_STAKE, AUTO_FISHING } from '../config/index.js';
import { log } from '../util/logger.js';
import { token } from '../util/rng.js';

/**
 * The id of the single shared-world document.
 *
 * The contract scopes this game to one harbour, so there is one row: the shop's
 * bait reservoir and anything else the world owns rather than a player.
 */
export const WORLD_KEY = 'harbor';

/** The canonical shape of a fresh guest player. */
export function createPlayerRecord(displayName, now = Date.now()) {
  return {
    sessionToken: token(32),
    displayName,
    rodLevel: 1,
    xp: 0,
    totalXp: 0,
    bait: STARTING_RESOURCES.bait,
    gold: STARTING_RESOURCES.gold,
    pearls: STARTING_RESOURCES.pearls,
    usdg: STARTING_RESOURCES.usdg,
    stake: DEFAULT_STAKE,
    autoFishing: AUTO_FISHING.defaultEnabled,
    totalCasts: 0,
    totalCatches: 0,
    uncutGems: [],
    catchCounts: {},
    inventory: {},
    buffs: {},
    chests: [],
    fish: [],
    rewardLog: [],
    lastBaitRegenAt: now,
    createdAt: now,
    lastSeenAt: now,
  };
}

/** Fields the server owns. Never trusts a client-sent copy of any of these. */
const PERSISTED_FIELDS = [
  'displayName', 'rodLevel', 'xp', 'totalXp', 'bait', 'gold', 'pearls', 'usdg',
  'stake', 'autoFishing', 'totalCasts', 'totalCatches',
  'uncutGems',
  'catchCounts', 'inventory', 'buffs', 'chests', 'fish', 'rewardLog',
  'lastBaitRegenAt', 'createdAt', 'lastSeenAt',
];

/**
 * A record as it comes back out of storage.
 *
 * Two renames deep, both handled here so reading is the only place that has
 * to know about either:
 *
 *   1. The soft currency was called `pearls` until it became Gold. A document
 *      written before that rename still carries the old field; the value
 *      moves across to `gold` on load, and nothing downstream ever sees it.
 *   2. The rare tier-3 currency was called `gems` until it was renamed to
 *      Pearl -- to stop colliding with the *uncut* gems in the bag, which
 *      are graded items rather than a currency, not because of rename (1).
 *      A document written before that rename still carries the old field;
 *      same treatment, this time onto `pearls`.
 *
 * The two run in that order on purpose: rename (1) already owned the field
 * name `pearls` for a different value in old documents, so it has to clear
 * that field before rename (2) can reuse the name for what it means today.
 *
 * Then one removal rather than a rename: `dialMode`. Every document written
 * before Stake and the Dial were collapsed into a single Stake axis carries
 * one, and nothing reads it any more. Dropped on the way in so a stale value
 * cannot reach game code even if something starts branching on `player.*`
 * generically; `savePlayer` unsets it in the store on the document's next
 * flush, which is what actually clears it out of Mongo.
 *
 * Kept rather than migrated in a script because a guest document is cheap and
 * each fallback costs one property read per join.
 */
function fromStorage(doc) {
  if (!doc) return doc;
  let out = doc;
  if (out.gold === undefined && out.pearls !== undefined) {
    out = { ...out, gold: out.pearls, pearls: undefined };
  }
  if (out.pearls === undefined && out.gems !== undefined) {
    out = { ...out, pearls: out.gems, gems: undefined };
  }
  if (out.dialMode !== undefined) {
    out = { ...out, dialMode: undefined };
  }
  return out;
}

/**
 * Fields a document may still carry from an older build that nothing reads any
 * more. Cleared on the next save rather than in a migration script: every
 * active document is flushed within PERSIST_INTERVAL_MS of being touched, so
 * the harbour cleans itself as it is played, and a document nobody has opened
 * in months is not worth a maintenance window.
 */
const RETIRED_FIELDS = ['dialMode'];

function projectForSave(record) {
  const out = {};
  for (const field of PERSISTED_FIELDS) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

/* ------------------------------------------------------------------ Mongo -- */

function mongoBackend({ Player, ChatMessage, World }) {
  return {
    kind: 'mongodb',

    async findPlayerByToken(sessionToken) {
      return fromStorage(await Player.findOne({ sessionToken }).lean().exec());
    },

    async insertPlayer(record) {
      await Player.create(record);
      return record;
    },

    async findPlayerByNearAccount(nearAccountId) {
      return fromStorage(await Player.findOne({ nearAccountId }).lean().exec());
    },

    /** False when the session is unknown or already bound to another wallet. */
    async bindNearAccount(sessionToken, nearAccountId) {
      const result = await Player.updateOne(
        { sessionToken, nearAccountId: { $exists: false } },
        { $set: { nearAccountId } },
      ).exec();
      return result.modifiedCount === 1;
    },

    async rotateSessionToken(oldToken, newToken) {
      const result = await Player.updateOne({ sessionToken: oldToken }, { $set: { sessionToken: newToken } }).exec();
      return result.modifiedCount === 1;
    },

    async savePlayer(record) {
      await Player.updateOne(
        { sessionToken: record.sessionToken },
        {
          $set: projectForSave(record),
          // `$set` alone leaves a retired field sitting in the document
          // forever, because the field is simply absent from what we write.
          // Named explicitly, and in the same round trip.
          $unset: Object.fromEntries(RETIRED_FIELDS.map((field) => [field, ''])),
        },
        // No upsert: a stale flush after a token rotation must not resurrect the old token.
        { strict: false },
      ).exec();
    },

    async leaderboard(limit = LEADERBOARD.size) {
      return Player.find({}, { displayName: 1, rodLevel: 1, totalCatches: 1, _id: 0 })
        .sort({ rodLevel: -1, totalCatches: -1 })
        .limit(limit)
        .lean()
        .exec();
    },

    async recentChat(limit = CHAT.historySize) {
      const rows = await ChatMessage.find({}, { name: 1, text: 1, at: 1, _id: 0 })
        .sort({ at: -1 })
        .limit(limit)
        .lean()
        .exec();
      return rows.reverse();
    },

    async pushChat(message) {
      await ChatMessage.create(message);
      // Keep the collection bounded without a TTL index, so history survives
      // restarts but never grows without limit.
      const total = await ChatMessage.estimatedDocumentCount();
      if (total > CHAT.persistedHistorySize * 2) {
        const cutoff = await ChatMessage.find({}, { at: 1 })
          .sort({ at: -1 })
          .skip(CHAT.persistedHistorySize)
          .limit(1)
          .lean()
          .exec();
        if (cutoff.length > 0) {
          await ChatMessage.deleteMany({ at: { $lt: cutoff[0].at } }).exec();
        }
      }
    },

    async playerCount() {
      return Player.estimatedDocumentCount();
    },

    async loadWorld() {
      return World.findOne({ key: WORLD_KEY }, { _id: 0 }).lean().exec();
    },

    async saveWorld(fields) {
      await World.updateOne(
        { key: WORLD_KEY },
        { $set: { ...fields, updatedAt: Date.now() } },
        { upsert: true },
      ).exec();
    },
  };
}

/* ----------------------------------------------------------------- Memory -- */

function memoryBackend() {
  const players = new Map();
  const chat = [];
  let world = null;

  return {
    kind: 'memory',

    async findPlayerByToken(sessionToken) {
      const found = players.get(sessionToken);
      return found ? fromStorage(structuredClone(found)) : null;
    },

    async insertPlayer(record) {
      players.set(record.sessionToken, structuredClone(record));
      return record;
    },

    async findPlayerByNearAccount(nearAccountId) {
      const found = [...players.values()].find((player) => player.nearAccountId === nearAccountId);
      return found ? fromStorage(structuredClone(found)) : null;
    },

    async bindNearAccount(sessionToken, nearAccountId) {
      const found = players.get(sessionToken);
      if (!found || found.nearAccountId) return false;
      found.nearAccountId = nearAccountId;
      return true;
    },

    async rotateSessionToken(oldToken, newToken) {
      const found = players.get(oldToken);
      if (!found) return false;
      players.delete(oldToken);
      players.set(newToken, { ...found, sessionToken: newToken });
      return true;
    },

    async savePlayer(record) {
      if (!players.has(record.sessionToken)) return;
      players.set(record.sessionToken, structuredClone({
        // Keeps nearAccountId, which the room never writes back.
        nearAccountId: players.get(record.sessionToken)?.nearAccountId,
        sessionToken: record.sessionToken,
        ...projectForSave(record),
      }));
    },

    async leaderboard(limit = LEADERBOARD.size) {
      return [...players.values()]
        .sort((a, b) => (b.rodLevel - a.rodLevel) || (b.totalCatches - a.totalCatches))
        .slice(0, limit)
        .map(({ displayName, rodLevel, totalCatches }) => ({ displayName, rodLevel, totalCatches }));
    },

    async recentChat(limit = CHAT.historySize) {
      return chat.slice(-limit).map((message) => ({ ...message }));
    },

    async pushChat(message) {
      chat.push({ ...message });
      if (chat.length > CHAT.persistedHistorySize) {
        chat.splice(0, chat.length - CHAT.persistedHistorySize);
      }
    },

    async playerCount() {
      return players.size;
    },

    async loadWorld() {
      return world ? { ...world } : null;
    },

    async saveWorld(fields) {
      world = { ...(world ?? { key: WORLD_KEY }), ...fields, updatedAt: Date.now() };
    },
  };
}

/* ------------------------------------------------------------------- API -- */

let backend = null;

export function getRepo() {
  if (!backend) throw new Error('Repository used before connectDatabase() resolved.');
  return backend;
}

export function repoKind() {
  return backend?.kind ?? 'none';
}

/**
 * Connects to MongoDB, or installs the memory fallback when that is allowed.
 * Resolves with the active backend; rejects only when a production deploy is
 * missing MONGO_URL.
 */
export async function connectDatabase({
  mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI || '',
  allowMemory = process.env.ALLOW_MEMORY_DB !== 'false',
} = {}) {
  if (mongoUrl) {
    mongoose.set('strictQuery', true);
    await mongoose.connect(mongoUrl, {
      serverSelectionTimeoutMS: 10000,
      // No credentials are ever logged; the URL itself stays in env only.
    });

    const models = await import('./models.js');
    backend = mongoBackend(models);

    mongoose.connection.on('error', (error) => log.error('MongoDB error:', error.message));
    mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected.'));

    log.info(`MongoDB connected (db: ${mongoose.connection.name}).`);
    return backend;
  }

  if (!allowMemory) {
    throw new Error(
      'MONGO_URL is not set and ALLOW_MEMORY_DB=false. Refusing to start without a database.',
    );
  }

  backend = memoryBackend();
  log.warn('==============================================================');
  log.warn(' MONGO_URL not set -- using the IN-MEMORY store.');
  log.warn(' Progress will NOT survive a server restart. Development only.');
  log.warn('==============================================================');
  return backend;
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  backend = null;
}
