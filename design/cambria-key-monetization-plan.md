# Cambria's Key Monetization & Balance Plan

*How to introduce a real-money exchange rate for Gold ("Cambria's Key") without breaking the free economy `design/GDD.md` and `design/balance-tables.md` already describe.*

## 0. What's being proposed, precisely

Mike's request: rename/reframe Gold Coins as **Cambria's Key**, at parity (1 Gold = 1 Key), and sell Keys for real money at a flat rate:

| Price | Keys / Gold |
| --- | --- |
| $0.10 | 10 |
| $1.00 | 100 |
| $10.00 | 1,000 |

All three rows are the same rate — **$1 = 100 Gold, i.e. $0.01 per Gold** — just shown at three scales. Worth flagging before anything else: this is a flat rate with no bulk bonus. Most cash-currency shops make the $10 pack more generous per dollar than the $1 pack (that's the whole point of offering a bigger tier); as written, there's no incentive to buy the $10 pack over ten $1 packs. That's a separate, easy fix (Section 5) — the bigger issue is the rate itself.

## 1. The problem: this rate is being bolted onto an economy priced for a $0 game

Every Gold number in the game today — both what things cost and how fast Gold comes in — was tuned entirely against other Gold numbers, because `design/GDD.md` states plainly: *"The game currently has no monetization... every currency is earned entirely through play."* Applying a real-money rate to Gold doesn't just add a new way to get Gold — it puts a dollar sign on numbers that were never designed to be looked at that way. Two facts from the current build matter here:

**Gold sinks are small and finite.** Skipping a rod level costs 30 / 72 / 132 / 228 / 372 / 600 / 930 / 1,440 / 2,196 Gold (levels 1→9) — skipping the *entire* ladder costs exactly **6,000 Gold**, once, ever. The most expensive Bait pack (Crate of Mackerel Strip) is 360 Gold for 1,000 Bait.

**Gold income is large and continuous**, from `balance-tables.md`'s Hourly Economy table (Net Gold after bulk bait replacement, i.e. already accounting for what a player spends re-stocking Bait):

| Rod | Play Style | Net Gold / hour |
| --- | --- | --- |
| 1 (starting) | Steady | ~60 |
| 1 (starting) | Balanced | ~1,196 |
| 1 (starting) | Risky | ~8,580 |
| 10 (max) | Steady | ~1,606 |
| 10 (max) | Balanced | ~11,444 |
| 10 (max) | Risky (Stake 1) | ~60,355 |
| 10 (max) | Risky (Stake 10) | ~111,420 |

And per the GDD's own Appendix, a player reaches max rod level through ordinary play in **16–75 minutes**, depending on play style.

## 2. What the proposed rate does when you actually apply it

- **The whole rod-skip ladder (6,000 Gold) would sell for $60** — to skip content a player can already finish for free in 16–75 minutes. No one buys $60 of convenience for something that fast.
- **A Crate pack (1,000 Bait) would sell for $3.60** — a Balanced player at max rod earns enough Gold for one every ~1.9 minutes of free play. A paying player would be handing over $3.60 for something a free player gets in about two minutes.
- **Hourly Gold income becomes a very large implied dollar figure.** A Risky/Stake-10 player at max rod nets ~111,420 Gold/hour — over **$1,100/hour** of "purchasing power" at this rate, earned for free. Nothing in the shop costs anywhere near that, so a committed player is permanently sitting on more spending power than the store has anything to sell them.
- **The shared world Bait pool is the sharpest risk, and it's specific to this being an MMO, not a single-player idle game.** The whole world draws from one 50,000-unit Bait pool (GDD Section 5). A single **$10 purchase (1,000 Gold) buys ~2,778 Bait at the Crate rate — 5.5% of the entire world's Bait supply in one transaction.** A **$100 purchase buys ~27,778 Bait — 55% of the whole pool** — in a world capped at 8 concurrent players. One paying player could materially starve everyone else fishing alongside them.

## 3. Root cause

Gold's sinks and Gold's income rate were tuned against *each other*, inside a closed loop that never had to survive contact with a dollar figure. You can't bolt a linear $-to-Gold rate onto that loop without landing on one of two outcomes: the store looks pointless (today's sinks are all cheap and instantly outpaced by free income — Section 2), or Gold gets devalued enough for purchases to matter, which also devalues everything free players already earned and quietly undercuts the game's own headline design pillar — Section 8's documented "Risky play generates over 30x more wealth per hour than Steady," which only means something if Gold itself still means something.

## 4. Three ways to actually resolve this (pick one)

### Path A — Decouple: Cambria's Key is a separate currency, not literally shared Gold

Sell Keys at the requested $0.10/$1/$10 price points, but Keys aren't the same balance as earned Gold. Two variants:

- **Keys buy a separate catalogue** that never touches the shared Bait pool or the finite rod-skip ladder: cosmetics, rod skins, name colors, leaderboard flair, a *personal* Bait reserve that draws from its own supply rather than the shared 50,000-unit pool, extra bag slots. The entire free economy in the GDD stays exactly as documented — only cosmetic/QoL value is for sale.
- **Keys convert to Gold, but at a steep ratio well below face value** — tuned so a purchase reads as "a modest boost," not "more than you could ever spend" (worked example in Section 5).

Either way, the "1 Gold = 1 Key" line can stay as flavor/branding without the *traded* rate actually being 1:1 — the display name and the exchange math don't have to match.

### Path B — Sell bundles, not raw currency

Skip a linear per-Gold price and sell fixed, curated packs instead — the way almost every mobile/idle game actually prices IAPs:

| Bundle | Contents | Suggested price |
| --- | --- | --- |
| Rookie Rod Skip | Levels 1–5 skip (834 Gold) | $2.99 |
| Full Rod Mastery | All 9 skips (6,000 Gold) | $9.99 |
| Bait Crate x5 | 5,000 Bait, from a cash-only stock outside the shared pool | $4.99 |

No player can compute a "$/Gold" rate and notice it's a bad deal, because there isn't one. Downside: it doesn't literally deliver the "$0.10 = 10 Keys, scales linearly" mechanic Mike described.

### Path C — Keep it literal, but re-tune the whole Gold economy around it

Only makes sense if Mike is willing to significantly cut Gold's *free* earn rate (every row of `balance-tables.md`) so a $10/1,000-Gold purchase is worth meaningfully more than the ~9 minutes of best-case free play it buys today. This is a full rebalance of the core loop, not a pricing add-on — it reaches into the same numbers behind Section 8's "30x gap" showcase chart. Not recommended unless monetization is meant to become a primary balancing lever going forward, rather than an add-on to the existing design.

## 5. Recommended default, if a concrete number is wanted

Use the same method already used to size the Charm Rack's Pearl pricing ([[cambria_balance_plan]]): anchor to a *realistic sustainable* play style, not the single biggest number on the sheet, and treat a purchase as buying a deliberately modest number of minutes.

Reference point: **Balanced, Stake 1, max rod = ~11,444 Gold/hour (≈191 Gold/minute)** — an engaged-but-not-maximum-grind baseline, the same rod/dial choice the Pearl Charm Rack math used.

Target: size the smallest price point so it buys roughly **2–3 minutes** of that baseline — enough to feel like a real convenience, not free money. That puts **$1 in the neighborhood of 2,000–3,000 Gold** — about 20–30x more generous than the proposed 100 Gold, not less. That's the correct direction of the fix: at the requested rate, cash purchases are *too expensive relative to how fast Gold is earned*, not too cheap. If Mike wants a purchase to matter *more* than "a couple of minutes," the sinks or the income rates need to move too (Path C) — the price alone can't do it while free income stays this high.

Regardless of the exact rate chosen: **cap or reroute cash-purchased Bait so it can't hit the shared 50,000-unit world pool at full size** (a personal reserve, a per-transaction cap, or Path A's separate-currency approach) — Section 2's math shows even a modest purchase can meaningfully deplete Bait for everyone else in that fishing world, which is a problem unique to this being a shared-world MMO.

## 6. What has to change alongside this, whichever path is chosen

- `design/GDD.md` Section 1 ("Monetization: None") and Section 9 ("No purchases, subscriptions, or premium currency exist") are both written as an explicit, business-facing claim that this is a zero-monetization game — both need a rewrite the moment any real-money path ships.
- The shared Bait pool needs a purchase cap or a separate cash-only reserve before Bait becomes buyable with real money (Section 2, Section 5).
- Confirm whether purchased Gold/Keys should be able to buy Stake levels 10+ and, through them, a shot at Legendary chests (GDD Section 4) — Stake-gated chest access already means "spend more, unlock more" with earned Gold, so extending that to purchased Gold is structurally consistent with Cambria's own Key-staking model, but it's a pay-for-better-odds mechanic and worth Mike explicitly signing off on rather than inheriting by default.

## 7. Open questions for Mike

- Which path: Keys as a separate currency/catalogue (A), curated bundles (B), or a literal shared rate with the free economy re-tuned around it (C)?
- If Keys stay linear-priced against Gold, is 2–3 minutes of Balanced/Stake-1 play the right size for the smallest pack, or should it be more/less generous than that?
- Should purchased Bait ever touch the shared 50,000-unit world pool, given up to 8 players draw from it at once — or should it always come from a separate cash-only supply?
- Is a flat rate across all three price points intentional, or should the $10 tier include a bonus (the way most premium-currency shops make bigger packs a better per-dollar deal)?

## Sources

- `design/GDD.md` (Sections 1, 3, 5, 8, 9, Appendix)
- `design/balance-tables.md` (Hourly economy table)
- `design/cambria-inspired-balance-plan.md` and `design/cambria-cost-structure-plan.md` (methodology reused here: scale from our own income numbers, not Cambria's dollar figures)
