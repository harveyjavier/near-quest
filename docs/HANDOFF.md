# Handoff

What is in this delivery, what was taken out of it, and what is still open.

Read the open items before anything ships to the public. Two of them are
blocking, one needs a decision that is not a developer's to make, and the rest
are things that will generate a question sooner or later.

- [What is delivered](#what-is-delivered)
- [Verified on delivery](#verified-on-delivery)
- [Open items](#open-items)
- [Decisions for the recipient](#decisions-for-the-recipient)
- [What was removed, and why](#what-was-removed-and-why)
- [Before zipping this folder](#before-zipping-this-folder)
- [Added after handoff](#added-after-handoff)

---

## What is delivered

A complete, runnable, documented multiplayer fishing game.

**Frontend** — Phaser 3 world, HTML/CSS HUD, Vite build, Firebase Hosting
config with cache and security headers already set.

**Backend** — Colyseus room with the authoritative idle loop, Express health and
catalog endpoints, MongoDB persistence with an in-memory fallback for
development, graceful shutdown, rate limiting, payload validation, and an
emission monitor that watches minted currency against the balance model.

**Content and balance** — ten rods, six species, four chest tiers, four gem
tiers, a five-rung stake ladder, a shop with a shared bait shelf, all of it in
`server/src/config/` and none of it hardcoded in game logic.

**Tests** — 107 server assertions across 18 suites, client unit tests, an
end-to-end smoke test (see open item 1), and a deterministic balance report.

**Artwork** — committed and ready to run, plus the Python builders that
regenerate it and a browser-based collision-map editor.

**Documentation** — the eight documents linked from the
[README](../README.md), covering architecture, protocol, configuration, data
model, development, deployment, operations and this handoff.

**CI** — `.github/workflows/ci.yml` runs tests and a production build on every
push.

---

## Verified on delivery

Run in a clean checkout on Node 22, at the time of writing:

| Check | Result |
|---|---|
| `npm test` | **107 passed**, 0 failed, 18 suites (server) |
| `npm --prefix client run test:level` | **2 passed**, 0 failed |
| `npm run build` | Succeeds; 1.5 MB of JS across three chunks |
| Server boot | Clean, `/health`, `/catalog` and `/` all answer |
| `npm run balance` | Generates the full tables |
| `npm run smoke` | **Fails** — see open item 1 |

---

## Open items

### 1. The end-to-end smoke test fails

**Blocking for any release that treats `npm run smoke` as a gate — which
DEPLOYMENT.md and the release checklist both do.**

The test passes its session, catalog, core-loop and progression phases, then
fails at:

```
Treasure chests
  FAIL  chests drop from catches while idling -- none held after 240s of fishing

Gem appraisal and rod upgrades
  ....  opening chests until an uncut gem drops        <- then hangs
```

**Cause.** The test predates the chest rarity rebalance, which made chests
roughly eight times rarer. At rod level 1 and stake 1 the chest rate is now
about **one chest per ten minutes** of continuous fishing:

```
catch rate    0.55 × 1.25  = 0.688 per cast
chest chance  0.0128 × 0.85 = 0.0109 per catch
              → 0.0075 chests per cast
cast + recast 4.0 s + 0.5 s = 4.5 s  → 13.3 casts/min
              → 0.10 chests per minute
```

Against the test's 240-second budget that is 0.4 expected chests, so the
assertion fails about **two runs in three**. The gem phase then waits for a
chest that never arrives and hangs until the harness kills it.

**This is a test problem, not a game problem.** The game is behaving exactly as
the rebalanced configuration specifies, and the unit suite covers `openChest`
and gem appraisal deterministically.

**Options, roughly in order of preference:**

1. **Move the rare-drop coverage into the unit suite** (where `openChest` and
   `appraiseGem` are already tested with a seeded RNG) and leave the smoke test
   asserting what it can observe reliably — that chest and gem fields are wired
   through `cast_result` and `me` with the right shape. Keeps the end-to-end
   test fast and deterministic. No production code changes.
2. **Give the smoke run a head start** — have it grant itself a higher rod level
   through legitimate play before the chest phase, and raise the budget. Slower
   and still probabilistic.
3. **Extend the budget to ~25 minutes** for 95% reliability. Honest, and almost
   certainly too slow to keep in anyone's release process.

Until it is resolved, the release checklist says to run it and confirm the
failures are confined to the chest, gem and appraisal phases.

### 2. Concurrency is capped at eight players, and fails quietly above it

**Blocking for any public launch that expects more than eight simultaneous
players.**

`MAX_CLIENTS_PER_ROOM` is 8 and the client joins with `joinOrCreate`, so the
ninth concurrent player gets a **second** harbour: separate live chat, separate
player list, and a separate in-memory copy of the shared bait shelf that the two
rooms then overwrite for each other. Nothing errors; the world simply splits and
the shelf figures drift.

Raising the constant is not the fix — it moves the seam without removing it. The
work required is set out in
[OPERATIONS.md](OPERATIONS.md#if-you-need-more-than-eight-concurrent-players).

If the intended launch is a small shared harbour, this is not a defect and
nothing needs doing. It only needs to be said out loud before anyone quotes a
player count.

### 3. No chat moderation

Chat is rate-limited (1.2 s) and length-capped (200 characters). It is not
filtered, and there is no mute, ban, report or delete affordance. The only
remedies are editing documents in MongoDB directly and restarting the backend.

For a public launch with anonymous guest sessions, this needs building.

### 4. `chatmessages` grows without limit

The room only ever reads the most recent 200 rows, and nothing prunes the rest.
It will grow until storage becomes the reason for an outage. A scheduled job is
the fix — query and rationale in
[OPERATIONS.md](OPERATIONS.md#chatmessages-is-growing-without-limit).

### 5. The client image payload is large

About **16.7 MB** of images under `client/public/assets`. Some load lazily
through CSS, but the standouts are worth a pass with an image optimiser:

| File | Size |
|---|---|
| `gems.png` | 3.0 MB |
| `gems-cut.png` | 2.4 MB |
| `harbor-environment.png` | 2.3 MB |
| `login/anglers-club/forest-pond-background.png` | 2.1 MB |
| `login/anglers-club/login-card-shell.png` | 1.5 MB |
| `ui/cozy-walnut-texture-v1.png` | 1.05 MB |
| `ui/cozy-parchment-texture-v1.png` | 1.02 MB |

These are full-resolution source plates being served as runtime sprites. The gem
sheets in particular render at icon size. Downscaling to the size actually drawn
and running the set through `oxipng` or `pngquant` should remove most of it
without a visible difference. Not blocking, but it is the largest single lever
on load time and it costs an afternoon.

Source maps have already been turned off for production builds, which removed
about 10 MB from the deployed bundle.

### 6. Two mirrored constants have no automated guard

Neither is currently wrong; both will drift eventually.

- `WORLD` in `server/src/config/game.config.js` mirrors `WORLD_COLUMNS` /
  `WORLD_ROWS` in `client/src/world/level.js`. The server clamps avatar
  positions to its own copy, so a mismatch walls players out of the map edge.
- `DISPLAY_NAME` in the server config mirrors `NAME_RULES` in
  `client/src/config.js`.

A test asserting each pair matches would close this cheaply.

### 7. Up to five seconds of progress is lost on an unclean kill

Player documents flush every five seconds, and on disconnect and shutdown. A
`SIGTERM` drains cleanly and loses nothing; a `kill -9`, an OOM or a platform
hard-stop loses whatever happened since the last flush.

This is the intended trade — a synchronous write per action would put MongoDB on
the hot path of every cast. Documented rather than fixed, but worth confirming
the recipient agrees with the trade.

---

## Decisions for the recipient

**Licensing.** No `LICENSE` file has been added, deliberately: for commissioned
work the terms belong to the parties, and inventing one would misstate them.
Whatever the contract says should be reflected in a `LICENSE` file at the root
before the repository goes anywhere.

**Third-party artwork.** `assets/sprites/character-template-readme.txt` carries
attribution for the character template. Confirm its licence permits the intended
commercial use, and that any other sourced art is likewise cleared.

**Hosting accounts.** The Railway, Firebase and MongoDB Atlas projects need to be
owned by whoever will operate this, not by whoever built it. Transfer or recreate
them, and rotate the database password on transfer.

**Player-facing terms.** There is no privacy policy or terms page. There is very
little to disclose — no accounts, no email, no IP, no analytics, no third-party
trackers; a display name and chat text are the only human-supplied data stored —
but "very little" is still not "none", and most jurisdictions expect the page to
exist.

---

## What was removed, and why

Performed by `tools/cleanup-for-release.ps1`, which is a dry run by default and
refuses to touch a dirty working tree. Everything tracked was removed with
`git rm`, so all of it remains in history.

**Business and third-party reference**

| Removed | Why |
|---|---|
| `Fishing_Game_Contract_v2.3.docx` | Commercial agreement, not project source. |
| `design/Robin's Club GDD.pdf` | Third-party reference used during design; not ours to redistribute. |

**Superseded design material**

| Removed | Why |
|---|---|
| `design/GDD.docx` | `design/GDD.md` is the maintained version; two copies drift. |
| `design/cambria-cost-structure-plan.md` | Proposal. Never built. |
| `design/cambria-inspired-balance-plan.md` | Proposal. Accepted parts already in `GDD.md`. |
| `design/cambria-key-monetization-plan.md` | Proposal. No monetisation is implemented. |
| `design/cambria-stake-dial-collapse-plan.md` | Proposal. Never signed off. |
| `design/gold-value-anchor-rebalance-plan.md` | Superseded; the balance it argued for is live and in `balance-tables.md`. |
| `design/web3-sustainability-rebalance-plan.md` | Proposal. Outside delivered scope. |

The reason for cutting all six plan documents is the same: they read like
specifications and describe behaviour the game does not have. Left in a handed-
over repository, they are the most likely thing to mislead the next developer.
`design/GDD.md`, `design/balance-tables.md` and `design/harbor-systems-map.md`
describe what actually ships.

**Build output and scratch** — `tools/__pycache__`, `tools/_gdd_images`
(~19 MB of intermediate page images), `client/dist` (stale build output), and
the empty `tmp/` and `output/` directories. All regenerated on demand and all
already ignored by Git.

**Kept deliberately:** `assets/` (the builders read it), `design/charts/` (the
GDD references them), the Python builders and the collision-map editor.

`tools/cleanup-for-release.ps1` has no purpose after the cleanup commit and may
be deleted with it.

---

## Before zipping this folder

`git clone` and `git archive` are clean. **A zipped copy of the working folder
is not.**

- `server/.env` — contains the MongoDB connection string, including credentials.
- `client/.env.local`, `client/.env.production` — local build config.
- `node_modules/` in both workspaces — hundreds of megabytes, reinstalled by
  `npm run install:all`.

Git ignores all of these, which is exactly why a folder copy carries them and a
clone does not. The cleanup script reports which are present but does not delete
them; they are yours.

**Delivering via Git avoids the whole problem.** If a folder must be sent,
delete the `.env` files and both `node_modules` directories first, and rotate the
database password afterwards on the assumption the string was exposed.

---

## Added after handoff

Wallet sign-in, USDC deposits and the first two Gold sinks were built after the
delivery above. Details: [ARCHITECTURE.md](ARCHITECTURE.md#identity-guests-and-wallets),
[PROTOCOL.md](PROTOCOL.md#http-endpoints), [OPERATIONS.md](OPERATIONS.md#deposits).

**What changed**

- Sign-in with a NEAR wallet (Meteor, HERE, MyNearWallet) or MetaMask. One
  player per wallet; a device's guest save is kept on first sign-in. Session
  tokens rotate on every sign-in, expire after 30 days, and can be revoked.
- USDC deposits on NEAR into the USDG balance, verified on-chain. Off until
  `NEAR_TREASURY_ACCOUNT` is set. The old free "deposit" now only works with
  `ALLOW_FAKE_DEPOSITS=true`, for local development.
- Chest keys (Epic 6 Gold, Legendary 20) and a 15% assay fee on appraisals.
- A browser test, `npm --prefix client run test:ui`.
- `node_modules` is no longer tracked in git.

**Open before deposits go live**

1. **Contract and legal.** The original contract excluded a real-money path,
   and a stake with real-value inputs can count as gambling in some places.
   Settle both before setting a treasury in production. This is not a
   developer's call.
2. **Real-wallet test.** Sign-in and deposits are tested with stand-in
   wallets. The deposit check also runs against one real relayed testnet USDC
   transfer (a captured RPC response), but no deposit of ours has gone through
   end to end. Do one testnet sign-in and one small deposit with each of
   MetaMask, Meteor, HERE and MyNearWallet.
3. **USDC contract ids** in `server/src/config/near.config.js` were written
   from memory. The testnet id is confirmed live (real `ft_transfer` traffic);
   check the mainnet one against Circle's published addresses.
4. **Treasury setup**: create it, register it for storage on the USDC contract,
   keep its keys offline. Steps in [OPERATIONS.md](OPERATIONS.md#turning-them-on).

**Open balance decision**

Stakes 5 and 10 lose Gold at every rod level once bait is bought, and did
before the new sinks; the sinks deepen that by 8-26%. Section 3.2 of
`design/web3-sustainability-rebalance-plan.md` proposes gem, chest XP and bait
changes to fix it, but its numbers were written against an older config.
Choosing new numbers is the next step.

**Known gaps**

- No withdrawals or refunds; deposits only go in.
- `client/` carries 21 low and moderate npm advisories inside the wallet
  vendors' SDKs (`decode-uri-component`, `elliptic`) with no non-breaking fix.
  High-severity ones are patched with `overrides` in `client/package.json`.
- `test:ui` needs a local Chromium and is not part of CI.
