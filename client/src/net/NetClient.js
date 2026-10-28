/**
 * Thin wrapper over colyseus.js.
 *
 * The client is a renderer. It sends intents and renders what comes back; it
 * never computes a reward, an odds table or a level-up. Everything in `send`
 * below is a request, not a result -- if you find yourself wanting to add
 * `send('grantGold', ...)`, that belongs in the room instead.
 *
 * Guest identity is a server-issued 64-char token kept in localStorage. It is
 * the only thing that persists a player across reloads, and it is not a
 * password: there is no account to log into.
 */

import { Client, getStateCallbacks } from '@colyseus/sdk';

const STORAGE_KEYS = {
  sessionToken: 'fishing-idle.sessionToken',
  displayName: 'fishing-idle.displayName',
  nearAccountId: 'fishing-idle.nearAccountId',
  pendingDeposits: 'fishing-idle.pendingDeposits',
};

/** A sent transfer the server hasn't confirmed is retried on each join for this long. */
const PENDING_DEPOSIT_TTL_MS = 7 * 24 * 60 * 60_000;

/** While connected, a slow chain or RPC is retried after these waits; then the next join tries again. */
const DEPOSIT_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000];

function forgetPendingDeposit(txHash) {
  const pending = readPendingDeposits();
  delete pending[txHash];
  writePendingDeposits(pending);
}

/** txHash -> { sentAt, accountId, senderId }, for transfers already on-chain but not yet credited. */
function readPendingDeposits() {
  try {
    return JSON.parse(readStorage(STORAGE_KEYS.pendingDeposits) || '{}');
  } catch {
    return {};
  }
}

function writePendingDeposits(pending) {
  writeStorage(STORAGE_KEYS.pendingDeposits, JSON.stringify(pending));
}

/** How often the client asks the room to prove it is still there. */
const HEARTBEAT_MS = 10_000;

/**
 * Silence that counts as gone: three beats unanswered.
 *
 * Generous on purpose. The cost of calling a live connection dead is throwing a
 * player out of a session that was fine, so this waits until the case is not
 * arguable rather than reacting to one dropped packet.
 */
const HEARTBEAT_GRACE_MS = 32_000;

/** How long a ping sent on waking has to be answered before the tab gives up. */
const WAKE_PROBE_MS = 8000;

/** localStorage throws in private-mode Safari and when storage is disabled. */
function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storedDisplayName() {
  return readStorage(STORAGE_KEYS.displayName);
}

export function storedSessionToken() {
  return readStorage(STORAGE_KEYS.sessionToken);
}

export function storedNearAccount() {
  return readStorage(STORAGE_KEYS.nearAccountId);
}

/** Adopts a session issued by wallet sign-in. */
export function storeSession(sessionToken, displayName, nearAccountId) {
  writeStorage(STORAGE_KEYS.sessionToken, sessionToken);
  writeStorage(STORAGE_KEYS.displayName, displayName);
  writeStorage(STORAGE_KEYS.nearAccountId, nearAccountId);
}

/** Clears the guest session. Used by the "start over" affordance. */
export function forgetSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEYS.sessionToken);
    window.localStorage.removeItem(STORAGE_KEYS.displayName);
    window.localStorage.removeItem(STORAGE_KEYS.nearAccountId);
  } catch {
    // Nothing to do -- storage was unavailable, so nothing was stored.
  }
}

export class NetClient {
  constructor(endpoint, roomName = 'harbor') {
    this.endpoint = endpoint;
    this.roomName = roomName;
    this.room = null;
    this.$ = null;

    this.catalog = null;
    this.me = null;
    /** The shop's shared bait shelf, mirrored out of room state. */
    this.baitStock = 0;

    /** event name -> Set<handler> */
    this.listeners = new Map();
    this.storageAvailable = true;

    /* Connection watchdog. See startHeartbeat. */
    this.lastPongAt = 0;
    this.heartbeatTimer = null;
    this.wakeProbeTimer = null;
    this.onVisible = null;
    /** Set once the session has ended, so it is only ever announced once. */
    this.ended = false;
  }

  /* --------------------------------------------------------------- events */

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (error) {
        // One broken listener must not stop the others or kill the frame.
        console.error(`Listener for "${event}" threw:`, error);
      }
    }
  }

  /* -------------------------------------------------------------- connect */

  /**
   * Joins the shared harbor. `displayName` is only used the first time a
   * device connects; after that the stored session token decides who you are.
   */
  async connect(displayName) {
    const client = new Client(this.endpoint);
    const sessionToken = storedSessionToken();

    const options = {};
    if (sessionToken) options.sessionToken = sessionToken;
    if (displayName) options.displayName = displayName;
    // Tells the server to refuse rather than mint a fresh guest if the token was rotated away.
    if (sessionToken && storedNearAccount()) options.walletSession = true;

    this.room = await client.joinOrCreate(this.roomName, options);
    this.$ = getStateCallbacks(this.room);

    this.bindMessages();
    this.bindState();
    this.bindLifecycle();
    this.startHeartbeat();

    if (displayName) {
      this.storageAvailable = writeStorage(STORAGE_KEYS.displayName, displayName);
    }

    return this.room;
  }

  bindMessages() {
    const room = this.room;

    room.onMessage('catalog', (catalog) => {
      this.catalog = catalog;
      this.emit('catalog', catalog);
    });

    // Sent once, when the server creates a brand-new guest for this device.
    room.onMessage('session', ({ sessionToken }) => {
      this.storageAvailable = writeStorage(STORAGE_KEYS.sessionToken, sessionToken);
      this.emit('session', { sessionToken, persisted: this.storageAvailable });
    });

    room.onMessage('me', (me) => {
      if (!this.me && me.nearAccountId) this.retryPendingDeposits(me.nearAccountId);
      this.me = me;
      this.emit('me', me);
    });

    room.onMessage('cast_started', (payload) => this.emit('castStarted', payload));
    room.onMessage('cast_result', (payload) => this.emit('castResult', payload));
    room.onMessage('cast_cancelled', (payload) => this.emit('castCancelled', payload));
    room.onMessage('chest_opened', (payload) => this.emit('chestOpened', payload));
    room.onMessage('gem_appraised', (payload) => this.emit('gemAppraised', payload));
    room.onMessage('fish_cashed', (payload) => this.emit('fishCashed', payload));
    room.onMessage('fish_cashed_all', (payload) => this.emit('fishCashedAll', payload));

    // The heartbeat's answer. Nothing reads the payload -- that it arrived at
    // all is the whole of what the watchdog wanted to know.
    room.onMessage('pong', () => { this.lastPongAt = Date.now(); });
    room.onMessage('rod_upgraded', (payload) => this.emit('rodUpgraded', payload));
    room.onMessage('purchased', (payload) => this.emit('purchased', payload));
    room.onMessage('usdg_deposited', (payload) => this.emit('usdgDeposited', payload));
    room.onMessage('deposit_claimed', ({ txHash, status, already }) => {
      // A 'pending' row means an earlier claim stopped before the player was
      // paid: keep the hash, the player has not been credited yet.
      if (status === 'credited') forgetPendingDeposit(txHash);
      this.emit('depositClaimed', { txHash, status, already });
    });
    room.onMessage('deposit_failed', (failure) => {
      if (failure.retryable) this.scheduleDepositRetry(failure.txHash);
      else forgetPendingDeposit(failure.txHash);
      this.emit('depositFailed', failure);
    });
    room.onMessage('gold_bought', (payload) => this.emit('goldBought', payload));
    room.onMessage('consumable_used', (payload) => this.emit('consumableUsed', payload));
    room.onMessage('catch_log', (payload) => this.emit('catchLog', payload));
    room.onMessage('error_msg', (payload) => this.emit('serverError', payload));

    // Anything the server adds later should be visible in development rather
    // than triggering a library warning nobody reads.
    room.onMessage('*', (type) => {
      if (import.meta.env?.DEV) console.debug('Unhandled server message:', type);
    });
  }

  bindState() {
    const $ = this.$;
    const state = this.room.state;

    $(state).players.onAdd((player, sessionId) => {
      this.emit('playerAdd', { player, sessionId, isSelf: sessionId === this.room.sessionId });
      $(player).onChange(() => this.emit('playerChange', { player, sessionId }));
    });

    $(state).players.onRemove((player, sessionId) => {
      this.emit('playerRemove', { player, sessionId });
    });

    $(state).messages.onAdd((entry) => this.emit('chat', entry));

    $(state).leaderboard.onAdd(() => this.emit('leaderboard', [...state.leaderboard]));
    $(state).leaderboard.onRemove(() => this.emit('leaderboard', [...state.leaderboard]));

    // The bait shelf is shared, so it moves when anyone buys or lands a cast --
    // not only when this player does. Listened to rather than read on open, so
    // an open shop panel counts down while someone else is shopping.
    this.baitStock = state.baitStock ?? 0;
    $(state).listen('baitStock', (units) => {
      this.baitStock = units;
      this.emit('baitStock', units);
    });
  }

  /**
   * The connection watchdog.
   *
   * `onLeave` covers a socket that closes: the server evicting a duplicate tab,
   * a clean shutdown, a refused connection. What it does not cover is a socket
   * that stops working without ever closing -- the laptop lid comes down, a
   * proxy quietly drops an idle connection, the server goes away without a
   * chance to say goodbye. The browser goes on reporting that socket as open,
   * so the game sits there looking playable and answering nothing.
   *
   * That is the case a player meets after leaving the tab open, so it is the
   * one worth catching: ask the room periodically to say it is there, and treat
   * a long enough silence as the disconnect it is.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();

    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);

    this.onVisible = () => {
      if (!document.hidden) this.probe();
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.wakeProbeTimer);
    this.heartbeatTimer = null;
    this.wakeProbeTimer = null;

    if (this.onVisible) {
      document.removeEventListener('visibilitychange', this.onVisible);
      this.onVisible = null;
    }
  }

  beat() {
    if (!this.room) return;

    // A hidden tab has its timers throttled to a crawl, so a long gap between
    // beats here is the browser's doing and says nothing about the connection.
    // The verdict waits for the probe that runs when the tab comes back.
    if (!document.hidden && Date.now() - this.lastPongAt > HEARTBEAT_GRACE_MS) {
      this.declareLost();
      return;
    }
    this.send('ping');
  }

  /**
   * One question on waking, judged on its own answer rather than on how long
   * the tab was asleep -- which is the moment a dead connection is usually
   * found, and the moment a live one must not be thrown away.
   */
  probe() {
    if (!this.room) return;

    const sentAt = Date.now();
    this.send('ping');

    clearTimeout(this.wakeProbeTimer);
    this.wakeProbeTimer = setTimeout(() => {
      if (this.room && this.lastPongAt < sentAt) this.declareLost();
    }, WAKE_PROBE_MS);
  }

  /** Ends the session on this side, for a socket that never closed itself. */
  declareLost() {
    const room = this.room;
    if (!room || this.ended) return;

    console.warn('[net] no answer from the room; treating the session as lost');
    this.ended = true;
    this.stopHeartbeat();
    this.room = null;
    // Best effort, and its own onLeave is why `ended` is set first: the socket
    // is almost certainly already dead, and the reason this ran at all is that
    // nothing on it is getting through.
    room.leave(false).catch(() => {});

    this.emit('disconnected', { code: 'stale', stale: true, duplicate: false });
  }

  bindLifecycle() {
    this.room.onLeave((code) => {
      console.warn('[net] left room, code', code);
      this.stopHeartbeat();
      if (this.ended) return;
      this.ended = true;
      // 4001 is the server evicting an older tab holding the same guest session.
      this.emit('disconnected', { code, duplicate: code === 4001 });
    });

    this.room.onError((code, message) => {
      this.emit('serverError', { code: String(code), message: message || 'Connection error.' });
    });
  }

  /* ----------------------------------------------------------------- send */

  send(type, payload = {}) {
    if (!this.room) return;
    try {
      this.room.send(type, payload);
    } catch (error) {
      // A send during teardown must not break the game loop.
      console.warn(`Could not send "${type}":`, error.message);
    }
  }

  setStake(stake) { this.send('set_stake', { stake }); }
  setAuto(enabled) { this.send('set_auto', { enabled }); }
  cast() { this.send('cast'); }
  openChest(chestId) { this.send('open_chest', { chestId }); }
  appraiseGem(gemId) { this.send('appraise_gem', { gemId }); }
  /** Cashes in every fish of one species from the bag, for Fishing Power XP. */
  cashOutSpecies(speciesId) { this.send('cash_out_species', { speciesId }); }
  /** Cashes in the whole fish bag at once. */
  cashOutAllFish() { this.send('cash_out_all_fish'); }
  /** Rod upgrades are Gold-only; the server no longer reads a currency field. */
  upgradeRod() { this.send('upgrade_rod'); }
  useConsumable(id) { this.send('use_consumable', { id }); }
  buy(itemId, quantity = 1) { this.send('buy', { itemId, quantity }); }
  /** Credits USDG to the wallet. See `depositUsdg` in server/src/game/economy.js. */
  depositUsdg(amount) { this.send('deposit_usdg', { amount }); }

  /**
   * Asks the server to credit an on-chain USDC transfer. The hash is kept
   * until the server confirms, so a dropped tab or RPC hiccup is retried.
   */
  claimDeposit(txHash, senderId) {
    const accountId = this.me?.nearAccountId;
    writePendingDeposits({ ...readPendingDeposits(), [txHash]: { sentAt: Date.now(), accountId, senderId } });
    this.send('claim_deposit', { txHash, senderId });
  }

  /** Backs off through DEPOSIT_RETRY_DELAYS_MS, only while this room is live. */
  scheduleDepositRetry(txHash) {
    this.depositRetries ??= new Map();
    const attempt = this.depositRetries.get(txHash) ?? 0;
    const delay = DEPOSIT_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    this.depositRetries.set(txHash, attempt + 1);
    setTimeout(() => {
      const entry = readPendingDeposits()[txHash];
      if (!this.ended && this.room && entry) this.send('claim_deposit', { txHash, senderId: entry.senderId });
    }, delay);
  }

  retryPendingDeposits(accountId) {
    const now = Date.now();
    const pending = readPendingDeposits();
    for (const [txHash, entry] of Object.entries(pending)) {
      if (!(now - entry?.sentAt <= PENDING_DEPOSIT_TTL_MS)) delete pending[txHash];
      else if (entry.accountId === accountId) this.send('claim_deposit', { txHash, senderId: entry.senderId });
    }
    writePendingDeposits(pending);
  }
  /** Converts USDG into Gold at the locked GOLD_DOLLAR_RATE anchor. */
  buyGold(gold) { this.send('buy_gold', { gold }); }
  chat(text) { this.send('chat', { text }); }
  requestMe() { this.send('request_me'); }
  requestCatchLog() { this.send('request_catch_log'); }
  move(x, y, facing, moving) { this.send('move', { x, y, facing, moving }); }

  get sessionId() {
    return this.room?.sessionId ?? null;
  }

  get players() {
    return this.room?.state?.players ?? new Map();
  }

  get leaderboard() {
    return this.room?.state?.leaderboard ? [...this.room.state.leaderboard] : [];
  }

  get chatHistory() {
    return this.room?.state?.messages ? [...this.room.state.messages] : [];
  }

  async leave() {
    this.stopHeartbeat();
    await this.room?.leave(true).catch(() => {});
    this.room = null;
  }
}
