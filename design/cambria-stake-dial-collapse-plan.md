# Plan: Collapse Stake + Dial into One Lever, Cambria-Style

*What has to change so the game has a single Stake axis instead of Stake × Dial — matching Cambria's actual mechanic (one continuous "risk more, win more" lever, no separate mode selector).*

## 0. Flag this before building it

Three Dial modes (Steady/Balanced/Risky) are explicit **in-scope, contracted** deliverables in `CLAUDE_CODE_BUILD_PROMPT.md`, and `design/GDD.md` calls the Dial/Stake trade-off "the design's central lever" and its headline feature (Section 8's "30x more wealth per hour" number is *the* thing that document sells). This plan removes that feature entirely and replaces it with something Cambria never actually documents in detail either — there's no public spec for exactly how Cambria's stake curve behaves, so what follows is a reconstruction of its *shape*, not a verified port of real numbers.

Concretely: this is a scope change to a fixed-price contract deliverable, not a balance tweak. If this is going to a client under that contract, it's worth a conversation with them before it ships, the same way the repo's own convention says to flag anything that looks like it's leaving scope rather than build it quietly.

## 1. The philosophy shift this requires

Today, Stake and Dial do two different jobs that don't overlap:

- **Stake** (1/5/10/20/40 Bait) is pure upside with a cost attached — `STAKE_CATCH_BONUS` only ever *helps* catch rate (1.00 → 1.30), never hurts it. The `game.config.js` comment says this outright: "this deliberately makes high stakes better value per bait."
- **Dial** (Steady/Balanced/Risky) is the actual risk/reward trade-off — Steady trades chest quality for catch frequency, Risky trades the reverse.

Cambria's model doesn't have that split. Staking more is *the* risk — you're not paying a fee for a strictly-better catch rate, you're betting more on a swing that can go better or worse. Collapsing the two systems means **Stake has to absorb Dial's trade-off**, not just Dial's absence. A higher stake needs to mean a *worse* catch rate in exchange for better rarity and chest odds — the opposite of what Stake does today. This is the one conceptual change everything else below implements.

## 2. The merged Stake table

Interpolating linearly across the existing Steady→Risky spread (rather than inventing new numbers) keeps the game's overall balance in the same neighborhood while moving the trade-off onto one axis. Treat Stake 1 as today's Steady, Stake 40 as today's Risky, and space the three middle levels evenly between them:

| Stake | Bait/cast | Catch mult. | Rarity bias | XP mult. | Chest-chance mult. | Chest tiers reachable |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1.25 | 0.78 | 0.95 | 0.85 | Common |
| 5 | 5 | 1.11 | 0.91 | 0.975 | 1.04 | Common, Rare |
| 10 | 10 | 0.975 | 1.04 | 1.00 | 1.225 | Common, Rare, Epic, Legendary |
| 20 | 20 | 0.84 | 1.17 | 1.025 | 1.41 | Rare, Epic, Legendary |
| 40 | 40 | 0.70 | 1.30 | 1.05 | 1.60 | Epic, Legendary |

Notes on where these came from, so they're easy to re-derive if the source numbers change:

- Catch mult., rarity bias, XP mult., and chest-chance mult. are straight linear interpolations between Steady's and Risky's existing values across the five stake levels (f = 0, 0.25, 0.5, 0.75, 1.0). `STAKE_CATCH_BONUS` is retired entirely — this table's Catch mult. column replaces it, and it now *decreases* with stake instead of increasing.
- The chest-tier column keeps Legendary gated at Stake 10+ exactly where it already is today (`CHEST_ACCESS.balanced.legendaryFrom = 10`) — this happens to be the one number in this whole plan with a real Cambria source behind it: the community dashboard's note that T4 "Massive Angler Sacks" require "a stake of 10 or more." Everything else in the table is a reconstruction; that one row is corroborated.
- Common and Rare drop off entirely at the top stakes, mirroring how Risky excludes them today — full send at Stake 40 means no more common-tier consolation prizes, same as full Risky does now.

Treat this table as a first pass to verify with `node server/tools/gdd-balance.js --write`, not a final answer — the goal is preserving the GDD's ~30x Steady-to-Risky Gold/hour spread on the new single axis, and the tool is what actually confirms that, not the interpolation math above.

## 3. Server-side changes, file by file

- **`server/src/config/game.config.js`**: delete `DIAL_MODES`, `DIAL_MODES_BY_ID`, `DIAL_MODE_IDS`, `DEFAULT_DIAL_MODE`, and `STAKE_CATCH_BONUS`. Replace with a single `STAKE_LEVELS` config array carrying the merged table above (bait cost, catch mult., rarity bias, xp mult., chest-chance mult., reachable tiers). Fold `CHEST_ACCESS` into that same array instead of keeping it as a separate dial-keyed object.
- **`server/src/game/fishing.js`**: remove `dialFor()` and every reference to `dial.*` in `beginCast()` — pull all five modifiers from the new per-stake config entry instead. `STAKE_RULES.scalesBaitCost` stays true; the rest of `STAKE_RULES` (scalesGold, scalesXp, scalesChestChance) can likely go too since Stake now directly carries what Dial used to.
- **`server/src/game/chests.js`**: `allowedChestTiers(dialMode, stake)` becomes `allowedChestTiers(stake)`, reading the reachable-tiers list straight off the new Stake config entry instead of `CHEST_ACCESS[dialMode]`.
- **`server/src/config/index.js`**: `CLIENT_CATALOG.dialModes` goes away; the catalog needs a `stakeLevels` (or extend whatever it already exposes for Stake) entry carrying enough of the new table for the client to render — names/blurbs for each stake tier if the UI still wants short labels like "Safer" / "Balanced" / "All in" at the low/mid/high ends.
- **`server/src/util/validate.js`**: delete `validateDialMode`. Nothing else needs to validate a `mode` string once Dial is gone — `stake` is presumably already validated against `STAKE_LEVELS` elsewhere; confirm and reuse that.
- **`server/src/rooms/HarborRoom.js`**: remove the `set_dial` message handler entirely, and `record.dialMode` / `player.dialMode` reads elsewhere in the room (there's also a `dialMode` reference in the idle-loop projection logic — check what "uninterrupted casting at their current rod, dial and stake" needs to become "rod and stake").
- **`server/src/rooms/schema/HarborState.js`**: remove the `dialMode: 'string'` schema field and its constructor default.
- **`server/src/rooms/views.js`**: remove `dialMode` from the player view payload sent to clients.
- **`server/src/db/models.js`**: remove `dialMode` from `PlayerSchema` — see the migration note below before actually dropping this.
- **`server/tools/gdd-balance.js`**: this tool's tables are all built by iterating `DIAL_MODES x STAKE_LEVELS` (see its `stats()` function and every `table(...)` call that spreads `DIAL_MODES`). With Dial gone, every one of those tables collapses from a 2D grid to a 1D list keyed by Stake alone — this file needs a real rewrite, not a find-and-replace, since its whole structure assumes two axes.

## 4. Client-side changes

- **`client/src/ui/hud.js`**: remove `renderDials()`, `renderDialGates()`, `this.dialCards`, the `hud-dials` / `panel-dialstake` DOM refs, and `dialStakeHint()` (or rewrite it to describe the new single-axis trade-off — its current text literally says "The Dial trades how often you hook something against how rich it is," which needs to become a Stake-only explanation). The Stake selector UI needs to visually communicate the trade-off Stake now carries (lower catch rate at higher stake) since today's Stake UI only ever communicated upside.
- **`client/src/net/NetClient.js`**: remove `setDial(mode)`.
- **`client/src/style.css`**: audit and remove `.dialcard` and related dial-panel rules — not read in full for this plan, so treat this as "search the stylesheet for dial-prefixed classes" rather than a fixed list.
- Client-side test coverage (`client/test/`) almost certainly references dial mode somewhere given how central it is to the GDD; expect to update or remove those tests alongside the server ones.

## 5. Migration concern: existing player data

Every player document in Mongo already has a `dialMode` field (`balanced` by default). Simply deleting the schema field is safe for *reading* old documents (Mongoose just ignores the extra field), but make sure nothing downstream still branches on it after this ships. This repo has handled an in-place currency rename before (`economy_currency_naming.md` — Gems → Pearls, with a backward-compatible field migration) — follow that same pattern here: confirm no code path reads `player.dialMode` after the cutover, and consider a one-time cleanup migration that strips the now-dead field from existing documents rather than leaving stale data sitting there indefinitely.

## 6. Documentation to update

`design/GDD.md` Section 4 ("The Risk & Reward Dial") describes exactly the two-system model this plan removes, and Section 8's headline "30x" chart is built on the Dial axis specifically — both need a rewrite once the merge ships, not just a balance-tables regeneration. `CLAUDE_CODE_BUILD_PROMPT.md`'s own "In scope" list still says "Three Dial modes" — if this change ships, that file is now describing scope that no longer exists, which is exactly the kind of drift Section 0 above is flagging.

## 7. Rollout order

1. Confirm the scope/contract question in Section 0 before writing any code.
2. Design and lock the merged `STAKE_LEVELS` table (Section 2), verified via `gdd-balance.js` — but that tool needs restructuring first (Section 3's last bullet) before it can verify anything, so budget time for that as its own step, not a side effect.
3. Server changes (config → game logic → room/schema/views), in that order, so nothing references a field that's already been deleted upstream.
4. Client changes, once the server's new catalog shape is stable.
5. Migration cleanup on existing player documents.
6. Documentation rewrite (GDD Section 4 and 8, the build prompt's scope list).

## 8. Open questions

- Confirmed you want this — but is it going to whoever holds the ₱60,000 contract as a scope change, or is this purely your own call to make on this project?
- Should the merged Stake levels keep names ("Safer," "Balanced," "All in") for the UI, or go fully numeric like Cambria's own staking (just "Stake: 10")?
- Does `STAKE_LEVELS` stay at five discrete rungs (1/5/10/20/40) or does "exactly like Cambria" mean moving toward a continuous/freeform stake amount, closer to how Cambria's Key-staking actually works? The table above assumes the five rungs stay — a freeform stake would be a bigger follow-on change to the cast-cost and reward math.
