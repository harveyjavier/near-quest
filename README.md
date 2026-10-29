# Fishing Idle Game MMO

A shared browser fishing harbour. Players join as guests, fish an idle loop,
open chests, appraise gems, buy bait and progress their rods in one live world
with chat and a leaderboard.

Phaser 3 client, authoritative Colyseus server, MongoDB persistence. No
accounts, no logins, no personal data — a guest session is an opaque token in
the browser's `localStorage`.

---

## Documentation

| Document | For |
|---|---|
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running it locally, repository layout, testing, artwork pipeline |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works, what the server decides, **scaling limits** |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable and config module |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Every message, endpoint, state field and error code |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | MongoDB collections, indexes, backup, schema changes |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Getting it hosted: Atlas, Railway, Firebase |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Running it: monitoring, incidents, rollback, known limits |
| [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) | Pre-flight before each deploy |
| [docs/HANDOFF.md](docs/HANDOFF.md) | **What is delivered, what is outstanding, what needs a decision** |

Game design lives in [design/GDD.md](design/GDD.md), with the generated
[balance tables](design/balance-tables.md) and the
[systems map](design/harbor-systems-map.md).

**Start with [docs/HANDOFF.md](docs/HANDOFF.md)** if you have just received this
project — it lists the open items before anything ships publicly.

---

## Quick start

Node 22 (see `.nvmrc`). No database needed to run it.

```bash
npm run install:all
echo "VITE_SERVER_URL=ws://127.0.0.1:2567" > client/.env.local
```

Then, in two terminals:

```bash
npm run dev:server     # Colyseus + Express on :2567
npm run dev:client     # Vite on :5173
```

Open the URL Vite prints, enter a display name, and you are fishing.

Without `MONGO_URL` the server uses an in-memory store and warns loudly;
progress lasts until it restarts. Both `.env.example` files document every
variable.

---

## Scripts

| | |
|---|---|
| `npm run install:all` | Install both workspaces |
| `npm run dev:server` / `npm run dev:client` | Development servers |
| `npm test` | Server suite (142 tests) + client unit tests |
| `npm run build` | Production client build into `client/dist` |
| `npm run verify` | `npm test` then `npm run build` — what CI runs |
| `npm run smoke` | End-to-end test against a running server |
| `npm --prefix client run test:ui` | Browser test: wallet sign-in, deposit panel, chest keys, assay fee (needs Chromium) |
| `npm run balance` | Print the current balance tables |
| `npm run seed` | Create indexes and welcome chat (needs `MONGO_URL`) |

---

## Repository layout

```
client/     Phaser 3 + HTML/CSS frontend (Vite)
server/     Colyseus + Express backend; server/src/config is ALL game balance
design/     GDD, generated balance tables, systems map, charts
docs/       Architecture, protocol, configuration, data model, operations
assets/     Source artwork the Python builders read
tools/      Artwork builders and the collision-map editor
```

Full annotated tree in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#repository-layout).

---

## The one rule

**The server decides, the client renders.**

Every catch, chest, reward, price and level-up is computed server-side from a
seed no client sees. The client sends intents and draws what comes back. There
is no message that grants a currency or reports an outcome the client computed,
and adding one would undo the design.

Odds are published to the client deliberately — a probability says nothing about
the next draw — but reward *amounts* and the raw weight tables are not, and a
smoke-test assertion fails the build if either leaks.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Before promising concurrency

The build is scoped to **one 8-seat harbour on a single replica**. The ninth
concurrent player gets a second, separate world with its own copy of the shared
bait shelf. This is a design ceiling, not a configuration value — raising the
constant moves the seam without removing it.

Read [Scaling limits](docs/ARCHITECTURE.md#scaling-limits) before quoting anyone
a player count.

---

## Artwork

Runtime artwork is committed, so Python is not needed to build or run the game.
The builders under `tools/` regenerate it from the source plates in `assets/`,
and need Pillow and NumPy. The illustrated harbour, login art and HUD panels are
maintained by hand in `client/public/assets` and no builder generates them.

Details and the full tool table:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#artwork-pipeline).
