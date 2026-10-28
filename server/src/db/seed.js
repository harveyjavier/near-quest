/**
 * Seeds a MongoDB instance with the defaults a fresh deployment needs.
 *
 *   npm run seed              # ensure indexes + welcome messages
 *   npm run seed -- --reset   # DROP players and chat first, then seed
 *
 * There are no player accounts to seed: a player document is created the first
 * time a browser joins. What this does set up is the indexes the leaderboard
 * and session lookup rely on, and a couple of chat lines so the very first
 * player does not arrive to a blank room.
 *
 * Requires MONGO_URL. It deliberately refuses to run against the in-memory
 * fallback -- seeding a store that evaporates on restart is a silent no-op.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

import { ChatMessage, Deposit, Player } from './models.js';
import { CHEST_TIERS, FISH, REWARD_TYPES, RODS, SHOP_ITEMS } from '../config/index.js';
import { log } from '../util/logger.js';

const WELCOME_MESSAGES = [
  'Welcome to the harbor. Pick a stake -- the higher it is, the rarer the prize and the rarer the bite -- and the rod does the rest.',
  'Risky lands fewer bites but better chests. Steady is the safe grind.',
  'Out of bait? Sell nothing -- just wait, a little washes up for free.',
];

async function main() {
  const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
  const reset = process.argv.includes('--reset');

  if (!mongoUrl) {
    log.error('MONGO_URL is not set. Seeding needs a real MongoDB instance.');
    process.exit(1);
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 10000 });
  log.info(`Connected to "${mongoose.connection.name}".`);

  if (reset) {
    log.warn('--reset given: dropping players and chat history.');
    await Player.deleteMany({});
    await ChatMessage.deleteMany({});
  }

  // Build the indexes the room queries against on every leaderboard refresh
  // and every join, rather than letting the first production query do it.
  await Player.syncIndexes();
  await ChatMessage.syncIndexes();
  await Deposit.syncIndexes();
  log.info('Indexes synced.');

  const existingChat = await ChatMessage.estimatedDocumentCount();
  if (existingChat === 0) {
    const now = Date.now();
    await ChatMessage.insertMany(
      WELCOME_MESSAGES.map((text, index) => ({
        name: 'harbor',
        text,
        // Spaced a minute apart so they read as a conversation, not one blob.
        at: now - (WELCOME_MESSAGES.length - index) * 60_000,
      })),
    );
    log.info(`Seeded ${WELCOME_MESSAGES.length} welcome messages.`);
  } else {
    log.info(`Chat already has ${existingChat} messages -- left alone.`);
  }

  const players = await Player.estimatedDocumentCount();

  log.info('--------------------------------------------------');
  log.info(`Database:      ${mongoose.connection.name}`);
  log.info(`Players:       ${players}`);
  log.info(`Chat messages: ${await ChatMessage.estimatedDocumentCount()}`);
  log.info('Content catalog (config-driven, not stored in MongoDB):');
  log.info(`  ${FISH.length} fish species, ${RODS.length} rod levels`);
  log.info(`  ${CHEST_TIERS.length} chest tiers, ${REWARD_TYPES.length} reward types`);
  log.info(`  ${SHOP_ITEMS.length} shop items`);
  log.info('--------------------------------------------------');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  log.error('Seed failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
