# Data model

MongoDB via Mongoose. Three collections, no relations, no migrations to date.

Schemas live in `server/src/db/models.js`; every read and write goes through the
repository in `server/src/db/repo.js`, which presents the same interface for the
MongoDB store and the in-memory fallback.

- [What is stored about a person](#what-is-stored-about-a-person)
- [players](#players)
- [chatmessages](#chatmessages)
- [worlds](#worlds)
- [Indexes](#indexes)
- [Seeding](#seeding)
- [Backup and restore](#backup-and-restore)
- [Changing the schema](#changing-the-schema)

---

## What is stored about a person

**No accounts and no personal data.** A player document is keyed by an opaque,
server-generated `sessionToken` held in the browser's `localStorage`. There is
no email, no password, no IP address and no device fingerprint stored anywhere.

The only human-supplied field in the entire database is the display name, which
is validated to 3–16 characters of `[A-Za-z0-9 _-]` — and chat message text.

This is worth stating plainly to whoever operates the game, because it decides
two things: there is no account-recovery path to build, and a data-subject
request has almost nothing to answer with. If a player wants their data gone,
deleting the one document matching their token is the whole operation.

---

## `players`

One document per guest session.

| Field | Type | Notes |
|---|---|---|
| `sessionToken` | String | Unique, indexed. Opaque 64-char server-generated token. The only identity. |
| `nearAccountId` | String | Optional. Unique, sparse. Set once by NEAR wallet sign-in, never changed. |
| `displayName` | String | 3–16 chars. Set once at first join; later joins keep the stored value. |
| `rodLevel` | Number | 1–10. |
| `xp` | Number | Progress toward the next level. |
| `totalXp` | Number | Lifetime. |
| `bait` | Number | Wallet. |
| `gold` | Number | Wallet. |
| `pearls` | Number | Wallet. Named Pearl rather than Gems so it stops colliding with `uncutGems`, which are items, not currency. |
| `stake` | Number | Current stake rung. |
| `autoFishing` | Boolean | Idle loop on/off. |
| `totalCasts` | Number | Lifetime. |
| `totalCatches` | Number | Lifetime. Leaderboard tiebreaker. |
| `catchCounts` | Mixed | `speciesId → count`. |
| `inventory` | Mixed | `itemId → count`. |
| `buffs` | Mixed | `buffId → remaining casts`. |
| `chests` | `[{ id, tier, at }]` | Unopened. Cap 60. |
| `uncutGems` | `[{ id, tier, at }]` | Unappraised. Cap 120. |
| `fish` | `[{ id, speciesId, xp, at }]` | Bag. 25 slots × 999 per species. |
| `rewardLog` | `[{ type, name, amount, speciesId, chestTier, gemTier, at }]` | Recent rewards; the client is sent the last 30. |
| `lastBaitRegenAt` | Number | Epoch ms. Regeneration is computed on join and on tick from this. |
| `createdAt` | Number | Epoch ms. |
| `lastSeenAt` | Number | Epoch ms. Written on leave. |

Two details that are load-bearing:

**`fish[].xp` is frozen at catch time.** It is not recomputed on cash-in, so a
stake change after the catch cannot re-price a fish already in the bag. Anything
that "fixes" this by recomputing on cash-in reopens that exploit.

**`minimize: false`** is set on the schema, so empty `Mixed` objects persist as
`{}` rather than vanishing. Code that reads `catchCounts` or `inventory` can
assume the key exists.

---

## `chatmessages`

| Field | Type | Notes |
|---|---|---|
| `name` | String | Display name at the time of posting. |
| `text` | String | ≤200 characters. |
| `at` | Number | Epoch ms, **server clock**, indexed. Never client-supplied. |

The room loads the most recent 200 on creation and keeps the last 50 in shared
state. Nothing prunes this collection automatically — see
[OPERATIONS.md](OPERATIONS.md) if it grows.

---

## `worlds`

A single document, keyed `key`, holding what belongs to the harbour rather than
to anybody in it.

| Field | Type | Notes |
|---|---|---|
| `key` | String | Unique, indexed. Fixed id. |
| `baitStock` | Number | The shop's shared shelf. Capacity 50,000. |
| `emission.goldMinted` | Number | Cumulative, lifetime. |
| `emission.pearlsMinted` | Number | Cumulative, lifetime. |
| `emission.baitMinted` | Number | Cumulative, lifetime. |
| `emission.windowStartedAt` | Number | When counting began. Without it the totals have no scale. |
| `updatedAt` | Number | Epoch ms. |

One document rather than one per player, because the shelf has to survive a
restart — otherwise the shelves silently refill themselves on every deploy.

The emission totals only ever increase. Resetting them is not a repair; it
destroys the comparison that makes them worth having.

**This document is why the deployment must run one room.** It is loaded into
room memory once and written back on a timer, so two rooms hold two copies and
overwrite each other. See
[ARCHITECTURE.md](ARCHITECTURE.md#scaling-limits).

---

## Indexes

Created by `npm run seed`, or by Mongoose on first connect.

| Collection | Index | For |
|---|---|---|
| `players` | `{ sessionToken: 1 }` unique | Join lookup — the hot path. |
| `players` | `{ rodLevel: -1, totalCatches: -1 }` | Leaderboard refresh, every 10 s. |
| `chatmessages` | `{ at: 1 }` | Loading recent history on room creation. |
| `worlds` | `{ key: 1 }` unique | Single-document lookup. |

The leaderboard index is the one that matters as the collection grows; without
it the 10-second refresh turns into a collection scan.

---

## Seeding

```bash
cd server
MONGO_URL="mongodb+srv://..." npm run seed
```

Creates the indexes and a few welcome chat messages. Safe to re-run — it is
idempotent.

```bash
npm run seed -- --reset
```

**Drops every player and every chat message first.** There is no recovery: no
accounts, no email, nothing to restore a session token from. Never run this
against production without a fresh backup you have verified.

---

## Backup and restore

Nothing in the application backs itself up. On Atlas, turn on continuous or
scheduled backups for the cluster; on a self-hosted instance, schedule
`mongodump`.

```bash
# Snapshot
mongodump --uri="mongodb+srv://..." --db=fishing-idle --archive=fishing-idle-$(date +%F).gz --gzip

# Restore into an empty database
mongorestore --uri="mongodb+srv://..." --archive=fishing-idle-2026-09-08.gz --gzip
```

Restore into a scratch database first and point a staging backend at it before
overwriting anything live.

---

## Changing the schema

There is no migration framework, and given the shape of the data there does not
need to be one — but the absence has rules:

- **Additive changes are free.** A new field with a default is read as its
  default on every existing document. Prefer this.
- **Renaming or removing a field needs a script.** Write it, run it against a
  restored copy of the backup first, and keep it in the repository next to
  `seed.js` so the change is auditable.
- **Never widen a cap downward without a plan.** Lowering the fish or chest bag
  cap leaves existing documents over the new limit; decide whether they are
  truncated, grandfathered, or refunded before shipping it.
- **`repo.js` has two implementations.** Any schema change has to land in the
  in-memory store as well, or `npm test` and local development drift away from
  production behaviour.
