# Configuration reference

Two kinds of setting, and they are not interchangeable.

**Environment variables** are per-deployment: where the database is, which
origins may connect, how loud the logs are. They never contain game balance.

**Config modules** under `server/src/config/` are the game itself: odds, prices,
caps, timings. They are versioned with the code, identical on every deployment,
and changing one requires a restart and a re-run of the balance report.

- [Backend environment variables](#backend-environment-variables)
- [Frontend environment variables](#frontend-environment-variables)
- [Config modules](#config-modules)
- [Key values at a glance](#key-values-at-a-glance)
- [Changing balance safely](#changing-balance-safely)

---

## Backend environment variables

Set in Railway (or Heroku) under **Variables**. Locally, copy
`server/.env.example` to `server/.env`.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGO_URL` | **in production** | *(unset)* | Full connection string including the database name. **Never commit this.** `MONGODB_URI` is accepted as an alias. |
| `ALLOW_MEMORY_DB` | **in production** | `true` | `false` makes the process refuse to boot without a database, instead of silently starting with an in-memory store and losing every player on the next deploy. |
| `CORS_ORIGIN` | **in production** | *(unset — allows any origin)* | Comma-separated exact browser origins, scheme included. Leave unset only in development. |
| `PORT` | no | `2567` | **Do not set this on Railway or Heroku.** They inject it; setting it yourself breaks the health check. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |

Nothing else is read from the environment. There are no feature flags, no
secrets beyond `MONGO_URL`, and no per-deployment balance overrides — that is
deliberate, so that two deployments of the same commit play identically.

### `ALLOW_MEMORY_DB` is the one that bites

Left at `true` in production, a deploy with a typo'd `MONGO_URL` starts
successfully, serves players, and discards everything on the next restart. The
only symptom until then is `"database": "memory"` on `/health`. Set it to
`false` and that becomes a boot failure you find in the deploy log.

---

## Frontend environment variables

Vite bakes these into the bundle **at build time**. Changing one means
rebuilding, not just redeploying. Everything in a `VITE_*` variable ships to the
browser in plain text, so none of it may be secret.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VITE_SERVER_URL` | **in production** | `ws://127.0.0.1:2567` | Backend address. Accepts `wss://`, `ws://`, `https://`, `http://` or a bare hostname; a bare host is assumed to be TLS. |
| `SOURCEMAP` | no | *(unset — maps off)* | Build-time only, not a `VITE_` variable. `SOURCEMAP=true npm run build` emits source maps for debugging. Off by default: the Phaser map alone is ~9.4 MB. |

Local development uses `client/.env.local`; a production build uses
`client/.env.production` (see `client/.env.production.example`) or plain
environment variables in CI.

---

## Config modules

All under `server/src/config/`, re-exported through `index.js`, which also
builds the `CLIENT_CATALOG` payload the client renders from.

| Module | Owns |
|---|---|
| `fish.config.js` | Species list, rarity tiers, per-species XP, unlock levels, bag stack and slot caps |
| `rods.config.js` | The ten rods: cast duration, catch rate, rarity bias, chest chance, XP curve |
| `rewards.config.js` | Chest tiers and reward tables, gem tiers and gold ranges, appraisal traits and grades, consumables, gold-to-dollar rate |
| `economy.config.js` | Currencies, shop items and prices, bait shelf capacity, purchase quantities |
| `game.config.js` | Stake ladder, risk bands, bait cost and regeneration, chat, display names, leaderboard, rate limits, connection timings, world grid, spawn seats, persistence interval, emission monitor |
| `index.js` | Re-export surface and the client catalog |

### What the catalog publishes

`CLIENT_CATALOG` carries presentation data plus the **static** odds — the ones
that depend on nothing about the player. Anything that moves with rod level or
stake is per-player and rides on the `me` payload instead.

Amounts are withheld from chest previews on purpose: the range a reward rolls
within is the part of a chest worth opening it to find out.

---

## Key values at a glance

Read from the config modules; treated as authoritative there, not here.

### Session and connection

| Setting | Value |
|---|---|
| Room name | `harbor` |
| Max clients per room | 8 |
| Simulation tick | 250 ms |
| Recast delay | 400 ms |
| Persist interval | 5 s |
| Leaderboard refresh | 10 s |
| Transport ping | 15 s × 4 retries |
| Reconnection grace | 180 s |

### Economy and progression

| Setting | Value |
|---|---|
| Rod levels | 1–10 (Bamboo → Leviathan) |
| Cast duration | 4.00 s at level 1 → 1.60 s at level 10 |
| Base catch rate | 55% at level 1 → 86% at level 10 |
| Chest chance per catch | 1.28% at level 1 → 2.82% at level 10 |
| Total XP to level 10 | 10,000 |
| Bait per cast | 1 × stake |
| Starting bait | 100 |
| Bait regeneration | +1 every 8 s, only below 25 |
| Shared bait shelf | 50,000 capacity, starts full |
| Gold per dollar | 0.1 |
| Fish bag | 25 slots × 999 per species |
| Chest bag | 60 |
| Uncut gem bag | 120 |
| Max purchase quantity | 1,000 per message |

### Limits and safety

| Setting | Value |
|---|---|
| Message rate limit | 20/s per client |
| `move` rate limit | 15/s per client |
| Chat cooldown | 1.2 s |
| Chat length | 200 characters |
| Chat history (state / stored) | 50 / 200 |
| Display name | 3–16 chars, `[A-Za-z0-9 _-]` |
| Leaderboard size | 10 |
| Emission window | 5 min, 2× alert ratio, 6-window carry |
| HTTP JSON body limit | 16 KB |

Bag behaviour worth knowing: a **full fish bag blocks casts**, a **full chest bag
loses new chest drops**, and a **full gem bag rerolls** the gem reward over the
chest's remaining entries.

---

## Changing balance safely

Everything in `server/src/config/` is live game balance. The loop:

1. **Edit the config module.** Never scatter a constant into a game module —
   `server/src/game/*` reads from config and should keep doing so.
2. **Run the tests.** `npm test` — 107 server tests cover odds, economy,
   progression and the emission model, and several assert on config invariants.
3. **Regenerate the balance report.** `npm run balance` prints the current
   tables; `node server/tools/gdd-balance.js --write` rewrites
   `design/balance-tables.md` in place.
4. **Read what changed.** The report gives hourly gold, XP pacing, species mix
   and chest EV per rod and stake. A change that looks small in a config file
   can move hourly gold by multiples.
5. **Commit config and regenerated tables together**, so the documented balance
   and the shipped balance never disagree.
6. **Restart the backend.** Config is read at module load. A running process
   keeps the old numbers.
7. **Watch the emission monitor** for the first few windows after deploy — see
   [OPERATIONS.md](OPERATIONS.md).

The client needs no rebuild for a balance change: it renders whatever the
catalog and `me` payload hand it.
