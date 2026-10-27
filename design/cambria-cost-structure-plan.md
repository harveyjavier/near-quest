# Balance Update Plan: Matching Cambria's Cost Structure

*How to bring our economy's actual prices in line with Cambria's cost structure (Keys, Grub, rod costs, Cursed Attractors) — without copying its real-money numbers, since our game has no monetization and Cambria's do.*

## 0. Why this isn't a 1:1 number copy

Cambria's prices are all anchored to USDC (10 Dungeon Keys = $1). Ours aren't anchored to anything external — Gold and Pearl only exist because a player fished them. Copying "Ember Rod costs 30 Keys" as "a rod costs 30 Gold" would be copying a number that means something completely different in each economy: in Cambria it's a few minutes of somebody's paycheck, in ours it would be whatever 30 Gold happens to be worth relative to how fast a player earns Gold today.

So every number below is derived the same way: take the *shape* of Cambria's cost curve (how bait compares to a permanent upgrade, how a stack of luck-upgrades escalates, how a full-completion gate works), then scale that shape using our own game's actual Gold/Pearl-per-hour figures from `design/balance-tables.md`, so the result is priced in *our* terms — hours of play, not dollars.

This plan extends [[cambria-balance-plan]] (`design/cambria-inspired-balance-plan.md`) and its build prompt (`BALANCE_PASS_BUILD_PROMPT.md`, currently scoped to Steps 1, 3 and 5). It refines Step 1, and it fully specifies Step 4 (giving Pearl a purpose), which was previously left as an open question.

## 1. What Cambria actually charges, and the ratios worth keeping

From the cost breakdown already gathered this session:

| Cambria item | Cost | What it implies, structurally |
| --- | --- | --- |
| Grub (bait) | 3 Keys / 100 Grub ($0.003/unit) | Bait is cheap per-unit, by design — it's the thing you spend constantly |
| Ember Rod | 30 Keys ($3.00) | A permanent upgrade costs roughly **1,000× one unit of bait** |
| Cursed Attractors, 10 tiers | 10 / 20 / 30 … 100 Keys (linear: tier *N* costs 10×*N* Keys) | A simple, escalating cost curve — no tier costs less than the one before it, and the top tier costs exactly 10× the first |
| All 10 Attractors, Key cost alone | ~550 Keys (~$55) | The *sticker price* of full completion |
| Favor gate to unlock all 10 tiers | ~194,400 cumulative Grub bought (~5,832 Keys / ~$583 worth of bait, over time) | The *real* cost of full completion is the cumulative grind/spend gate, not the sticker price — full completion is a long-term, invested-player goal, not an impulse buy |
| Combined Attractor effect | +54% Attraction, hard-capped at 90% overall return rate | No matter how many tiers stack, there's an explicit ceiling on the combined benefit |

Two shapes are worth keeping: **bait is cheap relative to permanent upgrades** (~1,000:1), and **a stack of optional power-ups escalates linearly and is hard-capped**, with full completion gated behind sustained play rather than a single purchase.

## 2. Bait re-pricing — refining Step 1 with a second anchor

The existing plan's Bait target ("one average Uncut Emerald buys about one bag-session of Bait") still stands as the primary anchor. Cambria's own bait-to-rod ratio (~1,000:1) is a useful cross-check, but it's a noisy one: depending on which of our rod tiers you treat as Ember's equivalent, it suggests anywhere from ~0.13 to ~2.2 Gold/Bait for the Crate pack — too wide a range to set a number from directly. Use it only as a direction-check (it agrees that Bait should get *more* expensive, not cheaper), and let the gem-based anchor and `node server/tools/gdd-balance.js --write` set the actual figure, exactly as Step 1 in the build prompt already specifies. No change to that step's target is needed here — this section exists so the reasoning is written down, not to move the number.

Leave the existing Gold rod-skip curve (30 → 72 → 132 → 228 → 372 → 600 → 930 → 1,440 → 2,196 Gold) untouched. Its own per-level growth rate (each tier costing roughly 1.5–1.6× the one before, tapering down from an initial 2.4×) already resembles Cambria's approach of later tiers costing meaningfully more in absolute terms — there's no gap here to close.

## 3. New: the Charm Rack — a Pearl-priced Cursed-Attractor equivalent

This is new scope, not a re-price of something that exists. It closes the GDD's Opportunity #1 ("give Pearl a purpose") by giving Pearl exactly the role Keys play for Cursed Attractors in Cambria — except priced in Pearl rather than Gold, since Gold already has two sinks (Bait, rod skips) and Pearl currently has none.

**Structure — 10 permanent tiers, escalating linearly, matching Cambria's shape:**

Tier *N* costs `k × N` Pearl, exactly mirroring Cursed Attractors' `10 × N` Keys formula — just re-scaled to `k`, a constant sized to our own Pearl economy (see below) rather than Cambria's.

**Sizing `k` from our own numbers, not Cambria's:** pick a target number of hours of sustained (not maximum-grind) endgame play to fully max the Rack, and back it out of a realistic Pearl/hour figure from `design/balance-tables.md`'s Hourly-economy table — not the single highest number on the sheet, which assumes uninterrupted play at the most extreme setting. Rod 10, Balanced, Stake 10 earns 168.90 Pearl/hour and is a reasonable stand-in for "an engaged player pushing their best sustainable setup." Targeting roughly 40 hours of that kind of play to fully max the Rack gives a total budget of about 6,750 Pearl. Since the 10 tiers sum to `55k`, that's `k ≈ 125`: tier 1 costs 125 Pearl, tier 10 costs 1,250 Pearl, all ten together cost 6,875 Pearl.

Treat the 40-hour target and the resulting 125-Pearl-per-tier constant as a starting point for Mike to confirm or adjust, not a final number — the actual target completion time is a product decision (how big a long-term goal Pearl collectors should be chasing), not something derivable purely from the math.

**What each tier does, and the hard cap that has to ship with it:** each tier should add a small, additive increase to Uncut Gem drop weight inside chest reward tables (the same reward type Cambria's Attractors boost, translated into our reward-table structure) — summing to roughly +50% relative at all ten tiers owned, deliberately just under Cambria's +54%. The combined effect **must** be clamped in code to a fixed ceiling (mirroring Cambria's 90%-RTP cap, and reusing the exact clamp-the-combined-multiplier pattern already designed for the buff-stacking cap that was cut from the build prompt as premature — it wasn't needed while no buffs existed, but the Charm Rack is a real, shipping stack of multipliers, so that same defensive pattern is needed here, not deferred). Verify with the same method Step 2 would have used: simulate all ten tiers owned at max rod and Risky/Stake 40, and confirm expected Gold-per-hour doesn't blow past roughly 1.5–2x the no-Rack baseline.

**The Favor-gate, translated to a game with no real money:** Cambria's Attractors aren't just Key-gated, they're Favor-gated — full completion requires a long cumulative Grub-buying history, not just having 550 Keys on hand today. The equivalent here, without needing real money, is a lifetime counter — total Bait ever purchased with Gold (a new stat on the player document, incremented in the same `purchase()` path in `server/src/game/economy.js` that already deducts Gold and grants Bait) — gating access to the top few Charm Rack tiers. A player who has bought, say, 20,000 lifetime Bait has earned the right to buy tier 8–10 even if they came into a lot of Pearl quickly; a player sitting on a Pearl windfall from a lucky Legendary-chest streak can't buy straight to tier 10 on day one. This preserves Cambria's "full completion is an invested-player goal" shape without needing a dollar figure anywhere in it. Whether this gate is wanted at all, versus a Pearl-only unlock with no secondary gate, is worth confirming with Mike before building it — it's an extra system, not a hard requirement of the Rack itself.

## 4. What doesn't need to change

Cambria's ~10-Key (~$1) baseline dungeon-run stake, with the option to risk more Keys for a bigger multiplier, is structurally the same shape our Stake system (1/5/10/20/40 Bait, each raising both cost and payout potential) already has. No change needed here — this is a place where our design already matches Cambria's pattern. The one open thread that connects to it is Step 3 from the earlier plan (whether the Steady-vs-Risky Gold/hour gap should get its own ceiling as rod level rises) — that's still an open decision, not resolved by this cost-structure work, and the build prompt already handles it as a no-op-by-default toggle pending Mike's confirmation.

## 5. Rollout order

1. Confirm the Bait re-pricing target from Step 1 (unchanged by this document) and ship it.
2. Add the lifetime-Bait-purchased counter (cheap, low-risk, no player-facing change yet) so the Favor-gate has data to work from by the time the Charm Rack ships.
3. Build the Charm Rack with its hard combined-effect cap from day one — never ship the stacking multiplier before the cap exists, for the same reason the original plan flagged for buffs.
4. Confirm the 40-hour/125-Pearl-per-tier target with Mike (or his revised numbers), and confirm whether the Favor-gate ships alongside the Rack or as a later addition.
5. Regenerate `design/balance-tables.md` and add a Charm Rack section to it (or a sibling table) so its EV impact is visible the same way every other system's is.

## 6. Open questions for Mike

- Is 40 hours of sustained Rod-10/Balanced/Stake-10 play the right target for maxing the Charm Rack, or should it be shorter/longer?
- Should each tier boost Uncut Gem drop weight specifically, or a different lever (chest-tier bias, appraisal grade odds)?
- Does the lifetime-Bait Favor-gate ship at all, or is a Pearl-only unlock (no secondary gate) preferred for simplicity?

## Sources

- [Cambria Docs — Dungeons Overview](https://docs.cambria.gg/dungeons/overview)
- [Cambria Docs — Patch v0.3.0](https://docs.cambria.gg/dungeons/patch-notes/patch-v0.3.0)
- [Cambria Economy Dashboard](https://www.markofthezeal.com/cambria)
- [EGamers — Dungeon Fishing Beta](https://egamers.io/cambria-opens-dungeon-fishing-beta-with-up-to-30000-free-grub-up-for-grabs/)
