# Cambria-Inspired Balance Implementation Plan

*How to apply Cambria's fishing-economy lessons to Fishing Idle Game MMO, in our own currency vocabulary (Bait, Gold, Pearl, Uncut Gem).*

## 0. How to read this

Cambria is a "risk-to-earn" onchain dungeon-crawler with its own fishing side-activity. Its economy is built from four pieces: a staking/spend currency bought with real money (**Dungeon Keys**), bait bought with that currency (**Grub**), a rare item pulled from treasure sacks that gets converted into value (**Gem** / Uncut Emerald), and a set of paid luck-upgrades capped at a fixed return rate (**Cursed Attractors**). Cambria also has one well-documented failure — the "Emerald Bug" — where stacking bait potency, cast speed, and a targeting exploit together caused massive over-minting of its currency.

None of Cambria's numbers transfer directly — it's a paid, real-money economy and ours has no monetization. What transfers is the *structure*: which currency plays which role, where the sinks are, and where the caps are. Translated into our terms:

| Cambria concept | Cambria term | Our equivalent | Role it plays |
| --- | --- | --- | --- |
| Staking / spend currency, buy-in for content | Dungeon Keys | **Gold** | Earned currency that buys Bait and skips rod levels |
| Bait, consumed per cast | Grub | **Bait** | Consumed every cast, bought with Gold |
| Rare high-value drop, converted to value | Gem (Uncut Emerald) | **Uncut Gem** (Emerald/Ruby/Sapphire/Diamond) | Sits in the bag until appraised for Gold |
| Paid luck-upgrades, RTP-capped | Cursed Attractors | *(not yet in our game — see Step 2)* | Would increase gem/chest odds, must be capped |
| Undefined bridge currency, no spend yet | Genesis Points / Royal Favor | **Pearl** | Found in Epic/Legendary chests; currently has no sink |
| Forces regular cash-in | Fish spoilage timer | 80-fish bag cap | Same purpose (stop hoarding), different mechanism |

The rest of this plan is organized around that table: for each row, what Cambria's design implies for us, checked against our actual numbers from `design/GDD.md` and `design/balance-tables.md`.

## 1. Diagnosis against our current numbers

**Bait pricing is stale, and our own GDD already flags it (Opportunity #2).** The shop sells Bait at 0.18–0.30 Gold per unit, but a single Uncut Emerald (our lowest gem tier) averages 45 Gold — enough to buy 250 Bait from the Crate pack in one appraisal. Cambria keeps its Keys↔Grub exchange rate (3 Keys per 100 Grub) deliberately tight against its reward economy so Grub stays a real sink; ours has drifted the other way as gem values were re-spaced. This is the most concrete, already-identified gap to close.

**The play-style gap has no ceiling as rod level rises.** At Rod 1, Risky nets ~12,400 Gold/hour versus Steady's ~-5,300 (bait-cost-negative). At Rod 10, Risky nets ~120,000 Gold/hour versus Steady's ~1,800 — the *absolute* gap keeps widening with rod level, not just the ratio. Cambria's answer to "power creep making the top end run away" is the Cursed Attractor system's hard RTP cap (~90% return, ten discrete upgrade tiers, no further stacking beyond that). We don't have an equivalent ceiling on Risky-mode Gold/hour today — worth a deliberate decision (see Step 3), not an accident of the stake/dial multiplier math.

**Pearl has the same "undefined bridge currency" shape Cambria has had at various points.** Our own GDD Opportunity #1 already says this plainly: Pearl has no spending destination. Cambria's lesson here isn't "eventually tie it to a token" — it's that a currency the game keeps minting with no sink is itself a design smell, independent of any exploit risk, because it either goes ignored (chests stop feeling exciting once Pearl is dead weight) or gets a sink added late, at which point every player's stockpile becomes spendable at once and floods whatever it's spent on.

**We are structurally resistant to the specific Emerald Bug, but not to its shape.** Cambria's bug came from stacking three independent multipliers (bait potency, cast speed, a targeting exploit) on top of each other with no combined cap. Our appraisal system already isolates randomness well (four independent traits, six-step grades, no player-facing way to target a specific grade) — but Opportunity #3 in the GDD notes two shelved buff items (a rarity-boosting charm, a catch-rate-boosting lure) that are fully built and could be reactivated. If both go live without a combined cap, we'd be one design decision away from recreating the same stacking problem, just with different levers.

## 2. Concrete implementation steps

**Step 1 — Re-price Bait against current gem values, not the old ones. — IMPLEMENTED.**
Use `node server/tools/gdd-balance.js --write` as the tuning loop: adjust the four Bait pack prices, regenerate `balance-tables.md`, and check the "Net Gold after bulk bait replacement" column across every rod/dial/stake combination. The target isn't "make every combination profitable" — the GDD is explicit that Steady-at-high-Stake being a losing proposition is intended friction, not a bug — the target is that Bait stops being something a single low-tier gem trivially buys out. A reasonable first pass: price the Crate (our best per-unit rate) so that one average Uncut Emerald (45 Gold) buys a two-to-three-session supply of Bait at Stake 1, not the entire pack size at once.

**Step 2 — Design any reactivated buff item with a hard RTP cap from day one.**
Before putting the rarity charm or catch-rate lure back into the shop or chest tables (Opportunity #3), decide a ceiling: the combined effect of every stacked buff on a single cast should never push that cast's expected Gold value above a fixed multiple (e.g. 1.5–2x) of the unbuffed baseline. Build the cap as a clamp in the drop-rate calculation itself, not as a soft balance assumption — Cambria's Attractors are capped at a fixed maximum tier count (ten) precisely so nothing downstream needs to trust that players won't find a way to stack past the intended ceiling.

**Step 3 — Decide, explicitly, whether the Steady→Risky gap should keep widening with rod level. — MECHANISM BUILT, DECISION STILL OPEN.**
Right now nothing bounds it — the gap is a side effect of dial/stake multipliers compounding with rod-level catch-rate and chest-chance improvements. Either that's fine (the GDD frames the current ~30x gap at max rod as the intended headline number) or it needs its own cap, analogous to Cursed Attractors capping the top end of Cambria's luck economy. If a cap is wanted, the cleanest lever is the rod's own catch-rate/chest-chance curve (Section 3 of the GDD) rather than touching the dial multipliers, since the dial choice is meant to stay a clean 3-way trade-off.

**Step 4 — Give Pearl a sink before adding any more Pearl faucets.**
Two low-risk options: a fixed-rate Pearl→Gold exchange (an NPC or shop panel, similar in spirit to how Cambria's bridge currencies eventually connect back to its main economy), or a Pearl-priced permanent unlock (a rod cosmetic, a bag-size increase) that doesn't touch the Gold economy at all. Either closes the open loop; which one depends on whether Pearl should ever meaningfully add to a player's Gold income (exchange) or stay a separate collectible-progression track (cosmetic/unlock). This is really a design call for Mike, not a balance-math one — flagged again in Section 3 below.

**Step 5 — Add server-side emission monitoring now, while it's cheap. — IMPLEMENTED.**
Cambria's Emerald Bug was caught after the fact, once someone noticed anomalous key creation. `server/tools/gdd-balance.js` already computes theoretical EV per chest/gem; a lightweight addition — logging actual server-wide Gold and Pearl minted per hour, and diffing it against the theoretical EV for the current player population's rod/dial/stake mix — would surface a future exploit or balance regression as a visible spike instead of a player report. This is independent of the other steps and can ship first.

**Step 6 — Leave fish spoilage out for now, but revisit if offline progress ships.**
The 80-fish bag cap already forces cash-ins on a similar cadence to Cambria's spoilage timer (3–15 minutes to fill, per the GDD's session-length appendix), so a timer on top would be redundant today. If offline/idle progress (Opportunity #4) is ever added, revisit this — idle accrual without either a cap or a timer is exactly the condition spoilage exists to prevent in Cambria.

## 2a. What was actually built (Steps 1, 3 and 5)

Steps 2, 4 and 6 were explicitly out of scope for this pass and are untouched.

| Step | Status | What changed, and where |
| --- | --- | --- |
| **1 — Re-price Bait** | Done | Every `SHOP_ITEMS` price in `server/src/config/economy.config.js` doubled: **6 / 24 / 80 / 360** Gold for the Tin / Pot / Bucket / Crate. Pack sizes and the 20% / 33% / 40% bulk-discount curve are unchanged, so only what a tier costs moved. At the new crate rate (0.36 Gold/bait) an average Uncut Emerald buys 125 bait — about one 80-fish-bag session, down from 250. The rationale is written out in the comment block above `SHOP_ITEMS`. `design/balance-tables.md` and GDD Section 5 regenerated/updated. Checked: Stake 1 stays net-positive at all 30 rod/dial combinations (tightest is Rod 1 Steady at **+59.95** Gold/hour), and the max-rod Steady-to-Risky ratio moved 33.1x → 37.6x. |
| **2 — Cap stacked buffs** | Not in scope | Untouched. |
| **3 — Cap the Steady/Risky gap** | Mechanism built, **defaulted to a no-op, decision still open** | `MAX_CHEST_TIER_BIAS` (`server/src/config/game.config.js`) clamps `chestUpgradeBias` in `server/src/game/chests.js`. Defaults to 4.0 against a live maximum of 2.00, so it binds on nothing — verified by regenerating the tables with the clamp at 4.0 and removed entirely and diffing: identical. Candidate values 1.75 / 1.50 / 1.25 were measured and written up in the README's "Assumptions & Open Questions" as **Q1**, including the finding that this lever does nothing at all at Stake 1 and may be the wrong lever. **No value has been chosen; this needs Mike.** |
| **4 — Pearl sink** | Not in scope | Untouched. Pearl still has no spending destination. |
| **5 — Emission monitoring** | Done | EV maths extracted from `server/tools/gdd-balance.js` into `server/src/game/balanceModel.js`; the tool now imports from it, so the design tables and the live monitor cannot drift apart. `server/src/game/metrics.js` counts every Gold / Pearl / Bait mint, instrumented at `appraiseGem` and `applyRewards` (`game/chests.js`) and `applyBaitRegen` (`game/economy.js`). `HarborRoom` flushes every 5 minutes (`EMISSION_MONITOR`), compares actual against theory built from the online players' real rod / dial / stake, and `log.warn`s past 2x. Lifetime totals persist in a new `emission` subdocument on `WorldSchema`. Covered by `server/test/metrics.test.js`. |
| **6 — Fish spoilage** | Not in scope | Untouched. |

One thing the build found that the plan did not anticipate: a fixed comparison
window false-alarms on honest play, because both big faucets are bursty — a gem
sits in the bag until the player visits the appraiser, and Pearl arrives in
chunks. A five-minute window tripped the Pearl wire in two runs out of four
before this was addressed. The monitor therefore treats theory as a *budget*
that carries unspent allowance forward for up to six windows
(`EMISSION_MONITOR.maxCarryWindows`), so a stashed bag cashed in all at once is
not read as an over-mint.

## 3. Rollout order

Do Steps 1 and 4 together in one balance pass — they interact, since a Pearl→Gold exchange would change effective Gold income and therefore what Bait price counts as "fair." Do Step 2 before touching the shelved buff items at all; retrofitting a cap after an item is already live and farmed is the harder version of the same problem Cambria had. Step 5 is low-risk and can ship independently, any time, ideally first. Step 3 and the Pearl-sink choice in Step 4 are the two genuine open design decisions in this plan — everything else is closing a gap the GDD has already identified.

## 4. Open questions for Mike

- Should the Steady-high-Stake "trap" (currently net-negative Gold) stay as intentional friction after Bait is re-priced, or should re-pricing remove it entirely? *(Step 1 kept it, per GDD Section 8. Still open as a design call.)*
- **Q1: should `MAX_CHEST_TIER_BIAS` be lowered from its no-op default?** The mechanism is built and measured; see the README's "Assumptions & Open Questions". Nothing in the live game changes until this is answered.
- What should Pearl actually buy — a Gold exchange, a cosmetic/unlock sink, or both?
- Is offline/idle progress close enough on the roadmap to justify designing anti-hoarding rules (Step 6) now instead of later?

## Sources on Cambria's design, for reference

- [Cambria Docs — Dungeons Overview](https://docs.cambria.gg/dungeons/overview)
- [Cambria Docs — Patch v0.3.0](https://docs.cambria.gg/dungeons/patch-notes/patch-v0.3.0)
- [Cambria Blog — "Aug 13: Emerald Bug"](https://blog.cambria.gg/aug-13-emerald-bug/)
- [Cambria Economy Dashboard](https://www.markofthezeal.com/cambria)
- [The Value Thesis #5: Cambria (WolvesDAO)](https://wolvesdao.substack.com/p/the-value-thesis-5-cambria)
