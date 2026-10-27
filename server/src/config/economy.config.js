/**
 * Three-tier currency shop: Bait > Gold Coin > Pearl.
 *
 * ASSUMPTION (A8): The contract requires a shop and a three-tier currency but
 * fixes no prices. The pack *sizes* below still match the shop mockup
 * (design/mockups/04); the Gold prices no longer do -- they were re-derived
 * against the current gem values, and the reasoning is written out above
 * SHOP_ITEMS.
 *
 * NO PAY-TO-WIN / NO REAL MONEY: every `cost` is denominated in an in-game
 * currency that is earned through play. There is no real-money code path
 * anywhere in this project, by contract.
 *
 * Pearl (tier 3) was named Gems until it was renamed to stop colliding with
 * the uncut gems in the bag -- an uncut gem is an item worth grading, this is
 * a wallet balance, and the shared name made the two easy to confuse.
 */

export const CURRENCIES = [
  { id: 'bait',   name: 'Bait',      tier: 1, description: 'Spent on every cast.' },
  { id: 'gold',   name: 'Gold Coin', tier: 2, description: 'Earned from catches. Buys bait, and skips rod levels.' },
  { id: 'pearls', name: 'Pearl',     tier: 3, description: 'Rare chest drops. Nothing at the harbour takes them yet.' },
];

export const CURRENCY_IDS = CURRENCIES.map((currency) => currency.id);

export const CURRENCIES_BY_ID = Object.freeze(
  Object.fromEntries(CURRENCIES.map((currency) => [currency.id, currency])),
);

/**
 * The harbour's bait reservoir.
 *
 * Bait is not minted on demand: the chandlery holds a finite pool of it that
 * every player buys out of, so a run on the shop is felt by everyone at the
 * dock. `capacity` is both the amount it opens with and the ceiling it can
 * ever hold -- see `returnBaitToStock` in game/economy.js for why the two are
 * the same number.
 *
 * Counted in single bait, not in packs, so a 200-bait bucket and twenty
 * 10-bait tins draw exactly the same amount out of it.
 */
export const BAIT_STOCK = {
  capacity: 50_000,
  /** What a world with no saved stock opens with. */
  initial: 50_000,
};

/**
 * The tabs the shop's type filter offers. `all` is synthesised by the client.
 *
 * Bait is the only one, because bait is the only thing on the shelf. A `gear`
 * tab stood here while the gem-priced tackle was displayed-but-locked; with
 * that stock gone the tab could only ever have drawn an empty shelf.
 */
export const SHOP_ITEM_TYPES = [
  { id: 'bait', name: 'Bait' },
];

/**
 * grants: what one purchase adds. Keys are currency ids or consumable ids.
 * cost:   { currency, amount } -- always an in-game currency.
 * type:   which filter tab the item sits under.
 * sprite: { sheet, id } for the shop grid; falls back to `icon` when absent.
 *
 * The chandlery sells bait and nothing else. It used to also display a gold
 * pouch and two tackle charms carrying `purchasable: false`, priced in Pearl
 * and drawn greyed behind a `lockedReason` -- a shelf of things that could be
 * looked at but never bought. They are gone rather than hidden: an item nobody
 * can buy is not stock, it is an advertisement for a counter that does not
 * open.
 *
 * `purchasable: false` is still honoured by `purchase()`, so a future item can
 * go up unsellable without a code change, and the server still refuses such a
 * sale itself rather than trusting the client to hide the button. The two
 * consumables those charms granted are unaffected -- `lucky_charm` and
 * `power_lure` are chest rewards, and still drop and still work.
 *
 * WHY ONE ITEM, AND WHY 100 BAIT FOR 3 GOLD.
 *
 * `design/gold-value-anchor-rebalance-plan.md` locks $0.10 = 1 Gold ahead of
 * monetization actually shipping. The bait side of that anchor was first set
 * at 1 Bait = 3 Gold, which left the fishing loop Gold-negative at every rung
 * of the Stake ladder; Mike's call is **100 Bait = 3 Gold**, a hundredth of
 * that rate, and this file is where it lives.
 *
 * The shelf used to be four packs (Tin/Pot/Bucket/Crate, 10/50/200/1000 Bait)
 * with bulk discounts -- see git history if that shape is ever wanted back.
 * Section 8 of that plan left open whether the price should keep the pack
 * structure or become one flat rate; the call was flat, so there is one item
 * and one rate. It is a 100-Bait unit rather than a fractionally-priced single
 * bait because both `cost.amount` and the Gold wallet are whole numbers.
 *
 * `purchase()` multiplies a single item's `cost`/`grants` by quantity, so the
 * quantity-step buttons (`PURCHASE_QUANTITIES` below) are what let a player
 * buy in bulk -- x10 of this item is 1,000 Bait for 30 Gold, the same rate as
 * x1. The reservoir, not the price, is what caps a big order: 50,000 bait on
 * the shelf is 500 units, well under `MAX_PURCHASE_QUANTITY`.
 *
 * The rest of that plan (Sections 1-5: cast cost, gem values, drop rates) is
 * still open -- this change is only the shop price itself.
 */
export const SHOP_ITEMS = [
  {
    id: 'bait',
    // Named for the unit it actually sells, so the 3-Gold price chip on the
    // shelf cannot be read as the price of one bait.
    name: 'Bait x100',
    type: 'bait',
    typeName: 'Bait',
    icon: 'bait',
    sprite: { sheet: 'bait', id: 'bait' },
    description: 'Bait for the next casts, at the locked rate: 100 Bait for 3 Gold.',
    cost: { currency: 'gold', amount: 3 },
    grants: { bait: 100 },
    purchasable: true,
  },
];

export const SHOP_ITEMS_BY_ID = Object.freeze(
  Object.fromEntries(SHOP_ITEMS.map((item) => [item.id, item])),
);

/**
 * Guard against a client asking to buy a million of something in one message.
 *
 * Sized to the shop's largest quantity button. It is not the real limit on a
 * purchase -- the wallet and the bait reservoir both bite long before this
 * does -- it is the cap on how much arithmetic one message can ask for.
 */
export const MAX_PURCHASE_QUANTITY = 1000;

/** Quantity buttons the shop offers, biggest last. */
export const PURCHASE_QUANTITIES = [1, 10, 30, 100, 300, 1000];

/**
 * Bounds on the USDG wallet.
 *
 * There is still no payment backend behind a deposit (see the wallet panel's
 * own comments in client/src/ui/hud.js) -- `depositUsdg` in game/economy.js
 * credits the balance directly. These limits exist only so one message cannot
 * hand a player an unbounded balance while that is true; none of them reflect
 * a real payment processor's limit.
 */
export const USDG_LIMITS = {
  /** Smallest deposit a single message may credit. */
  minDeposit: 1,
  /** Largest deposit a single message may credit. */
  maxDeposit: 5_000,
  /** Wallet balance ceiling, so repeated deposits cannot run away unbounded. */
  maxBalance: 20_000,
  /** Largest single Gold purchase, mirroring the client's sell-back limit. */
  maxGoldPurchase: 50_000,
};
