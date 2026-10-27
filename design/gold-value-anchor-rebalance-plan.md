# Gold & Bait Real-Value Anchor: Economy Rebalance Plan

*Locking the real-money value of Gold and Bait as design constants ahead of monetization actually shipping, and working out what else in the economy has to move to stay consistent with them. No purchase path is being built yet — this is purely about making every Gold-denominated number in the game mean something sane once a dollar sign eventually gets attached to it.*

## 0. The two locked constants

| Constant | Value |
| --- | --- |
| Gold's real value | **$0.10 = 1 Gold** (so $1 = 10 Gold, $10 = 100 Gold, $100 = 1,000 Gold) |
| Bait's price | **1 Bait = 3 Gold** ($0.30) |

This replaces the $0.01/Gold figure from the earlier `cambria-key-monetization-plan.md` — Gold is now defined as **10x more valuable per unit** than that draft suggested. Both numbers below are treated as fixed law; everything else in this document is about making the rest of the economy consistent with them, not about questioning the constants themselves.

## 1. What these two rules do to the numbers that already exist

Nothing else in `balance-tables.md` or the shop has been touched yet, so the first useful thing to do is see what today's actual numbers cost or pay under the new rate.

**The rod-skip ladder holds up well — no change needed here.** Total cost to skip levels 1→9 is 6,000 Gold, unchanged. At $0.10/Gold that's exactly **$600** for full completion. Cambria's own real full-completion price for the structurally equivalent system (all 10 Cursed Attractors) is ~$55 at sticker price but ~$583 once its Favor-gate cumulative-spend requirement is counted (`cambria-cost-structure-plan.md`, Section 1) — our $600 lands almost exactly on Cambria's *real* number. This is a good sign the ladder doesn't need to move.

**Bait's new price is the opposite story.** At 3 Gold/unit ($0.30), a single Bait costs **100x** what Cambria's real Grub costs per unit (Grub is 3 Keys/100 units at Cambria's real 10 Keys=$1 rate, i.e. $0.003/unit) — even though Gold and Keys are meant to play the same structural role. Put against the cost of a permanent upgrade: Cambria's Grub is ~1,000x cheaper than its Ember Rod ($0.003 vs $3.00); our Bait at $0.30 is only ~10x cheaper than our *cheapest* rod-skip level ($3.00 for level 1). Bait is supposed to be the thing a player spends constantly without thinking about — Cambria keeps it a rounding error next to permanent progress, and this price doesn't.

**Applying just the new Bait price to today's cast economics is where it breaks hardest.** `Bait spent` per hour, straight from `balance-tables.md`, times the new 3 Gold/unit price:

| Rod | Dial | Stake | Bait spent/hr | Bait cost/hr (Gold) | Bait cost/hr ($) |
| --- | --- | --- | --- | --- | --- |
| 1 (start) | any | 1 | 800 | 2,400 | $240 |
| 10 (max) | any | 1 | 1,600 | 4,800 | $480 |
| 10 (max) | any | 10 | 16,000 | 48,000 | $4,800 |
| 10 (max) | any | 40 | 64,000 | 192,000 | $19,200 |

That's the cost of Bait alone, at the *lowest* stake, for a brand-new player: **$240/hour**, before they've caught a single fish. This isn't a pricing nuance — it means the current cast-every-1.6–4.0-seconds loop cannot coexist with a flat 3-Gold Bait price without either the loop or the price changing (Section 3).

**Recomputing "Net Gold after bait" with only the Bait price changed** (gem income and everything else held at today's values) shows exactly how far off the rest of the economy now is:

| Rod | Dial | Stake | Old Net Gold/hr | New Net Gold/hr (3 Gold/Bait) | New Net $/hr |
| --- | --- | --- | --- | --- | --- |
| 1 | Steady | 1 | +59.95 | **-2,074.43** | -$207.44 |
| 1 | Balanced | 1 | +1,195.74 | **-949.23** | -$94.92 |
| 1 | Risky | 1 | +8,580.26 | +6,372.58 | +$637.26 |
| 10 | Steady | 1 | +1,606.34 | **-2,758.01** | -$275.80 |
| 10 | Balanced | 1 | +11,443.86 | +6,976.50 | +$697.65 |
| 10 | Balanced | 10 | +14,979.11 | **-27,563.94** | -$2,756.39 |
| 10 | Risky | 1 | +60,355.34 | +55,555.34 | +$5,555.53 |
| 10 | Risky | 40 | +109,424.19 | **-60,521.30** | -$6,052.13 |

Two findings jump out:

1. **Steady stops being viable at any stake, at any rod level, including Stake 1.** Today's balance explicitly protects "Stake 1 stays net-positive at every rod/dial" (GDD Opportunity #2's resolution) — that invariant breaks immediately once Bait costs 3 Gold, for both Steady *and* Balanced at Rod 1. A brand-new player fishing Steady or Balanced at the safest possible setting would be bleeding Gold from cast one.
2. **Even where the numbers stay positive, they're still absurd in dollar terms.** Risky/Stake1 at max rod would "earn" $5,555/hour if Gold were real money today. The Bait re-price alone doesn't fix the "$/hour is nonsensical" problem — it only breaks some rows and leaves others wildly overpriced. Gem-derived Gold income has to come down independently of whatever happens to Bait.

## 2. Two separate problems — don't solve them with the same lever

**Problem A: Bait's per-cast consumption rate is incompatible with a real per-unit price.** This is a *cast-loop* problem, not a *gem-value* problem. No amount of rescaling gem drops fixes it, because Bait cost scales with casts-per-hour (which is fixed by cast time, 1.6–4.0 seconds depending on rod level) times cost-per-cast (1/5/10/20/40 Bait per the Stake table) times the new 3-Gold price. The only levers that touch this are: how much Bait a cast actually costs, how often a player casts, or the price itself.

**Problem B: gem-derived Gold income is priced for a currency with no dollar value, and now Gold has one.** Even a Risky player who never buys a single unit of Bait (living entirely off the free personal trickle) would gross up to 131,478 Gold/hour at max rod — **$13,148/hour** of value under the new rate. This has nothing to do with Bait; it's the appraisal/chest system paying out in a range that made sense when Gold was worthless outside the game and makes no sense once it's worth a literal dime each.

## 3. Why a gem-value rescale alone can't fix Problem A (worked illustration)

To show why these need separate fixes, here's what happens if only gem-derived income is rescaled, using an illustrative (not final — see Section 6) target of **$1.00/hour net** for Balanced/Stake 1 at max rod:

- Target net = $1.00 = 10 Gold/hour.
- Bait cost at that row is fixed by today's consumption rate: 1,600 Bait/hr × 3 Gold = 4,800 Gold/hr.
- Required gross income = 10 + 4,800 = **4,810 Gold/hour**.
- Today's gross at that row is 11,776.5 Gold/hour, so gem values would need to shrink by roughly **2.4x** to hit this target — a modest, plausible cut on its own.

But look at what that gross number is actually made of: **4,800 of the required 4,810 Gold (99.8%) is Bait cost.** The player would be earning almost nothing except exactly enough to feed the cast loop. That's not a functioning economy — there's no room for rod-skip savings, no sense of progress, no cushion for a bad-luck stretch. This confirms Section 2's split: **the Bait consumption rate itself has to change**, not just gem values, or every player becomes a hamster wheel that earns Gold only to immediately hand it back for the right to keep casting.

## 4. The real decision: what does 3 Gold actually buy per cast?

This is the one structural question that has to be answered before any table in `balance-tables.md` gets touched, because it changes what "Stake 1" even means:

- **Option 1 — Redefine what a Stake tier costs.** Keep 1 Bait = 3 Gold as the shop price, but make Stake 1 cost less than a whole Bait per cast (e.g., a cast consumes a fraction of a unit, or "1 unit" is redefined to cover several casts). This keeps the sticker price simple (3 Gold buys something recognizable) while bringing hourly Bait spend down to a sane multiple of gem income.
- **Option 2 — Make the free personal trickle the primary Bait source for ordinary play, and Gold-bought Bait a burst/high-stake-only purchase.** The GDD already gives every player a free trickle topping up to 25 in reserve; if that trickle (plus Bait won from chests — the `Chest bait` column already worth 62–2,737/hr depending on setup) is made to cover most or all of Stake 1–5 casting, then the 3-Gold shop price only has to make sense for Stake 10+ players deliberately paying for a faster/richer session, not for baseline play. This is the option that most resembles Cambria's own shape (Grub is cheap and constant; the *staked* real-money spend happens at the "dungeon run" decision point, not on every attempt).
- **Option 3 — Slow the cast loop itself at low stakes.** If cast time or catch attempts scale down independent of Stake, Bait consumption per hour drops without touching the Stake pricing table at all. This is the most invasive option since cast time is also what the rod-progression table (Section 3 of the GDD) is built around.

Options 1 and 2 are not mutually exclusive — a real build likely wants some of both (trickle covers idle/casual play, a redefined Stake table keeps active play affordable). Option 3 reaches deepest into systems this plan doesn't otherwise need to touch and should be a last resort.

## 5. What has to happen on the gem-income side, independent of the Bait decision

Whatever Section 4 decides, gem-derived Gold income still needs a large cut on its own (Problem B, Section 2) — a Risky player earning five figures of Gold an hour is a five-figure-dollar-an-hour claim once Gold has a real value, regardless of what Bait costs. Two independent levers exist, and both should probably move together rather than picking one:

- **Gem value ranges** (currently Uncut Emerald 10–80, Ruby 50–400, Sapphire 250–2,000, Diamond 1,000–10,000) — the most direct lever, and the one the existing plans already treat as the primary Gold-value dial.
- **Gem/chest drop rates** — currently 15–16% per chest tier for the matching gem; lowering this instead of (or alongside) gem value changes the *frequency* of Gold windfalls rather than their size, which changes how "spiky" income feels even at the same average.

Recommend anchoring the actual scale factor to a target that's explicit about *why* that number was picked (hours to a meaningful purchase, or a target $/hour ceiling for the best-case playstyle) rather than picking a round Gold number first — this is the same method already used to size the Charm Rack's Pearl pricing in `cambria_balance_plan.md` (target hours of sustainable play → back out the constant), and it's the natural next step once Section 4 is answered, since the Bait-cost side of the equation needs to be settled before "target net Gold/hour" means anything stable.

## 6. What this plan is deliberately not deciding

- **The actual target $/hour for each play style.** Section 3's $1.00/hour figure is illustrative only, chosen to make the math visible — it is not a recommendation. This is a business/design call (how rewarding should free play feel once Gold has a real value?) that needs Mike's number, not a derived one.
- **Which of Section 4's three options (or blend) to take.** This is a core-loop architecture decision, not a balance-math one.
- **Whether existing invariants should be preserved or intentionally abandoned** — e.g., "Stake 1 stays net-positive everywhere" was a deliberate earlier design goal (GDD Opportunity #2). Section 1 shows the new Bait price breaks it outright for Steady and Balanced at Rod 1; whether that's acceptable friction now (matching the "Steady-high-Stake trap is intended" precedent already accepted elsewhere) or needs protecting again is Mike's call.

## 7. Rollout order

1. Decide Section 4 (what a cast actually costs in Bait, and how much the free trickle is expected to cover) — nothing downstream can be finalized without this.
2. Decide the target $/hour ceiling(s) from Section 6, at minimum for Balanced/Stake 1 at max rod as the reference "engaged casual" row.
3. Back out the gem value/drop-rate scale factor from that target the way `cambria_balance_plan.md` sized the Charm Rack, then regenerate `balance-tables.md` via `node server/tools/gdd-balance.js --write` and re-check the Stake-1-stays-positive invariant at every rod/dial (or explicitly retire that invariant per Section 6).
4. Leave the rod-skip ladder untouched — Section 1 shows it already prices out sensibly against Cambria's real numbers.
5. Update `design/GDD.md` Sections 1/9 only once real monetization actually ships, per `cambria-key-monetization-plan.md` Section 6 — this pass is internal balancing only and shouldn't change the game's current "no monetization" public-facing claims yet.

## 8. Open questions for Mike

- Which of Section 4's Bait-consumption options (redefine Stake costs, lean on free trickle, slow the cast loop, or a blend) should the game take?
- What's the target $/hour for Balanced/Stake 1 at max rod — the number Section 5's rescale gets sized against?
- Should the "Stake 1 always net-positive" invariant be preserved under the new Bait price, or is a steeper Steady-mode penalty acceptable now that Bait carries real value?
- Should Bait retain its current four-tier bulk-discount pack structure (Tin/Pot/Bucket/Crate) on top of the 3-Gold base rate, or does "1 Bait = 3 Gold" mean a single flat price with no bulk discount at all?

## Sources

- `design/GDD.md` (Sections 3, 4, 5, 8, Appendix)
- `design/balance-tables.md` (Hourly economy table)
- `design/cambria-inspired-balance-plan.md`, `design/cambria-cost-structure-plan.md` (Grub/Ember Rod/Attractor real-price figures, and the "size the constant from our own numbers" method reused here)
- `design/cambria-key-monetization-plan.md` (superseded on the specific $/Gold rate; its structural findings on the shared Bait pool and GDD-language dependency still apply once monetization ships)
