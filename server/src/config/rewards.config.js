/**
 * Treasure chests, uncut gems and the reward types they roll into.
 *
 * Follows the GDD (v1.3) chest model: a chest yields a stone matched to its
 * rarity, or one of a short list of other things. Uncut gems are held in the
 * bag and taken to an appraiser, who grades them and pays what they are worth
 * in Gold.
 *
 * ASSUMPTION (A3): the GDD fixes four container tiers but not the bonus rolls
 * or the relative weights inside a chest. Those are the invented parts, as are
 * the gem names -- Emerald, Ruby, Sapphire and Diamond, one per chest rarity,
 * so the stone a player sees in the bag and the rarity swatch beside it agree.
 *
 * A3b: the GDD has Common/Epic/Legendary chests yielding Sparks and Legendary
 * carrying a bonus fish roll ("Bonus Catch"). Both were removed from the chest
 * tables first, and have since been removed from the game outright: Sparks
 * were never earnable by any other means, so the rod-upgrade panel is
 * Gold-only now (see `progression.js`), and Bonus Catch never did anything a
 * real catch didn't already do better. See CHEST_TIERS.
 *
 * A3a: the GDD's Gold ranges have since been replaced outright, on a design
 * call that the four tiers should feel meaningfully different without the
 * lower ones being useless. See GEM_TIERS.
 *
 * NO REAL MONEY: the GDD's monetisation section has Gems bought with real
 * money. That is out of scope by contract and is deliberately not implemented
 * -- the currency here (Pearl) is earned from Epic and Legendary chests only.
 * It is named apart from the uncut gems in the bag on purpose: an uncut gem is
 * an item worth grading, Pearl is a wallet balance, and sharing the name
 * "Gems" between the two used to make them easy to confuse.
 */

/**
 * The 5 reward types the game knows how to render. `kind` tells the grant
 * logic where each one lands.
 *
 * Being listed here says the game can *name and draw* the thing, not that
 * anything currently hands it out. Four come out of a chest (uncut_gem, bait,
 * pearls, xp) and Gold comes from an appraisal.
 *
 * Lucky Charm and Power Lure are not chest rewards either -- the GDD's chest
 * table has no room for them -- but they remain buyable in the shop, so the
 * consumable system they drive is unchanged.
 */
export const REWARD_TYPES = [
  { id: 'uncut_gem', name: 'Uncut Gem',     kind: 'uncut_gem', icon: 'gem',   description: 'A rough stone. Have it appraised for Gold Coin.' },
  { id: 'gold',      name: 'Gold Coin',     kind: 'currency',  icon: 'coin',  description: 'Soft currency for restocking bait, and the only currency that skips a rod level.' },
  { id: 'bait',      name: 'Bait',          kind: 'currency',  icon: 'bait',  description: 'Consumed on every cast.' },
  { id: 'pearls',    name: 'Pearl',         kind: 'currency',  icon: 'pearl', description: 'Rare currency from the deepest chests.' },
  { id: 'xp',        name: 'Fishing Power', kind: 'xp',        icon: 'xp',    description: 'Progress toward the next rod level.' },
];

export const REWARD_TYPE_IDS = REWARD_TYPES.map((reward) => reward.id);

export const REWARD_TYPES_BY_ID = Object.freeze(
  Object.fromEntries(REWARD_TYPES.map((reward) => [reward.id, reward])),
);

/**
 * What one coin is worth in the appraiser's own money: $0.10, i.e. 10 Gold
 * to the dollar.
 *
 * NOT REAL MONEY, and nothing here can be bought with any. The appraiser
 * quotes a stone in dollars because that is how the tiers were designed and
 * how a range reads at a glance -- "$100 - $1,000" says more about a Legendary
 * than "1,000 - 10,000 Gold" does. He still pays in Gold, and the payout
 * button converts the quote back at this rate.
 */
export const GOLD_DOLLAR_RATE = 0.1;

/**
 * Uncut gems, one per chest rarity, and what an appraisal can value them at.
 *
 * BACK ON THE GDD'S SHAPE, on Mike's call (Sep 2026). An earlier pass spaced
 * the tiers -- each floor near the tier below's ceiling -- so that a bad
 * Diamond still beat a good Sapphire. Every tier now starts at $1 again, which
 * is what the GDD specified: the tiers differ in how high they *can* go, not in
 * where they bottom out, and a badly graded Legendary genuinely can pay what a
 * Common pays.
 *
 * That is the trade being made deliberately: the appraisal gets its full range
 * of tension back at every tier, at the cost of a bad roll on a rare stone
 * being a real disappointment. Read with APPRAISAL_GRADES below -- the grade
 * ladder is weighted toward its low end (D/C/B are 85% of a trait), so the
 * *mean* sits well under each range's midpoint and the ceiling is a tail, not
 * something a player expects to see.
 *
 * Quoted in dollars -- to the design, and on the appraisal panel itself --
 * at GOLD_DOLLAR_RATE above:
 *
 *   Common     $1 - $10       Epic        $1 - $667
 *   Rare       $1 - $80       Legendary   $1 - $2,500
 */
export const GEM_TIERS = [
  { id: 'emerald',  name: 'Uncut Emerald',  color: '#50c878', gold: { min: 10, max: 100 } },
  { id: 'ruby',     name: 'Uncut Ruby',     color: '#c41e3a', gold: { min: 10, max: 800 } },
  { id: 'sapphire', name: 'Uncut Sapphire', color: '#0f52ba', gold: { min: 10, max: 6670 } },
  { id: 'diamond',  name: 'Uncut Diamond',  color: '#b9f2ff', gold: { min: 10, max: 25000 } },
];

export const GEM_TIERS_BY_ID = Object.freeze(
  Object.fromEntries(GEM_TIERS.map((gem) => [gem.id, gem])),
);

/** Hard cap on unappraised gems, so the bag stays a bag. */
export const MAX_UNCUT_GEMS = 120;

/**
 * What the appraiser grades a stone on, in the order the grades come back.
 *
 * Four traits rather than one number: a single roll gives the player one
 * moment, four graded in turn gives them four -- and the last one still
 * matters, because every trait moves the price.
 */
export const APPRAISAL_TRAITS = [
  { id: 'purity',  name: 'Purity' },
  { id: 'clarity', name: 'Clarity' },
  { id: 'weight',  name: 'Weight' },
  { id: 'cut',     name: 'Cut' },
];

/**
 * The grade ladder, worst first. A grade's *index* is its score, and the four
 * scores together place the stone inside its tier's Gold range -- so the
 * grades a player watches land are what set the price, rather than decoration
 * around a number rolled separately.
 *
 * `weight` is the grade's independent probability per trait, in percent --
 * the six figures sum to exactly 100, so `gdd-balance.js` and
 * `balanceModel.js` both read `weight / 100` straight off this table with no
 * separate normalisation step.
 *
 * 2026-09-08: rescaled from the old {7, 17, 27, 24, 16, 9} ladder (mean 2.52
 * of 5) to this steeper one (mean 1.38 of 5) on a design call that high
 * grades, and payouts near a tier's ceiling, should be substantially rarer.
 * A+ and S together were 25% of a trait before; they are 3% now. Every gem
 * tier's mean appraisal fell by roughly a third as a result -- see
 * `design/balance-tables.md` (`node server/tools/gdd-balance.js --write`).
 */
export const APPRAISAL_GRADES = [
  { id: 'D',  color: '#8d7358', weight: 25 },
  { id: 'C',  color: '#8a63d2', weight: 30 },
  { id: 'B',  color: '#4a9fd8', weight: 30 },
  { id: 'A',  color: '#3fae6a', weight: 12 },
  { id: 'A+', color: '#f0a41f', weight: 2.8 },
  { id: 'S',  color: '#e0524a', weight: 0.2 },
];

export const APPRAISAL_GRADES_BY_ID = Object.freeze(
  Object.fromEntries(APPRAISAL_GRADES.map((grade) => [grade.id, grade])),
);

/** Best a stone can be graded: every trait at the top of the ladder. */
export const MAX_APPRAISAL_SCORE = APPRAISAL_TRAITS.length * (APPRAISAL_GRADES.length - 1);

/** Effect of one consumable unit, applied server-side per cast. */
export const CONSUMABLE_EFFECTS = {
  lucky_charm: { casts: 20, rarityBias: 1.6, catchRateMult: 1.0, xpMult: 1.0 },
  power_lure:  { casts: 20, rarityBias: 1.0, catchRateMult: 1.25, xpMult: 1.35 },
};

/**
 * Treasure chest tiers.
 *
 * A chest yields exactly **one** reward. Each tier is a single weighted table
 * and opening the chest draws from it once -- which is what makes the opening
 * a spin with a result rather than a bundle being handed over.
 *
 * Reward priority runs Fishing Power (XP) first, then Bait, then the tier's
 * uncut gem, and -- in the top two tiers -- Pearl last. XP is the everyday
 * progression currency so it wins most often; the gem is now the rare
 * "big ticket" roll rather than the default outcome.
 *
 * A chest holds four things and no more: its gem, Bait, Fishing Power, and --
 * in the top two tiers -- Pearl. Three types were deliberately taken out:
 *
 *   Gold    the gem is how a chest becomes Gold, and only once it has been
 *           appraised. Paying Gold alongside it made the gem the slow route
 *           to the same thing, and made the appraisal skippable.
 *   Spark   removed on request, and later removed from the game entirely --
 *           this was the only source of Sparks, so once it was gone the
 *           currency had no way to be earned. The rod-upgrade panel now
 *           charges Gold only.
 *   Fish    ("Bonus Catch") removed on request, and later removed from the
 *           game entirely. Species are caught by fishing, which is where a
 *           catch means something; a free one from a chest did not.
 *
 * The weight those entries held was not reassigned when they were removed --
 * the rest of the table simply renormalised over it.
 *
 * Every other entry's amounts are sized so that `weight/total x amount` lands
 * near what that reward type used to contribute when a chest paid out three to
 * five items at once, so per-chest Bait, Fishing Power and Pearl income is
 * broadly unchanged. `node tools/balance.js` prints the per-tier figures.
 *
 * `weight`     relative chance of this entry being the one that lands
 * `min`/`max`  inclusive amount range, rolled after the entry is picked
 * `gemTier`    for gem entries: which stone goes into the bag
 */
export const CHEST_TIERS = [
  {
    id: 'common',
    name: 'Common Chest',
    color: '#a8763f',
    rewardTable: [
      { type: 'uncut_gem', gemTier: 'emerald', weight: 14 },
      { type: 'bait',  weight: 22, min: 1, max: 10 },
      { type: 'xp',    weight: 55, min: 5, max: 12 },
    ],
  },
  {
    id: 'rare',
    name: 'Rare Chest',
    color: '#4a9fd8',
    rewardTable: [
      { type: 'uncut_gem', gemTier: 'ruby', weight: 15 },
      { type: 'bait',   weight: 22, min: 1, max: 20 },
      { type: 'xp',     weight: 55, min: 23, max: 49 },
    ],
  },
  {
    id: 'epic',
    name: 'Epic Chest',
    color: '#a95fd8',
    rewardTable: [
      { type: 'uncut_gem', gemTier: 'sapphire', weight: 14 },
      { type: 'bait',  weight: 16, min: 10, max: 50 },
      { type: 'xp',    weight: 54, min: 77, max: 155 },
      { type: 'pearls', weight: 5,  min: 24,  max: 52   },
    ],
  },
  {
    id: 'legendary',
    name: 'Legendary Chest',
    color: '#f5c542',
    rewardTable: [
      { type: 'uncut_gem', gemTier: 'diamond', weight: 10 },
      { type: 'xp',     weight: 54, min: 345, max: 719 },
      { type: 'pearls', weight: 6,  min: 58,   max: 126  },
      { type: 'bait',   weight: 11, min: 50, max: 80 },
    ],
  },
];

export const CHEST_TIER_IDS = CHEST_TIERS.map((tier) => tier.id);

export const CHEST_TIERS_BY_ID = Object.freeze(
  Object.fromEntries(CHEST_TIERS.map((tier) => [tier.id, tier])),
);

/**
 * A reward table as probabilities rather than weights.
 *
 * A chest pays exactly one reward, drawn once from its table (see `openChest`
 * in game/chests.js), so an entry's share of the total weight *is* its chance
 * -- there is no ordering effect and nothing to convolve. Exact, and identical
 * for every player, which is why this can be built at config load and shipped
 * in the catalog rather than recomputed per player.
 *
 * Lives here rather than in game/odds.js so that config stays a leaf: the
 * catalog needs these figures at module load, and a config file reaching into
 * game logic to get them would invert the dependency.
 *
 * Amounts are deliberately left out. What a reward rolls *within* its range is
 * the part of a chest worth opening it to find out.
 */
export function chestContentOdds(rewardTable = []) {
  const total = rewardTable.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  return rewardTable.map(({ type, gemTier, weight }) => ({
    type,
    ...(gemTier ? { gemTier } : {}),
    chance: weight / total,
  }));
}

/**
 * Relative weights for which chest tier drops, applied only across the tiers
 * the player's stake actually allows (see `chestTiers` on STAKE_LEVELS in
 * game.config.js). Biased at roll time by the rarity of the fish that produced
 * the chest.
 *
 * 2026-09-08: rescaled from {600, 280, 100, 20} to this ~53:30:24-times
 * cascade, together with every rod's `chestChance` in rods.config.js (both
 * scaled down together -- see that file's own note), so that at Stake 10
 * (the one rung where all four tiers are simultaneously allowed) a Rod 1
 * cast reads Common 1-in-121, Rare 1-in-6,458, Epic 1-in-195,916, Legendary
 * 1-in-4,226,505 -- matching, in scale and cascade, a reference "Sacks of
 * Treasure" screenshot Mike wanted the Odds tab's four numbers to land near.
 * A chest is now roughly 8x rarer overall at that rung than it was before
 * this change, which moves `design/balance-tables.md` and the emission
 * monitor's calibration: regenerate the tables with
 * `node server/tools/gdd-balance.js --write` and re-check the monitor's
 * thresholds in game.config.js against the new mint rate before shipping.
 *
 * The other four stakes (1, 5, 20, 40) still gate tiers out entirely rather
 * than just making them rare -- e.g. Rare/Epic/Legendary still read "never"
 * at Stake 1 -- because `chestTiers` on STAKE_LEVELS is a hard allow-list
 * this rescale did not touch. That is unchanged, original design ("the one
 * place a Stake choice changes *what* a player can win"), not a bug this
 * pass left behind.
 */
export const CHEST_TIER_WEIGHTS = {
  common: 48000,
  rare: 810,
  epic: 24,
  legendary: 1,
};

/** Hard cap on unopened chests held at once, so the inventory view stays sane. */
export const MAX_UNOPENED_CHESTS = 60;
