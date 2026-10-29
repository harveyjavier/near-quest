/**
 * The single shared fishing area.
 *
 * This room is the authority for everything: it owns the cast timers, spends
 * the bait, rolls the RNG, grants the rewards and decides what each client is
 * allowed to know. Clients send intents ("I want to cast", "set stake to 10x")
 * and receive results. No client message ever carries an outcome, an amount or
 * a probability -- if one did, this file would ignore it.
 */

import { Room, ServerError } from '@colyseus/core';

import {
  AUTO_FISHING,
  BAIT_STOCK,
  CHAT,
  CLIENT_CATALOG,
  CONNECTION,
  CURRENCIES_BY_ID,
  EMISSION_MONITOR,
  LEADERBOARD,
  MAX_CLIENTS_PER_ROOM,
  MOVE_RATE_LIMIT,
  PERSIST_INTERVAL_MS,
  RATE_LIMIT,
  SPAWN,
  tileStand,
} from '../config/index.js';
import { openChest, appraiseGem, useConsumable } from '../game/chests.js';
import {
  applyBaitRegen, buyGoldWithUsdg, createBaitStock, depositUsdg, purchase, returnBaitToStock,
} from '../game/economy.js';
import {
  activeBuffs,
  beginCast,
  cancelCast,
  cashOutAllFish,
  cashOutSpecies,
  resolveCast,
} from '../game/fishing.js';
import { buyLevel } from '../game/progression.js';
import { expectedMintPerSecond } from '../game/balanceModel.js';
import {
  accumulateEmission,
  createEmissionMetrics,
  createTheoryCarry,
  emissionAlerts,
  nextTheoryCarry,
  takeEmissionWindow,
  theoryBudget,
} from '../game/metrics.js';
import { BAIT_REGEN } from '../config/game.config.js';
import { createPlayerRecord, getRepo, WORLD_KEY } from '../db/repo.js';
import { HarborState, ChatEntry, LeaderEntry, PlayerState } from './schema/HarborState.js';
import { catchLogView, meView } from './views.js';
import { log } from '../util/logger.js';
import {
  ValidationError,
  asObject,
  coerceDisplayName,
  isValidSessionToken,
  validateBoolean,
  validateChatMessage,
  validateChestId,
  validatePosition,
  validateQuantity,
  validateGemId,
  validateGoldPurchaseAmount,
  validateShopItem,
  validateSpeciesId,
  validateStake,
  validateUsdgAmount,
} from '../util/validate.js';

/** How long a dropped client keeps its dock slot before being cleaned up. */
const RECONNECT_GRACE_SECONDS = CONNECTION.reconnectGraceSeconds;

/** Join rejection for a wallet device whose token was rotated by a later sign-in. */
export const SESSION_EXPIRED = 4401;

const liveRooms = new Set();

/**
 * Saves and evicts whoever is seated on `sessionToken`, in every room in this
 * process. Called by wallet sign-in before it rotates that token.
 */
export async function releaseSession(sessionToken) {
  await Promise.all([...liveRooms].map((room) => room.releaseSession(sessionToken)));
}

export class HarborRoom extends Room {
  constructor(...args) {
    super(...args);
    this.maxClients = MAX_CLIENTS_PER_ROOM;
    /** sessionId -> { record, plan, nextCastAt, dirty, lastChatAt, rate } */
    this.runtime = new Map();

    /**
     * The harbour's bait shelf. Loaded from storage in onCreate and shared by
     * everyone in the room -- see `createBaitStock` for why bait is a closed
     * loop rather than something the shop mints on demand.
     *
     * One room holds one shelf. The contract scopes this game to a single
     * shared area and the room is sized to it (MAX_CLIENTS_PER_ROOM), so there
     * is exactly one harbour and one reservoir; a second room would keep a
     * second copy and the two would fight over the same document.
     */
    this.baitStock = createBaitStock(BAIT_STOCK.initial);
    this.baitStockDirty = false;

    /**
     * Lifetime currency emission for the harbour, loaded from the world
     * document alongside the bait shelf. The short window the tripwire
     * compares against theory lives in game/metrics.js; this is the running
     * total those windows are folded into.
     */
    this.emissionTotals = createEmissionMetrics();
    this.emissionDirty = false;

    /**
     * Theoretical mint earned in earlier windows and not yet spent. Deliberate
     * memory, not state that needs persisting: a restart forfeits the bank,
     * which at worst makes the first window after a deploy stricter than it
     * needs to be.
     */
    this.emissionCarry = createTheoryCarry();
  }

  /* ------------------------------------------------------------ lifecycle */

  async onCreate() {
    this.state = new HarborState();
    this.autoDispose = false; // the harbor is a persistent world, not a match
    liveRooms.add(this);

    await this.loadBaitStock();
    await this.loadEmissionTotals();
    await this.loadChatHistory();
    await this.refreshLeaderboard();

    this.registerHandlers();

    this.setSimulationInterval((delta) => this.tick(delta), AUTO_FISHING.tickMs);

    this.clock.setInterval(
      () => this.refreshLeaderboard().catch((error) => log.error('Leaderboard refresh failed:', error.message)),
      LEADERBOARD.refreshMs,
    );
    this.clock.setInterval(
      () => this.flushDirty().catch((error) => log.error('Persist failed:', error.message)),
      PERSIST_INTERVAL_MS,
    );
    if (EMISSION_MONITOR.enabled) {
      this.clock.setInterval(() => this.flushEmission(), EMISSION_MONITOR.flushIntervalMs);
    }

    log.info(`Harbor room ${this.roomId} created.`);
  }

  async onJoin(client, options = {}) {
    const repo = getRepo();
    const requested = asObjectSafe(options);

    let record = null;
    let isNewSession = false;

    // Returning device: look the guest session up by its opaque token.
    if (isValidSessionToken(requested.sessionToken)) {
      record = await repo.findPlayerByToken(requested.sessionToken);
    }

    // A wallet device must never silently fall back to a fresh guest.
    if (!record && requested.walletSession === true) {
      throw new ServerError(SESSION_EXPIRED, 'Your wallet session has expired. Please sign in again.');
    }

    if (!record) {
      const name = coerceDisplayName(requested.displayName, client.sessionId.slice(0, 4));
      record = createPlayerRecord(name);
      await repo.insertPlayer(record);
      isNewSession = true;
      log.info(`New guest session for "${record.displayName}".`);
    } else {
      record = normaliseRecord(record);
      // The name is entered once at game start; later joins keep the stored one.
      record.lastSeenAt = Date.now();
    }

    // A guest session is single-seat. If the same token is already playing in
    // this room, evict the older connection rather than run two idle loops
    // against one wallet.
    this.evictDuplicateSession(record.sessionToken, client.sessionId);

    applyBaitRegen(record);

    this.runtime.set(client.sessionId, {
      record,
      plan: null,
      nextCastAt: 0,
      dirty: true,
      lastChatAt: 0,
      // Which reason (if any) is currently stopping the idle loop from
      // starting a cast -- NO_BAIT or FISH_BAG_FULL. Tracked by code rather
      // than a single boolean so switching from one blocker to the other
      // still sends a fresh notice instead of staying silent.
      blockedCode: null,
      rate: { windowStart: 0, count: 0 },
      moveRate: { windowStart: 0, count: 0 },
    });

    const dockSlot = this.nextFreeDockSlot();
    const seat = spawnFor(dockSlot);

    this.state.players.set(
      client.sessionId,
      new PlayerState({
        name: record.displayName,
        rodLevel: record.rodLevel,
        totalCatches: record.totalCatches,
        dockSlot,
        stake: record.stake,
        x: seat.x,
        y: seat.y,
        facing: 'down',
      }),
    );
    this.state.onlineCount = this.state.players.size;

    client.send('catalog', CLIENT_CATALOG);
    if (isNewSession) client.send('session', { sessionToken: record.sessionToken });
    this.sendMe(client);
  }

  async onLeave(client, consented) {
    const runtime = this.runtime.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (player) player.online = false;

    if (runtime) {
      runtime.record.lastSeenAt = Date.now();
      runtime.dirty = true;
      await this.persist(runtime).catch((error) => log.error('Persist on leave failed:', error.message));
    }

    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
        const rejoined = this.state.players.get(client.sessionId);
        if (rejoined) rejoined.online = true;
        return;
      } catch {
        // Grace period expired -- fall through to cleanup.
      }
    }

    this.runtime.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.state.onlineCount = this.state.players.size;
  }

  async onDispose() {
    liveRooms.delete(this);
    // Close the open emission window before the last save, or a shutdown
    // silently drops whatever the harbour minted since the previous flush.
    if (EMISSION_MONITOR.enabled) this.flushEmission();
    await this.flushDirty().catch((error) => log.error('Final flush failed:', error.message));
    log.info(`Harbor room ${this.roomId} disposed.`);
  }

  /* ------------------------------------------------------------- messages */

  registerHandlers() {
    /**
     * Liveness, and nothing else.
     *
     * A socket that dies quietly -- the machine sleeps, a proxy drops an idle
     * connection, this process goes away -- leaves the browser still believing
     * it is connected, because nothing ever closed the socket from its end. The
     * client cannot tell that from a harbor where simply nothing is happening,
     * so it asks, and the answer to this is the proof that anyone is listening.
     *
     * Registered raw rather than through `handle`: it needs no player record and
     * no validation, and it must keep answering while a client is being rate
     * limited -- a player hammering the buttons has not lost their connection,
     * and must not be told they have.
     */
    this.onMessage('ping', (client) => {
      client.send('pong', { at: Date.now() });
    });

    this.handle('set_stake', (client, runtime, payload) => {
      runtime.record.stake = validateStake(payload.stake, runtime.record.rodLevel);
      runtime.dirty = true;
      runtime.blockedCode = null;
      const player = this.state.players.get(client.sessionId);
      if (player) player.stake = runtime.record.stake;
      this.sendMe(client, runtime);
    });

    this.handle('set_auto', (client, runtime, payload) => {
      const enabled = validateBoolean(payload.enabled, true);
      runtime.record.autoFishing = enabled;
      runtime.dirty = true;

      // Switching the loop off has to stop the cast already in the water, not
      // just decline to start the next one -- otherwise a player who walks
      // away mid-cast still lands the catch they walked away from.
      if (!enabled) this.abortCast(client, runtime);

      this.sendMe(client, runtime);
    });

    // Manual single cast. Same code path as the idle loop -- the only
    // difference is what triggered it.
    this.handle('cast', (client, runtime) => {
      if (runtime.plan) return; // already in flight
      this.startCast(client, runtime);
    });

    this.handle('open_chest', (client, runtime, payload) => {
      const chestId = validateChestId(payload.chestId);
      const result = openChest(runtime.record, chestId);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: 'That chest is no longer available.' });
        return;
      }

      runtime.dirty = true;
      client.send('chest_opened', result);
      this.syncPublic(client, runtime);
      this.sendMe(client, runtime);
    });

    /** GDD: uncut gems are the second container, appraised for Gold. */
    this.handle('appraise_gem', (client, runtime, payload) => {
      const gemId = validateGemId(payload.gemId);
      const result = appraiseGem(runtime.record, gemId);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: 'That gem is no longer available.' });
        return;
      }

      runtime.dirty = true;
      client.send('gem_appraised', result);
      this.sendMe(client, runtime);
    });

    /**
     * GDD: skip the grind by spending Gold. (The GDD's other skip-the-grind
     * path, Sparks, has been removed from the game -- see progression.js.)
     *
     * The cost is recomputed server-side from the player's actual remaining XP,
     * so a client that sends a stale or invented price is charged the real one.
     */
    this.handle('upgrade_rod', (client, runtime) => {
      const result = buyLevel(runtime.record);

      if (!result.ok) {
        client.send('error_msg', {
          code: result.code,
          message: result.code === 'MAX_LEVEL'
            ? 'Your rod is already at the maximum level.'
            : `Not enough Gold Coin. Need ${result.needed}, you have ${result.held}.`,
        });
        return;
      }

      runtime.dirty = true;
      client.send('rod_upgraded', result);
      this.syncPublic(client, runtime);
      this.sendMe(client, runtime);
    });

    this.handle('use_consumable', (client, runtime, payload) => {
      const id = typeof payload.id === 'string' ? payload.id : '';
      const result = useConsumable(runtime.record, id);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: 'You have none of those.' });
        return;
      }

      runtime.dirty = true;
      client.send('consumable_used', result);
      this.sendMe(client, runtime);
    });

    /**
     * Cashes in every fish of one species from the bag, for the Fishing Power
     * XP they were worth when they were caught. May level the rod up, so the
     * public projection is synced the same way a chest's XP reward is.
     */
    this.handle('cash_out_species', (client, runtime, payload) => {
      const speciesId = validateSpeciesId(payload.speciesId);
      const result = cashOutSpecies(runtime.record, speciesId);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: 'No fish of that kind to cash in.' });
        return;
      }

      runtime.dirty = true;
      // The bag just freed up, so a cast that was refused for being full can
      // be tried again on the very next tick instead of waiting out its
      // one-second backoff.
      runtime.blockedCode = null;
      client.send('fish_cashed', result);
      this.syncPublic(client, runtime);
      this.sendMe(client, runtime);
    });

    /** Cashes in the whole bag at once -- every species, in one click. */
    this.handle('cash_out_all_fish', (client, runtime) => {
      const result = cashOutAllFish(runtime.record);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: 'The bag has no fish to cash in.' });
        return;
      }

      runtime.dirty = true;
      runtime.blockedCode = null;
      client.send('fish_cashed_all', result);
      this.syncPublic(client, runtime);
      this.sendMe(client, runtime);
    });

    this.handle('buy', (client, runtime, payload) => {
      const item = validateShopItem(payload.itemId);
      const quantity = validateQuantity(payload.quantity);
      const result = purchase(runtime.record, item, quantity, this.baitStock);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: purchaseError(result, item) });
        return;
      }

      runtime.dirty = true;
      runtime.blockedCode = null;
      // Bait left the shelf, so every client's shop count has to move with it.
      if (result.stock) this.publishBaitStock();
      client.send('purchased', result);
      this.sendMe(client, runtime);
    });

    /**
     * Credits USDG straight to the wallet.
     *
     * There is no payment backend behind this yet -- see `depositUsdg`'s own
     * note in game/economy.js -- so this is the "simulated deposit" the wallet
     * panel already described as coming, bounded by USDG_LIMITS.
     */
    this.handle('deposit_usdg', (client, runtime, payload) => {
      const amount = validateUsdgAmount(payload.amount);
      const result = depositUsdg(runtime.record, amount);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: depositError(result) });
        return;
      }

      runtime.dirty = true;
      client.send('usdg_deposited', result);
      this.sendMe(client, runtime);
    });

    /** Converts USDG into Gold at the locked GOLD_DOLLAR_RATE anchor. */
    this.handle('buy_gold', (client, runtime, payload) => {
      const gold = validateGoldPurchaseAmount(payload.gold);
      const result = buyGoldWithUsdg(runtime.record, gold);

      if (!result.ok) {
        client.send('error_msg', { code: result.code, message: buyGoldError(result) });
        return;
      }

      runtime.dirty = true;
      client.send('gold_bought', result);
      this.sendMe(client, runtime);
    });

    this.handle('chat', async (client, runtime, payload) => {
      const now = Date.now();
      if (now - runtime.lastChatAt < CHAT.cooldownMs) {
        client.send('error_msg', { code: 'CHAT_COOLDOWN', message: 'Slow down a moment.' });
        return;
      }

      const text = validateChatMessage(payload.text);
      runtime.lastChatAt = now;

      const message = { name: runtime.record.displayName, text, at: now };
      this.pushChatEntry(message);
      await getRepo().pushChat(message).catch((error) => log.error('Chat persist failed:', error.message));
    });

    /**
     * Avatar position.
     *
     * Deliberately NOT authoritative. Where a player stands buys them nothing:
     * bait, odds, rewards and progression are all decided by the room without
     * ever reading a coordinate. Validating movement against the collision map
     * would mean shipping the map to the server and running a physics step per
     * client to defend a value with no economic weight -- so this clamps to the
     * world bounds, rate-limits the spam, and treats the rest as cosmetic.
     *
     * The one thing that must hold is that a client cannot use `move` as an
     * unlimited message channel, which is what the separate budget below is for.
     */
    this.onMessage('move', (client, rawPayload) => {
      const runtime = this.runtime.get(client.sessionId);
      if (!runtime) return;
      // Silently dropped when over budget: an error toast per frame would be
      // worse than a slightly stale avatar.
      if (!withinBudget(runtime.moveRate, MOVE_RATE_LIMIT)) return;

      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      try {
        const position = validatePosition(asObject(rawPayload));
        player.x = position.x;
        player.y = position.y;
        player.facing = position.facing;
        player.moving = position.moving;
      } catch {
        // Malformed position: ignore this update, keep the last good one.
      }
    });

    this.handle('request_me', (client, runtime) => {
      this.sendMe(client, runtime);
    });

    this.handle('request_catch_log', (client, runtime) => {
      client.send('catch_log', { entries: catchLogView(runtime.record.catchCounts) });
    });
  }

  /**
   * Wraps every handler with the checks that must never be skipped: the client
   * must be a known session, the payload must be an object, the client must be
   * inside its rate budget, and a ValidationError must become a message rather
   * than an unhandled rejection that takes the room down.
   */
  handle(type, handler) {
    this.onMessage(type, async (client, rawPayload) => {
      const runtime = this.runtime.get(client.sessionId);
      if (!runtime) return;

      if (!this.withinRateLimit(runtime)) {
        client.send('error_msg', { code: 'RATE_LIMITED', message: 'Too many actions. Slow down.' });
        return;
      }

      try {
        const payload = rawPayload === undefined || rawPayload === null ? {} : asObject(rawPayload);
        await handler(client, runtime, payload);
      } catch (error) {
        if (error instanceof ValidationError) {
          client.send('error_msg', { code: error.code, message: error.message });
          return;
        }
        log.error(`Handler "${type}" failed:`, error);
        client.send('error_msg', { code: 'SERVER_ERROR', message: 'Something went wrong.' });
      }
    });
  }

  withinRateLimit(runtime) {
    return withinBudget(runtime.rate, RATE_LIMIT);
  }

  /* ------------------------------------------------------------ simulation */

  /**
   * The idle loop. Runs every AUTO_FISHING.tickMs for every connected player:
   * regenerates bait, starts a cast when one is due, and resolves one whose
   * timer has elapsed. Cast timing lives here and only here -- a client that
   * lies about elapsed time changes nothing.
   */
  tick() {
    const now = Date.now();
    this.state.serverTime = now;

    for (const [sessionId, runtime] of this.runtime) {
      const client = this.clientBySessionId(sessionId);
      if (!client) continue;

      const regenerated = applyBaitRegen(runtime.record, now);
      if (regenerated > 0) {
        runtime.dirty = true;
        // Only clears a bait-shaped block. A full fish bag is unaffected by
        // bait regenerating, so it must stay reported until the bag itself
        // has room again.
        if (runtime.blockedCode === 'NO_BAIT') runtime.blockedCode = null;
        this.sendMe(client, runtime);
      }

      if (runtime.plan) {
        const player = this.state.players.get(sessionId);
        if (player) {
          const elapsed = now - runtime.plan.startedAt;
          player.castProgress = Math.min(1, elapsed / runtime.plan.durationMs);
        }
        if (now >= runtime.plan.endsAt) this.finishCast(client, runtime, now);
        continue;
      }

      if (runtime.record.autoFishing && now >= runtime.nextCastAt) {
        this.startCast(client, runtime, now);
      }
    }
  }

  startCast(client, runtime, now = Date.now()) {
    const result = beginCast(runtime.record, now);

    if (!result.ok) {
      // Blocked (no bait, or the fish bag is full): back off the loop and
      // tell the client once per distinct reason, not every tick.
      if (runtime.blockedCode !== result.code) {
        runtime.blockedCode = result.code;
        client.send('error_msg', {
          code: result.code,
          message: blockedCastMessage(result, runtime.record.stake),
        });
        this.sendMe(client, runtime);
      }
      runtime.nextCastAt = now + 1000;
      return;
    }

    runtime.blockedCode = null;
    runtime.plan = result.plan;
    runtime.dirty = true;

    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.casting = true;
      player.castProgress = 0;
    }

    client.send('cast_started', {
      durationMs: result.plan.durationMs,
      endsAt: result.plan.endsAt,
      stake: result.plan.stake,
      baitSpent: result.plan.baitCost,
      bait: runtime.record.bait,
      buffsConsumed: result.plan.buffsConsumed,
    });
  }

  /**
   * Drops a cast still in flight and refunds it. No-op when nothing is cast,
   * so callers do not have to check first.
   */
  abortCast(client, runtime) {
    if (!runtime.plan) return;

    const refund = cancelCast(runtime.record, runtime.plan);
    runtime.plan = null;
    runtime.nextCastAt = Date.now() + AUTO_FISHING.recastDelayMs;
    runtime.dirty = true;

    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.casting = false;
      player.castProgress = 0;
    }

    client.send('cast_cancelled', {
      ...refund,
      bait: runtime.record.bait,
    });
  }

  finishCast(client, runtime, now = Date.now()) {
    const { plan } = runtime;
    runtime.plan = null;
    runtime.nextCastAt = now + AUTO_FISHING.recastDelayMs;

    const outcome = resolveCast(runtime.record, plan, now);
    runtime.dirty = true;

    // The cast is spent, so the bait it burned is genuinely gone from the
    // player and goes back on the shop's shelf. Done here rather than at cast
    // start because a cast that is cancelled is refunded to the player
    // instead -- putting it back in both places would mint bait.
    if (returnBaitToStock(this.baitStock, plan.baitCost) > 0) this.publishBaitStock();

    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.casting = false;
      player.castProgress = 0;
      player.rodLevel = runtime.record.rodLevel;
      player.totalCatches = runtime.record.totalCatches;
    }

    client.send('cast_result', {
      ...outcome,
      bait: runtime.record.bait,
      goldTotal: runtime.record.gold,
      pearlsTotal: runtime.record.pearls,
      rodLevel: runtime.record.rodLevel,
      xpCurrent: runtime.record.xp,
      buffs: { ...(runtime.record.buffs ?? {}) },
      activeBuffs: activeBuffs(runtime.record),
    });

    this.sendMe(client, runtime);
  }

  /* ---------------------------------------------------------------- chat */

  async loadChatHistory() {
    try {
      const history = await getRepo().recentChat(CHAT.historySize);
      for (const message of history) {
        this.state.messages.push(new ChatEntry(message));
      }
    } catch (error) {
      log.error('Could not load chat history:', error.message);
    }
  }

  pushChatEntry(message) {
    this.state.messages.push(new ChatEntry(message));
    while (this.state.messages.length > CHAT.historySize) {
      this.state.messages.shift();
    }
  }

  /* ----------------------------------------------------------- bait shop */

  /**
   * Reads the shelf back from storage, so a restart does not quietly refill a
   * harbour that had been fished dry. A world with nothing saved yet opens at
   * the configured capacity.
   */
  async loadBaitStock() {
    try {
      const world = await getRepo().loadWorld();
      this.baitStock = createBaitStock(world?.baitStock ?? BAIT_STOCK.initial);
    } catch (error) {
      log.error('Could not load the bait stock:', error.message);
    }
    this.publishBaitStock();
  }

  /** Mirrors the shelf into shared state. Every client sees the same number. */
  publishBaitStock() {
    this.state.baitStock = this.baitStock.units;
    this.state.baitStockCapacity = this.baitStock.capacity;
    this.baitStockDirty = true;
  }

  async persistBaitStock() {
    if (!this.baitStockDirty) return;
    this.baitStockDirty = false;
    await getRepo().saveWorld({ key: WORLD_KEY, baitStock: this.baitStock.units });
  }

  /* ------------------------------------------------------ emission monitor */

  /**
   * Reads the lifetime emission tally back, so a restart continues the count
   * rather than starting the harbour's history over every deploy.
   */
  async loadEmissionTotals() {
    try {
      const world = await getRepo().loadWorld();
      const stored = world?.emission;
      if (stored) {
        this.emissionTotals = {
          goldMinted: Number(stored.goldMinted) || 0,
          pearlsMinted: Number(stored.pearlsMinted) || 0,
          baitMinted: Number(stored.baitMinted) || 0,
          windowStartedAt: Number(stored.windowStartedAt) || Date.now(),
        };
      }
    } catch (error) {
      log.error('Could not load the emission totals:', error.message);
    }
  }

  /**
   * What the players currently online *should* mint over `ms`, per
   * game/balanceModel.js.
   *
   * Coarse by construction, and in the direction that produces fewer false
   * alarms: it credits every actively fishing player with a full window of
   * uninterrupted casting at their current rod and stake, and allows the
   * free bait trickle its maximum rate for everyone connected. A real window is
   * always some fraction of that -- players walk away, bags fill, the trickle
   * stops at its ceiling -- so the theoretical figure runs high, and clearing
   * 2x over it takes a genuine anomaly rather than a busy afternoon.
   */
  theoreticalMint(ms) {
    const seconds = ms / 1000;
    const theory = { gold: 0, pearls: 0, bait: 0 };

    for (const runtime of this.runtime.values()) {
      const { record } = runtime;
      // A paused loop mints nothing, and counting it would only inflate theory.
      if (!record.autoFishing || runtime.blockedCode !== null) continue;

      const rate = expectedMintPerSecond({
        rodLevel: record.rodLevel,
        stake: record.stake,
      });
      theory.gold += rate.gold * seconds;
      theory.pearls += rate.pearls * seconds;
      theory.bait += rate.bait * seconds;
    }

    // The trickle is per-connected-player and independent of fishing, so it is
    // allowed for everyone at its ceiling rate rather than its real one.
    if (BAIT_REGEN.enabled) {
      theory.bait += BAIT_REGEN.amount * (ms / BAIT_REGEN.intervalMs) * this.runtime.size;
    }

    return theory;
  }

  /**
   * Closes an emission window: folds it into the lifetime total, compares it
   * with theory, and warns when the two are far enough apart to be worth
   * looking at.
   *
   * Never throws. This is observability -- a monitor that can take the room
   * down with it is worse than no monitor.
   */
  flushEmission(now = Date.now()) {
    try {
      const window = takeEmissionWindow(undefined, now);
      if (window.ms <= 0) return null;

      accumulateEmission(this.emissionTotals, window);
      this.emissionDirty = true;

      const theory = this.theoreticalMint(window.ms);
      // Judged against the window's own theory plus what earlier windows were
      // entitled to and did not mint -- see EMISSION_MONITOR.maxCarryWindows
      // for why a bag of gems cashed in all at once is not an anomaly.
      const budget = theoryBudget(theory, this.emissionCarry);
      const alerts = emissionAlerts(window, budget);
      this.emissionCarry = nextTheoryCarry(budget, window, theory);

      const minutes = (window.ms / 60000).toFixed(1);
      log.debug(
        `Emission ${minutes}m (${this.runtime.size} online), actual/allowed: `
        + `gold ${window.gold.toFixed(0)}/${budget.gold.toFixed(0)}, `
        + `pearls ${window.pearls.toFixed(0)}/${budget.pearls.toFixed(0)}, `
        + `bait ${window.bait.toFixed(0)}/${budget.bait.toFixed(0)}.`,
      );

      for (const alert of alerts) {
        const multiple = Number.isFinite(alert.ratio)
          ? `${alert.ratio.toFixed(1)}x`
          : 'no theoretical baseline';
        log.warn(
          `EMISSION ANOMALY: ${alert.currency} minted ${alert.actual.toFixed(0)} in ${minutes}m `
          + `against a theoretical ${alert.theoretical.toFixed(0)} (${multiple}, threshold `
          + `${EMISSION_MONITOR.alertRatio}x, ${this.runtime.size} online). `
          + 'Check for an exploit or a balance regression.',
        );
      }

      return { window, theory, budget, alerts };
    } catch (error) {
      log.error('Emission flush failed:', error.message);
      return null;
    }
  }

  async persistEmissionTotals() {
    if (!this.emissionDirty) return;
    this.emissionDirty = false;
    await getRepo().saveWorld({ key: WORLD_KEY, emission: { ...this.emissionTotals } });
  }

  /* --------------------------------------------------------- leaderboard */

  async refreshLeaderboard() {
    const rows = await getRepo().leaderboard(LEADERBOARD.size);

    this.state.leaderboard.splice(0, this.state.leaderboard.length);
    rows.forEach((row, index) => {
      this.state.leaderboard.push(new LeaderEntry({
        rank: index + 1,
        name: row.displayName,
        rodLevel: row.rodLevel,
        totalCatches: row.totalCatches,
      }));
    });
  }

  /* ----------------------------------------------------------- utilities */

  clientBySessionId(sessionId) {
    for (const client of this.clients) {
      if (client.sessionId === sessionId) return client;
    }
    return null;
  }

  sendMe(client, runtime = this.runtime.get(client.sessionId)) {
    if (!runtime) return;
    client.send('me', meView(runtime.record, runtime));
  }

  /** Mirrors record fields that are part of the public projection. */
  syncPublic(client, runtime) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.rodLevel = runtime.record.rodLevel;
    player.totalCatches = runtime.record.totalCatches;
  }

  nextFreeDockSlot() {
    const taken = new Set();
    this.state.players.forEach((player) => taken.add(player.dockSlot));
    for (let slot = 0; slot < MAX_CLIENTS_PER_ROOM; slot += 1) {
      if (!taken.has(slot)) return slot;
    }
    return 0;
  }

  evictDuplicateSession(sessionToken, keepSessionId) {
    for (const [sessionId, runtime] of this.runtime) {
      if (sessionId === keepSessionId) continue;
      if (runtime.record.sessionToken !== sessionToken) continue;

      this.clientBySessionId(sessionId)?.leave(4001);
      this.runtime.delete(sessionId);
      this.state.players.delete(sessionId);
    }
  }

  async releaseSession(sessionToken) {
    for (const [sessionId, runtime] of this.runtime) {
      if (runtime.record.sessionToken !== sessionToken) continue;
      // Out of the map before the await, so no periodic flush races the rotation.
      this.runtime.delete(sessionId);
      this.state.players.delete(sessionId);
      this.state.onlineCount = this.state.players.size;
      this.clientBySessionId(sessionId)?.leave(4001);
      runtime.dirty = true;
      await this.persist(runtime);
    }
  }

  async persist(runtime) {
    if (!runtime.dirty) return;
    runtime.dirty = false;
    await getRepo().savePlayer(runtime.record);
  }

  async flushDirty() {
    const pending = [];
    for (const runtime of this.runtime.values()) {
      if (runtime.dirty) pending.push(this.persist(runtime));
    }
    if (this.baitStockDirty) {
      pending.push(this.persistBaitStock()
        .catch((error) => log.error('Bait stock persist failed:', error.message)));
    }
    if (this.emissionDirty) {
      pending.push(this.persistEmissionTotals()
        .catch((error) => log.error('Emission persist failed:', error.message)));
    }
    if (pending.length > 0) await Promise.allSettled(pending);
  }
}

/**
 * Turns a refused purchase into a line the shop panel can show as-is.
 *
 * The reasons a sale fails are the three the player can act on -- no money, no
 * stock on the shelf, or an item the harbour does not trade yet -- so each one
 * says which it was rather than collapsing into "could not be completed".
 */
function purchaseError(result, item) {
  switch (result.code) {
    case 'INSUFFICIENT_FUNDS':
      return `Not enough ${CURRENCIES_BY_ID[result.currency]?.name ?? result.currency}. `
        + `Need ${result.needed}, you have ${result.held}.`;
    case 'OUT_OF_STOCK':
      return `The shop only has ${result.available} bait left -- enough for `
        + `${result.packsAvailable} ${item.name}.`;
    case 'ITEM_LOCKED':
      return result.reason ?? `${item.name} is not for sale yet.`;
    default:
      return 'That purchase could not be completed.';
  }
}

/** Turns a refused USDG deposit into a line the wallet panel can show as-is. */
function depositError(result) {
  switch (result.code) {
    case 'AMOUNT_TOO_LARGE':
      return `Deposits are capped at $${result.max.toLocaleString('en-US')} at a time.`;
    case 'BALANCE_CAP':
      return `Your wallet is capped at $${result.max.toLocaleString('en-US')}. `
        + `You hold $${result.held.toFixed(2)}.`;
    default:
      return 'Enter an amount to deposit.';
  }
}

/** Turns a refused Gold purchase into a line the Gold screen can show as-is. */
function buyGoldError(result) {
  switch (result.code) {
    case 'INSUFFICIENT_USDG':
      return `Not enough USDG. Need $${result.needed.toFixed(2)}, you have $${result.held.toFixed(2)}.`;
    case 'AMOUNT_TOO_LARGE':
      return `You can buy at most ${result.max.toLocaleString('en-US')} Gold at a time.`;
    default:
      return 'Enter how much Gold to buy.';
  }
}

/**
 * What to tell the client about a cast the idle loop could not start.
 *
 * Two reasons block a cast: no bait, or a fish bag with no room left for
 * whatever the cast might land. Each needs its own line, since only one of
 * them is fixed by buying bait.
 */
function blockedCastMessage(result, stake) {
  if (result.code === 'FISH_BAG_FULL') {
    return 'Your fish bag is full. Cash some in from the Bag to keep fishing.';
  }
  return `Out of bait. A ${stake}x cast costs ${result.baitCost}.`;
}

/** Join options arrive from the client; never assume they are an object. */
function asObjectSafe(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Sliding-window counter shared by the general and movement rate limits. */
function withinBudget(window, limit) {
  const now = Date.now();
  if (now - window.windowStart > limit.windowMs) {
    window.windowStart = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count <= limit.maxMessages;
}

/**
 * Where a joining player is seated. Takes the next named seat, and falls back
 * to spreading along the boardwalk once those run out, so arrivals never stack
 * on one plank. See the COUPLING note on SPAWN in config/game.config.js.
 */
function spawnFor(dockSlot) {
  const seat = SPAWN.seats[dockSlot];
  if (seat) return tileStand(seat.tx, seat.ty);

  let index = Math.max(0, dockSlot - SPAWN.seats.length);

  for (const { x0, x1, y0, y1 } of SPAWN.lanes) {
    const columns = x1 - x0 + 1;
    const size = columns * (y1 - y0 + 1);
    if (index < size) {
      return tileStand(x0 + (index % columns), y0 + Math.floor(index / columns));
    }
    index -= size;
  }

  // More players than the harbour has planks. Cannot happen while the lanes
  // cover MAX_CLIENTS_PER_ROOM -- the level test asserts they do -- but seating
  // someone on top of the first arrival beats seating them off the map.
  return tileStand(SPAWN.seats[0].tx, SPAWN.seats[0].ty);
}

/**
 * Shell tiers, in the order they were replaced by gem tiers.
 *
 * A document written before appraisal existed holds `shells`. Those are still
 * the player's, so they are carried across to the stone of the same rank
 * rather than dropped -- a build that changes what an item is called must not
 * empty a returning player's bag.
 */
const LEGACY_SHELL_TIERS = {
  common: 'emerald',
  silver: 'ruby',
  golden: 'sapphire',
  legendary: 'diamond',
};

function migrateShells(record) {
  if (Array.isArray(record.uncutGems)) return record.uncutGems;
  if (!Array.isArray(record.shells)) return [];

  return record.shells
    .filter((shell) => LEGACY_SHELL_TIERS[shell.tier])
    .map((shell) => ({ ...shell, tier: LEGACY_SHELL_TIERS[shell.tier] }));
}

/**
 * Backfills fields a document written by an older build might be missing, so a
 * schema addition never crashes a returning player's session.
 */
function normaliseRecord(record) {
  return {
    ...record,
    catchCounts: record.catchCounts ?? {},
    inventory: record.inventory ?? {},
    buffs: record.buffs ?? {},
    chests: Array.isArray(record.chests) ? record.chests : [],
    // A document written before catches paid out through the bag has no
    // `fish` field at all -- a fresh empty bag is the correct default, not a
    // missing one.
    fish: Array.isArray(record.fish) ? record.fish : [],
    uncutGems: migrateShells(record),
    // The gems -> pearls rename itself is handled in db/repo.js's
    // fromStorage(), same as every other legacy field rename; this is just
    // the plain missing-field default every other field here gets.
    pearls: record.pearls ?? 0,
    rewardLog: Array.isArray(record.rewardLog) ? record.rewardLog : [],
    totalCasts: record.totalCasts ?? 0,
    totalCatches: record.totalCatches ?? 0,
    lastBaitRegenAt: record.lastBaitRegenAt ?? Date.now(),
  };
}
