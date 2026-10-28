/**
 * The DOM heads-up display.
 *
 * Everything here is presentation. It reads the catalog the server sent (names,
 * prices, icons) and the private `me` snapshot, and turns clicks into intents.
 * No number shown to the player is computed here: if the HUD needs a value, the
 * server has already sent it.
 */

import {
  escapeHtml, formatDollars, formatDuration, formatNumber, formatOdds, formatTime,
} from './format.js';
import { isTyping, isTypingTarget } from './typing.js';
import { spriteIcon, applySprite, fitScale } from '../art/icons.js';

/**
 * Printed after every odds figure in the UI.
 *
 * It stands for the part of a rate this figure does not account for: active
 * tackle is not folded into the drop rates, and the tier a chest lands on is
 * biased by the rarity of the fish that dropped it, so a single roll deviates
 * from the quoted average in both directions.
 *
 * It is printed on the chest contents too, where nothing is in fact hidden --
 * a tier's reward table is fixed and those probabilities are exact -- because
 * the design asks for one consistent marker rather than two classes of number
 * the player has to learn to tell apart. This constant and `oddsFigure` below
 * are the only places it is rendered, so scoping it to the drop rates alone is
 * a one-line change.
 */
const ODDS_SUFFIX = '+ ???';

/** What the "+ ???" marker means, on hover. */
const ODDS_SUFFIX_HINT =
  'Base rate. Active tackle and the fish that drops the chest both move it.';

const RARITY_CLASS = {
  common: 'var(--rarity-common)',
  uncommon: 'var(--rarity-uncommon)',
  rare: 'var(--rarity-rare)',
  epic: 'var(--rarity-epic)',
  legendary: 'var(--rarity-legendary)',
};

const TOAST_MS = 3600;

/** How long a pickup banner (see `showPickup`) sits before it slides back out. */
const PICKUP_MS = 3200;

/** How many pickup banners stack at once before the oldest is dropped. */
const MAX_PICKUPS = 4;

/**
 * A stable colour per angler, so a leaderboard row's avatar disc reads the
 * same on every render without the server needing to hand out one -- the
 * name is already unique enough to hash.
 */
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 42%, 36%)`;
}

/** Where the "grade instantly" choice is kept between sessions. */
const QUICK_APPRAISE_KEY = 'fishing-idle.quickAppraise';

/** Whether the chat card was left minimized, so it opens the same way next time. */
const CHAT_MINIMIZED_KEY = 'fishing-idle.chatMinimized';

/** localStorage throws in private-mode Safari and when storage is disabled. */
function readSetting(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A preference that cannot be remembered is not worth failing a click over.
  }
}

/** Gap between one trait being graded and the appraiser starting the next. */
const GRADE_STEP_MS = 620;
/** How long a trait is read before its grade lands, matching the stylesheet. */
const GRADE_ROLL_MS = 460;

/**
 * Slots always drawn in the bag grid, so it reads as a container when empty.
 *
 * Five rows of the stylesheet's five columns. Two rows read as a strip of
 * leftovers rather than as the pack the player is filling, and every drop
 * pushed the grid into a scroll the moment a third stack appeared.
 */
const MIN_BAG_SLOTS = 25;

/**
 * Fish per bag slot, used until the server says otherwise (it sends the real
 * number as `fishStackSize`). Mirrors MAX_FISH_STACK in the server config.
 */
const FISH_STACK_SIZE = 999;

/** Shelf width, in slots. Mirrors the shop grid's column count in the stylesheet. */
const SHOP_COLUMNS = 5;

/**
 * The shelf is drawn out to this many rows however few items are on it.
 *
 * A counter with one thing on it is still a counter: empty shelving reads as a
 * shop that has room for more, where a single tile floating in a panel reads
 * as a layout that broke.
 */
const SHOP_MIN_ROWS = 2;

/**
 * How big shop artwork is drawn, as the side of the square it has to fit.
 *
 * Sheets do not share a frame size, so asking for a box rather than a scale is
 * what keeps a 14px worm of bait and a 45px fish reading as the same size on
 * the shelf. These mirror the boxes the stylesheet reserves for them.
 *
 * The two large boxes are 90 because `fitScale` snaps an enlargement down to a
 * whole multiple: 90 lands the 45px fish at a clean 2x, and the 14px bait
 * plate snaps to its own clean 6x (84px) inside the same box. The shelf
 * widened along with the dialog (see `.modal--wide .modal__card` in the
 * stylesheet) to give the bigger box room -- at the old 560px width the fish
 * only ever landed on a 1x, 52px box. The price box is below every plate's
 * own size, so it shrinks rather than snaps and can be any number that suits
 * the row.
 */
const SHOP_SLOT_ART = 90;
const SHOP_DETAIL_ART = 90;
const SHOP_AMOUNT_ART = 40;
const SHOP_PRICE_ART = 24;

/** The coin the Gold Wallet leads with, as the side of the square it fits. */
const GOLD_WALLET_ART = 56;

/** Coin art in the wallet's balance rows, and in its cashout route. */
const WALLET_ROW_ART = 22;
const WALLET_ROUTE_ART = 18;

/**
 * The chains a deposit could arrive over or a withdrawal leave by.
 *
 * A list on the client because there is nothing on the server to ask: no
 * payment backend exists yet. When one does, this comes from it.
 */
const WALLET_NETWORKS = ['Ethereum Mainnet', 'Solana'];

/** The most Gold one sell-back can quote for, mirroring the reference's cap. */
const WALLET_SELL_LIMIT = 10_000;

/**
 * How big a chest is drawn.
 *
 * The reveal stage asks for a box and lets `fitScale()` snap it, the way the
 * shop sizes its shelf: 192 lands on an exact 6x. The frame is mostly padding
 * -- the chest itself is an 18x16 drawing centred on 32x32 -- so 6x is what
 * puts the chest at roughly 108x96 on screen, big enough to hold the middle of
 * a full-screen stage rather than sit in the hole of the name ring.
 *
 * The bag is a half step instead, and set as a scale rather than a box because
 * `fitScale()` would snap 48 back down to 32. The supplied icons are an 18x16
 * chest centred on a 32x32 canvas, so most of the frame is padding and 1.5x
 * puts the chest itself at 27x24 inside a 46px slot. The cost of the half step
 * is that a source pixel covers two screen pixels in some rows and one in
 * others, on a display that is not drawing at 2x.
 */
const BAG_CHEST_SCALE = 1.5;

/**
 * Uncut gems are 24px on their sheet against the chest's 32, so they need
 * their own multiplier to land on the same 48px as a chest does. Drawn at one
 * size, the two read as items in the same bag; left at 1x the stones looked
 * like a different, smaller class of thing.
 */
const BAG_GEM_SCALE = 2;

/**
 * Fish are already the largest thing on any item sheet at 45x39, so drawing
 * them at native size already lands close to the 48px the other bag items are
 * sized to -- no multiplier needed the way chests and gems each need their own.
 */
const BAG_FISH_SCALE = 1;

/**
 * How far to nudge each fish species up inside its bag slot, in native (1x)
 * sprite pixels.
 *
 * `fish.png` (built by `tools/build_icons.py`) deliberately sits every fish
 * on the *bottom* of its 45x39 frame -- "a fish reads as an object standing
 * on a surface, not floating in one" -- which is the right call on a shelf
 * or a dock, but in the bag grid there is no surface, just a slot, so a
 * bottom-heavy fish reads as mis-centred against `.bagslot__art`'s own
 * centring. Fixing that in the shared sheet would also flatten the
 * standing-on-a-surface look everywhere else it's used (the shop shelf, the
 * cash-in list, the species log, chest rewards), so instead this shifts the
 * art up by half of *this frame's* empty headroom, bag-only, via the
 * `--art-offset-y` custom property `.bagslot__art` reads in the stylesheet.
 *
 * Measured directly off `fish.png`: each value is half the transparent gap
 * above that species' art in its frame (frame height 39 minus the art's own
 * height, halved). A species with no entry here (or added later) simply gets
 * no correction rather than a build error.
 */
const BAG_FISH_ART_OFFSET_Y = {
  muddy_carp: -6.5,
  speckled_trout: -8.5,
  whiskered_catfish: -5,
  golden_koi: -4.5,
  moonfish: -4,
  leviathan: -2.5,
};
const CHEST_STAGE_ART = 192;

/**
 * How big a reward is drawn in the strip of what a chest can hold.
 *
 * The strip has no frames around its items, so the box is the only thing
 * holding the row level: every sheet is asked for the same square and snaps to
 * its own whole multiple inside it -- a 24px gem at 2x, a 45px fish at 1x --
 * which lands them within a few pixels of each other instead of at their
 * native sizes, which differ by half again.
 */
const CHEST_CONTENTS_ART = 52;

/**
 * How big a reward is drawn on a card in the spinning reel.
 *
 * Fitted to a box rather than scaled, for the same reason the strip above is:
 * the sheets have different native sizes and a shared multiplier would leave a
 * gem card and a fish card visibly out of step as they went past. Sized to
 * leave the card's frame clear at the corners, where the notch and the slash
 * are drawn.
 */
const REEL_CARD_ART = 34;

/**
 * How big a chest tier's own art is drawn on its card in the Odds tab's
 * "Which chest" grid. `fitScale` snaps this to the chest sheet's native 32px
 * frame doubled -- bigger than the 48px (1.5x) the bag draws chest stacks at,
 * because a card here has nothing else competing for attention on it.
 */
const ODDS_CARD_ART = 64;

/**
 * How big a reward is drawn in the "What's Inside" sheet a chest card opens.
 * Sized like `CHEST_CONTENTS_ART` for the same reason -- a shared box is what
 * keeps a gem and a fish icon looking like they belong in the same list --
 * but a touch smaller, because this list also carries a name and a chance
 * on the same line rather than standing alone under the icon.
 */
const ODDS_ITEM_ART = 40;

/**
 * How long the winning card is left lit under the marker before the band goes,
 * and how long the band takes to go. Together they are the beat between "the
 * strip stopped here" and "here is what you won" -- the two used to be the
 * same frame. `REEL_CLOSE_MS` must match the `reel-close` animation.
 */
const REEL_HOLD_MS = 620;
const REEL_CLOSE_MS = 340;

/**
 * The notional frame a glyph icon is drawn on when a reward has no sprite.
 *
 * Only XP is in that position, and the sparkle it shows is the same drawing
 * the gems sheet carries as its `spark` frame -- so it takes that sheet's 24px
 * frame as its own, and a caller's `scale` then means the same thing whether
 * the reward turned out to have a plate sprite or not.
 *
 * `GLYPH_EM` is the height the icon rules give a glyph's box (`1.35em`), which
 * is what turns a wanted pixel size back into a font size.
 */
const GLYPH_ART_FRAME = 24;
const GLYPH_EM = 1.35;

/**
 * How long the tab has to have been in the background before a disconnect is
 * blamed on the player being away rather than on the network.
 *
 * A browser throttles a hidden tab's timers hard, which is what eventually
 * lets the socket go quiet enough to be closed. Under a minute is short enough
 * to be an ordinary blip; past it, "you were away" is the honest explanation.
 */
const AWAY_AFTER_MS = 90_000;

/**
 * How long after coming back a disconnect can still be attributed to the
 * absence. A dropped socket is usually only *noticed* when the tab wakes, so
 * the away stretch that caused it has already ended by the time this runs.
 */
const AWAY_GRACE_MS = 20_000;

export class Hud {
  constructor(net) {
    this.net = net;
    this.catalog = null;
    this.me = null;

    /** What the player asked for, independent of whether they are at the water. */
    this.autoFishingWanted = true;
    this.fishable = true;
    this.moving = false;

    this.cast = null;
    this.castRaf = null;

    /** The chest-opening sitting: which stack, how many opened, what they gave. */
    this.chest = null;
    this.chestTimer = null;

    /** The open shop counter: filters, selection and quantity. See openShop. */
    this.shop = null;

    /** The open appraisal panel, so the graded reply can find its rows. */
    this.appraisal = null;
    /** Skip the trait-by-trait reveal on the cheapest stones. Player's choice. */
    this.quickAppraise = readSetting(QUICK_APPRAISE_KEY) === '1';

    /** Backgrounded stretches, for telling an idle drop from a network one. */
    this.presence = {
      hiddenSince: document.hidden ? Date.now() : 0,
      lastAwayMs: 0,
      lastAwayEndedAt: 0,
    };
    this.logTab = 'rod';

    /** Dedupes chat, so hydrating from history cannot double-render a line. */
    this.seenChat = new Set();

    this.dom = this.collect();

    /** Messages that arrived while the card was minimized, for the rail dot. */
    this.chatUnread = false;
    /** True only while replaying chat backlog, which must not count as unread. */
    this.hydratingChat = false;

    // Phones begin with chat compact, preserving the harbor and fishing dock.
    // A stored choice wins over that default in both directions: a player who
    // minimized the card on desktop finds it minimized, and one who opened it
    // on a phone finds it open.
    const stored = readSetting(CHAT_MINIMIZED_KEY);
    const minimized = stored === null
      ? window.matchMedia('(max-width: 860px)').matches
      : stored === '1';
    this.setChatMinimized(minimized, { persist: false });
    this.bindStaticEvents();
    this.bindNetwork();
    this.hydrate();
  }

  /**
   * Renders whatever already arrived before this HUD existed.
   *
   * NetClient subscribes to room state during connect(), which is necessarily
   * before the HUD is constructed, so the first burst of onAdd callbacks for
   * chat history and the leaderboard can land with no listener attached.
   * Pulling current state once here closes that window.
   */
  hydrate() {
    if (this.net.catalog) {
      this.catalog = this.net.catalog;
      this.renderStakes();
      this.renderRiskDial();
    }
    if (this.net.me) {
      this.me = this.net.me;
      this.renderMe();
    }
    this.hydratingChat = true;
    for (const entry of this.net.chatHistory) this.appendChat(entry);
    this.hydratingChat = false;
    this.renderLeaderboard(this.net.leaderboard);
    this.renderPlayers();
  }

  collect() {
    const byId = (id) => document.getElementById(id);
    return {
      hud: byId('hud'),
      castLabel: byId('hud-cast-label'),
      castFill: byId('hud-cast-fill'),
      bait: byId('hud-bait'),
      gold: byId('hud-gold'),
      goldPill: byId('wallet-gold-pill'),
      usdg: byId('hud-usdg'),
      near: byId('hud-near'),
      nearAccount: byId('hud-near-account'),
      usdgPill: byId('wallet-usdg-pill'),
      btnDeposit: byId('btn-deposit'),
      pearls: byId('hud-pearls'),
      stakes: byId('hud-stakes'),
      stakeLabel: byId('hud-stake-label'),
      stakeHint: byId('hud-stake-hint'),
      stakeNote: byId('hud-stake-note'),
      riskDial: byId('hud-riskdial'),
      stakePanel: byId('panel-stake'),
      rodLevel: byId('hud-rod-level'),
      rodFill: byId('hud-rod-fill'),
      rodCta: byId('btn-rod-levelup'),
      players: byId('hud-players'),
      onlineCount: byId('hud-online-count'),
      chat: byId('hud-chat'),
      chatForm: byId('hud-chat-form'),
      chatInput: byId('hud-chat-input'),
      chatPanel: byId('panel-chat'),
      chatToggle: byId('btn-chat-toggle'),
      chatMin: byId('btn-chat-min'),
      toasts: byId('hud-toasts'),
      pickups: byId('hud-pickups'),
      status: byId('hud-status'),
      bag: byId('hud-bag'),
      bagCount: byId('hud-bag-count'),
      btnShop: byId('btn-shop'),
      btnLog: byId('btn-log'),
      btnCashIn: byId('btn-cashin'),
      btnAuto: byId('btn-auto'),
      btnLeaderboard: byId('btn-leaderboard'),
      modal: byId('modal'),
      // The dialog itself rather than the scrim around it: the shop's Custom
      // layer is a sheet over the card, so it has to be inside it.
      modalCard: byId('modal').querySelector('.modal__card'),
      modalTitle: byId('modal-title'),
      modalSubtitle: byId('modal-subtitle'),
      modalBody: byId('modal-body'),
      modalKeeper: byId('modal-keeper'),
      sides: [...document.querySelectorAll('.side')],
    };
  }

  show() {
    this.dom.hud.hidden = false;
  }

  /* -------------------------------------------------------------- events */

  bindStaticEvents() {
    const { dom } = this;

    dom.btnShop.addEventListener('click', () => this.openShop());
    dom.btnLog.addEventListener('click', () => this.openLog());
    dom.btnCashIn.addEventListener('click', () => this.openCashIn());
    dom.btnLeaderboard.addEventListener('click', () => this.openLeaderboard());

    // The pill is a <span role="button">, not a real <button> -- it has to
    // keep the wallet tray's exact chip styling, which a native button's own
    // UA chrome would fight. That means Enter/Space have to be wired by hand;
    // click alone would leave it a mouse-only control.
    dom.goldPill.addEventListener('click', () => this.openGoldWallet());
    dom.goldPill.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.openGoldWallet();
    });

    // The USDG chip is the same kind of span-as-button as the Gold one beside
    // it, and needs the same hand-wired keys. Deposit is a real button, so it
    // needs none of that -- it is only here because it belongs to the chip.
    dom.usdgPill.addEventListener('click', () => this.openWallet());
    dom.usdgPill.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.openWallet();
    });
    dom.btnDeposit.addEventListener('click', () => this.openWallet({ deposit: true }));

    dom.btnAuto.addEventListener('click', () => {
      // Only flips the intent. The scene owns the actual set_auto message,
      // because it is the thing that knows whether the angler is standing at
      // the water and standing still -- sending from here would let the button
      // switch fishing back on mid-stride.
      this.autoFishingWanted = !this.autoFishingWanted;
      this.renderAutoButton();
    });

    // A one-click skip, paid in Gold. The button itself is only shown once
    // the render loop confirms the price is actually affordable.
    dom.rodCta.addEventListener('click', () => {
      if (!this.me?.upgrade) return;
      this.net.upgradeRod();
    });

    dom.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = dom.chatInput.value.trim();
      dom.chatInput.value = '';
      // Sending hands the keyboard back to the harbor, so Enter-type-Enter
      // leaves the player walking again rather than silently still typing.
      dom.chatInput.blur();
      if (!text) return;
      this.net.chat(text);
    });

    dom.chatToggle.addEventListener('click', () => {
      // The compact card defaults to its readable message view. On a phone,
      // the first tap opens that view; subsequent taps reveal/hide the small
      // composer without sacrificing the postcard-like chat layout.
      if (dom.chatPanel.classList.contains('is-collapsed')) {
        this.setChatMinimized(false);
        return;
      }
      const composing = dom.chatPanel.classList.toggle('is-composing');
      dom.chatToggle.setAttribute('aria-expanded', String(composing));
    });

    // The minimize button owns one job only: the whole card down to its title
    // rail, and back. It is deliberately separate from the label above, which
    // is about the composer -- one control doing both was the confusion.
    dom.chatMin.addEventListener('click', () => {
      this.setChatMinimized(!dom.chatPanel.classList.contains('is-collapsed'));
    });

    dom.modal.addEventListener('click', (event) => {
      if (event.target.dataset.close) this.closeModal();
    });

    // Tracks how long the tab spends in the background. Nothing in the game
    // depends on it -- it exists only so a disconnect can say which of the two
    // things went wrong, being away or the connection itself.
    document.addEventListener('visibilitychange', () => {
      const now = Date.now();
      if (document.hidden) {
        this.presence.hiddenSince = now;
        return;
      }
      if (this.presence.hiddenSince) {
        this.presence.lastAwayMs = now - this.presence.hiddenSince;
        this.presence.lastAwayEndedAt = now;
        this.presence.hiddenSince = 0;
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeModal();
        // Escape is also the way out of the chat box, back to walking.
        if (document.activeElement === this.dom.chatInput) this.dom.chatInput.blur();
        return;
      }

      // Enter focuses chat from anywhere, the way every other game does it --
      // but only from the harbor. Fired while the player is already in a text
      // field (chat itself, or a shop quantity) it would steal the keystroke
      // that field was about to act on.
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      // Both sides of the question: what has focus now, and what the keystroke
      // was aimed at -- a handler that closes its panel on Enter moves focus
      // before this one runs.
      if (isTyping() || isTypingTarget(event.target)) return;
      // A focused button's Enter belongs to the button.
      if (document.activeElement?.tagName === 'BUTTON') return;

      event.preventDefault();
      // Typing is the strongest possible "I want the chat" -- it restores a
      // minimized card, but does not rewrite the stored preference, so the
      // card goes back to minimized on the next load.
      this.setChatMinimized(false, { persist: false });
      this.dom.chatPanel.classList.add('is-composing');
      this.dom.chatInput.focus();
    });

    // On phones the side panels are hidden by default; tapping the headers in
    // the top bar reveals them.
    this.dom.hud.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-toggle-side]');
      if (!trigger) return;
      const side = document.querySelector(trigger.dataset.toggleSide);
      side?.classList.toggle('is-open');
    });
  }

  bindNetwork() {
    const net = this.net;

    net.on('catalog', (catalog) => {
      this.catalog = catalog;
      this.renderStakes();
      this.renderRiskDial();
    });

    net.on('me', (me) => {
      this.me = me;
      this.renderMe();
      // The counter quotes the wallet, so a catch that pays out while the shop
      // is open has to move what the player can afford -- and the wallet screen
      // is a balance, which is the same story from the other side.
      this.refreshShop();
      this.refreshGoldWallet();
      this.refreshWallet();
    });

    net.on('castStarted', (payload) => this.startCastProgress(payload));
    net.on('castResult', (result) => this.onCastResult(result));

    // Walking away aborts the cast; the server refunds the bait it took.
    net.on('castCancelled', () => {
      this.stopCastProgress();
      this.renderCastIdleLabel();
    });

    net.on('chestOpened', (result) => this.showChestReveal(result));
    net.on('gemAppraised', (result) => this.showGemAppraisalResult(result));

    net.on('fishCashed', (result) => {
      this.toast(
        `+${formatNumber(result.xp)} Fishing Power from ${result.count} `
        + `${this.fishName(result.speciesId)}`,
        'good',
      );
      if (result.levelUp) this.toast(`Rod level ${result.levelUp.toLevel}!`, 'good');
      // The panel lists what is still in the bag, so a cash-in has to redraw
      // it the same way buying a rod level redraws an open journal.
      if (this.modalKind === 'cashin') this.openCashIn();
    });

    net.on('fishCashedAll', (result) => {
      this.toast(`+${formatNumber(result.xp)} Fishing Power from ${result.count} fish`, 'good');
      if (result.levelUp) this.toast(`Rod level ${result.levelUp.toLevel}!`, 'good');
      if (this.modalKind === 'cashin') this.openCashIn();
    });

    net.on('rodUpgraded', (result) => {
      this.toast(
        `Rod upgraded to Lv.${result.levelUp.toLevel} for ${formatNumber(result.spent)} `
        + this.rewardName('gold'),
        'good',
      );
      if (this.modalKind === 'log') this.openLog();
    });

    net.on('purchased', (result) => {
      const parts = Object.entries(result.granted)
        .map(([id, amount]) => `${formatNumber(amount)} ${this.rewardName(id)}`);
      this.toast(`Bought ${parts.join(', ')}`, 'good');
      this.refreshShop();
    });

    net.on('depositClaimed', ({ already }) => {
      if (already) this.toast('That deposit was already credited.', 'warn');
    });

    net.on('usdgDeposited', (result) => {
      this.toast(`Deposited ${this.formatUsdg(result.deposited)}`, 'good');
      if (this.wallet?.nodes.depositAmount) this.wallet.nodes.depositAmount.value = '';
    });

    net.on('goldBought', (result) => {
      this.toast(
        `Bought ${formatNumber(result.gold)} Gold for ${this.formatUsdg(result.spent)}`,
        'good',
      );
      if (this.goldBuy) {
        this.goldBuy.amount = 0;
        if (this.goldBuy.nodes.input) this.goldBuy.nodes.input.value = '0';
        this.refreshGoldWallet();
      }
    });

    net.on('consumableUsed', (result) => {
      this.toast(`${this.rewardName(result.consumableId)} active for ${result.castsRemaining} casts`, 'good');
    });

    net.on('serverError', (error) => this.onServerError(error));

    // Anyone's cast puts bait back on the shelf and anyone's purchase takes it
    // off, so an open shop counts along with the whole harbour.
    net.on('baitStock', () => this.refreshShop());

    net.on('chat', (entry) => this.appendChat(entry));
    net.on('leaderboard', (rows) => this.renderLeaderboard(rows));

    net.on('playerAdd', () => this.renderPlayers());
    net.on('playerRemove', () => this.renderPlayers());
    net.on('playerChange', () => this.renderPlayers());

    net.on('session', ({ persisted }) => {
      if (!persisted) {
        this.setStatus(
          'Storage is blocked, so this session will not survive a reload.',
          'warn',
          0,
        );
      }
    });

    net.on('disconnected', ({ duplicate }) => {
      this.stopCastProgress();
      this.showDisconnected({ duplicate });
    });
  }

  /* ------------------------------------------------------- catalog panels */

  renderStakes() {
    const { stakes } = this.dom;
    stakes.replaceChildren();

    for (const level of this.catalog.stakes) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      // Bare numbers, because the label beside them says what the number is.
      // "40" alongside "Stake" reads as forty bait a cast.
      chip.textContent = String(level.stake);
      chip.dataset.stake = String(level.stake);
      chip.setAttribute('aria-pressed', 'false');
      // Assume locked until `renderMe` gets a real rod level to check against
      // -- a brief false "locked" flash on a rung that turns out unlocked
      // reads better than a brief false "unlocked" flash on one that isn't.
      const locked = this.isStakeLocked(level);
      chip.classList.toggle('is-locked', locked);
      chip.disabled = locked;
      chip.setAttribute('aria-disabled', String(locked));
      // The whole trade-off for this rung, one hover away. The read-out below
      // the row says the same thing for whichever rung is currently chosen --
      // this is what lets a player compare a rung before committing to it.
      chip.title = this.stakeTooltip(level);
      chip.addEventListener('click', () => this.selectStake(level.stake));
      stakes.append(chip);
    }
  }

  /**
   * The Risk Dial: Steady / Balanced / Risky, built once from the catalog.
   *
   * A gauge, not a control. These three were a mode selector before Stake
   * absorbed the whole risk trade-off, and they are kept because they are
   * still the clearest one-glance answer to "how hard am I fishing right
   * now?" -- a bare number on a chip is not.
   *
   * Built as plain elements rather than buttons on purpose: there is nothing
   * to click, and a button that does nothing when pressed is worse than no
   * button. Which band is lit is set in `renderRiskBandState`, driven entirely
   * by the server's answer for the player's current Stake.
   */
  renderRiskDial() {
    const { riskDial } = this.dom;
    riskDial.replaceChildren();

    /** band id -> its card, so lighting one does not re-read the DOM. */
    this.riskBandCards = new Map();

    for (const band of this.catalog.riskBands ?? []) {
      const card = document.createElement('span');
      card.className = 'riskband';
      card.dataset.band = band.id;
      card.title = band.blurb;

      const name = document.createElement('span');
      name.className = 'riskband__name';
      name.textContent = band.name;

      card.append(name);
      this.riskBandCards.set(band.id, card);
      riskDial.append(card);
    }

    this.renderRiskBandState();
  }

  /**
   * Lights the band the current Stake falls in, and tells a screen reader the
   * same thing the lit card tells everyone else.
   *
   * The mapping is the server's (`band` on each Stake entry), never computed
   * here -- a client that decided for itself which band a stake belonged to
   * would be a second copy of a rule the server already owns.
   */
  renderRiskBandState() {
    const level = this.stakeLevel(this.me?.stake ?? this.catalog?.stakes?.[0]?.stake);
    const active = level?.band ?? null;

    for (const [id, card] of this.riskBandCards ?? []) {
      // aria-current rather than aria-pressed: this reports a state, it does
      // not offer a choice.
      if (id === active) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    }

    const name = (this.catalog?.riskBands ?? []).find((band) => band.id === active)?.name;
    if (name) this.dom.riskDial.setAttribute('aria-label', `Risk dial: ${name}`);
  }

  /** The catalog entry for a stake, or null if the ladder does not name it. */
  stakeLevel(stake) {
    return (this.catalog?.stakes ?? []).find((level) => level.stake === stake) ?? null;
  }

  /**
   * Chest tiers a stake can win, in the player's language.
   *
   * Read off the catalog's per-stake `chestTiers` rather than written out
   * here, so it cannot drift from what `allowedChestTiers` actually enforces.
   * "Common Chest" -> "Common": the word "chest" is already in the line.
   */
  stakeChestLine(level) {
    const names = new Map((this.catalog?.chestTiers ?? []).map((tier) => [tier.id, tier.name]));
    const tiers = (level?.chestTiers ?? [])
      .map((tier) => (names.get(tier) ?? tier).replace(/ Chest$/, ''));
    return tiers.length > 0 ? `${tiers.join(', ')} chests` : '';
  }

  /**
   * Name, trade-off and chest access for one rung of the ladder -- or, if the
   * player's rod hasn't reached it yet, what it takes to unlock instead. The
   * locked line replaces the trade-off rather than appending to it: a rung a
   * player cannot select yet doesn't need its odds sold to them, just what
   * stands between them and it.
   */
  stakeTooltip(level) {
    const rodLevel = this.me?.rodLevel ?? 1;
    if ((level.unlockLevel ?? 1) > rodLevel) {
      return [
        `Stake ${level.stake} — ${level.name}`,
        `Unlocks at Rod Level ${level.unlockLevel}`,
      ].join('\n');
    }
    return [
      `Stake ${level.stake} — ${level.name}`,
      level.blurb,
      this.stakeChestLine(level),
    ].filter(Boolean).join('\n');
  }

  /** Whether the player's current rod level has reached this Stake's unlock. */
  isStakeLocked(level) {
    return (level.unlockLevel ?? 1) > (this.me?.rodLevel ?? 1);
  }

  /**
   * The one line under the control, saying what Stake actually does.
   *
   * Assembled from the catalog's `stakeRules` rather than written out, because
   * what a Stake charges is a server decision: hard-coding "sets bait per
   * cast" here would keep saying so after someone turned that off.
   *
   * The second sentence is the important one, and it names the cost as well as
   * the prize. Stake used to be pure upside with a price tag -- a bigger
   * number that only ever bit more often -- and the UI said so. It is the
   * whole risk lever now: the same move that buys rarer fish and better chests
   * is the one that makes the rod bite less. A hint that only advertised the
   * upside would be describing the old game.
   */
  stakeHint() {
    const rules = this.catalog?.stakeRules ?? {};
    const cost = rules.scalesBaitCost
      ? 'Stake sets bait per cast'
      : 'Stake sets the odds';

    return `Rod sets cast speed. ${cost}, and is the whole risk: raise it and `
      + 'you hook rarer fish, richer chests and tiers a low stake cannot reach '
      + '— and you bite less often to pay for it.';
  }

  /**
   * The live read-out under the stake row: what the chosen rung is called,
   * what it trades, and what it can win.
   *
   * Visible rather than hover text on purpose. The row it replaced was three
   * Dial cards whose names carried the risk framing ("Steady" / "Risky"); a
   * bare row of numbers carries none of that on its own, so the trade-off has
   * to be stated somewhere the player is already looking.
   */
  renderStakeNote() {
    const level = this.stakeLevel(this.me?.stake ?? this.catalog?.stakes?.[0]?.stake);
    if (!level) return;

    const chests = this.stakeChestLine(level);
    this.dom.stakeNote.textContent = [level.name, level.blurb, chests]
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * Large stakes spend bait quickly; make the first deliberate jump explicit.
   *
   * The confirm names what the jump gives up as well as what it costs. That is
   * new, and it is the point of the merge: the top two rungs drop Common (and
   * then Rare) chests entirely, so climbing the ladder is not only a bigger
   * bill, it narrows what a cast can win. A player who only saw the bait
   * figure would be agreeing to half of the trade.
   */
  selectStake(stake) {
    const level = this.stakeLevel(stake);
    if (level && this.isStakeLocked(level)) return;

    const current = this.me?.stake ?? 1;
    if (stake < 20 || stake <= current) {
      this.net.setStake(stake);
      return;
    }

    // The server sets the real per-cast cost; scale the one it last quoted
    // rather than assuming stake and bait stay one-for-one.
    const bait = stake * (this.me?.baitPerCast ?? 1) / Math.max(current, 1);
    const chests = this.stakeChestLine(level);

    const okay = window.confirm(
      `Set stake to ${stake}x? This will spend about ${formatNumber(bait)} bait per cast, `
      + 'and bite less often.'
      + (chests ? `\nYou will only win ${chests} at this stake.` : ''),
    );
    if (okay) this.net.setStake(stake);
  }

  /* ------------------------------------------------------------ me panel */

  renderMe() {
    const { dom, me } = this;
    if (!me) return;

    dom.bait.textContent = formatNumber(me.bait);
    dom.gold.textContent = formatNumber(me.gold);
    dom.pearls.textContent = formatNumber(me.pearls);
    dom.usdg.textContent = this.formatUsdg(me.usdg ?? 0);

    const account = me.nearAccountId;
    dom.near.hidden = !account;
    if (account) {
      // Implicit accounts are 64 hex chars; keep the chip readable.
      dom.nearAccount.textContent = account.length > 24 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account;
      dom.nearAccount.title = `Signed in with NEAR as ${account}`;
    }

    for (const chip of dom.stakes.children) {
      const stake = Number(chip.dataset.stake);
      chip.setAttribute('aria-pressed', String(stake === me.stake));

      const level = this.stakeLevel(stake);
      const locked = level ? this.isStakeLocked(level) : false;
      chip.classList.toggle('is-locked', locked);
      chip.disabled = locked;
      chip.setAttribute('aria-disabled', String(locked));
      if (level) chip.title = this.stakeTooltip(level);
    }

    // The bait cost is the stake itself at the contracted rate, but it is the
    // server that decides -- so the tooltip states what the server actually
    // charges rather than assuming the two stay equal. Kept off the label
    // itself now: "Stake" is all the row has room to say out loud, and the
    // figure is one hover away.
    dom.stakeLabel.textContent = 'Stake';
    dom.stakeLabel.title = `${formatNumber(me.baitPerCast)} bait per cast`;
    dom.stakeHint.textContent = this.stakeHint();
    dom.stakePanel.title = this.stakeHint();
    this.renderRiskBandState();
    this.renderStakeNote();
    this.renderRodPanel();

    this.renderBag();

    // The server is the source of truth for whether the loop is running.
    this.autoFishingWanted = me.autoFishing || this.autoFishingWanted;
    this.renderAutoButton();
    this.renderCastIdleLabel();
  }

  /**
   * The bottom-centre rod badge: level, progress toward the next one, and a
   * one-click "Level Up!" that only appears once a skip is actually
   * affordable -- it is the fast path, not a second place to browse prices
   * (that is still the Log's Rod tab, via `upgradePanel`).
   */
  renderRodPanel() {
    const { dom, me } = this;

    dom.rodLevel.textContent = `Lv.${me.rodLevel}`;

    const ratio = me.xpToNext === null ? 1 : Math.min(1, me.xp / me.xpToNext);
    dom.rodFill.style.width = `${ratio * 100}%`;

    const upgrade = me.upgrade;
    const affordable = !!upgrade && (me.gold ?? 0) >= upgrade.gold;

    dom.rodCta.hidden = !affordable;
    if (upgrade) {
      dom.rodCta.title = `Skip to Lv.${upgrade.toLevel} for ${formatNumber(upgrade.gold)} gold`;
    }
  }

  renderAutoButton() {
    const on = this.autoFishingWanted;
    this.dom.btnAuto.setAttribute('aria-pressed', String(on));
    this.dom.btnAuto.title = on ? 'Auto-fishing on' : 'Auto-fishing off';
    this.dom.btnAuto.classList.toggle('iconbtn--active', on);
  }

  /* ------------------------------------------------------------ bag grid */

  /**
   * The bag is a live grid in the corner rather than a dialog: chests are the
   * thing a player wants to click the moment one drops, and burying them behind
   * a modal put two clicks between the reward and the reveal.
   *
   * Identical items share a slot and show a count. Caught fish come first --
   * they are what a player is actually fishing for -- then chests ordered by
   * tier, then gems, then consumables, then empty slots to keep the container
   * shape.
   */
  renderBag() {
    const { bag, bagCount } = this.dom;
    const me = this.me;
    if (!me) return;

    // Split by stack size here but not in the cash-in panel: the bag is a
    // grid of slots, so a species past one stack takes another slot, while
    // cashing in settles a whole species at once and wants one row for it.
    const fishStacks = this.fishStacks(me.fish ?? [], me.fishStackSize ?? FISH_STACK_SIZE);
    const chestStacks = this.chestStacks(me.chests);
    const gemStacks = this.gemStacks(me.uncutGems ?? []);
    const consumables = Object.entries(me.inventory).filter(([, count]) => count > 0);

    // The header counts items, not slots -- "(9)" for nine chests in three
    // stacks is the number a player cares about.
    const items = (me.fish?.length ?? 0)
      + me.chests.length
      + (me.uncutGems?.length ?? 0)
      + consumables.reduce((total, [, count]) => total + count, 0);
    const filled = fishStacks.length + chestStacks.length + gemStacks.length + consumables.length;

    bagCount.textContent = items > 0 ? `(${items})` : '';
    bag.replaceChildren();

    for (const stack of fishStacks) {
      bag.append(this.fishSlot(stack));
    }
    for (const stack of chestStacks) {
      bag.append(this.chestSlot(stack));
    }
    for (const stack of gemStacks) {
      bag.append(this.gemSlot(stack));
    }
    for (const [id, count] of consumables) {
      bag.append(this.consumableSlot(id, count));
    }
    for (let i = filled; i < MIN_BAG_SLOTS; i += 1) {
      const empty = document.createElement('div');
      empty.className = 'bagslot bagslot--empty';
      empty.setAttribute('role', 'listitem');
      bag.append(empty);
    }
  }

  /**
   * Groups caught fish by species, in the catalog's own species order
   * (rarest last, mirroring the catch log and species panel).
   *
   * Unlike a chest or a gem, two fish of the same species can be worth
   * different XP -- the amount is frozen per-fish at catch time, off whatever
   * stake was active then -- so the stack's total is the actual sum
   * of what its fish are worth, not a per-fish amount times a count.
   *
   * `stackSize` splits a species that has outgrown one stack across as many
   * as it needs, oldest fish first; left out, a species is one stack however
   * many of it are held.
   */
  fishStacks(fish, stackSize = Infinity) {
    const order = (this.catalog?.fish ?? []).map((entry) => entry.id);
    const bySpecies = new Map();

    for (const item of fish) {
      if (!bySpecies.has(item.speciesId)) bySpecies.set(item.speciesId, []);
      bySpecies.get(item.speciesId).push(item);
    }

    return [...bySpecies.values()]
      .sort((a, b) => order.indexOf(a[0].speciesId) - order.indexOf(b[0].speciesId))
      .flatMap((group) => {
        const stacks = [];
        for (let start = 0; start < group.length; start += stackSize) {
          const items = group.slice(start, start + stackSize);
          stacks.push({
            speciesId: items[0].speciesId,
            tier: items[0].tier,
            name: items[0].name,
            color: items[0].color,
            ids: items.map((item) => item.id),
            totalXp: items.reduce((sum, item) => sum + item.xp, 0),
          });
        }
        return stacks;
      });
  }

  fishSlot(stack) {
    const count = stack.ids.length;

    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'bagslot';
    slot.setAttribute('role', 'listitem');
    slot.title = count > 1
      ? `${stack.name} x${count} -- click to cash in for Fishing Power`
      : `${stack.name} -- click to cash in for Fishing Power`;

    // Tier reads as the slot's own frame colour, same as a chest or a gem.
    slot.classList.add('bagslot--tiered');
    slot.style.setProperty('--tier-color', RARITY_CLASS[stack.tier] ?? stack.color);

    const art = spriteIcon('fish', stack.speciesId, BAG_FISH_SCALE)
      ?? document.createElement('span');
    art.classList.add('bagslot__art');

    // Counteracts fish.png's baked-in bottom alignment so the icon reads as
    // centred in the slot instead of standing on an invisible floor -- see
    // BAG_FISH_ART_OFFSET_Y.
    const offsetY = BAG_FISH_ART_OFFSET_Y[stack.speciesId];
    if (offsetY !== undefined) art.style.setProperty('--art-offset-y', `${offsetY}px`);

    slot.append(art);
    if (count > 1) slot.append(this.countBadge(count));

    slot.addEventListener('click', () => this.openCashIn(stack.speciesId));
    return slot;
  }

  /**
   * Groups unopened chests by tier, in the catalog's own tier order.
   *
   * The order matters: a chest carries a server-generated id and the grid is
   * rebuilt on every `me`, so sorting by anything that shifts as chests are
   * opened would move a stack out from under the cursor mid-click. Tier order
   * is fixed, so a stack only ever disappears when its last chest is opened.
   */
  chestStacks(chests) {
    const order = (this.catalog?.chestTiers ?? []).map((tier) => tier.id);
    const byTier = new Map();

    for (const chest of chests) {
      if (!byTier.has(chest.tier)) byTier.set(chest.tier, []);
      byTier.get(chest.tier).push(chest);
    }

    return [...byTier.values()]
      .sort((a, b) => order.indexOf(a[0].tier) - order.indexOf(b[0].tier))
      .map((group) => ({
        tier: group[0].tier,
        name: group[0].name,
        color: group[0].color,
        // Oldest first, so repeated clicks work through the stack in the order
        // the chests were won.
        ids: group.map((chest) => chest.id),
      }));
  }

  /** Same grouping rule as chests, keyed on the catalog's gem tier order. */
  gemStacks(uncutGems) {
    const order = (this.catalog?.gemTiers ?? []).map((tier) => tier.id);
    const byTier = new Map();

    for (const gem of uncutGems) {
      if (!byTier.has(gem.tier)) byTier.set(gem.tier, []);
      byTier.get(gem.tier).push(gem);
    }

    return [...byTier.values()]
      .sort((a, b) => order.indexOf(a[0].tier) - order.indexOf(b[0].tier))
      .map((group) => ({
        tier: group[0].tier,
        name: group[0].name,
        color: group[0].color,
        ids: group.map((gem) => gem.id),
      }));
  }

  gemSlot(stack) {
    const count = stack.ids.length;

    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'bagslot';
    slot.setAttribute('role', 'listitem');
    slot.title = count > 1
      ? `${stack.name} x${count} -- click to have one appraised`
      : `${stack.name} -- click to have it appraised`;

    // Tier reads as the slot's own frame colour rather than a bar under the
    // art -- set as a custom property so the CSS controls where it actually
    // applies (see `.bagslot--tiered`).
    slot.classList.add('bagslot--tiered');
    slot.style.setProperty('--tier-color', stack.color);

    const art = spriteIcon('gems', stack.tier, BAG_GEM_SCALE) ?? document.createElement('span');
    art.classList.add('bagslot__art');

    slot.append(art);
    if (count > 1) slot.append(this.countBadge(count));

    slot.addEventListener('click', () => this.showGemAppraisal(stack));
    return slot;
  }

  chestSlot(stack) {
    const count = stack.ids.length;

    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'bagslot';
    slot.setAttribute('role', 'listitem');
    slot.title = count > 1
      ? `${stack.name} x${count} -- click to open`
      : `${stack.name} -- click to open`;

    // Tier reads as the slot's own frame colour rather than a bar under the
    // art -- set as a custom property so the CSS controls where it actually
    // applies (see `.bagslot--tiered`).
    slot.classList.add('bagslot--tiered');
    slot.style.setProperty('--tier-color', stack.color);

    // Each tier has its own chest sprite, so the coloured frame is
    // confirmation rather than the only thing telling the four apart.
    const art = spriteIcon('chests', stack.tier, BAG_CHEST_SCALE)
      ?? document.createElement('span');
    art.classList.add('bagslot__art');

    slot.append(art);
    if (count > 1) slot.append(this.countBadge(count));

    slot.addEventListener('click', () => this.showChestPreview(stack));
    return slot;
  }

  consumableSlot(id, count) {
    const meta = this.catalog?.rewardTypes.find((reward) => reward.id === id);

    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'bagslot';
    slot.setAttribute('role', 'listitem');
    slot.title = count > 1
      ? `${meta?.name ?? id} x${count} -- click to use one`
      : `${meta?.name ?? id} -- click to use`;

    const art = document.createElement('span');
    art.className = 'bagslot__art';
    art.textContent = this.glyphFor(meta?.icon);

    slot.append(art);
    if (count > 1) slot.append(this.countBadge(count));

    slot.addEventListener('click', () => this.net.useConsumable(id));
    return slot;
  }

  /** Stack size, shown only when there is more than one to count. */
  countBadge(count) {
    const badge = document.createElement('span');
    badge.className = 'bagslot__count';
    badge.textContent = String(count);
    return badge;
  }

  /** Maps a catalog icon name to the glyph that stands in for its sprite. */
  glyphFor(icon) {
    return {
      bait: '\u{1F41B}',
      coin: '\u{1F7E1}',
      gem: '\u{1F48E}',
      xp: '\u2B50',
      fish: '\u{1F41F}',
      charm: '\u{1F9ED}',
      lure: '\u{1F3A3}',
    }[icon] ?? '\u{1F48E}';
  }

  renderCastIdleLabel() {
    if (this.cast) return;
    if (!this.me) return;

    if (this.moving) {
      this.dom.castLabel.textContent = 'Walking';
      return;
    }
    if (!this.fishable) {
      this.dom.castLabel.textContent = 'No spot picked';
      return;
    }
    if (this.me.bait < this.me.baitPerCast) {
      this.dom.castLabel.textContent = 'Out of bait';
      return;
    }
    if (this.me.fishBagFull ?? ((this.me.fish?.length ?? 0) >= (this.me.maxFish ?? Infinity))) {
      this.dom.castLabel.textContent = 'Bag full';
      return;
    }
    this.dom.castLabel.textContent = this.autoFishingWanted ? 'Waiting' : 'Paused';
  }

  /* ------------------------------------------------------ cast progress */

  startCastProgress({ durationMs, endsAt }) {
    this.cast = { durationMs, endsAt };
    this.dom.castLabel.textContent = 'Casting...';

    const tick = () => {
      if (!this.cast) return;
      const remaining = this.cast.endsAt - Date.now();
      const ratio = 1 - Math.min(1, Math.max(0, remaining / this.cast.durationMs));
      this.dom.castFill.style.width = `${ratio * 100}%`;

      if (ratio >= 1) {
        this.dom.castLabel.textContent = 'Reeling...';
      }
      this.castRaf = requestAnimationFrame(tick);
    };

    cancelAnimationFrame(this.castRaf);
    this.castRaf = requestAnimationFrame(tick);
  }

  stopCastProgress() {
    cancelAnimationFrame(this.castRaf);
    this.cast = null;
    this.dom.castFill.style.width = '0%';
  }

  onCastResult(result) {
    this.stopCastProgress();

    if (result.success) {
      this.dom.castLabel.textContent = result.species.name;
      // A catch no longer pays out on its own -- it waits in the bag until
      // cashed in (see openCashIn), so this pickup banner is the one notice
      // that a fish was landed at all.
      this.showPickup({
        sheet: 'fish',
        spriteId: result.species.id,
        scale: BAG_FISH_SCALE,
        tierColor: RARITY_CLASS[result.species.tier] ?? result.species.color,
        name: result.species.name,
        sub: `+${formatNumber(result.xp)} Fishing Power when cashed in`,
      });
    } else {
      this.dom.castLabel.textContent = 'Nothing bit';
    }

    if (result.chest) {
      this.showPickup({
        sheet: 'chests',
        spriteId: result.chest.tier,
        scale: BAG_CHEST_SCALE,
        tierColor: RARITY_CLASS[result.chest.tier] ?? result.chest.color,
        name: result.chest.name,
        sub: 'Open it in your Bag',
      });
    }
  }

  /* ----------------------------------------------------------- fishable */

  /**
   * Called by the scene when the angler takes up, or leaves, a fishing spot.
   *
   * The name is now a slight lie -- standing at the water is no longer enough,
   * the player has to have clicked one of the marked pools -- but the flag
   * means the same thing to everything downstream: whether a cast can start.
   */
  setFishable(canFish) {
    this.fishable = canFish;

    if (!canFish) {
      this.setStatus('Click one of the dark pools in the water to fish there', 'warn', 0);
    } else {
      this.clearStatus();
    }
    this.renderCastIdleLabel();
  }

  /**
   * Called by the scene every frame. You cannot fish while walking, so the cast
   * label has to say so rather than sitting on a stale "Waiting".
   */
  setMoving(moving) {
    if (moving === this.moving) return;
    this.moving = moving;
    if (moving) this.stopCastProgress();
    this.renderCastIdleLabel();
  }

  /* --------------------------------------------------------------- shop */

  /**
   * The chandlery.
   *
   * A shelf of goods above the counter and one item under discussion at the
   * foot of it: pick a slot, pick a quantity, accept. It is a counter rather
   * than a column of buy buttons because bait is finite -- what a slot has to
   * show first is how much of it the harbour has left, and that number moves
   * while the panel is open as other anglers buy and fish.
   *
   * Everything volatile (stock, wallet, what is affordable) is refreshed in
   * place by `refreshShop`, so a shelf ticking down never scrolls the grid
   * back to the top.
   */
  openShop() {
    this.modalKind = 'shop';
    this.setModalChrome({ title: 'Harbour Provisions', wide: true, keeper: true });

    // Quantity survives a reopen. The selected item does not survive a
    // catalog that no longer lists it -- see renderShopSlots.
    const previous = this.shop;
    this.shop = {
      itemId: previous?.itemId ?? null,
      /** What the counter is currently drawing, so a tick need not redraw it. */
      shownItemId: null,
      quantity: previous?.quantity ?? 1,
      /**
       * An amount typed into the Custom dialog that is not one of the preset
       * steps. It rides in the row as a step of its own, so the quantity the
       * counter is holding is always one of the buttons on screen.
       */
      customQuantity: previous?.customQuantity ?? null,
      steps: [],
      /**
       * Whether the counter's primary is offering a top-up rather than a
       * sale. See refreshShopAccept.
       */
      needsGold: false,
      /** The Custom dialog, while it is open. See openShopAmount. */
      amount: null,
      slots: new Map(),
      nodes: {},
    };

    const panel = document.createElement('div');
    panel.className = 'shop';
    panel.append(this.shopBar(), this.shopGrid(), this.shopDetail());

    // The shelf does the scrolling here, not the dialog: the counter at the
    // foot has to stay put, and two nested scrollbars is one too many.
    this.dom.modalBody.classList.add('modal__body--shop');
    this.dom.modalBody.append(panel);
    this.dom.modal.hidden = false;

    this.renderShopSlots();
    this.refreshShop();
  }

  /**
   * What the player has brought to spend.
   *
   * Used to lead with a search box and, before that, two selects filtering by
   * item type and by whether an item was for sale. The shelf held four Bait
   * packs then; it holds one flat-rate Bait item now (see economy.config.js),
   * so a control for narrowing the shelf down has nothing left to narrow --
   * same reasoning that already dropped the two selects. The wallet is the
   * one thing here worth keeping: it is the counter's own currency, read
   * against the item's price on the detail row below.
   */
  shopBar() {
    const bar = document.createElement('div');
    bar.className = 'shop__bar';

    const wallet = document.createElement('div');
    wallet.className = 'shop__wallet';
    wallet.title = 'Gold Coin you are carrying';
    const walletAmount = document.createElement('b');
    wallet.append(walletAmount, this.currencyIcon('gold'));

    this.shop.nodes.wallet = walletAmount;
    bar.append(wallet);
    return bar;
  }

  shopGrid() {
    const grid = document.createElement('div');
    grid.className = 'shop__grid';
    grid.setAttribute('role', 'list');
    this.shop.nodes.grid = grid;
    return grid;
  }

  /**
   * Rebuilds the shelf. There is no filter left to change it any more (see
   * `shopBar`), so in practice this only ever runs once per `openShop` --
   * stock ticks go through `refreshShop` instead, which writes the new
   * numbers into the slots this built.
   */
  renderShopSlots() {
    const { grid } = this.shop.nodes;
    const items = this.catalog?.shop ?? [];

    this.shop.slots.clear();
    grid.replaceChildren();

    if (items.length === 0) {
      grid.append(this.empty('Nothing on the shelf right now.'));
      return;
    }

    for (const item of items) this.shop.slots.set(item.id, this.shopSlot(item, grid));

    // Empty shelving out to a full shelf, so a short list still reads as a
    // shop counter rather than three buttons floating in a panel.
    const rows = Math.max(SHOP_MIN_ROWS, Math.ceil(items.length / SHOP_COLUMNS));
    const filler = (rows * SHOP_COLUMNS) - items.length;
    for (let i = 0; i < filler; i += 1) {
      const blank = document.createElement('div');
      blank.className = 'shopslot shopslot--empty';
      grid.append(blank);
    }

    // A selection the filters just hid would leave the counter talking about
    // something the player can no longer see.
    if (!this.shop.slots.has(this.shop.itemId)) {
      this.shop.itemId = (items.find((item) => item.purchasable !== false) ?? items[0]).id;
    }
  }

  shopSlot(item, grid) {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'shopslot';
    slot.setAttribute('role', 'listitem');

    const stock = document.createElement('span');
    stock.className = 'shopslot__stock';

    // What one purchase actually hands over, opposite the stock count. A shelf
    // that sells bait a hundred at a time has to say so on the tile itself, or
    // the price along the bottom reads as the price of a single bait.
    const perPack = item.grants?.bait ?? 0;
    const bundle = document.createElement('span');
    bundle.className = 'shopslot__bundle';
    bundle.textContent = `x${formatNumber(perPack)}`;
    bundle.hidden = perPack <= 1;

    const art = this.shopArt(item, SHOP_SLOT_ART);
    art.classList.add('shopslot__art');

    const price = document.createElement('span');
    price.className = 'shopslot__price';
    const amount = document.createElement('b');
    amount.textContent = formatNumber(item.cost.amount);
    price.append(this.currencyIcon(item.cost.currency), amount);

    slot.append(stock, bundle, art, price);
    slot.addEventListener('click', () => {
      this.shop.itemId = item.id;
      this.refreshShop();
    });

    grid.append(slot);
    return { slot, stock };
  }

  /**
   * The item's sprite drawn to fit a `box`-pixel square, or the flat icon glyph
   * for one with no artwork -- sized to the same box so a shelf of the two
   * mixed together still lines up.
   */
  shopArt(item, box) {
    const sprite = item.sprite
      && spriteIcon(item.sprite.sheet, item.sprite.id, fitScale(item.sprite.sheet, box));
    if (sprite) return sprite;

    const fallback = document.createElement('i');
    fallback.className = `icon icon--${item.icon}`;
    fallback.style.fontSize = `${Math.round(box * 0.72)}px`;
    return fallback;
  }

  /**
   * A `LABEL value` chip for the counter's meta row.
   *
   * The label is set in small caps beside its number rather than run into it
   * as prose, so the row scans as a spec sheet: the eye finds "stock" once and
   * then only reads the numbers on repeat visits.
   */
  shopChip(label, value, extraClass = '') {
    const chip = document.createElement('span');
    chip.className = extraClass ? `shop__chip ${extraClass}` : 'shop__chip';

    const key = document.createElement('i');
    key.className = 'shop__chipkey';
    key.textContent = label;

    const amount = document.createElement('b');
    amount.className = 'shop__chipval';
    amount.textContent = value;

    chip.append(key, amount);
    return chip;
  }

  /** A currency's own sprite where there is one, its flat icon where there is not. */
  currencyIcon(currency, box = SHOP_PRICE_ART) {
    // Bait, gold and pearl each have their own dedicated sheet. The frame id
    // is always the currency name.
    const sheets = { bait: 'bait', gold: 'gold', pearls: 'pearl' };
    const sheet = sheets[currency];
    const sprite = spriteIcon(sheet, currency, fitScale(sheet, box));
    if (sprite) {
      sprite.classList.add('shop__coin');
      return sprite;
    }

    const fallbackGlyphs = { gold: 'coin', pearls: 'pearl' };
    const fallback = document.createElement('i');
    fallback.className = `icon icon--${fallbackGlyphs[currency] ?? 'gem'}`;
    return fallback;
  }

  /** The counter: what is selected, how many, and the two buttons that settle it. */
  shopDetail() {
    const detail = document.createElement('div');
    detail.className = 'shop__detail';

    const head = document.createElement('div');
    head.className = 'shop__detailhead';

    const art = document.createElement('span');
    art.className = 'shop__detailart';

    const text = document.createElement('div');
    text.className = 'shop__detailtext';
    const name = document.createElement('div');
    name.className = 'shop__detailname';
    const desc = document.createElement('div');
    desc.className = 'shop__detaildesc';
    const meta = document.createElement('div');
    meta.className = 'shop__meta';
    text.append(name, desc, meta);
    head.append(art, text);

    const actions = document.createElement('div');
    actions.className = 'shop__actions';

    const quantities = this.shopQuantities();

    const confirm = document.createElement('div');
    confirm.className = 'shop__confirm';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn shop__cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.closeModal());

    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'btn shop__accept';
    accept.textContent = 'Accept';
    accept.addEventListener('click', () => this.acceptPurchase());

    confirm.append(cancel, accept);
    actions.append(quantities, confirm);
    detail.append(head, actions);

    Object.assign(this.shop.nodes, { art, name, desc, meta, accept });
    return detail;
  }

  /**
   * The quantity row, built once.
   *
   * Every step the catalog offers is drawn whatever the wallet holds, and a
   * refresh only re-disables them -- rebuilding the row on each `me` would pull
   * a button out from under a player's cursor twice a cast.
   */
  shopQuantities() {
    const row = document.createElement('div');
    row.className = 'shop__qty';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Quantity');

    this.shop.steps = [];

    for (const step of this.catalog?.purchaseQuantities ?? [1]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'shop__step';
      button.textContent = `x${formatNumber(step)}`;
      button.addEventListener('click', () => {
        this.shop.quantity = step;
        // Picking a preset puts the Custom button back: the typed amount is
        // no longer what the counter is holding, so it stops being a step.
        this.shop.customQuantity = null;
        this.refreshShopDetail();
      });
      row.append(button);
      this.shop.steps.push({ button, step });
    }

    // Last in the row, and the only one that opens something: everything
    // else here sets a quantity outright.
    const custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'shop__step shop__step--custom';
    custom.textContent = 'Custom';
    custom.addEventListener('click', () => this.openShopAmount());
    row.append(custom);

    this.shop.nodes.customButton = custom;
    return row;
  }

  /**
   * Repaints everything that moves: the shelf counts, the wallet, which
   * quantities are still within reach, and the counter's summary. Safe to call
   * on every `me` and every stock tick -- it writes into the nodes the panel
   * already built rather than replacing them.
   */
  refreshShop() {
    if (this.modalKind !== 'shop' || !this.shop) return;
    const { nodes } = this.shop;

    nodes.wallet.textContent = formatNumber(this.me?.gold ?? 0);

    for (const [itemId, refs] of this.shop.slots) {
      const item = this.shopItem(itemId);
      const locked = item.purchasable === false;
      const available = this.stockFor(item);
      // The count on the tile is the shelf itself, not how many purchases it
      // covers -- that division is what the bundle badge beside it explains.
      const units = this.shelfUnits(item);

      refs.stock.textContent = locked || units === null ? '--' : formatNumber(units);
      refs.slot.classList.toggle('is-locked', locked);
      refs.slot.classList.toggle('is-out', !locked && available === 0);
      refs.slot.classList.toggle('is-selected', itemId === this.shop.itemId);
      refs.slot.setAttribute('aria-pressed', String(itemId === this.shop.itemId));
      refs.slot.title = locked
        ? `${item.name} -- ${item.lockedReason ?? 'not for sale yet'}`
        : `${item.name} -- ${formatNumber(units ?? available)} in stock`;
    }

    this.refreshShopDetail();
  }

  refreshShopDetail() {
    const { nodes } = this.shop;
    const item = this.shopItem(this.shop.itemId);

    if (!item) {
      this.shop.shownItemId = null;
      nodes.art.replaceChildren();
      nodes.name.textContent = 'Nothing selected';
      nodes.desc.textContent = 'Pick something off the shelf.';
      nodes.meta.replaceChildren();
      this.syncShopQuantities(null, 0);
      this.shop.needsGold = false;
      nodes.accept.classList.remove('shop__accept--gold');
      nodes.accept.disabled = true;
      nodes.accept.textContent = 'Accept';
      return;
    }

    const locked = item.purchasable === false;
    // What the shelf has, what the wallet covers and what one message may ask
    // for are three different limits; the smallest is the only one that
    // matters at the counter.
    const most = this.mostAffordable(item);

    // The sprite and the blurb only change when the selection does, so they are
    // left alone on a stock tick rather than rebuilt twice a second.
    if (this.shop.shownItemId !== item.id) {
      this.shop.shownItemId = item.id;
      nodes.art.replaceChildren(this.shopArt(item, SHOP_DETAIL_ART));
      nodes.name.textContent = item.name;
      nodes.desc.textContent = locked
        ? (item.lockedReason ?? 'Not for sale yet.')
        : item.description;
    }

    // Clamped before the chips are written, not after: every number below is
    // quoted for the quantity actually being bought, so the row and the chips
    // and the Accept button can never disagree about what that is.
    this.shop.quantity = Math.max(1, Math.min(this.shop.quantity, Math.max(most, 1)));
    if (this.shop.customQuantity !== null) {
      this.shop.customQuantity = this.shop.quantity;
    }
    const quantity = this.shop.quantity;

    // The whole order, not the unit price: a shelf sold in bundles and bought
    // in multiples has two multiplications between the tile and the wallet,
    // and this is the one number that has both of them applied.
    const price = document.createElement('span');
    price.className = 'shop__chip shop__chip--price';
    price.append(this.currencyIcon(item.cost.currency));
    price.append(document.createTextNode(formatNumber(item.cost.amount * quantity)));

    const chips = [price];

    const perPack = item.grants?.bait ?? 0;
    if (perPack > 0) {
      chips.push(this.shopChip(
        'Bundle',
        `${formatNumber(perPack)} per purchase · ${formatNumber(perPack * quantity)} total`,
      ));
    }

    const units = this.shelfUnits(item);
    if (locked) {
      chips.push(this.shopChip('Stock', 'Not for sale'));
    } else if (units !== null) {
      chips.push(this.shopChip('Stock', formatNumber(units)));
    }

    chips.push(this.shopChip('Type', item.typeName ?? item.type ?? 'Goods', 'shop__chip--type'));

    nodes.meta.replaceChildren(...chips);

    this.syncShopQuantities(item, most);
    this.refreshShopAccept(item, most);
  }

  /**
   * Re-disables the steps out of reach and writes the Custom button's label.
   * The buttons themselves are the ones `shopQuantities` built, so nothing
   * under the cursor moves.
   */
  syncShopQuantities(item, most) {
    // A remembered custom amount with nothing selected to spend it on is not
    // pressed, but it is not forgotten either -- reselecting an item brings
    // the same order back rather than dropping the player at x1.
    const custom = item ? this.shop.customQuantity : null;

    for (const { button, step } of this.shop.steps) {
      button.disabled = step > most;
      button.setAttribute(
        'aria-pressed',
        String(custom === null && this.shop.quantity === step),
      );
    }

    // Custom carries the amount once one is set, so what is being bought is
    // always readable off a button in the row rather than remembered from a
    // dialog that has since closed.
    const { customButton } = this.shop.nodes;
    customButton.disabled = !item || most < 1;
    customButton.textContent = custom === null ? 'Custom' : `x${formatNumber(custom)}`;
    customButton.setAttribute('aria-pressed', String(custom !== null));
    customButton.classList.toggle('is-set', custom !== null);

    // An open dialog is bounded by numbers that move under it -- the shelf
    // ticks and the wallet is spent while it is up.
    if (this.shop.amount) this.syncShopAmount(most);
  }

  /* ------------------------------------------------ shop: custom amount */

  /**
   * The Custom dialog: a slider, two nudge buttons and a box.
   *
   * It opens as a sheet inside the modal card rather than as a panel of its
   * own, so the counter behind it keeps everything it had -- the shelf goes on
   * ticking underneath while an amount is being chosen, and Cancel leaves the
   * shop exactly as it was found. Escape and the sheet's own scrim close this
   * first and the shop second; see `closeModal`.
   *
   * The range is `mostAffordable`, not `MAX_PURCHASE_QUANTITY`: the server
   * checks the shelf and the wallet again anyway, and a control that offers a
   * number the client already knows will be refused is only a trap.
   */
  openShopAmount() {
    const item = this.shopItem(this.shop?.itemId);
    const most = this.mostAffordable(item);
    if (!item || most < 1 || this.shop.amount) return;

    const layer = document.createElement('div');
    layer.className = 'shopamount';
    // The sheet's own backdrop. It closes the sheet, never the shop under it,
    // which is why it is not one of the modal's `data-close` targets.
    layer.addEventListener('mousedown', (event) => {
      if (event.target === layer) this.closeShopAmount();
    });

    const card = document.createElement('div');
    card.className = 'shopamount__card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', `How many ${item.name} to buy`);

    const head = document.createElement('div');
    head.className = 'shopamount__head';
    const title = document.createElement('h3');
    title.className = 'shopamount__title';
    title.textContent = 'Choose Amount';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'shopamount__close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => this.closeShopAmount());
    head.append(title, close);

    // What is being counted, so the number below has a subject.
    const subject = document.createElement('div');
    subject.className = 'shopamount__item';
    const art = this.shopArt(item, SHOP_AMOUNT_ART);
    art.classList.add('shopamount__art');
    const name = document.createElement('b');
    name.className = 'shopamount__name';
    name.textContent = item.name;
    const limit = document.createElement('span');
    limit.className = 'shopamount__limit';
    limit.textContent = `Up to ${formatNumber(most)}`;
    subject.append(art, name, limit);

    const row = document.createElement('div');
    row.className = 'shopamount__row';

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'shopamount__nudge';
    down.setAttribute('aria-label', 'One fewer');
    down.textContent = '−';
    down.addEventListener('click', () => this.setShopAmount(this.shop.amount.value - 1));

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'shopamount__slider';
    slider.min = '1';
    slider.max = String(most);
    slider.setAttribute('aria-label', 'Amount');
    slider.addEventListener('input', () => this.setShopAmount(slider.value));

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'shopamount__nudge';
    up.setAttribute('aria-label', 'One more');
    up.textContent = '+';
    up.addEventListener('click', () => this.setShopAmount(this.shop.amount.value + 1));

    const field = document.createElement('input');
    field.type = 'number';
    field.className = 'shopamount__value';
    field.min = '1';
    field.max = String(most);
    field.setAttribute('aria-label', 'Amount');
    // Typed digits are clamped without being written back, so a half-typed
    // number is never yanked out from under the cursor; blur and Set Amount
    // are where the box is squared up with the value it actually holds.
    field.addEventListener('input', () => this.setShopAmount(field.value, { keepField: true }));
    field.addEventListener('blur', () => this.setShopAmount(this.shop.amount?.value ?? 1));
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.commitShopAmount();
    });

    row.append(down, slider, up, field);

    const actions = document.createElement('div');
    actions.className = 'shopamount__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn shopamount__cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.closeShopAmount());
    const set = document.createElement('button');
    set.type = 'button';
    set.className = 'btn shopamount__set';
    set.textContent = 'Set Amount';
    set.addEventListener('click', () => this.commitShopAmount());
    actions.append(cancel, set);

    card.append(head, subject, row, actions);
    layer.append(card);
    this.dom.modalCard.append(layer);

    this.shop.amount = { layer, value: 1, max: most, nodes: { slider, field, limit } };
    // Opens on what the counter is already holding: the dialog is for
    // adjusting an order, not for starting one over.
    this.setShopAmount(this.shop.quantity);
    field.focus();
    field.select();
  }

  /** Writes `value` into the dialog, clamped to what the counter can fill. */
  setShopAmount(value, { keepField = false } = {}) {
    const amount = this.shop?.amount;
    if (!amount) return;

    const wanted = Math.floor(Number(value));
    amount.value = Number.isFinite(wanted)
      ? Math.min(amount.max, Math.max(1, wanted))
      : 1;

    amount.nodes.slider.value = String(amount.value);
    if (!keepField) amount.nodes.field.value = String(amount.value);
  }

  /** Re-bounds an open dialog against a shelf and a wallet that have moved. */
  syncShopAmount(most) {
    const amount = this.shop?.amount;
    if (!amount) return;

    amount.max = Math.max(1, most);
    amount.nodes.slider.max = String(amount.max);
    amount.nodes.field.max = String(amount.max);
    amount.nodes.limit.textContent = `Up to ${formatNumber(amount.max)}`;
    this.setShopAmount(amount.value);
  }

  /** Takes the dialog's amount back to the counter and closes it. */
  commitShopAmount() {
    const amount = this.shop?.amount;
    if (!amount) return;

    const { value } = amount;
    this.shop.quantity = value;
    // An amount that lands on a step is that step, not a custom one: two
    // buttons in the row claiming the same number would both look chosen.
    const presets = this.catalog?.purchaseQuantities ?? [];
    this.shop.customQuantity = presets.includes(value) ? null : value;

    this.closeShopAmount();
    this.refreshShopDetail();
  }

  closeShopAmount() {
    const amount = this.shop?.amount;
    if (!amount) return;

    amount.layer.remove();
    this.shop.amount = null;
    // Back to the button that opened it, rather than to the top of the panel.
    this.shop.nodes.customButton?.focus();
  }

  /**
   * The Accept button's label, and whether it is taking an order or sending
   * the player for more Gold.
   *
   * An empty wallet is not a dead end at this counter, so the button does not
   * grey out for one: it turns into Buy Gold and opens the Gold Wallet. An
   * empty *shelf* still greys it, because no amount of Gold fixes that -- the
   * two refusals look different because they are different problems.
   */
  refreshShopAccept(item, most) {
    const chosen = item ?? this.shopItem(this.shop.itemId);
    const reach = most ?? this.mostAffordable(chosen);

    // Short of one purchase, with stock on the shelf to spend it on. Quantity
    // is already clamped to what the wallet covers, so "cannot afford the
    // order" and "cannot afford a single one of them" are the same state.
    const needsGold = !!chosen
      && chosen.purchasable !== false
      && this.affordableCount(chosen) < 1
      && this.stockFor(chosen) >= 1;

    this.shop.needsGold = needsGold;

    const { accept } = this.shop.nodes;
    accept.classList.toggle('shop__accept--gold', needsGold);

    if (needsGold) {
      accept.disabled = false;
      accept.textContent = 'Buy Gold';
      return;
    }

    accept.disabled = !chosen || reach < this.shop.quantity;
    accept.textContent = accept.disabled
      ? 'Accept'
      : `Accept x${formatNumber(this.shop.quantity)}`;
  }

  acceptPurchase() {
    const item = this.shopItem(this.shop?.itemId);
    if (!item || item.purchasable === false) return;

    // The same button, the other job: an empty wallet sends the player to the
    // Gold Wallet instead of to a refusal from the server. It opens over the
    // shop the way the counter's own sheets do not -- this is a different
    // screen, and the shop is remembered rather than held open behind it.
    if (this.shop.needsGold) {
      this.closeShopAmount();
      this.openGoldWallet();
      return;
    }

    this.net.buy(item.id, this.shop.quantity);
  }

  shopItem(itemId) {
    return (this.catalog?.shop ?? []).find((item) => item.id === itemId) ?? null;
  }

  /**
   * How many of `item` the harbour can supply right now.
   *
   * The shelf holds single bait, so a pack's availability is however many whole
   * packs are left in it -- the same division the server does before it agrees
   * to sell one. Anything that is not bait does not come off the shelf.
   */
  stockFor(item) {
    const perPack = item.grants?.bait ?? 0;
    if (perPack <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor((this.net.baitStock ?? 0) / perPack);
  }

  /**
   * What the shelf is holding of `item`, in the units the item is counted in
   * -- bait, not packs of it. `null` for anything that does not come off the
   * shelf at all, which has no stock number to show.
   */
  shelfUnits(item) {
    const perPack = item.grants?.bait ?? 0;
    return perPack > 0 ? (this.net.baitStock ?? 0) : null;
  }

  /**
   * The most of `item` the counter will let a player order in one go: what the
   * shelf can supply, what the wallet covers, and what one message is allowed
   * to ask for, whichever runs out first.
   */
  mostAffordable(item) {
    if (!item || item.purchasable === false) return 0;
    const ceiling = this.catalog?.maxPurchaseQuantity ?? Number.POSITIVE_INFINITY;
    return Math.min(this.stockFor(item), this.affordableCount(item), ceiling);
  }

  /** How many the wallet covers, at this item's price and in its currency. */
  affordableCount(item) {
    const held = this.me?.[item.cost.currency] ?? 0;
    return Math.floor(held / Math.max(1, item.cost.amount));
  }

  /* ------------------------------------------------------------ cash in */

  /**
   * Where the fish bag actually pays out.
   *
   * A chest or a gem gets a modal of its own because opening one is an event
   * worth watching land; cashing in a fish is not a roll, it is a plain
   * exchange, so one panel lists every species held and lets each be settled
   * on its own or all at once -- clicking a fish stack in the bag opens this
   * same panel rather than acting immediately, so a player always sees the
   * full haul before anything is spent.
   */
  openCashIn() {
    this.modalKind = 'cashin';
    this.setModalChrome({
      title: 'Cash In Catch',
      subtitle: 'Trade fish from your bag for Fishing Power XP',
    });

    const me = this.me;
    if (!me) return;

    const stacks = this.fishStacks(me.fish ?? []);

    if (stacks.length === 0) {
      this.dom.modalBody.append(
        this.empty('Nothing in the bag yet. Catch a fish and it will wait here for you.'),
      );
      this.dom.modal.hidden = false;
      return;
    }

    let grandTotalXp = 0;
    let grandTotalCount = 0;

    for (const stack of stacks) {
      grandTotalXp += stack.totalXp;
      grandTotalCount += stack.ids.length;
      this.dom.modalBody.append(this.cashInRow(stack));
    }

    if (stacks.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'btn chestopen__spin';
      all.textContent = `Cash in everything (${grandTotalCount} fish, `
        + `+${formatNumber(grandTotalXp)} Fishing Power)`;
      all.addEventListener('click', () => this.net.cashOutAllFish());
      this.dom.modalBody.append(all);
    }

    this.dom.modal.hidden = false;
  }

  /** One species held, and the single button that settles it. */
  cashInRow(stack) {
    const row = document.createElement('div');
    row.className = 'shoprow';

    const art = spriteIcon('fish', stack.speciesId, BAG_FISH_SCALE);
    if (art) {
      art.classList.add('shoprow__art');
      row.append(art);
    }

    const body = document.createElement('div');
    body.className = 'shoprow__body';
    body.innerHTML = `
      <div class="shoprow__name">${escapeHtml(stack.name)} `
      + `<span style="color:var(--ink-soft)">x${stack.ids.length}</span></div>
      <div class="shoprow__desc">Worth ${formatNumber(stack.totalXp)} Fishing Power</div>
    `;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.innerHTML = `<i class="icon icon--xp"></i>Cash in`;
    button.addEventListener('click', () => this.net.cashOutSpecies(stack.speciesId));

    row.append(body, button);
    return row;
  }

  /* ---------------------------------------------------------------- log */

  /**
   * Catch log, lifetime record, active buffs and recent rewards.
   *
   * Chests and consumables used to live here too. They moved out to the bag
   * grid in the corner, which leaves this as the reference screen -- the things
   * a player reads rather than clicks.
   */
  openLog() {
    this.modalKind = 'log';
    // The chest grid is the one tab in this modal laid out in columns rather
    // than rows (see `setModalChrome`'s note on `wide`) -- four cards each
    // need room for a name, an odds figure and a full-width button, which
    // the base 460px card was cramping into ~100px columns badly enough that
    // "What's Inside" wrapped on three of the four. Widened only while the
    // Odds tab is showing; `openLog` reruns whole on every tab click (see
    // the tab buttons below), so this tracks `logTab` automatically.
    this.setModalChrome({ title: 'Robin Journal', wide: this.logTab === 'odds' });

    const me = this.me;
    if (!me) return;

    const tabs = document.createElement('div');
    tabs.className = 'journal-tabs';
    tabs.setAttribute('role', 'tablist');
    const definitions = [
      ['rod', 'Rod'], ['species', 'Fish'], ['odds', 'Treasure Chest'],
      ['history', 'History'], ['boosts', 'Boosts'],
    ];
    for (const [id, label] of definitions) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'journal-tab';
      tab.textContent = label;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(this.logTab === id));
      tab.addEventListener('click', () => {
        this.logTab = id;
        this.openLog();
      });
      tabs.append(tab);
    }
    this.dom.modalBody.append(tabs);

    const content = document.createElement('div');
    content.className = 'journal-content';
    content.setAttribute('role', 'tabpanel');
    this.renderLogTab(content, me);
    this.dom.modalBody.append(content);
    this.dom.modal.hidden = false;
  }

  renderLogTab(content, me) {
    if (this.logTab === 'rod') {
      content.append(this.sectionTitle('Rod progression'));
      content.append(this.upgradePanel(me));
      const next = this.catalog?.fish.find((fish) => !new Set(me.unlockedSpecies ?? []).has(fish.id));
      if (next) content.append(this.empty(`Next discovery: ${next.name} at rod level ${next.unlockLevel}.`));
      return;
    }

    if (this.logTab === 'species') {
      content.append(this.sectionTitle('Fish collection'));
      content.append(this.speciesPanel(me));
      return;
    }

    if (this.logTab === 'odds') {
      this.oddsPanel(content, me);
      return;
    }

    const active = Object.entries(me.buffs).filter(([, casts]) => casts > 0);
    if (this.logTab === 'boosts') {
      content.append(this.sectionTitle('Active tackle'));
      if (active.length === 0) content.append(this.empty('No active boosts. Find chests or visit the shop to prepare your next run.'));
      for (const [id, casts] of active) {
        const row = document.createElement('div');
        row.className = 'stat';
        row.innerHTML = `<span>${escapeHtml(this.rewardName(id))}</span><b>${casts} casts left</b>`;
        content.append(row);
      }
      return;
    }

    content.append(this.sectionTitle('Catch log'));
    content.append(this.catchLog(me.catchCounts));

    content.append(this.sectionTitle('Harbor record'));
    for (const [label, value] of [
      ['Rod level', `${me.rodLevel} / ${me.maxRodLevel}`],
      ['Total casts', formatNumber(me.totalCasts)],
      ['Total catches', formatNumber(me.totalCatches)],
      ['Lifetime XP', formatNumber(me.totalXp)],
    ]) {
      const row = document.createElement('div');
      row.className = 'stat';
      row.innerHTML = `<span>${label}</span><b>${value}</b>`;
      content.append(row);
    }

    if (me.rewardLog.length > 0) {
      content.append(this.sectionTitle('Recent rewards'));
      const list = document.createElement('ul');
      list.className = 'rewardlist';

      for (const reward of me.rewardLog.slice(0, 12)) {
        const item = document.createElement('li');
        item.style.animationDelay = '0ms';
        item.innerHTML = `
          <i class="icon icon--${this.rewardIcon(reward.type)}"></i>
          <span>${escapeHtml(this.rewardLabel(reward))}</span>
          <span style="margin-left:auto;color:var(--ink-soft)">${formatTime(reward.at)}</span>
        `;
        list.append(item);
      }
      content.append(list);
    }
  }

  /**
   * The GDD's skip-the-grind path, priced in Gold. The price comes from the
   * server -- the client never works out what a level should cost.
   */
  upgradePanel(me) {
    const wrap = document.createElement('div');

    const level = document.createElement('div');
    level.className = 'stat';
    level.innerHTML = `<span>${escapeHtml(me.rodName)}</span><b>Lv.${me.rodLevel} / ${me.maxRodLevel}</b>`;
    wrap.append(level);

    if (!me.upgrade) {
      wrap.append(this.empty('Your rod is fully upgraded.'));
      return wrap;
    }

    const row = document.createElement('div');
    row.className = 'shoprow';

    const body = document.createElement('div');
    body.className = 'shoprow__body';
    body.innerHTML = `
      <div class="shoprow__name">Upgrade to Lv.${me.upgrade.toLevel}</div>
      <div class="shoprow__desc">Skip the remaining Fishing Power for this level.</div>
    `;

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.gap = '5px';

    const cost = me.upgrade.gold;
    const held = me.gold;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.innerHTML = `<i class="icon icon--coin"></i>${formatNumber(cost)}`;
    button.disabled = held < cost;
    button.title = button.disabled
      ? `You have ${formatNumber(held)} ${this.rewardName('gold')}`
      : `Spend ${formatNumber(cost)} ${this.rewardName('gold')}`;
    button.addEventListener('click', () => this.net.upgradeRod());
    buttons.append(button);

    row.append(body, buttons);
    wrap.append(row);
    return wrap;
  }

  /**
   * One card per species: the GDD's sprite, the name, and either what it is
   * worth or the rod level that unlocks it. Locked species are shown rather
   * than hidden, because the point of the panel is to tell you what levelling
   * is *for*.
   */
  speciesCard(fish, value, locked) {
    const card = document.createElement('div');
    card.className = locked ? 'species__card species__card--locked' : 'species__card';
    card.style.borderTopColor = RARITY_CLASS[fish.tier] ?? fish.color;

    const icon = spriteIcon('fish', fish.id);
    if (icon) {
      card.append(icon);
    } else {
      // No artwork for this species: fall back to the flat rarity swatch.
      const swatch = document.createElement('i');
      swatch.className = 'fishicon';
      swatch.style.cssText = `width:45px;height:39px;background:${fish.color}`;
      card.append(swatch);
    }

    const name = document.createElement('span');
    name.className = 'species__name';
    name.textContent = fish.name;

    const worth = document.createElement('b');
    worth.className = 'species__value';
    worth.textContent = value;

    card.append(name, worth);
    return card;
  }

  /** Which species this rod can hook, and what the next level opens up. */
  speciesPanel(me) {
    const unlocked = new Set(me.unlockedSpecies ?? []);
    const grid = document.createElement('div');
    grid.className = 'species';

    for (const fish of this.catalog?.fish ?? []) {
      const locked = !unlocked.has(fish.id);
      grid.append(
        this.speciesCard(fish, locked ? `Lv.${fish.unlockLevel}` : `+${fish.baseXp} XP`, locked),
      );
    }
    return grid;
  }

  /* --------------------------------------------------------------- odds */

  /**
   * Which chest a cast can turn up, one card per tier.
   *
   * Used to open with a "Per cast" section (a fish, then a chest, any tier)
   * and close with a per-gem breakdown below the grid -- both removed, so the
   * tab is just the thing a player actually came to compare.
   *
   * A tier the current Stake cannot reach used to print a dimmed "never".
   * It now prints the real odds that tier has at the Stake where it first
   * unlocks (`me.oddsUnlock`, from the server's `chestTierUnlockOdds`),
   * marked as a target rather than a live figure -- see `oddsChestCard`.
   * That keeps the thing "never" was for (a locked tier is still visibly
   * different from a live one) while giving a player looking at Legendary a
   * number to want instead of a wall.
   */
  oddsPanel(content, me) {
    const odds = me.odds;
    if (!odds) {
      content.append(this.empty('Odds are unavailable — reconnect to load them.'));
      return;
    }

    const tiers = this.catalog?.chestTiers ?? [];

    content.append(this.sectionTitle('Which chest'));
    content.append(this.oddsChestGrid(tiers, odds, me.oddsUnlock));

    content.append(this.empty(
      'A chest pays exactly one reward, drawn once from its table. '
      + 'Raising your Stake trades bites for better chests — a tier your Stake '
      + 'cannot reach yet shows the odds it unlocks at instead. '
      + 'Tap a chest’s "What’s Inside" for its table.',
    ));
  }

  /**
   * The "which chest" grid: one card per tier, each with its own art, how
   * often a cast finds one, and a button onto what it can hold.
   *
   * Cards rather than the plain rows every other line in this panel uses,
   * because a chest tier is a thing a player recognises by its icon before
   * they read its name -- the four sit side by side the way the chest
   * stacks themselves do in the bag, instead of as a column of text a
   * Legendary line looks no different from a gem line in.
   */
  oddsChestGrid(tiers, odds, unlock) {
    const grid = document.createElement('div');
    grid.className = 'oddscards';
    for (const tier of tiers) {
      grid.append(this.oddsChestCard(tier, odds?.tiers?.[tier.id], unlock?.[tier.id]));
    }
    return grid;
  }

  /**
   * One chest tier card: art, name, the per-cast figure `oddsFigure` already
   * knows how to print (the "+ ???" marker comes along for free), and a
   * "What's Inside" button onto its reward table.
   *
   * `probability` is this tier's live per-cast odds at the player's current
   * Stake -- 0 when this Stake cannot produce it at all. `unlock` is what
   * `chestTierUnlockOdds` says this tier reads at the lowest Stake that can:
   * `{ stake, probability }`. A live, reachable tier only ever uses the
   * first; a locked one falls back to the second, dimmed and captioned with
   * the Stake it needs, so the number on the card is never "never" but is
   * still visibly not something this cast can actually land.
   *
   * The table itself is left off the card on purpose -- printing every
   * reward's name and chance under all four cards is what the section
   * looked like before this, and it read as a spreadsheet to scan rather
   * than four things to compare. One click is all `openChestContents` costs.
   */
  oddsChestCard(tier, probability, unlock) {
    const card = document.createElement('div');
    card.className = 'oddscard';
    card.style.setProperty('--tier-color', tier.color ?? 'transparent');

    const art = spriteIcon('chests', tier.id, fitScale('chests', ODDS_CARD_ART));
    if (art) {
      art.classList.add('oddscard__art');
      card.append(art);
    }

    const name = document.createElement('div');
    name.className = 'oddscard__name';
    name.textContent = tier.name;
    card.append(name);

    const live = Number(probability) > 0;
    card.classList.toggle('oddscard--locked', !live);
    card.append(this.oddsFigure(live ? probability : unlock?.probability, 'oddscard__odds'));

    if (!live && unlock) {
      const needs = document.createElement('div');
      needs.className = 'oddscard__unlock';
      needs.textContent = `at Stake ${unlock.stake}`;
      needs.title = `Your current Stake cannot produce a ${tier.name} -- `
        + `this is what it reads once Stake reaches ${unlock.stake}.`;
      card.append(needs);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn oddscard__inside';
    button.textContent = "What's Inside";
    button.addEventListener('click', () => this.openChestContents(tier));
    card.append(button);

    return card;
  }

  /**
   * The sheet a "What's Inside" button opens: every reward the tier can pay,
   * best odds first, each with its icon and its name -- no odds printed, so
   * the sheet answers "what's in here" the same way the reel does.
   *
   * Reuses `openSheet` -- the same layer the wallet's dialogs use over the
   * dark card -- rather than a panel of its own, so it stacks over the Odds
   * tab exactly the way those stack over the wallet, and `closeModal`
   * already knows to close it before the Log itself.
   */
  openChestContents(tier) {
    this.openSheet(tier.name, () => {
      const sorted = [...(tier.contents ?? [])].sort((a, b) => b.chance - a.chance);
      return sorted.map((entry) => this.oddsItemRow(entry));
    });
  }

  /** One reward line inside a "What's Inside" sheet: icon and name. */
  oddsItemRow(entry) {
    const row = document.createElement('div');
    row.className = 'oddsitem';

    const icon = document.createElement('span');
    icon.className = 'oddsitem__icon';
    icon.append(this.rewardArtBox(entry, ODDS_ITEM_ART));
    row.append(icon);

    const name = document.createElement('span');
    name.className = 'oddsitem__name';
    name.textContent = this.rewardShortName(entry);
    row.append(name);

    return row;
  }

  catchLog(catchCounts) {
    const entries = Object.entries(catchCounts).filter(([, count]) => count > 0);
    if (entries.length === 0) return this.empty('Nothing caught yet.');

    const known = new Map(this.catalog.fish.map((fish) => [fish.id, fish]));
    const grid = document.createElement('div');
    grid.className = 'species';

    const sorted = entries
      .map(([id, count]) => ({ fish: known.get(id), count }))
      .filter((entry) => entry.fish)
      .sort((a, b) => a.fish.rarityIndex - b.fish.rarityIndex);

    for (const { fish, count } of sorted) {
      grid.append(this.speciesCard(fish, formatNumber(count), false));
    }
    return grid;
  }

  /* ------------------------------------------------------- chest reveal */

  /**
   * Which sheet and frame a reward draws from, or null when it has no sprite
   * and the caller should fall back to the flat UI-pack icon.
   */
  rewardSprite(reward) {
    switch (reward.type) {
      case 'uncut_gem': return { sheet: 'gems', id: reward.gemTier };
      case 'bait': return { sheet: 'bait', id: 'bait' };
      case 'gold': return { sheet: 'gold', id: 'gold' };
      case 'pearls': return { sheet: 'pearl', id: 'pearls' };
      default: return null;
    }
  }

  /** A reward's artwork, sized in whole multiples so the pixels stay square. */
  rewardArt(reward, scale = 1) {
    const sprite = this.rewardSprite(reward);
    const art = sprite && spriteIcon(sprite.sheet, sprite.id, scale);
    if (art) return art;

    // XP has no plate sprite, so it keeps the UI pack's icon -- but drawn as
    // artwork rather than as a glyph in a line of text: a centred square the
    // size a sprite would have been at this `scale`, taking the gems sheet's
    // 24px frame as the notional one (XP borrows the spark drawn on it). The
    // glyph is sized at 1.35em by `.icon--xp`, so the font size is what
    // actually fills the square; left inherited it came out at ~17px in a
    // 104px reveal frame, tucked up in the corner by the icon's text margin.
    const fallback = document.createElement('i');
    fallback.className = `icon icon--art icon--${this.rewardIcon(reward.type)}`;
    fallback.style.width = `${GLYPH_ART_FRAME * scale}px`;
    fallback.style.height = `${GLYPH_ART_FRAME * scale}px`;
    fallback.style.fontSize = `${Math.round((GLYPH_ART_FRAME * scale) / GLYPH_EM)}px`;
    return fallback;
  }

  /**
   * A reward's artwork drawn to fit a `box`-pixel square, the way the shop
   * sizes its shelf -- for rows that have no frame to hide a size difference in.
   */
  rewardArtBox(reward, box) {
    const sprite = this.rewardSprite(reward);
    const art = sprite && spriteIcon(sprite.sheet, sprite.id, fitScale(sprite.sheet, box));
    if (art) return art;

    // XP has no plate sprite, so it keeps the UI pack's icon, centred in the
    // box the sprites are fitted to rather than sitting on a text baseline.
    const fallback = document.createElement('i');
    fallback.className = `icon icon--art icon--${this.rewardIcon(reward.type)}`;
    fallback.style.width = `${box}px`;
    fallback.style.height = `${box}px`;
    fallback.style.fontSize = `${Math.round(box * 0.78)}px`;
    return fallback;
  }

  /** A gem reward's tier colour, or null when the reward is not a gem. */
  gemTierColor(reward) {
    if (!reward?.gemTier) return null;
    return this.catalog?.gemTiers?.find((tier) => tier.id === reward.gemTier)?.color ?? null;
  }

  /** Short label for a reel card, where there is no room for an amount. */
  rewardShortName(reward) {
    if (reward.type === 'uncut_gem') {
      return this.catalog?.gemTiers?.find((tier) => tier.id === reward.gemTier)?.name
        ?? 'Uncut Gem';
    }
    return this.rewardName(reward.type);
  }

  /* -------------------------------------------------------- chest opening */

  /**
   * The chest, unopened, with what it might hold laid out under it.
   *
   * Nothing is sent from here. Opening is what spends the chest, so a player
   * who came to look at a Legendary before committing it can close this and
   * still have it -- the same bargain the appraisal counter makes.
   *
   * The row of possible contents comes from the catalog's `contents`. Only the
   * reward *types* are drawn: it says what is in the pool, never the odds or
   * the amounts. The Odds tab in the log is where the numbers live.
   */
  showChestPreview(stack) {
    const remaining = this.chestsInStack(stack.tier, stack.ids);

    this.chest = {
      tier: stack.tier,
      name: stack.name,
      color: stack.color,
      opened: 0,
      haul: new Map(),
      auto: false,
    };

    this.modalKind = 'chest';
    this.setModalChrome({
      title: stack.name,
      subtitle: 'Open the chest and reveal your reward',
      full: true,
    });

    const wrap = document.createElement('div');
    wrap.className = 'chestopen';

    const stage = this.chestStage(stack.color);
    // The reel is inserted after the stage, and "Open another" has to be able
    // to find it from an action row that has no reference to this panel.
    this.chest.stage = stage;
    stage.append(this.nameRing(stack.name), this.sparkles(4));

    const chest = spriteIcon('chests', stack.tier, fitScale('chests', CHEST_STAGE_ART));
    if (chest) {
      chest.classList.add('chestopen__chest');
      stage.append(chest);
    }
    wrap.append(stage);
    wrap.append(this.contentsStrip(stack.tier));

    const actions = document.createElement('div');
    actions.className = 'chestopen__actions';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn chestopen__done';
    close.textContent = 'Close';
    close.onclick = () => this.closeModal();

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn chestopen__spin';
    open.textContent = 'Open chest';
    open.onclick = () => {
      this.markOpening(open);
      this.startReel();
      this.openNextChest();
    };

    actions.append(close, open);

    // Only offered for a stack, and only for this tier: a stack is what the bag
    // shows as one slot, and sweeping up other tiers would open chests the
    // player never looked at.
    if (remaining.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'btn chestopen__all';
      all.textContent = `Open all (${remaining.length})`;
      all.onclick = () => {
        this.chest.auto = true;
        all.disabled = true;
        open.disabled = true;
        this.openNextChest();
      };
      actions.append(all);
    }

    wrap.append(actions);

    this.dom.modalBody.append(wrap);
    this.dom.modal.hidden = false;
  }

  /** Unopened chests of one tier, oldest first, straight from the last `me`. */
  chestsInStack(tier, fallbackIds = []) {
    const held = this.me?.chests?.filter((chest) => chest.tier === tier);
    return held?.length ? held.map((chest) => chest.id) : [...fallbackIds];
  }

  /** Sends the next chest of the open session's tier, if one is still held. */
  openNextChest() {
    const next = this.chestsInStack(this.chest?.tier ?? '')[0];
    if (!next) return false;

    this.net.openChest(next);
    return true;
  }

  /**
   * Puts a reel into the panel and starts it cruising, now, on the click.
   *
   * The roll is a round trip, and the reel used to wait for it: the request
   * went out, the panel sat still, and the strip only appeared once the answer
   * was already in hand -- which made a spin that is meant to be suspense into
   * a replay of a decision already taken. Started here it is turning before
   * the server has answered, and the reply is what tells it where to stop, so
   * the wait is inside the animation rather than in front of it.
   *
   * The node is kept on the session, not on the panel, because `showChestReveal`
   * rebuilds the panel around it -- see the handover there.
   */
  startReel() {
    const session = this.chest;
    if (!session?.stage?.isConnected || session.auto) return null;

    session.reel?.destroy();
    const reel = this.buildReel(session.tier, session.color);
    session.reel = reel;
    session.stage.after(reel.root);
    reel.start();
    return reel;
  }

  /** Stops and removes the session's reel, if one is running. */
  stopReel() {
    this.chest?.reel?.destroy();
    if (this.chest) this.chest.reel = null;
  }

  /**
   * What came out, on the same stage the chest was standing on.
   *
   * The reel is presentation only. `result` was rolled and applied on the
   * server before this ran -- the reel is built *around* the reward it was
   * handed, and cannot change it. Closing the modal early, or reloading
   * mid-spin, loses nothing.
   *
   * Everything opened in this sitting is tallied underneath, so working
   * through a stack of six reads as one haul rather than six modals that each
   * forget the last.
   */
  showChestReveal(result) {
    // A reply with no session behind it -- a reconnect landing an old open, or
    // a chest opened from somewhere this panel does not know about.
    if (!this.chest || this.chest.tier !== result.tier) {
      // Whatever was spinning belonged to the session being replaced, and its
      // loop would otherwise keep running against a node no one holds.
      this.stopReel();
      this.chest = {
        tier: result.tier,
        name: result.tierName,
        color: result.color,
        opened: 0,
        haul: new Map(),
        auto: false,
      };
    }

    const session = this.chest;
    const auto = session.auto;

    this.modalKind = 'chest';
    this.setModalChrome({
      title: result.tierName,
      subtitle: 'Open the chest and reveal your reward',
      full: true,
    });

    const wrap = document.createElement('div');
    wrap.className = 'chestopen';

    const stage = this.chestStage(result.color);
    session.stage = stage;
    wrap.append(stage);

    // The server guarantees one reward per chest, but a malformed payload must
    // not leave the player staring at a panel that cannot go anywhere.
    const prize = result.rewards?.[0];
    if (!prize) {
      // Nothing to land on, so the strip has nowhere to go: stop it rather
      // than leave it cruising behind a panel that is now a dead end.
      this.stopReel();
      const chest = spriteIcon('chests', result.tier, fitScale('chests', CHEST_STAGE_ART));
      if (chest) stage.append(chest);
      wrap.append(this.chestActions(() => this.closeModal()));
      this.dom.modalBody.append(wrap);
      this.dom.modal.hidden = false;
      this.toast('That chest came back empty. Nothing was spent.', 'warn');
      return;
    }

    session.opened += 1;
    this.tally(session.haul, prize);

    const chest = spriteIcon('chests', result.tier, fitScale('chests', CHEST_STAGE_ART));
    if (chest) {
      chest.classList.add('chestopen__chest');
      stage.append(chest);
    }

    const banner = document.createElement('div');
    banner.className = 'chestwon';
    wrap.append(banner);

    const haul = document.createElement('div');
    haul.className = 'haul';
    wrap.append(haul);

    const actions = this.chestActions(() => this.closeModal());
    wrap.append(actions);

    const land = () => {
      // The chest hands the stage over to what came out of it, framed and lit
      // in the reward's own colour.
      stage.replaceChildren(
        this.wonFrame(prize, result.color),
        this.sparkles(5),
        this.confetti(prize.color ?? result.color),
      );
      stage.classList.add('chestopen__stage--opened');

      banner.replaceChildren(...this.wonText(prize, result.levelUp, session));
      this.renderHaul(haul, session);
      this.renderChestActions(actions, session);
    };

    this.dom.modalBody.append(wrap);
    this.dom.modal.hidden = false;

    // Open all skips the reel: six spins of four seconds each is not a
    // sequence anyone sits through, and the tally below is what the player is
    // actually reading by then.
    if (auto) {
      this.stopReel();
      land();
      clearTimeout(this.chestTimer);
      this.chestTimer = setTimeout(() => {
        if (this.chest === session && session.auto && !this.openNextChest()) {
          session.auto = false;
          this.renderChestActions(actions, session);
        }
      }, 700);
      return;
    }

    // The handover. `setModalChrome` emptied the body above, which took the
    // spinning reel out of the document but not out of this session -- the
    // loop is driven by rAF against the node, so it has kept turning while the
    // panel was rebuilt around it. Putting it back is enough to carry the spin
    // across the rebuild unbroken. It has to go back in before `land`, because
    // solving where to stop needs the band's laid-out width and a detached
    // node measures zero.
    let reel = session.reel;
    if (reel) stage.after(reel.root);
    else reel = this.startReel();

    // Nothing to spin -- the reward is still owed, so it is handed over
    // straight away rather than held back waiting on an animation that is not
    // going to run.
    if (!reel) {
      land();
      return;
    }

    reel.land(prize, () => {
      // A beat on the winning card before the band goes: the strip stopping is
      // the answer, and cutting straight to the reward frame skips over it.
      clearTimeout(this.chestTimer);
      this.chestTimer = setTimeout(() => {
        if (this.chest !== session) return;
        // The band collapses into the line the marker was already drawing and
        // fades from there, rather than being cut out of the panel between one
        // frame and the next.
        reel.root.classList.add('reel--closing');
        this.chestTimer = setTimeout(() => {
          if (this.chest !== session) return;
          this.stopReel();
          land();
        }, REEL_CLOSE_MS);
      }, REEL_HOLD_MS);
    });
  }

  /** The lit plinth both chest states share. `--tier` paints its glow. */
  chestStage(color) {
    const stage = document.createElement('div');
    stage.className = 'chestopen__stage';
    stage.style.setProperty('--tier', color);
    return stage;
  }

  /**
   * The chest's name written around it on a circle, turning slowly.
   *
   * An SVG text path rather than letters positioned one at a time: the ring
   * has to hold its shape at any panel width, and the browser is better at
   * spacing text along a curve than a loop here would be.
   */
  nameRing(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const RADIUS = 82;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
    /** Rough width of one character at the ring's font size, in viewBox units. */
    const CHAR_UNITS = 8.6;

    // A unique id per ring: two panels' worth of <defs> in one document would
    // otherwise both resolve to whichever path was inserted first.
    const pathId = `ring-${Math.random().toString(36).slice(2, 9)}`;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'namering');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('id', pathId);
    path.setAttribute('fill', 'none');
    path.setAttribute('d', `M100,${100 - RADIUS} a${RADIUS},${RADIUS} 0 1,1 -0.1,0`);

    const defs = document.createElementNS(NS, 'defs');
    defs.append(path);

    // Repeated so the ring reads as continuous however short the name is, with
    // the count chosen to land near one full turn -- too many and the tail
    // laps the start, which shows as a collision at the top of the circle.
    const label = `${name} · `.toUpperCase();
    const repeats = Math.max(2, Math.round(CIRCUMFERENCE / (label.length * CHAR_UNITS)));

    const text = document.createElementNS(NS, 'text');
    const textPath = document.createElementNS(NS, 'textPath');
    textPath.setAttribute('href', `#${pathId}`);
    // The estimate above only gets close; pinning the run to the circumference
    // and letting the browser take up the slack in the gaps closes it exactly,
    // so the ring meets itself whatever the name is called.
    textPath.setAttribute('textLength', String(Math.round(CIRCUMFERENCE)));
    textPath.setAttribute('lengthAdjust', 'spacing');
    textPath.textContent = label.repeat(repeats);
    text.append(textPath);

    svg.append(defs, text);
    return svg;
  }

  /** Four-pointed glints drifting around the stage. Decoration, so aria-hidden. */
  sparkles(count) {
    const group = document.createElement('div');
    group.className = 'sparkles';
    group.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < count; i += 1) {
      const spark = document.createElement('span');
      spark.className = 'sparkles__one';
      // Spread around the stage rather than randomly, so none of them ever
      // stacks on the chest in the middle.
      const angle = (i / count) * Math.PI * 2 + 0.6;
      spark.style.left = `${50 + Math.cos(angle) * 34}%`;
      spark.style.top = `${50 + Math.sin(angle) * 32}%`;
      spark.style.animationDelay = `${i * 320}ms`;
      group.append(spark);
    }
    return group;
  }

  /** The burst thrown outward at the moment a chest gives up its reward. */
  confetti(color) {
    const group = document.createElement('div');
    group.className = 'confetti';
    group.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < 14; i += 1) {
      const bit = document.createElement('span');
      bit.className = 'confetti__bit';
      const angle = (i / 14) * Math.PI * 2;
      bit.style.setProperty('--dx', `${Math.cos(angle) * (56 + Math.random() * 34)}px`);
      bit.style.setProperty('--dy', `${Math.sin(angle) * (44 + Math.random() * 30)}px`);
      bit.style.setProperty('--spin', `${Math.round((Math.random() - 0.5) * 540)}deg`);
      // Half in the reward's colour, half in the panel's gold, so the burst
      // reads against both a bright reward and a drab one.
      bit.style.background = i % 2 === 0 ? color : 'var(--gold)';
      bit.style.animationDelay = `${Math.round(Math.random() * 90)}ms`;
      group.append(bit);
    }
    return group;
  }

  /** The reward under a rarity-coloured frame, notched at the corners. */
  wonFrame(reward, fallbackColor) {
    const frame = document.createElement('div');
    frame.className = 'wonframe';
    frame.style.setProperty('--tint', reward.color ?? fallbackColor);
    frame.append(this.rewardArt(reward, 3));
    return frame;
  }

  /** Headline, the running count, the reward's blurb, and any level-up. */
  wonText(reward, levelUp, session) {
    const title = document.createElement('h3');
    title.className = 'chestwon__title';
    title.textContent = `You won ${this.rewardLabel(reward).replace(/^\+/, '')}`;

    const nodes = [title];

    // How many of this reward the sitting has produced so far. Only once there
    // is more than one -- on the first chest it would just be "x1" under a
    // headline that already said what came out.
    const tallied = session?.haul?.get(this.tallyKey(reward))?.amount ?? 0;
    if (tallied > (reward.amount ?? 1)) {
      const count = document.createElement('p');
      count.className = 'chestwon__count';
      count.textContent = `x${formatNumber(tallied)} so far`;
      nodes.push(count);
    }

    const blurb = this.catalog?.rewardTypes?.find((type) => type.id === reward.type)?.description;
    if (blurb) {
      const line = document.createElement('p');
      line.className = 'chestwon__blurb';
      line.textContent = blurb;
      nodes.push(line);
    }

    if (levelUp) {
      const bonus = document.createElement('p');
      bonus.className = 'chestwon__bonus';
      bonus.textContent = `Rod level up to Lv.${levelUp.toLevel}`;
      nodes.push(bonus);
    }
    return nodes;
  }

  /**
   * Folds one reward into the running haul.
   *
   * Keyed by type *and* tier, so three Uncut Sapphires stack into one row while
   * a Sapphire and a Diamond stay apart -- they are different items, and a
   * row saying "Uncut Gem x2" would hide which two.
   */
  tallyKey(reward) {
    return [reward.type, reward.gemTier, reward.speciesId].filter(Boolean).join(':');
  }

  tally(haul, reward) {
    const key = this.tallyKey(reward);
    const seen = haul.get(key);

    if (seen) {
      seen.amount += reward.amount ?? 1;
      return;
    }
    haul.set(key, { reward, amount: reward.amount ?? 1 });
  }

  /** Everything this sitting has produced, newest kind last. */
  renderHaul(root, session) {
    root.replaceChildren();

    const title = document.createElement('h4');
    title.className = 'haul__title';
    title.textContent = session.opened === 1
      ? `Opened 1 ${session.name}`
      : `Opened ${session.opened} ${session.name}s`;
    root.append(title);

    const list = document.createElement('ul');
    list.className = 'haul__list';

    for (const { reward, amount } of session.haul.values()) {
      const row = document.createElement('li');
      row.className = 'haul__row';
      row.style.setProperty('--tint', reward.color ?? session.color);

      const art = this.rewardArt(reward);
      art.classList.add('haul__art');

      const name = document.createElement('span');
      name.className = 'haul__name';
      name.textContent = this.rewardShortName(reward);

      const count = document.createElement('b');
      count.className = 'haul__count';
      // An item is counted, an amount is summed -- "x3 Uncut Sapphire" against
      // "x1,240 Bait" -- so both read as the same column.
      count.textContent = `x${formatNumber(amount)}`;

      row.append(art, name, count);
      list.append(row);
    }
    root.append(list);

    const total = document.createElement('p');
    total.className = 'haul__total';
    total.textContent = session.haul.size === 1 ? '1 reward' : `${session.haul.size} rewards`;
    root.append(total);
  }

  /**
   * Puts an open button into its waiting state.
   *
   * The click has gone to the server and the reveal comes back on its own, so
   * the button is spent -- but it keeps its colour and takes a turning ring
   * rather than greying out, because a slow reply is the panel working and not
   * the button refusing.
   */
  markOpening(button, label = 'Opening...') {
    button.disabled = true;
    button.classList.add('is-busy');
    button.textContent = label;
  }

  /** The action row, carrying only Close until a reveal has landed. */
  chestActions(onClose) {
    const actions = document.createElement('div');
    actions.className = 'chestopen__actions';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn chestopen__done';
    close.textContent = 'Close';
    close.onclick = onClose;
    actions.append(close);

    return actions;
  }

  renderChestActions(actions, session) {
    const remaining = this.chestsInStack(session.tier);
    const close = actions.querySelector('.chestopen__done');
    actions.replaceChildren(close);
    // Close turns into Claim once the stack is empty, and with nothing beside
    // it that button is the one thing left to do -- it takes the lit styling
    // Open was carrying rather than staying a slab in an empty row.
    close.classList.remove('chestopen__claim');

    if (session.auto) {
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'btn chestopen__spin';
      skip.textContent = `Opening (${remaining.length} left)`;
      skip.classList.add('is-busy');
      skip.disabled = true;
      actions.append(skip);
      return;
    }

    if (remaining.length === 0) {
      close.textContent = 'Claim';
      close.classList.add('chestopen__claim');
      return;
    }

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn chestopen__spin';
    again.textContent = 'Open another';
    again.onclick = () => {
      this.markOpening(again);
      // The stage is holding the last reward; the strip comes back over it and
      // the next reveal rebuilds the panel around the spin already running.
      this.startReel();
      this.openNextChest();
    };
    actions.append(again);

    if (remaining.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'btn chestopen__all';
      all.textContent = `Open all (${remaining.length})`;
      all.onclick = () => {
        session.auto = true;
        all.disabled = true;
        again.disabled = true;
        this.openNextChest();
      };
      actions.append(all);
    }
  }

  /**
   * One odds figure with its "+ ???" marker, as a node.
   *
   * Every printed probability in the HUD goes through here, so the format and
   * the marker are decided once. `formatOdds` owns the arithmetic; this owns
   * how it reads.
   */
  oddsFigure(probability, className = 'odds__value') {
    const node = document.createElement('b');
    const impossible = !(Number(probability) > 0);

    node.className = impossible ? `${className} odds__value--never` : className;
    node.append(document.createTextNode(formatOdds(probability)));

    // "never + ???" would say the opposite of what it means: a stake that
    // cannot reach a tier is a hard gate in `allowedChestTiers`, not a rate
    // too small to quote, and there is nothing further to disclose about a
    // thing that cannot happen. The marker is for figures that move.
    if (impossible) {
      node.title = 'Your Stake cannot reach this. Raise it to put this in the pool.';
      return node;
    }

    node.title = ODDS_SUFFIX_HINT;
    const more = document.createElement('span');
    more.className = 'odds__more';
    more.textContent = ` ${ODDS_SUFFIX}`;
    node.append(more);

    return node;
  }

  /**
   * The row of reward types this tier can produce.
   *
   * The strip answers "what is in here" and nothing else: no odds under the
   * items, and no amounts. Printing a "1 in N" under every icon turned the
   * moment before opening into a table to study, which is the opposite of what
   * this panel is for -- the reel is what reveals, and it needs something left
   * to reveal.
   *
   * The weights still travel with the catalog (see `chestContentOdds` in the
   * server's rewards config) and are still used here to order the row, and the
   * Odds tab in the log is where a player who wants the numbers reads them.
   *
   * The items stay drawn bare, with no slot frame behind them. A frame per item
   * turned a hint into a five-cell inventory grid, which reads as a promise of
   * five things rather than as a list of what one reward could be.
   */
  contentsStrip(tierId) {
    const tier = this.catalog?.chestTiers?.find((entry) => entry.id === tierId);

    const wrap = document.createElement('div');
    wrap.className = 'maybe';

    const title = document.createElement('h4');
    title.className = 'maybe__title';
    title.textContent = 'Items that might be in this chest';
    wrap.append(title);

    const row = document.createElement('div');
    row.className = 'maybe__row';

    // Best odds first: the strip is read left to right as "mostly this,
    // sometimes that, rarely the stone", which is the shape of the table.
    const contents = [...(tier?.contents ?? [])].sort((a, b) => b.chance - a.chance);

    for (const entry of contents) {
      const cell = document.createElement('span');
      cell.className = 'maybe__cell';

      const slot = document.createElement('span');
      slot.className = 'maybe__slot';
      slot.title = this.rewardShortName(entry);
      slot.append(this.rewardArtBox(entry, CHEST_CONTENTS_ART));

      cell.append(slot);
      row.append(cell);
    }

    wrap.append(row);
    return wrap;
  }

  /**
   * Builds the reel: an endless strip of item slots running past a centre
   * marker, which later decelerates onto whatever the server rolled.
   *
   * Nothing about the strip is a fixed-length track any more. A track long
   * enough to spin for four seconds is also a track that runs out: at 1920px
   * the old 44 cards left half a screen of empty band behind the winner, and
   * at any width it started flush against card zero with nothing to its left.
   * So the cards are virtualised instead -- a pool just big enough to cover
   * the viewport, recycled as it scrolls, reading its symbol from a function
   * of the virtual index. The strip is full at both edges at every width, and
   * `spin` can hold it cruising for as long as the server takes to answer.
   *
   * Every card except the winning one is filler, drawn from the reward types
   * this chest tier can produce (`contents` in the catalog). The filler is
   * decoration: it says what the chest *could* hold, and carries no amounts
   * and no odds.
   *
   * Geometry must match the stylesheet, or the reel stops between cards.
   */
  buildReel(tierId, fallbackColor) {
    const CARD_PX = 48;     // .reelcard width
    const GAP_PX = 8;       // .reel__track gap
    const PITCH = CARD_PX + GAP_PX;
    /** Cards held off each edge, so nothing is ever seen popping into place. */
    const LEAD = 2;

    /**
     * Cruise speed, px/sec, and the two ramps either side of it. Fast enough
     * to blur, slow enough that a tier colour still registers going past.
     *
     * Reduced motion keeps the reel -- it is what says the reward was drawn
     * rather than handed over -- but takes the four seconds of it down to a
     * short settle, which is the part that carries the meaning.
     */
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    const CRUISE = calm ? 700 : 1800;
    const SPINUP_MS = calm ? 90 : 320;
    const DECEL_MS = calm ? 520 : 2800;

    const tier = this.catalog?.chestTiers?.find((entry) => entry.id === tierId);
    const filler = tier?.contents?.length ? tier.contents : [{ type: 'gold' }];
    const tierColor = tier?.color ?? fallbackColor;

    const root = document.createElement('div');
    root.className = 'reel';

    // The clipped window. The marker sits outside it, because it overhangs the
    // band top and bottom and would be cut off by the same overflow that keeps
    // the cards inside.
    const view = document.createElement('div');
    view.className = 'reel__view';

    const track = document.createElement('div');
    track.className = 'reel__track';
    view.append(track);
    root.append(view);

    const marker = document.createElement('div');
    marker.className = 'reel__marker';
    marker.setAttribute('aria-hidden', 'true');
    root.append(marker);

    /**
     * Which reward sits at a virtual index.
     *
     * Hashed rather than `i % filler.length`, because a four-type pool cycled
     * in order reads as a visible repeating pattern at cruise speed -- the eye
     * locks onto it and the strip stops looking like a draw. Deterministic all
     * the same, so a recycled card that comes back to an index it has already
     * shown redraws the same thing.
     */
    let winnerIndex = null;
    let winnerReward = null;
    const symbolAt = (i) => {
      if (winnerIndex !== null && i === winnerIndex) return winnerReward;
      let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
      x ^= x >>> 13;
      x = Math.imul(x, 0xc2b2ae35);
      x ^= x >>> 16;
      return filler[Math.abs(x) % filler.length];
    };

    /** Draws `reward` into a pooled card, reusing the card's own nodes. */
    const paint = (card, reward, index) => {
      card.dataset.index = String(index);
      // Gem fillers carry no colour of their own -- the catalog's `contents`
      // is types, not items -- so the tier's own colour stands in.
      card.style.setProperty('--tint', reward.color ?? this.gemTierColor(reward) ?? tierColor);
      card.replaceChildren(this.rewardArtBox(reward, REEL_CARD_ART));
      card.title = this.rewardShortName(reward);
      card.classList.toggle('reelcard--won', winnerIndex !== null && index === winnerIndex);
    };

    /** The pool, sized to the current width and grown when the window is. */
    const pool = [];
    let width = 0;
    const fit = () => {
      width = root.clientWidth || window.innerWidth;
      const want = Math.ceil(width / PITCH) + LEAD * 2 + 1;
      while (pool.length < want) {
        const card = document.createElement('div');
        card.className = 'reelcard';
        card.dataset.index = '';
        pool.push(card);
        track.append(card);
      }
    };

    /** How far the strip has travelled, in px. Only ever increases. */
    let offset = 0;
    let velocity = 0;
    let phase = 'idle';       // idle | spinup | cruise | decel | done
    let raf = null;
    let last = 0;
    let onSettled = null;

    // Deceleration state.
    let decelFrom = 0;
    let decelDistance = 0;
    let decelStart = 0;

    /**
     * Lays the pool out for the current `offset`.
     *
     * Card `v` lives at screen x = `v * PITCH - offset`, so the leftmost one
     * still on screen is `floor(offset / PITCH)`. The track carries the
     * sub-card remainder as a transform and the pool carries the rest as
     * content, which is what keeps this to one composited property per frame.
     */
    const draw = () => {
      const first = Math.floor(offset / PITCH) - LEAD;
      const shift = offset - first * PITCH;
      track.style.transform = `translate3d(${-shift}px, 0, 0)`;
      for (let k = 0; k < pool.length; k += 1) {
        const index = first + k;
        const card = pool[k];
        if (card.dataset.index === String(index)) continue;
        paint(card, symbolAt(index), index);
      }
    };

    const settle = () => {
      if (phase === 'done') return;
      phase = 'done';
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      const done = onSettled;
      onSettled = null;
      if (done) done();
    };

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      // Clamped, so a backgrounded tab that resumes after ten seconds does not
      // teleport the strip a screen and a half in one step.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      if (phase === 'spinup') {
        velocity = Math.min(CRUISE, velocity + (CRUISE / (SPINUP_MS / 1000)) * dt);
        offset += velocity * dt;
        if (velocity >= CRUISE) phase = 'cruise';
      } else if (phase === 'cruise') {
        offset += CRUISE * dt;
      } else if (phase === 'decel') {
        const t = Math.min(1, (now - decelStart) / DECEL_MS);
        // Ease-out cubic: its slope at t=0 is 3x the average, which is what
        // `decelDistance` was solved for, so the strip leaves cruise speed
        // without a visible step down.
        offset = decelFrom + decelDistance * (1 - (1 - t) ** 3);
        if (t >= 1) {
          draw();
          settle();
          return;
        }
      }

      draw();
    };

    const run = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    return {
      root,

      /** Starts the strip moving and leaves it cruising until `land`. */
      start() {
        if (phase !== 'idle') return;
        fit();
        draw();
        phase = 'spinup';
        run();
      },

      /**
       * Injects `won` into the strip ahead of where it is now and eases onto it.
       *
       * The target is solved rather than chosen: an ease-out cubic covering
       * `d` in `T` leaves the start at `3d/T`, so `d = CRUISE * T / 3` is the
       * distance that continues cruise speed exactly. That lands between
       * cards, so the nearest whole card is taken and `d` recomputed -- the
       * half-card of slack that introduces is far below the step the eye can
       * see, and it is what guarantees the winner is centred rather than
       * merely close.
       */
      land(won, onDone) {
        if (phase === 'done') { onDone?.(); return; }
        onSettled = onDone;
        fit();
        if (phase === 'idle') { phase = 'cruise'; velocity = CRUISE; run(); }

        winnerReward = won;
        const wanted = CRUISE * (DECEL_MS / 1000) / 3;
        // Stop a little off-centre so the reel does not look mechanical. The
        // jitter is bounded well inside one card, so the card under the marker
        // is still unambiguously the one that was won.
        const jitter = (Math.random() - 0.5) * CARD_PX * 0.5;
        const centre = offset + wanted + width / 2 - CARD_PX / 2;
        winnerIndex = Math.max(Math.floor(offset / PITCH) + 4, Math.round(centre / PITCH));

        decelFrom = offset;
        decelDistance = (winnerIndex * PITCH + CARD_PX / 2 - width / 2 + jitter) - offset;
        decelStart = performance.now();
        phase = 'decel';

        // The winning index may already be inside the pool's window; repaint so
        // it carries the prize rather than the filler it was drawn with.
        for (const card of pool) {
          const index = Number(card.dataset.index);
          if (index === winnerIndex) paint(card, won, index);
        }
      },

      /** Cancels the loop. Safe to call at any phase, including mid-spin. */
      destroy() {
        onSettled = null;
        phase = 'done';
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        root.remove();
      },
    };
  }

  /**
   * The appraiser's counter: the stone on one side, the four traits it is
   * being graded on down the other, and its worth building up between them.
   *
   * The panel is built once, in its unappraised state -- every trait "??" and
   * no price. Nothing is sent until the player asks for the appraisal, so
   * closing this modal costs them nothing: the gem is still in the bag,
   * ungraded. Asking commits it, and the server's reply is what the reveal
   * below animates through.
   */
  showGemAppraisal(stack) {
    this.modalKind = 'gem';
    this.setModalChrome({ title: 'Gem Appraisal' });
    this.dom.modalBody.classList.add('modal__body--appraise');

    // Dollars per Gold, off the catalog. The appraiser quotes in dollars and
    // pays in Gold, and this is the only place the two are tied together.
    const rate = this.catalog?.goldDollarRate ?? 0;

    const wrap = document.createElement('div');
    wrap.className = 'appraise';

    /* The counter: gem and price on the left, the grade sheet on the right. */
    const counter = document.createElement('div');
    counter.className = 'appraise__counter';
    counter.style.setProperty('--tier', stack.color);

    const stone = document.createElement('div');
    stone.className = 'appraise__stone';

    // The sprite bobs on its own animation, so the swelling as grades land has
    // to happen on something else -- a transform here would be overwritten by
    // the keyframes the moment they ran.
    const gembox = document.createElement('div');
    gembox.className = 'appraise__gembox';

    const art = spriteIcon('gems', stack.tier, 5);
    if (art) {
      art.classList.add('appraise__gem');
      gembox.append(art);
    }
    stone.append(gembox);

    const price = document.createElement('div');
    price.className = 'appraise__price';
    price.textContent = '???';
    stone.append(price);

    // What this tier can fetch, quoted in dollars and pinned to the stone
    // itself rather than to a line of small print below the counter: it is the
    // stakes, so it belongs on the thing being staked. The quote that lands
    // above it is in the same money, which is what makes a good roll legible
    // -- $6 over "$1 - $8" says more than a Gold figure on its own can.
    const range = this.catalog?.gemTiers?.find((tier) => tier.id === stack.tier)?.gold;
    if (range) {
      const band = document.createElement('div');
      band.className = 'appraise__range';
      band.innerHTML = `<span>${escapeHtml(formatDollars(range.min, rate))}</span>`
        + ' &ndash; '
        + `<span>${escapeHtml(formatDollars(range.max, rate))}</span>`;
      stone.append(band);
    }

    const sheet = document.createElement('dl');
    sheet.className = 'appraise__sheet';

    // One row per trait, in the catalog's order. Each keeps a handle on its
    // value cell so the reveal can fill them in one at a time.
    const rows = (this.catalog?.appraisal?.traits ?? []).map((trait) => {
      const row = document.createElement('div');
      row.className = 'appraise__trait';

      // "Purity:" and "B" as one phrase rather than a label pushed to one edge
      // and a value to the other -- four rows of that read as a table, and this
      // is meant to read as the appraiser saying what he found.
      const label = document.createElement('dt');
      label.textContent = `${trait.name}:`;

      const value = document.createElement('dd');
      value.className = 'appraise__grade';
      value.textContent = '??';

      row.append(label, value);
      sheet.append(row);
      return { id: trait.id, row, value };
    });

    counter.append(stone, sheet);
    wrap.append(counter);

    /* What is on the counter, and what the tier is known to be worth. */
    const ticket = document.createElement('div');
    ticket.className = 'appraise__ticket';

    const ticketArt = spriteIcon('gems', stack.tier);
    if (ticketArt) ticket.append(ticketArt);

    const held = stack.ids.length;
    const perDollar = rate > 0 ? Math.round(1 / rate) : 0;

    const ticketText = document.createElement('div');
    ticketText.className = 'appraise__ticket-text';
    ticketText.innerHTML = `
      <b>${escapeHtml(stack.name)}${held > 1 ? ` &times;${held}` : ''}</b>
      <span>${perDollar
        ? `Paid in Gold Coin at ${formatNumber(perDollar)} to the dollar.`
        : 'Worth whatever it grades at.'}</span>
    `;
    ticket.append(ticketText);
    wrap.append(ticket);

    /* The counter's own foot: the one action, and how it should be played. */
    const foot = document.createElement('div');
    foot.className = 'appraise__foot';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn chestopen__spin';
    button.textContent = 'Appraise';
    foot.append(button);

    // A stone worth a few coins does not warrant three seconds of ceremony,
    // and a player working through a pocketful of them wants the Gold, not
    // the show. The choice is remembered, and only offered where it applies --
    // the top tiers are the ones the reveal exists for.
    const quick = this.quickAppraiseToggle(stack.tier);
    if (quick) foot.append(quick);

    wrap.append(foot);

    // Held for the reveal, which arrives as its own message rather than as a
    // return value, and so has to find the panel it belongs to.
    this.appraisal = { stack, rows, price, gembox, art, button, rate };

    button.onclick = () => {
      button.disabled = true;
      button.textContent = 'Appraising';
      this.net.appraiseGem(stack.ids[0]);
    };

    this.dom.modalBody.append(wrap);
    this.dom.modal.hidden = false;
  }

  /**
   * The "grade it instantly" checkbox, or null for a tier worth watching.
   *
   * Offered on the two cheapest stones only. On a Diamond the reveal *is*
   * the item -- a range that wide is why the four traits are graded one at a
   * time -- so skipping it there would be taking away the thing the panel is
   * for rather than saving anyone time.
   */
  quickAppraiseToggle(tierId) {
    const order = (this.catalog?.gemTiers ?? []).map((tier) => tier.id);
    const rank = order.indexOf(tierId);
    if (rank < 0 || rank > 1) return null;

    const names = (this.catalog?.gemTiers ?? []).slice(0, 2).map((tier) => tier.name);

    const label = document.createElement('label');
    label.className = 'appraise__quick';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.quickAppraise;
    box.addEventListener('change', () => {
      this.quickAppraise = box.checked;
      writeSetting(QUICK_APPRAISE_KEY, box.checked ? '1' : '0');
    });

    const text = document.createElement('span');
    text.textContent = `Grade instantly (${names.join(' and ')})`;

    label.append(box, text);
    return label;
  }

  /** Whether this stone should skip the trait-by-trait reveal. */
  gradesInstantly(tierId) {
    if (!this.quickAppraise) return false;
    const order = (this.catalog?.gemTiers ?? []).map((tier) => tier.id);
    const rank = order.indexOf(tierId);
    return rank >= 0 && rank <= 1;
  }

  /**
   * Plays the graded result back onto the open panel.
   *
   * Presentation only, exactly like the chest reel: the grades and the price
   * were rolled and paid on the server before this runs, and stepping through
   * them one at a time cannot change either. A player who closes the modal
   * mid-appraisal has still been paid -- the Gold is already in the wallet,
   * and the Log records the sale.
   */
  showGemAppraisalResult(result) {
    const panel = this.appraisal;
    if (!panel || this.modalKind !== 'gem') return;

    panel.button.textContent = 'Appraising';

    const grades = result.grades ?? [];
    // Each trait's share of the price, so the running total climbs in step
    // with the grades rather than jumping at the end.
    const total = grades.reduce((sum, trait) => sum + trait.score, 0) || 1;

    let paid = 0;
    panel.timers = [];

    /** Writes one trait's grade into its row, and the price it has earned. */
    const land = (trait, index) => {
      const row = panel.rows.find((candidate) => candidate.id === trait.id);
      if (row) {
        row.row.classList.remove('appraise__trait--reading');
        row.row.classList.add('appraise__trait--graded');
        row.value.textContent = trait.grade;
        row.value.style.color = trait.color;
      }

      paid += trait.score;
      // The last trait lands on the exact figure the server sent; the ones
      // before it show the share of it the grades so far have earned.
      const shown = index === grades.length - 1
        ? result.gold
        : Math.round(result.gold * (paid / total));
      // Quoted in dollars, the same money the range under the stone is in, so
      // the climbing figure can be read against what the tier was worth.
      panel.price.textContent = formatDollars(shown, panel.rate);
      panel.price.classList.add('appraise__price--counting');

      // The stone swells as it is graded, so the value climbing and the thing
      // being valued grow together rather than the number moving on its own.
      panel.gembox?.style.setProperty('--graded', String(index + 1));
    };

    const finish = () => {
      panel.price.textContent = formatDollars(result.gold, panel.rate);
      panel.price.classList.add('appraise__price--final');
      panel.gembox?.classList.add('appraise__gembox--valued');

      // The rough stone becomes the finished gem the moment it is done being
      // graded -- the same swap the appraiser is telling the player just
      // happened. Repainted in place, on the element that is already bobbing,
      // rather than swapping in a new one: the idle animation and swell
      // transform stay attached to the same node either way.
      if (panel.art) applySprite(panel.art, 'gemsCut', panel.stack.tier, 5);

      panel.button.disabled = false;
      panel.button.classList.add('appraise__claim');
      // The quote was in dollars; what changes hands is the Gold Coin it
      // converts to, so the button names them rather than repeating the price.
      panel.button.textContent = `Claim ${formatNumber(result.gold)} ${this.rewardName('gold')}`;
      panel.button.onclick = () => this.closeModal();
    };

    // The cheap stones, when the player has asked for it: every grade at once
    // and straight to the claim. The result is identical -- only the telling
    // of it is skipped.
    if (this.gradesInstantly(result.tier)) {
      grades.forEach(land);
      finish();
      return;
    }

    grades.forEach((trait, index) => {
      const row = panel.rows.find((candidate) => candidate.id === trait.id);

      panel.timers.push(setTimeout(() => {
        row?.row.classList.add('appraise__trait--reading');
        panel.timers.push(setTimeout(() => land(trait, index), GRADE_ROLL_MS));
      }, index * GRADE_STEP_MS));
    });

    panel.timers.push(setTimeout(
      finish,
      grades.length * GRADE_STEP_MS + GRADE_ROLL_MS + 220,
    ));
  }

  /* -------------------------------------------------------- disconnected */

  /**
   * How long the tab has been in the background, or was for the stretch it has
   * just come back from. Zero when the player has been here all along.
   *
   * The second case is the one that matters: a socket that died while the tab
   * slept is usually only found to be dead once the tab wakes up and tries to
   * use it, by which point the absence is already over.
   */
  awayFor() {
    const { hiddenSince, lastAwayMs, lastAwayEndedAt } = this.presence;
    if (hiddenSince) return Date.now() - hiddenSince;
    if (lastAwayEndedAt && Date.now() - lastAwayEndedAt < AWAY_GRACE_MS) return lastAwayMs;
    return 0;
  }

  /**
   * The end of the session, as a panel rather than a line in the status bar.
   *
   * A disconnect is not a warning, it is a full stop: the world on screen is
   * frozen, every button behind this does nothing, and the previous status
   * message was easy to sit staring past. So this one takes the screen, says
   * which of the three things happened, and offers the only move left.
   *
   * Deliberately not closable -- there is nothing to go back to. `closeModal`
   * refuses while this is up, which covers the scrim, the close button and
   * Escape in one place.
   */
  showDisconnected({ duplicate = false } = {}) {
    const away = this.awayFor();
    const idled = !duplicate && away >= AWAY_AFTER_MS;

    // A reveal caught mid-flight has queued timers pointed at rows this is
    // about to replace. The Gold was paid before the drop, so there is
    // nothing to finish.
    for (const timer of this.appraisal?.timers ?? []) clearTimeout(timer);
    this.appraisal = null;

    this.modalKind = 'disconnected';
    this.dom.modal.classList.add('modal--final');
    this.setModalChrome({ title: duplicate ? 'Fishing elsewhere' : 'Line gone slack' });

    const wrap = document.createElement('div');
    wrap.className = 'gone';

    const lede = document.createElement('p');
    lede.className = 'gone__lede';
    if (duplicate) {
      lede.textContent = 'You opened the harbor in another tab, and it took over your session.';
    } else if (idled) {
      lede.textContent = `You were away for ${formatDuration(away)}, and the harbor let your `
        + 'line go slack. Your catch, your bag and your rod are all safe.';
    } else {
      lede.textContent = 'The connection to the harbor dropped. Your catch, your bag and your '
        + 'rod are all safe.';
    }
    wrap.append(lede);

    // Everything is server-side and saved as it happens, so a rejoin is the
    // whole recovery. Saying so is the point of this line: the fear on seeing
    // a disconnect is having lost the last hour of idling.
    const note = document.createElement('p');
    note.className = 'gone__note';
    note.textContent = duplicate
      ? 'Carry on in that tab, or take the session back here.'
      : 'Rejoining picks up exactly where you left off.';
    wrap.append(note);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn gone__rejoin';
    button.textContent = duplicate ? 'Fish here instead' : 'Rejoin the harbor';
    // A reload rather than a reconnect in place: the session token is in
    // storage, so the server hands back the same angler, and starting from a
    // clean scene avoids reviving a world that has been frozen for an hour.
    button.addEventListener('click', () => window.location.reload());
    wrap.append(button);

    this.dom.modalBody.append(wrap);
    this.dom.modal.hidden = false;
    button.focus();
  }

  /* ---------------------------------------------------- lists and chat */

  /**
   * The leaderboard used to be an always-on sidebar list; it moved into a
   * modal so a rank check doesn't cost permanent screen space, the way the
   * shop and journal already work. It keeps its own dark chrome -- a board
   * of names is read, not worked in, so it doesn't need the parchment the
   * other dialogs use.
   */
  openLeaderboard() {
    this.modalKind = 'leaderboard';
    this.setModalChrome({ title: 'Top Robins', subtitle: 'Ranked by total catches', dark: true });
    this.dom.modalBody.classList.add('modal__body--leaderboard');

    this.lbList = document.createElement('ol');
    this.lbList.className = 'lb-list';
    this.dom.modalBody.append(this.lbList);

    this.renderLeaderboardList();
    this.dom.modal.hidden = false;
  }

  /**
   * Rows arrive over the network whether or not the modal happens to be
   * open, so this only caches them; the DOM only gets touched when there is
   * a live list to touch, which keeps a leaderboard push from resurrecting
   * a modal the player already closed.
   */
  renderLeaderboard(rows) {
    this.leaderboardRows = rows ?? [];
    if (this.modalKind === 'leaderboard') this.renderLeaderboardList();
  }

  renderLeaderboardList() {
    const list = this.lbList;
    if (!list) return;
    list.replaceChildren();

    const rows = this.leaderboardRows ?? [];
    if (rows.length === 0) {
      list.append(this.empty('No anglers ranked yet.'));
      return;
    }

    rows.forEach((row, index) => list.append(this.leaderboardRow(row, index + 1)));
  }

  leaderboardRow(row, rank) {
    const isMe = this.me && row.name === this.me.displayName;

    const item = document.createElement('li');
    item.className = `lb-row${isMe ? ' lb-row--me' : ''}`;

    const rankEl = document.createElement('span');
    rankEl.className = `lb-rank${rank <= 3 ? ` lb-rank--${rank}` : ''}`;
    rankEl.textContent = String(rank);

    const avatar = document.createElement('span');
    avatar.className = 'lb-avatar';
    avatar.style.background = avatarColor(row.name);
    avatar.textContent = row.name.trim().slice(0, 1).toUpperCase();
    avatar.setAttribute('aria-hidden', 'true');

    const id = document.createElement('div');
    id.className = 'lb-id';
    id.innerHTML = `
      <div class="lb-name${isMe ? ' lb-name--me' : ''}">${escapeHtml(row.name)}</div>
      <div class="lb-sub">Lv.${row.rodLevel} rod</div>
    `;

    const score = document.createElement('div');
    score.className = 'lb-score';
    const icon = spriteIcon('fish', 'golden_koi', fitScale('fish', 16));
    if (icon) {
      icon.classList.add('lb-score__icon');
      score.append(icon);
    }
    const scoreNum = document.createElement('span');
    scoreNum.textContent = `${formatNumber(row.totalCatches)} catches`;
    score.append(scoreNum);

    item.append(rankEl, avatar, id, score);
    return item;
  }

  /* --------------------------------------------------------- gold wallet */

  /**
   * The Gold pill's own screen: what Gold is for, what it costs at the locked
   * `goldDollarRate` anchor (the same rate the appraiser already quotes
   * against), how much of it to buy, and the actions a real wallet carries.
   *
   * Shaped like the purchase dialog it will one day be -- title over a centred
   * coin, the price on a pill under it, then an AMOUNT row and one full-width
   * action -- rather than like a balance readout, because that is the job it
   * is being built for.
   *
   * Monetization has not shipped yet, so every action here reports "not live
   * yet" instead of moving anything real. This settles the shape of that
   * screen ahead of the payment work that would sit behind it.
   *
   * Dark like the leaderboard rather than parchment like the shop: this is a
   * screen the player passes through, not a counter they work in.
   */
  openGoldWallet() {
    this.modalKind = 'goldwallet';
    this.setModalChrome({ title: 'Gold', dark: true, wallet: true });
    this.dom.modalBody.classList.add('modal__body--goldwallet');

    const me = this.me;
    if (!me) return;

    // Opens at nothing ordered, so the first thing the button says is the
    // errand the player came here for rather than a price they didn't ask for.
    this.goldBuy = { amount: 0, nodes: {} };

    this.dom.modalBody.append(...this.goldWalletContent(me));

    this.refreshGoldWallet();
    this.dom.modal.hidden = false;
  }

  /**
   * The Gold screen's body, in the order it is read.
   *
   * Built apart from the panel that holds it because it has two homes: its own
   * modal off the Gold chip, and a sheet over the Wallet, where it is the step
   * between having money and having something to spend at the counter.
   */
  goldWalletContent(me) {
    return [
      this.goldWalletHero(me),
      this.goldWalletAmount(),
      this.goldWalletActions(),
      this.goldWalletNote(),
    ];
  }

  /** The coin, what it is for, and the two numbers that price it. */
  goldWalletHero(me) {
    const rate = this.catalog?.goldDollarRate ?? 0;

    const hero = document.createElement('div');
    hero.className = 'gw-hero';

    const icon = this.currencyIcon('gold', GOLD_WALLET_ART);
    icon.classList.add('gw-hero__art');

    const line = document.createElement('p');
    line.className = 'gw-hero__line';
    line.textContent = 'Spend Gold on bait and rod levels.';

    const pills = document.createElement('div');
    pills.className = 'gw-pills';

    const balance = document.createElement('span');
    balance.className = 'gw-pill';
    balance.textContent = `You hold: ${formatNumber(me.gold)} Gold`;

    const usdgBalance = document.createElement('span');
    usdgBalance.className = 'gw-pill';
    usdgBalance.textContent = `USDG: ${this.formatUsdg(me.usdg ?? 0)}`;

    const price = document.createElement('span');
    price.className = 'gw-pill';
    price.textContent = rate
      ? `Price per Gold: ${formatDollars(1, rate)}`
      : 'Not priced yet';

    pills.append(balance, usdgBalance, price);
    hero.append(icon, line, pills);

    this.goldBuy.nodes.balance = balance;
    this.goldBuy.nodes.usdgBalance = usdgBalance;
    return hero;
  }

  /**
   * How much to buy.
   *
   * A plain box rather than the shop's slider and steps: the shop is bounded
   * by a shelf and a wallet and has to say so, and this is bounded by nothing
   * the client knows -- whatever payment eventually sits behind it is what
   * says no.
   */
  goldWalletAmount() {
    const row = document.createElement('div');
    row.className = 'gw-amount';

    const text = document.createElement('div');
    text.className = 'gw-amount__text';

    const label = document.createElement('div');
    label.className = 'gw-amount__label';
    label.textContent = 'Amount';

    const hint = document.createElement('div');
    hint.className = 'gw-amount__hint';
    hint.textContent = 'Buys Gold with the USDG in your wallet';

    text.append(label, hint);

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'gw-amount__input';
    input.min = '0';
    input.value = '0';
    input.setAttribute('aria-label', 'How much Gold to buy');
    input.addEventListener('input', () => {
      const wanted = Math.floor(Number(input.value));
      this.goldBuy.amount = Number.isFinite(wanted) && wanted > 0 ? wanted : 0;
      this.refreshGoldWallet();
    });

    row.append(text, input);
    this.goldBuy.nodes.input = input;
    return row;
  }

  /**
   * Buy, cash out, history -- the reference wallet's three jobs, with buying
   * spanning the row above the other two. Buying now goes through `goldPrimaryAction`
   * to a real `this.net.buyGold` call; cash out and history still have no
   * backend behind them, so those stay placeholder toasts.
   */
  goldWalletActions() {
    const wrap = document.createElement('div');
    wrap.className = 'gw-actions';

    const notLiveYet = (what) => this.toast(`${what} isn’t live yet.`, 'warn');

    const buy = this.goldWalletButton('Add Funds', 'gw-btn--primary', () => this.goldPrimaryAction());

    wrap.append(
      buy,
      this.goldWalletButton('Cash Out', 'gw-btn--secondary', () => notLiveYet('Cashing out Gold')),
      this.goldWalletButton('See History', 'gw-btn--secondary', () => notLiveYet('Transaction history')),
    );

    this.goldBuy.nodes.buy = buy;
    return wrap;
  }

  /**
   * What the primary does, which follows what it says.
   *
   * With nothing typed it is not a purchase, it is the errand before one:
   * "Add Funds" is about getting money in, and money gets in at the Wallet,
   * so that is where it goes. With an amount typed it is the purchase itself
   * -- sent to the server, which spends USDG and grants Gold at the locked
   * rate (see `buyGoldWithUsdg` in server/src/game/economy.js); a shortfall
   * comes back as a server error and toasts the usual way.
   */
  goldPrimaryAction() {
    const amount = this.goldBuy?.amount ?? 0;
    if (amount > 0) {
      this.net.buyGold(amount);
      return;
    }

    // Opened as a sheet, the Wallet is already underneath -- so this puts the
    // sheet away and unfolds the deposit section there, rather than stacking a
    // second copy of the panel over the first.
    if (this.modalKind === 'wallet' && this.wallet) {
      this.closeSheet();
      this.toggleWalletTransfer(true);
      return;
    }

    this.openWallet({ deposit: true });
  }

  /**
   * The primary carries the order once there is one.
   *
   * Nothing typed is not an error -- it is a player who came to top up and has
   * not said how much yet, so the button stays the errand ("Add Funds") until
   * an amount turns it into a price.
   */
  refreshGoldWallet() {
    if (!this.goldBuy) return;

    const { amount, nodes } = this.goldBuy;
    // A screen that has since been closed leaves its state behind for a tick.
    if (!nodes.buy?.isConnected) return;

    const rate = this.catalog?.goldDollarRate ?? 0;

    if (nodes.balance && this.me) {
      nodes.balance.textContent = `You hold: ${formatNumber(this.me.gold)} Gold`;
    }
    if (nodes.usdgBalance && this.me) {
      nodes.usdgBalance.textContent = `USDG: ${this.formatUsdg(this.me.usdg ?? 0)}`;
    }

    nodes.buy.textContent = amount > 0 && rate
      ? `Buy ${formatNumber(amount)} Gold for ${formatDollars(amount, rate)}`
      : 'Add Funds';
  }

  goldWalletButton(label, variantClass, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `gw-btn ${variantClass}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  /** The caveat the reference wallet didn't need and this one does. */
  goldWalletNote() {
    const note = document.createElement('p');
    note.className = 'gw-note';
    note.textContent = 'Buying Gold spends the USDG in your wallet at the rate above. '
      + 'Cashing out isn’t live yet.';
    return note;
  }

  /* -------------------------------------------------------------- wallet */

  /**
   * The USDG wallet: the account, what it holds, and every way money moves in
   * or out of it.
   *
   * USDG is the cash side of the same anchor Gold is priced against -- one
   * Gold is `goldDollarRate` of it -- so this panel is the layer under the
   * Gold screen rather than a second version of it: money arrives here, and
   * turns into Gold there.
   *
   * NOTHING HERE MOVES REAL MONEY. Deposit and Buy Gold now hold a real,
   * server-persisted balance (`player.usdg`, see server/src/db/models.js) and
   * actually spend it -- but there is still no payment gateway or chain behind
   * either: `depositUsdg` (server/src/game/economy.js) credits USDG straight
   * to the wallet on request. The account itself is still not a real one --
   * there is no address to hand out and no chain to withdraw to, so it reads
   * "Not connected" and cashout/swap/withdraw still report "not live yet".
   * See `goldWalletNote` for the same caveat on the Gold screen.
   *
   * `deposit: true` opens with the transfer section already unfolded, which is
   * what the Deposit chip in the top bar wants -- it is a shortcut to that one
   * row, not a second door onto the panel.
   */
  openWallet({ deposit = false } = {}) {
    this.modalKind = 'wallet';
    this.setModalChrome({ title: 'Wallet', dark: true, wallet: true });
    this.dom.modalBody.classList.add('modal__body--wallet');

    this.wallet = { transferOpen: deposit, nodes: {} };

    this.dom.modalBody.append(
      this.walletAccount(),
      this.walletBalances(),
      this.walletActions(),
      this.walletTransfer(),
      this.walletCashout(),
      this.walletCommunity(),
      this.walletNote(),
    );

    this.refreshWallet();
    this.dom.modal.hidden = false;
  }

  /**
   * Whose wallet this is.
   *
   * The reference names the account by its address. There is no account to
   * name yet and inventing one would be worse than useless -- an address on a
   * screen is somewhere people send money -- so this says so plainly and the
   * chevron stays inert until there is something to unfold.
   */
  walletAccount() {
    const row = document.createElement('div');
    row.className = 'wal-account';

    const dot = document.createElement('span');
    dot.className = 'wal-account__dot';

    const name = document.createElement('span');
    name.className = 'wal-account__name';
    name.textContent = this.me?.nearAccountId ?? 'No wallet connected';

    const chevron = document.createElement('span');
    chevron.className = 'wal-account__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';

    row.append(dot, name, chevron);
    return row;
  }

  /** What the wallet holds: the cash, and the Gold that cash turns into. */
  walletBalances() {
    const list = document.createElement('div');
    list.className = 'wal-balances';

    const usdg = this.walletBalanceRow({
      key: 'usdg',
      icon: this.usdgIcon(WALLET_ROW_ART),
      label: 'USDG',
      value: this.formatUsdg(this.me?.usdg ?? 0),
    });

    const goldIcon = this.currencyIcon('gold', WALLET_ROW_ART);
    goldIcon.classList.add('wal-row__art');
    const gold = this.walletBalanceRow({
      key: 'gold',
      icon: goldIcon,
      label: 'Gold',
      value: formatNumber(this.me?.gold ?? 0),
    });

    list.append(usdg, gold);
    return list;
  }

  walletBalanceRow({ key, icon, label, value }) {
    const row = document.createElement('div');
    row.className = 'wal-row';

    const name = document.createElement('span');
    name.className = 'wal-row__name';
    name.textContent = label;

    const amount = document.createElement('b');
    amount.className = 'wal-row__value';
    amount.textContent = value;

    row.append(icon, name, amount);
    this.wallet.nodes[`${key}Value`] = amount;
    return row;
  }

  /**
   * The three ways in: put money in, turn money into Gold, or move between
   * this and another coin. Deposit leads because it is the one that has to
   * happen first.
   */
  walletActions() {
    const wrap = document.createElement('div');
    wrap.className = 'wal-actions';

    const deposit = this.goldWalletButton('Deposit', 'gw-btn--primary', () => this.toggleWalletTransfer());
    deposit.setAttribute('aria-expanded', 'false');

    wrap.append(
      deposit,
      this.goldWalletButton('Buy Gold to Play', 'gw-btn--secondary gw-btn--wide', () => this.openBuyGoldSheet()),
      this.goldWalletButton('Swap USDG <> ETH', 'gw-btn--secondary gw-btn--wide', () => this.openSwapSheet()),
    );

    this.wallet.nodes.deposit = deposit;
    return wrap;
  }

  /**
   * Deposit, unfolded: which coin, over which network, and how much to add.
   *
   * It expands in place rather than opening a sheet, because an amount is
   * something a player types while looking at the rest of their wallet -- the
   * reference does the same for its address field. What the button does
   * depends on `catalog.deposits.mode`: 'chain' sends USDC on NEAR and the
   * server credits it from the chain, 'fake' (dev only) credits it directly,
   * 'off' disables it.
   */
  walletTransfer() {
    const box = document.createElement('div');
    box.className = 'wal-transfer';

    const head = document.createElement('div');
    head.className = 'wal-transfer__head';
    const title = document.createElement('span');
    title.className = 'wal-transfer__title';
    title.textContent = 'Deposit USDG';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wal-transfer__close';
    close.setAttribute('aria-label', 'Hide transfer details');
    close.textContent = '×';
    close.addEventListener('click', () => this.toggleWalletTransfer(false));
    head.append(title, close);

    const grid = document.createElement('div');
    grid.className = 'wal-transfer__grid';
    const deposits = this.catalog?.deposits ?? { mode: 'off' };
    const onChain = deposits.mode === 'chain';
    grid.append(
      this.walletField('Currency', this.walletSelect([onChain ? 'USDC' : 'USDG'])),
      this.walletField('Network', this.walletSelect(onChain ? ['NEAR'] : WALLET_NETWORKS)),
    );

    const amountLabel = document.createElement('div');
    amountLabel.className = 'wal-transfer__label';
    amountLabel.textContent = 'Amount';

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.className = 'wal-input';
    amount.min = '0';
    amount.step = '0.01';
    amount.placeholder = '0.00';
    amount.setAttribute('aria-label', 'How much USDG to deposit');
    amount.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') confirm.click();
    });

    const confirm = this.goldWalletButton('Deposit', 'gw-btn--primary gw-btn--wide', () => {
      const value = Number(amount.value);
      if (!Number.isFinite(value) || value <= 0) {
        this.toast('Enter an amount to deposit.', 'warn');
        return;
      }
      const usdg = Math.round(value * 100) / 100;
      if (deposits.mode === 'fake') {
        this.net.depositUsdg(usdg);
      } else if (onChain) {
        this.sendChainDeposit(deposits, usdg, confirm);
      }
    });
    confirm.disabled = deposits.mode === 'off';

    const hint = document.createElement('p');
    hint.className = 'wal-transfer__hint';
    hint.textContent = {
      chain: 'Sends USDC from your NEAR wallet. 1 USDC = $1.00 USDG, credited once the transfer is final.',
      fake: 'Dev mode: credited straight to your wallet. Nothing is charged.',
      off: 'Deposits are not open yet.',
    }[deposits.mode];

    box.append(head, grid, amountLabel, amount, confirm, hint);
    this.wallet.nodes.transfer = box;
    this.wallet.nodes.depositAmount = amount;
    return box;
  }

  /** Opens the wallet to send USDC, then hands the transaction hash to the server. */
  async sendChainDeposit(deposits, usdg, button) {
    const accountId = this.me?.nearAccountId;
    if (!accountId) {
      this.toast('Sign in with a NEAR wallet to deposit.', 'warn');
      return;
    }
    button.disabled = true;
    try {
      const { sendUsdcDeposit } = await import('../net/nearWallet.js');
      const txHash = await sendUsdcDeposit({ deposits, accountId, usdg });
      this.net.claimDeposit(txHash);
      this.toast('Transfer sent. Confirming on NEAR...', 'good');
    } catch (error) {
      console.error('USDC deposit failed:', error);
      this.toast(error?.message || 'The deposit did not go through.', 'warn');
    } finally {
      button.disabled = false;
    }
  }

  /** Shows or hides the transfer section, and tells the button which it is. */
  toggleWalletTransfer(open = !this.wallet.transferOpen) {
    this.wallet.transferOpen = open;
    this.wallet.nodes.transfer.hidden = !open;
    this.wallet.nodes.deposit.setAttribute('aria-expanded', String(open));
  }

  /**
   * The way out: Gold back to USDG, USDG back to a chain, and the record of
   * both. Boxed off from the actions above because money leaving is a
   * different decision from money arriving, and should not sit one careless
   * click away from it.
   */
  walletCashout() {
    const box = document.createElement('div');
    box.className = 'wal-cashout';

    const title = document.createElement('div');
    title.className = 'wal-cashout__title';
    title.textContent = 'Cashout';

    // The route the money takes, drawn rather than described: Gold becomes
    // USDG, and USDG becomes a coin on a chain.
    const route = document.createElement('div');
    route.className = 'wal-route';
    const goldIcon = this.currencyIcon('gold', WALLET_ROUTE_ART);
    goldIcon.classList.add('wal-route__art');
    const held = document.createElement('b');
    held.className = 'wal-route__held';
    held.textContent = '0';
    const toUsdg = document.createElement('span');
    toUsdg.className = 'wal-route__arrow';
    toUsdg.textContent = '→';
    const usdgIcon = this.usdgIcon(WALLET_ROUTE_ART);
    const toChain = document.createElement('span');
    toChain.className = 'wal-route__arrow';
    toChain.textContent = '→';
    const chain = document.createElement('span');
    chain.className = 'wal-route__chain';
    chain.textContent = 'ETH or SOL';
    route.append(goldIcon, held, toUsdg, usdgIcon, toChain, chain);

    const pair = document.createElement('div');
    pair.className = 'wal-cashout__pair';
    pair.append(
      this.goldWalletButton('Sell Gold', 'gw-btn--secondary', () => this.openSellGoldSheet()),
      this.goldWalletButton('Withdraw USDG', 'gw-btn--secondary', () => this.openWithdrawSheet()),
    );

    const history = this.goldWalletButton('See History', 'gw-btn--quiet', () => this.openHistorySheet());

    const note = document.createElement('p');
    note.className = 'wal-cashout__note';
    note.textContent = 'Gold sales are processed in batches; you can then '
      + 'withdraw the USDG to ETH or SOL.';

    box.append(title, route, pair, history, note);
    this.wallet.nodes.routeHeld = held;
    return box;
  }

  /** The one button here that is not about money. */
  walletCommunity() {
    return this.goldWalletButton('Discord', 'gw-btn--discord', () => {
      this.toast('No Discord invite is set up yet.', 'warn');
    });
  }

  walletNote() {
    const note = document.createElement('p');
    note.className = 'gw-note';
    note.textContent = 'Deposits and buying Gold credit your wallet directly, with no '
      + 'real payment gateway behind them yet. Swaps and withdrawals aren’t live yet.';
    return note;
  }

  /** Repaints the two balances and the route's Gold count. */
  refreshWallet() {
    if (!this.wallet) return;

    const { nodes } = this.wallet;
    const gold = this.me?.gold ?? 0;
    const usdg = this.me?.usdg ?? 0;

    nodes.usdgValue.textContent = this.formatUsdg(usdg);
    nodes.goldValue.textContent = formatNumber(gold);
    nodes.routeHeld.textContent = formatNumber(gold);

    if (this.wallet.transferOpen !== undefined) {
      nodes.transfer.hidden = !this.wallet.transferOpen;
      nodes.deposit.setAttribute('aria-expanded', String(this.wallet.transferOpen));
    }
  }

  /* ------------------------------------------------------- wallet sheets */

  /**
   * A dialog over the wallet, in the same terms as the shop's Custom sheet: a
   * layer inside the modal card, so the panel it came from is still there
   * behind it and closing one does not close the other.
   */
  openSheet(title, build) {
    this.closeSheet();

    const layer = document.createElement('div');
    layer.className = 'wsheet';
    layer.addEventListener('mousedown', (event) => {
      if (event.target === layer) this.closeSheet();
    });

    const card = document.createElement('div');
    card.className = 'wsheet__card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', title);

    const head = document.createElement('div');
    head.className = 'wsheet__head';
    const heading = document.createElement('h3');
    heading.className = 'wsheet__title';
    heading.textContent = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wsheet__close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => this.closeSheet());
    head.append(heading, close);

    const body = document.createElement('div');
    body.className = 'wsheet__body';
    body.append(...build());

    card.append(head, body);
    layer.append(card);
    this.dom.modalCard.append(layer);

    this.sheet = { layer };
    close.focus();
  }

  closeSheet() {
    if (!this.sheet) return;
    this.sheet.layer.remove();
    this.sheet = null;
  }

  /** The Gold screen, over the wallet rather than instead of it. */
  openBuyGoldSheet() {
    const me = this.me;
    if (!me) return;

    this.goldBuy = { amount: 0, nodes: {} };
    this.openSheet('Gold', () => this.goldWalletContent(me));
    this.refreshGoldWallet();
  }

  /**
   * Swap: one coin in, another out, at a rate nobody is quoting yet.
   *
   * Both amounts are inert. A swap screen's whole job is to show a price, and
   * there is no market behind this one -- so it shows the shape of the trade
   * and says outright that the numbers are not live.
   */
  openSwapSheet() {
    this.openSheet('Swap', () => {
      const pay = this.walletSwapSide('You pay', 'ETH');
      const flip = document.createElement('div');
      flip.className = 'wal-swap__flip';
      flip.setAttribute('aria-hidden', 'true');
      flip.textContent = '⇅';
      const receive = this.walletSwapSide('You receive (estimated)', 'USDG');

      const details = document.createElement('div');
      details.className = 'wal-details';
      details.append(
        this.walletDetailRow('Slippage tolerance', '0.50%'),
        this.walletDetailRow('Network', 'Not connected'),
        this.walletDetailRow('Rate', 'No quote yet'),
      );

      return [pay, flip, receive, details, this.walletSheetActions('Swap', 'Swapping')];
    });
  }

  /** One half of the swap: which coin, and how much of it. */
  walletSwapSide(label, currency) {
    const side = document.createElement('div');
    side.className = 'wal-swap__side';

    const caption = document.createElement('div');
    caption.className = 'wal-swap__caption';
    caption.textContent = label;

    const coin = document.createElement('div');
    coin.className = 'wal-swap__coin';
    coin.append(currency === 'USDG' ? this.usdgIcon(WALLET_ROW_ART) : this.walletCoinDot(currency));
    const name = document.createElement('b');
    name.textContent = currency;
    coin.append(name);

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.className = 'wal-swap__amount';
    amount.min = '0';
    amount.placeholder = '0.0';
    amount.setAttribute('aria-label', `${label}, in ${currency}`);

    const balance = document.createElement('div');
    balance.className = 'wal-swap__balance';
    balance.textContent = 'Balance: not connected';

    side.append(caption, coin, amount, balance);
    return side;
  }

  /**
   * Selling Gold back.
   *
   * The quote is the same locked `goldDollarRate` the Gold screen buys at,
   * shown here rather than a spread, because there is no market making one --
   * when there is, this is the line it changes.
   */
  openSellGoldSheet() {
    this.openSheet('Sell Back Gold', () => {
      const rate = this.catalog?.goldDollarRate ?? 0;
      const held = this.me?.gold ?? 0;

      const hero = document.createElement('div');
      hero.className = 'gw-hero';
      const icon = this.currencyIcon('gold', GOLD_WALLET_ART);
      icon.classList.add('gw-hero__art');
      const line = document.createElement('p');
      line.className = 'gw-hero__line';
      line.textContent = 'Sell unused Gold back for USDG at the current quoted price.';
      hero.append(icon, line);

      const row = document.createElement('div');
      row.className = 'gw-amount';
      const text = document.createElement('div');
      text.className = 'gw-amount__text';
      const label = document.createElement('div');
      label.className = 'gw-amount__label';
      label.textContent = 'Amount';
      const hint = document.createElement('div');
      hint.className = 'gw-amount__hint';
      hint.textContent = 'Sell Gold for USDG';
      text.append(label, hint);

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'gw-amount__input';
      input.min = '0';
      input.max = String(WALLET_SELL_LIMIT);
      input.value = '0';
      input.setAttribute('aria-label', 'How much Gold to sell back');

      row.append(text, input);

      const limit = document.createElement('p');
      limit.className = 'wal-quote wal-quote--limit';
      limit.textContent = `Max ${formatNumber(WALLET_SELL_LIMIT)} Gold per withdrawal. `
        + `You hold ${formatNumber(held)}.`;

      const quote = document.createElement('p');
      quote.className = 'wal-quote';

      const sell = this.goldWalletButton('Sell Back', 'gw-btn--primary', () => {
        this.toast('Selling Gold back isn’t live yet.', 'warn');
      });

      const price = () => {
        const wanted = Math.floor(Number(input.value));
        const amount = Number.isFinite(wanted) && wanted > 0
          ? Math.min(wanted, WALLET_SELL_LIMIT)
          : 0;
        quote.textContent = amount && rate
          ? `~${formatDollars(amount, rate)} USDG`
          : 'Enter an amount to see what it is worth.';
      };
      input.addEventListener('input', price);
      price();

      return [hero, row, limit, quote, sell];
    });
  }

  /**
   * Withdrawing.
   *
   * The one screen here that asks for something rather than showing it, so it
   * carries the two warnings a withdrawal screen owes a player: what the
   * process actually does, and that an address typed wrong cannot be undone.
   * The button still only reports "not live yet" -- nothing is sent anywhere.
   */
  openWithdrawSheet() {
    this.openSheet('Withdraw Funds', () => {
      const currency = this.walletField('From Currency', this.walletSelect(['USDG']));
      const chain = this.walletField('Destination Chain', this.walletSelect(WALLET_NETWORKS));

      const address = document.createElement('input');
      address.type = 'text';
      address.className = 'wal-input';
      address.placeholder = '0x…';
      address.spellcheck = false;
      address.setAttribute('aria-label', 'Recipient address');
      const addressField = this.walletField(
        'Recipient Address',
        address,
        'The address on that chain where you want to receive your funds.',
      );

      const amount = document.createElement('input');
      amount.type = 'number';
      amount.className = 'wal-input';
      amount.min = '0';
      amount.placeholder = '0.0';
      amount.setAttribute('aria-label', 'Amount to withdraw');
      const amountField = this.walletField(
        'Amount to Withdraw',
        amount,
        `Balance: ${this.formatUsdg(this.me?.usdg ?? 0)} USDG`,
      );

      const process = document.createElement('div');
      process.className = 'wal-process';
      const processTitle = document.createElement('div');
      processTitle.className = 'wal-process__title';
      processTitle.textContent = 'Withdrawal process';
      const steps = document.createElement('ol');
      steps.className = 'wal-process__steps';
      for (const step of [
        'Your USDG is bridged to the chain you picked.',
        'It is then sent to the address you entered.',
        'Nothing is bridged or sent today: payments are not live.',
      ]) {
        const li = document.createElement('li');
        li.textContent = step;
        steps.append(li);
      }
      process.append(processTitle, steps);

      const warning = document.createElement('p');
      warning.className = 'wal-warning';
      warning.textContent = '⚠ Double-check the recipient address. A transfer sent '
        + 'to the wrong one cannot be reversed.';

      return [
        currency,
        chain,
        addressField,
        amountField,
        process,
        warning,
        this.walletSheetActions('Start Withdrawal', 'Withdrawing'),
      ];
    });
  }

  /** Everything that has ever left the wallet, which is nothing. */
  openHistorySheet() {
    this.openSheet('Withdrawal History', () => {
      const empty = document.createElement('p');
      empty.className = 'wal-empty';
      empty.textContent = 'No withdrawals yet';
      return [empty];
    });
  }

  /* ------------------------------------------------ wallet: small parts */

  /** Cancel beside the action the sheet is named for. */
  walletSheetActions(label, gerund) {
    const row = document.createElement('div');
    row.className = 'wal-sheetactions';
    row.append(
      this.goldWalletButton('Cancel', 'gw-btn--secondary', () => this.closeSheet()),
      this.goldWalletButton(label, 'gw-btn--primary', () => {
        this.toast(`${gerund} isn’t live yet.`, 'warn');
      }),
    );
    return row;
  }

  /** A labelled control, with the note that explains it underneath. */
  walletField(label, control, hint = '') {
    const field = document.createElement('label');
    field.className = 'wal-field';

    const caption = document.createElement('span');
    caption.className = 'wal-field__label';
    caption.textContent = label;
    field.append(caption, control);

    if (hint) {
      const note = document.createElement('span');
      note.className = 'wal-field__hint';
      note.textContent = hint;
      field.append(note);
    }

    return field;
  }

  walletSelect(options) {
    const select = document.createElement('select');
    select.className = 'wal-select';
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = option;
      select.append(item);
    }
    return select;
  }

  walletDetailRow(label, value) {
    const row = document.createElement('div');
    row.className = 'wal-details__row';
    const key = document.createElement('span');
    key.textContent = label;
    const amount = document.createElement('b');
    amount.textContent = value;
    row.append(key, amount);
    return row;
  }

  /**
   * USDG to the cent, always.
   *
   * `formatDollars` drops the cents on a whole number, which is right for a
   * price quoted in passing and wrong for a balance: money in a wallet reads
   * as money at two decimal places and as a mistake at none.
   */
  formatUsdg(amount = 0) {
    return `$${(Number(amount) || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  /**
   * USDG's own mark, at whatever size the caller has room for.
   *
   * Its art is vector rather than one of the pixel sheets `spriteIcon` draws
   * from -- the coin is money from outside the harbour and is drawn that way
   * -- so it is a background image rather than a sprite frame.
   */
  usdgIcon(box = WALLET_ROW_ART) {
    const icon = document.createElement('span');
    icon.className = 'wal-coin wal-coin--usdg';
    icon.style.width = `${box}px`;
    icon.style.height = `${box}px`;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  /** The same disc for a chain coin the game has no art for either. */
  walletCoinDot(currency) {
    const icon = document.createElement('span');
    icon.className = 'wal-coin';
    icon.style.width = `${WALLET_ROW_ART}px`;
    icon.style.height = `${WALLET_ROW_ART}px`;
    icon.textContent = currency.slice(0, 1);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  renderPlayers() {
    const players = [...this.net.players.entries()];
    const list = this.dom.players;
    list.replaceChildren();

    this.dom.onlineCount.textContent = `(${players.length})`;

    players.sort(([, a], [, b]) => b.rodLevel - a.rodLevel);

    for (const [sessionId, player] of players) {
      const item = document.createElement('li');
      const isMe = sessionId === this.net.sessionId;
      item.innerHTML = `
        <span class="dot ${player.online ? '' : 'dot--away'}"></span>
        <span class="${isMe ? 'you' : ''}">${escapeHtml(player.name)}</span>
        <div class="board__sub">Lv.${player.rodLevel}${player.casting ? ' &middot; casting' : ''}</div>
      `;
      list.append(item);
    }
  }

  /**
   * Minimizes the chat card to its title rail, or restores it.
   *
   * One place owns the class, the two aria states, the stored preference and
   * the unread dot, because they only ever change together. `persist: false`
   * is for moves the player did not ask for -- the first paint, and Enter
   * reaching past a minimized card to type -- which should not overwrite the
   * choice they last made with the button.
   */
  setChatMinimized(minimized, { persist = true } = {}) {
    const { chatPanel, chatToggle, chatMin } = this.dom;
    chatPanel.classList.toggle('is-collapsed', minimized);
    if (minimized) {
      // A minimized card cannot show a composer; leaving the class on would
      // restore it mid-sentence with a stale height.
      chatPanel.classList.remove('is-composing');
    } else {
      this.chatUnread = false;
      chatPanel.classList.remove('is-unread');
    }
    chatToggle.setAttribute('aria-expanded', String(!minimized));
    chatMin.setAttribute('aria-expanded', String(!minimized));
    chatMin.setAttribute('aria-label', minimized ? 'Expand chat' : 'Minimize chat');
    chatMin.setAttribute('title', minimized ? 'Expand chat' : 'Minimize chat');
    if (persist) writeSetting(CHAT_MINIMIZED_KEY, minimized ? '1' : '0');
  }

  /** Dots the rail when something is said to a card that is minimized. */
  markChatUnread() {
    if (!this.dom.chatPanel.classList.contains('is-collapsed')) return;
    this.chatUnread = true;
    this.dom.chatPanel.classList.add('is-unread');
  }

  appendChat(entry) {
    const key = `${entry.at}|${entry.name}|${entry.text}`;
    if (this.seenChat.has(key)) return;
    this.seenChat.add(key);

    const list = this.dom.chat;
    // Follow the log only when the player has not scrolled up to read history.
    const pinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;

    const item = document.createElement('li');
    item.innerHTML = `
      <span class="chat__time">${formatTime(entry.at)}</span>
      <span class="chat__who">${escapeHtml(entry.name)}:</span>
      <span>${escapeHtml(entry.text)}</span>
    `;
    list.append(item);

    while (list.children.length > 60) list.firstElementChild.remove();
    if (pinned) list.scrollTop = list.scrollHeight;
    // Backlog replayed into an already-minimized card is not news, so only
    // live lines light the dot.
    if (!this.hydratingChat) this.markChatUnread();
  }

  systemChat(text) {
    const item = document.createElement('li');
    item.innerHTML = `<span class="chat__who chat__who--system">harbor:</span> <span>${escapeHtml(text)}</span>`;
    this.dom.chat.append(item);
    this.dom.chat.scrollTop = this.dom.chat.scrollHeight;
    this.markChatUnread();
  }

  /* ------------------------------------------------------------ feedback */

  onServerError(error) {
    // An open that never landed must not leave Open all marching through the
    // rest of the stack against a server that just refused one.
    if (this.chest) this.chest.auto = false;
    clearTimeout(this.chestTimer);

    // Running out of bait is an expected state, not an error banner.
    if (error.code === 'NO_BAIT') {
      this.setStatus('Out of bait. Buy more in the shop, or wait for the free trickle.', 'warn', 6000);
      this.renderCastIdleLabel();
      return;
    }
    // Likewise a full fish bag: it stops the loop the same way running out of
    // bait does, and the fix is a click away in the same bag, not an error.
    if (error.code === 'FISH_BAG_FULL') {
      this.setStatus('Your fish bag is full. Cash some in for Fishing Power to keep fishing.', 'warn', 6000);
      this.renderCastIdleLabel();
      return;
    }
    if (error.code === 'RATE_LIMITED' || error.code === 'CHAT_COOLDOWN') {
      this.toast(error.message, 'error');
      return;
    }
    this.toast(error.message || 'Something went wrong.', 'error');
  }

  toast(message, kind = '') {
    const node = document.createElement('div');
    node.className = `toast ${kind ? `toast--${kind}` : ''}`;
    node.textContent = message;
    this.dom.toasts.append(node);

    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 220ms ease';
      setTimeout(() => node.remove(), 240);
    }, TOAST_MS);

    while (this.dom.toasts.children.length > 4) {
      this.dom.toasts.firstElementChild.remove();
    }
  }

  /**
   * A "you got an item" banner, BOTW-style: a rectangular strip at the right
   * edge of the screen carrying the item's own art and name, that slides in,
   * sits for a few seconds, then slides back out. This is for things that
   * land in the bag -- a catch, a chest found -- not for economy confirmations
   * (those stay `toast`, which reads as a message rather than an object).
   *
   * `sheet`/`spriteId` pick the art the same way a bag slot does; pass
   * `sheet: null` for something with no sprite sheet entry, and the banner
   * falls back to a flat tinted swatch instead of leaving a blank gap.
   */
  showPickup({ sheet, spriteId, scale = 1, tierColor, name, sub }) {
    const node = document.createElement('div');
    node.className = 'pickup';
    if (tierColor) node.style.setProperty('--tier-color', tierColor);

    const swatch = document.createElement('span');
    swatch.className = 'pickup__swatch';
    node.append(swatch);

    const art = (sheet ? spriteIcon(sheet, spriteId, scale) : null)
      ?? document.createElement('span');
    art.classList.add('pickup__art');
    node.append(art);

    const body = document.createElement('div');
    body.className = 'pickup__body';
    const nameEl = document.createElement('div');
    nameEl.className = 'pickup__name';
    nameEl.textContent = name;
    body.append(nameEl);
    if (sub) {
      const subEl = document.createElement('div');
      subEl.className = 'pickup__sub';
      subEl.textContent = sub;
      body.append(subEl);
    }
    node.append(body);

    this.dom.pickups.append(node);

    setTimeout(() => {
      node.classList.add('pickup--leaving');
      setTimeout(() => node.remove(), 240);
    }, PICKUP_MS);

    while (this.dom.pickups.children.length > MAX_PICKUPS) {
      this.dom.pickups.firstElementChild.remove();
    }
  }

  setStatus(message, kind = '', autoHideMs = 4000) {
    const { status } = this.dom;
    status.textContent = message;
    status.className = `status ${kind ? `status--${kind}` : ''}`;
    status.hidden = false;

    clearTimeout(this.statusTimer);
    if (autoHideMs > 0) {
      this.statusTimer = setTimeout(() => this.clearStatus(), autoHideMs);
    }
  }

  clearStatus() {
    clearTimeout(this.statusTimer);
    this.dom.status.hidden = true;
  }

  closeModal() {
    // The disconnect panel is the end of the session, not a dialog over it.
    if (this.modalKind === 'disconnected') return;

    // The shop's Custom sheet is a layer over the counter rather than another
    // panel beside it, so the first Escape (or close) puts the sheet away and
    // leaves the shop open behind it. The wallet's sheets work the same way.
    if (this.shop?.amount) {
      this.closeShopAmount();
      return;
    }
    if (this.sheet) {
      this.closeSheet();
      return;
    }

    this.dom.modal.hidden = true;
    this.modalKind = null;
    this.dom.modalBody.classList.remove('modal__body--appraise', 'modal__body--shop', 'modal__body--leaderboard', 'modal__body--goldwallet', 'modal__body--wallet');
    this.dom.modal.classList.remove('modal--full', 'modal--wide', 'modal--keeper', 'modal--dark', 'modal--wallet');
    // All three point at panels that are about to be thrown away.
    this.goldBuy = null;
    this.wallet = null;
    this.sheet = null;
    this.dom.modalKeeper.hidden = true;
    this.dom.modalSubtitle.hidden = true;

    // Points at a list node that is about to be thrown away; the next open
    // rebuilds it fresh rather than finding a stale reference reused.
    this.lbList = null;

    // The shop's quantity is remembered for the next visit; its node
    // references are not, because they point at a panel that is now gone.
    if (this.shop) {
      this.shop.nodes = {};
      this.shop.amount = null;
    }

    // Closing mid-run ends the run. Everything already opened has been rolled
    // and paid, so there is nothing to unwind -- only the queued step to drop.
    clearTimeout(this.chestTimer);
    // rAF holds the reel, not the DOM, so a strip left spinning would keep
    // running against a detached node for as long as the tab is open.
    this.stopReel();
    this.chest = null;

    // An appraisal closed part-way through leaves timers queued against
    // elements that are no longer on the page. The Gold is already paid, so
    // there is nothing to finish -- drop the rest of the reveal.
    for (const timer of this.appraisal?.timers ?? []) clearTimeout(timer);
    this.appraisal = null;
  }

  /* ------------------------------------------------------------- helpers */

  /**
   * Sets the modal's heading and which of its two shapes it takes.
   *
   * Every opener goes through here, because the alternative -- each one setting
   * the title and remembering to undo whatever the last one turned on -- is how
   * a panel ends up full-screen because the chest before it was.
   *
   * `full` drops the card entirely: the content goes on the dimmed world, with
   * the heading at the top and the actions at the foot of the screen. It is for
   * the moments the game wants the whole screen -- opening a chest is one.
   *
   * `wide` keeps the card but widens it, for a panel laid out in columns rather
   * than in rows -- the shop's shelf is the one that needs it.
   *
   * `keeper` stands the bait seller over the top of the card. Only the shop
   * has a person behind it, so only the shop asks for him.
   *
   * `dark` swaps the parchment card for a night-dark one with gold text --
   * for a board that's read rather than worked in, like the leaderboard.
   */
  setModalChrome({ title, subtitle = '', full = false, wide = false, keeper = false, dark = false, wallet = false }) {
    const { modal, modalTitle, modalSubtitle, modalBody, modalKeeper } = this.dom;

    modalTitle.textContent = title;
    modalSubtitle.textContent = subtitle;
    modalSubtitle.hidden = !subtitle;
    modal.classList.toggle('modal--full', full);
    modal.classList.toggle('modal--wide', wide);
    // The class reserves the room above the card that he stands in; the
    // `hidden` attribute is what actually puts him there.
    modal.classList.toggle('modal--keeper', keeper);
    modalKeeper.hidden = !keeper;
    modal.classList.toggle('modal--dark', dark);
    modal.classList.toggle('modal--wallet', wallet);

    modalBody.classList.remove('modal__body--appraise', 'modal__body--shop', 'modal__body--leaderboard', 'modal__body--goldwallet', 'modal__body--wallet');
    modalBody.replaceChildren();
  }

  sectionTitle(text) {
    const node = document.createElement('h3');
    node.className = 'section-title';
    node.textContent = text;
    return node;
  }

  empty(text) {
    const node = document.createElement('p');
    node.className = 'empty';
    node.textContent = text;
    return node;
  }

  rewardName(id) {
    return this.catalog?.rewardTypes.find((reward) => reward.id === id)?.name ?? id;
  }

  fishName(speciesId) {
    return this.catalog?.fish.find((fish) => fish.id === speciesId)?.name ?? speciesId;
  }

  rewardIcon(id) {
    return this.catalog?.rewardTypes.find((reward) => reward.id === id)?.icon ?? 'xp';
  }

  rewardLabel(reward) {
    // A gem carries its own tier name ("Uncut Sapphire"); the generic reward
    // name would flatten all four into "Uncut Gem".
    if (reward.type === 'uncut_gem') return reward.name ?? 'Uncut Gem';
    return `+${formatNumber(reward.amount)} ${this.rewardName(reward.type)}`;
  }
}
