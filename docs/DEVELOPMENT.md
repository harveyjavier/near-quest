# Development guide

Getting the project running, the layout of the tree, how to test it, and how the
artwork is maintained.

- [Requirements](#requirements)
- [First run](#first-run)
- [Repository layout](#repository-layout)
- [npm scripts](#npm-scripts)
- [Testing](#testing)
- [Working on the game](#working-on-the-game)
- [Artwork pipeline](#artwork-pipeline)
- [The collision map editor](#the-collision-map-editor)
- [Coding conventions](#coding-conventions)

---

## Requirements

| | |
|---|---|
| Node.js | 22 LTS (see `.nvmrc`). 20 is the declared minimum and works. |
| npm | Ships with Node. |
| MongoDB | **Optional for development.** Without it the server uses an in-memory store. |
| Python 3 + Pillow + NumPy | **Only** to regenerate artwork. Not needed to build or run the game. |

The runtime artwork is committed, so a fresh clone runs with Node alone.

---

## First run

```bash
npm run install:all
```

Then two terminals:

```bash
npm run dev:server     # Colyseus + Express on :2567
npm run dev:client     # Vite on :5173
```

Point the client at the server once:

```bash
echo "VITE_SERVER_URL=ws://127.0.0.1:2567" > client/.env.local
```

Open the URL Vite prints. Enter a display name and you are fishing. Vite is
configured with `host: true`, so the same URL works from a phone on the same
network — useful for touch-layout QA.

Without `MONGO_URL` the server logs a loud warning and stores everything in
process memory. Progress lasts until the server restarts. To develop against a
real database:

```bash
# server/.env
MONGO_URL=mongodb://127.0.0.1:27017/fishing-idle
```

and seed it once with `npm run seed`.

Both `.env.example` files document every variable; the full reference is in
[CONFIGURATION.md](CONFIGURATION.md).

---

## Repository layout

```
.
├── client/                     Phaser 3 + HTML/CSS frontend (Vite)
│   ├── index.html              Shell, login gate, HUD skeleton
│   ├── public/assets/          Runtime artwork, copied verbatim into dist/
│   ├── src/
│   │   ├── config.js           Backend URL resolution, name rules
│   │   ├── main.js             Boot, login gate, Phaser game setup
│   │   ├── net/NetClient.js    Colyseus wrapper, heartbeat, guest session
│   │   ├── scenes/             BootScene (asset load), HarborScene (world)
│   │   ├── ui/                 hud.js (all panels), format.js, typing.js
│   │   ├── world/              level.js, pathfind.js, collision-grid.json
│   │   ├── art/                Runtime sprite metadata and palettes
│   │   └── style.css           The entire HUD stylesheet
│   ├── test/                   level.test.js (unit), smoke.js (end-to-end)
│   ├── firebase.json           Hosting config: SPA rewrites, cache headers
│   └── vite.config.js          Build config, vendor chunk split
│
├── server/                     Colyseus + Express backend
│   ├── src/
│   │   ├── index.js            Process entry: Express, Colyseus, shutdown
│   │   ├── config/             ALL game balance. See CONFIGURATION.md
│   │   ├── rooms/
│   │   │   ├── HarborRoom.js   Lifecycle, message handlers, cast loop
│   │   │   ├── views.js        Private per-player payloads
│   │   │   └── schema/         Colyseus synchronised state
│   │   ├── game/               Pure gameplay: fishing, chests, economy,
│   │   │                       progression, odds, metrics, balanceModel
│   │   ├── db/                 models.js, repo.js (Mongo + memory), seed.js
│   │   └── util/               logger, rng, validate
│   ├── test/                   game.test.js, metrics.test.js
│   ├── tools/                  balance.js, gdd-balance.js
│   ├── railway.json            Railway build and health check
│   ├── nixpacks.toml           Pins Node 22 on Railway
│   └── Procfile                Heroku entry
│
├── design/                     GDD.md, balance-tables.md, harbor-systems-map.md, charts/
├── docs/                       This documentation set
├── assets/                     Source artwork the builders read
├── tools/                      Python artwork builders, collision-map editor
└── .github/workflows/ci.yml    Tests and build on push
```

Two coupling points worth knowing about, because nothing enforces them:

- **World dimensions.** `WORLD` in `server/src/config/game.config.js` mirrors
  `WORLD_COLUMNS` / `WORLD_ROWS` in `client/src/world/level.js`. The server
  clamps avatar positions to its own copy, so a mismatch walls players out of
  the edge of the map.
- **Display-name rules.** `NAME_RULES` in `client/src/config.js` mirrors
  `DISPLAY_NAME` in the server config. The client copy exists only for instant
  feedback on the login gate; the server's copy is the one that decides.

---

## npm scripts

Run from the repository root.

| Script | Does |
|---|---|
| `npm run install:all` | Install both workspaces. |
| `npm run dev:server` | Server with `--watch`. |
| `npm run dev:client` | Vite dev server. |
| `npm test` | Server suite (107 tests) + client unit tests. |
| `npm run build` | Production client build into `client/dist`. |
| `npm run verify` | `npm test` then `npm run build`. What CI runs. |
| `npm run smoke` | End-to-end test against a running server. |
| `npm run balance` | Print the current balance tables. |
| `npm run seed` | Create indexes and welcome chat. Needs `MONGO_URL`. |

---

## Testing

Three layers, and they cover different failure modes.

### Unit and integration — `npm test`

`server/test/game.test.js` (107 assertions across 18 suites) exercises the game
modules directly: catch and chest rolls at every rod and stake, chest reward
tables, gem appraisal, purchases and stock, progression and upgrade costs, bag
caps and their overflow behaviour, and validation of every message payload
shape.

`server/test/metrics.test.js` checks the emission monitor against the shared
balance model, including that a deliberate over-minting exploit trips the wire.

`client/test/level.test.js` checks the collision grid and pathfinding.

These need no database and no running server. They are fast, and they are what
you run on every change.

### End-to-end — `npm run smoke`

Drives a **real running server** with the real client library and asserts the
whole contracted loop: join → cast → catch → XP → level → chest → shop, plus
guest-session persistence and the three multiplayer surfaces (player list, chat,
leaderboard) across two concurrent sessions.

```bash
npm run dev:server                                   # terminal 1
npm --prefix client run smoke -- ws://127.0.0.1:2567  # terminal 2
```

The endpoint argument is not optional in practice — the built-in default is
`ws://127.0.0.1:3001`, which is not the server's default port. It can also be
given as `SMOKE_ENDPOINT`.

It idles in real time waiting for a rod level-up and a chest drop, so it takes
a few minutes. It exits non-zero on the first failed assertion, so it can gate a
deploy. Run it against a staging backend before a release, never against
production — it creates guest sessions and posts chat.

### Balance — `npm run balance`

Not a pass/fail test but a report: hourly gold, XP pacing, species mix and chest
EV for every rod and stake. Run it after any config change and read what moved.
`node server/tools/gdd-balance.js --write` rewrites `design/balance-tables.md`
from the live configuration.

---

## Working on the game

**Balance and content** live entirely in `server/src/config/`. Adding a fish,
retuning a rod, repricing the shop, changing chest odds — all config edits, no
client rebuild. The full loop for doing it safely is in
[CONFIGURATION.md](CONFIGURATION.md#changing-balance-safely).

**New mechanics** belong in `server/src/game/` as pure functions over a player
record, called from a handler in `HarborRoom`. Keeping them pure is what makes
them testable without a socket, and it is why `game.test.js` can cover the
economy without standing a server up.

**New messages** need three things: a validator in `server/src/util/validate.js`,
a handler registered through `this.handle(...)` in `HarborRoom` (not raw
`onMessage`, which skips the rate limit and the error wrapper), and an entry in
[PROTOCOL.md](PROTOCOL.md).

**Never** add a message that grants a currency or reports an outcome the client
computed. If a change wants `send('grantGold', ...)`, the logic belongs in the
room.

**HUD work** is `client/src/ui/hud.js` and `client/src/style.css`. Both are
large single files by deliberate choice — the HUD is one interacting system and
splitting it previously produced more cross-imports than clarity.

---

## Artwork pipeline

Runtime artwork is committed under `client/public/assets/`, so **Python is not
required to build or run the game.** The builders exist to regenerate it.

To regenerate, install Pillow and NumPy and run the script from the repository
root:

| Tool | Output |
|---|---|
| `tools/build_character.py` | Angler sheet and pose metadata |
| `tools/build_icons.py` | Fish sheet and metadata |
| `tools/build_chest_icons.py` | Chest sheet and metadata |
| `tools/build_gem_icons.py` | Uncut gem sheet and metadata |
| `tools/build_cut_gem_icons.py` | Cut gem sheet and metadata |
| `tools/build_bait_icon.py` | Bait icon and metadata |
| `tools/build_gold_icon.py` | Gold icon and metadata |
| `tools/build_pearl_icon.py` | Pearl icon and metadata |
| `tools/build_spark_icon.py` | Fishing-power icon |
| `tools/build_shopkeeper.py` | Shopkeeper image |
| `tools/build_ui_pack.py` | Inventory slot images and manifest |
| `tools/build_4443_spritesheet.py` | 4×4×4×3 sheet assembly helper |
| `tools/remove_checkerboard_background.py` | Strips checkerboard alpha from new source art |

Source plates the builders read live in `assets/`. `assets/sprites/` also holds
the character template and its attribution note.

The illustrated harbor background, the login artwork and the HUD panels are
maintained **directly** in `client/public/assets` — no builder generates them,
and `build_ui_pack.py` is written to preserve them.

Keep source art only while a maintained tool needs it, and public art only while
the client uses it or it documents a current sprite sheet.

---

## The collision map editor

`tools/collision-map-editor.html` is a standalone page — open it in a browser,
no server needed. It paints walkable and solid tiles over the current harbor
background and exports `client/src/world/collision-grid.json`, which
`client/src/world/level.js` reads as the movement map.

After changing the grid, run `npm --prefix client run test:level`: the level
test checks the grid's shape and that the spawn seats are reachable.

---

## Coding conventions

The existing code is consistent about these; new code should be too.

- **ES modules everywhere.** Both packages set `"type": "module"`.
- **No build step on the server.** It runs the source directly. Keep it to
  syntax Node 20+ supports natively.
- **Comments explain *why*.** The codebase is unusually well commented, and the
  comments carry design reasoning that is not recoverable from the code —
  why the ping intervals are what they are, why the emission window carries,
  why odds are published but amounts are not. Preserve that when editing, and
  add to it when a decision is not obvious.
- **Config over constants.** A number that a designer might want to change goes
  in `server/src/config/`, not inline in a game module.
- **Server decides, client renders.** The single rule the architecture rests on.
