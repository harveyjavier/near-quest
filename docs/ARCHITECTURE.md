# Architecture

How the pieces fit together, what each one is allowed to decide, and where the
limits of the current design are.

- [The shape of the system](#the-shape-of-the-system)
- [Authority: what the server decides](#authority-what-the-server-decides)
- [The harbor room](#the-harbor-room)
- [Two channels: shared state and private messages](#two-channels-shared-state-and-private-messages)
- [The cast loop](#the-cast-loop)
- [Identity: guests and wallets](#identity-guests-and-wallets)
- [Deposits](#deposits)
- [Persistence](#persistence)
- [The emission monitor](#the-emission-monitor)
- [Scaling limits](#scaling-limits)
- [Security posture](#security-posture)

---

## The shape of the system

Three deployed pieces, and nothing else:

```
   Browser                    Node process                  MongoDB
 ┌────────────────┐        ┌────────────────────┐        ┌──────────────┐
 │ Phaser 3 scene │        │ Express            │        │ players      │
 │ HTML/CSS HUD   │◄─HTTPS─┤   /health          │        │ chatmessages │
 │ colyseus.js    │        │   /catalog         │        │ worlds       │
 │                │        │                    │        └──────────────┘
 │                │◄─WSS──►│ Colyseus           │                ▲
 │                │        │   HarborRoom       │───── mongoose ─┘
 └────────────────┘        │   idle loop @250ms │
   Firebase Hosting        │   config/*         │
   (static files)          └────────────────────┘
                             Railway / Heroku
                             (persistent process)
```

The frontend is a static bundle. It has no server of its own, no API routes and
no build-time secrets — everything it knows about the game arrives over the
socket or from `GET /catalog`.

The backend is one long-lived Node process. It is **not serverless-safe**: the
`HarborRoom` holds every in-flight cast timer in memory, and a runtime that
cold-starts per request or freezes between invocations would drop them. This
constraint drives the whole hosting choice in [DEPLOYMENT.md](../DEPLOYMENT.md).

MongoDB stores durable player, chat and world records. It is not on the hot
path: the room reads a player once on join and writes back on a timer.

---

## Authority: what the server decides

The rule the codebase is organised around: **the client is a renderer.** It
sends intents and draws what comes back. It never computes a reward, an odds
table, a level-up, or a currency balance.

Concretely, the server alone decides:

| Decision | Where |
|---|---|
| Whether a cast hooks anything, and which species | `server/src/game/fishing.js` |
| Whether a chest drops, and of which tier | `server/src/game/chests.js` |
| What a chest pays out | `server/src/game/chests.js` |
| What an appraised gem is worth | `server/src/game/economy.js` |
| XP, rod level, upgrade cost | `server/src/game/progression.js` |
| Every currency balance and bag count | `server/src/db/repo.js` records |
| Shop prices, stock and purchase validity | `server/src/game/economy.js` |

The client cannot make any of these move except by sending a message the room
accepts. Every inbound message is validated in `server/src/util/validate.js`
before a handler sees it, and every handler is wrapped by `HarborRoom.handle`,
which applies the rate limit and turns a thrown validation error into an
`error_msg` rather than a crash.

**The one deliberate exception is avatar position.** `move` is not
authoritative. Where a player stands buys them nothing — bait, odds, rewards and
progression are decided without ever reading a coordinate — so the room clamps
the position to world bounds, rate-limits the message, and treats the rest as
cosmetic. Validating movement against the collision map would mean shipping the
map to the server and running a physics step per client to defend a value with
no economic weight.

### Odds are published, amounts are not

Chest and catch probabilities ship to the client in `CLIENT_CATALOG` and in the
per-player `me` payload, and the HUD renders them as "1 in N" figures. This is a
deliberate reversal of an earlier rule.

A probability says nothing about the next draw, only about the long run of them,
and the draw still happens server-side from a seed no client ever sees.

Two things stay withheld, and a smoke-test assertion guards both:

- **Amounts.** The range a reward rolls within is the part of a chest worth
  opening it to find out. A preview reading "345–719 Fishing Power" would answer
  the question the reel exists to ask.
- **Raw tables.** Derived probabilities ship; the underlying `catchRate` and
  `weight` fields do not. `catalog carries no probability tables` in
  `client/test/smoke.js` fails the build if either leaks back into the payload.

See `server/src/game/odds.js` for exactly what is disclosed and why.

---

## The harbor room

One Colyseus room class, `server/src/rooms/HarborRoom.js`, registered under the
name `harbor`.

It is a persistent world, not a match: `autoDispose = false`, so it survives
having no players in it. On creation it loads the bait shelf, the lifetime
emission totals, chat history and the leaderboard from MongoDB, then starts four
timers:

| Timer | Interval | Job |
|---|---|---|
| Simulation tick | 250 ms (`AUTO_FISHING.tickMs`) | Advance casts, resolve finished ones, start the next |
| Leaderboard refresh | 10 s (`LEADERBOARD.refreshMs`) | Recompute the top 10 from MongoDB |
| Persist flush | 5 s (`PERSIST_INTERVAL_MS`) | Write dirty player documents and the bait shelf |
| Emission flush | 5 min (`EMISSION_MONITOR.flushIntervalMs`) | Compare minted currency against theory |

Per-connection state that must not be persisted — the in-flight cast plan, rate
limit windows, the last blocked-cast code — lives in an in-memory `runtime` map
keyed by session id, alongside the player record being mutated.

---

## Two channels: shared state and private messages

This split is the reason one player cannot read another's wallet off the wire.

**Shared state** (`HarborState`, synchronised to everyone by Colyseus) carries
only what all players may see:

- the online player list: name, rod level, total catches, dock slot, cast
  progress, stake, avatar position and facing
- the last 50 chat lines
- the top-10 leaderboard
- `baitStock` and `baitStockCapacity` — the shop's shelf belongs to the harbour,
  not to any one player, and everyone buying out of it has to see it move

**Private direct messages** carry everything else. `me` (built by
`server/src/rooms/views.js`) is sent to one client and holds bait, gold, pearls,
XP, inventory, chests, gems, the fish bag, the reward log and that player's
current odds. It is pushed on every change that affects the sender.

Deliberately absent from shared state: every currency, every bag, every
inventory. Adding one there would publish it to the whole harbour.

---

## The cast loop

A cast is server-scheduled work with a fixed end time. The client draws a
progress bar toward that time; it does not decide when the bar completes.

```
 tick (250 ms)
   │
   ├─ cast in flight?  ── yes ─► endsAt reached? ── no ─► update castProgress
   │                                   │
   │                                  yes
   │                                   ▼
   │                            resolveCast()          server/src/game/fishing.js
   │                              ├─ roll catch, species, XP (frozen at catch time)
   │                              ├─ roll chest drop and tier
   │                              ├─ append to bag / chest bag / reward log
   │                              ├─ return unspent bait to the shelf
   │                              └─ send `cast_result`, then `me`
   │
   └─ no cast?  ── auto-fishing on, bait available, bag has room ─► startCast()
                     ├─ freeze rod + stake modifiers into the plan
                     ├─ spend bait from the wallet and the shared shelf
                     └─ send `cast_started` with endsAt
```

Two properties of this design matter operationally:

- **Cast modifiers are frozen at start.** Changing stake mid-cast affects the
  next cast, never the one in the water. Fish XP is likewise frozen at catch
  time, so a stake change after the catch cannot re-price a fish already in the
  bag.
- **A restart loses in-flight casts, not progress.** The bait is spent and the
  cast is gone. That is the correct trade: the alternative — replaying casts
  after a restart — would let a restart duplicate rewards.

A cast can be refused rather than started. `NO_BAIT` and `FISH_BAG_FULL` are
tracked by code rather than a boolean so that switching from one blocker to the
other still sends the player a fresh notice.

---

## Identity: guests and wallets

There is no email, no password and no account recovery. A player is either a
guest (a token in the browser) or a guest bound to a wallet.

On first join the server generates an opaque 64-character `sessionToken`,
returns it once in a `session` message, and the browser keeps it in
`localStorage`. Every later join presents that token and gets the same player
document back.

Consequences that must be stated to players and to whoever operates this:

- **Clearing site data ends the session permanently.** There is nothing to
  recover it with, by design.
- **A blocked `localStorage`** (private-mode Safari, browsers set to block site
  data) means progress cannot persist at all. The client detects this and warns
  rather than silently losing the session.
- **A session is single-seat.** Joining with a token already playing in the room
  evicts the older connection instead of running two idle loops against one
  wallet. The player sees "You opened the harbor in another tab."
- **The token is not a password.** Anyone holding it holds that session. It is
  never logged and never leaves the browser except over WSS.

### Wallet sign-in

A player can sign in with a NEAR wallet (Meteor, HERE, MyNearWallet) or with
MetaMask. Either way the server proves control of a NEAR account and binds the
player to it (`nearAccountId`, one player per account). The wire format is in
[PROTOCOL.md](PROTOCOL.md#http-endpoints).

- **NEAR wallets** sign a one-time challenge (NEP-413). The server checks the
  ed25519 signature, then asks NEAR RPC that the key is a full-access key of
  the account. A function-call key is not enough: any app the user once
  approved can hold one.
- **MetaMask** can't sign NEP-413, so it signs the challenge text with
  `personal_sign`. The server recovers the address, which is itself the NEAR
  account id (an eth-implicit account, NEP-518). Addresses on NEAR's banned
  list are refused.
- **Challenges** are 32 random bytes, used once, valid 5 minutes, capped at
  10,000 outstanding and 20 auth requests per IP per minute. A challenge is
  only spent when a session is issued. The per-IP count only sees real client
  IPs when `TRUST_PROXY` matches the proxies in front of the server.
- **Sign-in still ends in a session token**, so the room join is the same for
  guests and wallets. But each wallet sign-in issues a new token and kills the
  old one, saving and kicking any seat on it first. Wallet tokens also expire
  after 30 days, and `POST /auth/signout` revokes one. A wallet device whose
  token died gets "sign in again" (join code 4401), never a fresh guest.
  Expiry is checked when a player joins, not during play: a session that
  expires mid-play runs until the player leaves and joins again. A reconnect
  inside the grace window skips the check too, since it never runs `onJoin`.
- **First wallet sign-in on a device** binds that device's guest save, unless
  the wallet already owns a player. Then the server refuses with
  `SWITCH_REQUIRED` before changing anything, the player is asked, and only a
  confirmed retry rotates the wallet's token.

Guest tokens never expire and can't be revoked from the server, because a guest
has no way back in.

The only human-supplied field stored is the display name. Wallet players also
carry their public NEAR account id.

## Deposits

USDG is the in-game dollar balance. It is filled by sending USDC on NEAR to the
treasury account (`NEAR_TREASURY_ACCOUNT`), from either kind of wallet.

The client never says how much was paid. It sends a transaction hash; the
server reads the final transaction from RPC and credits the sum of successful
`ft_transfer` receipts on the USDC contract whose predecessor is the player and
whose receiver is the treasury. Checking receipts rather than the outer
transaction is what makes MetaMask work: its transfers are signed by a NEAR
relayer, but `ft_transfer` always spends the predecessor's tokens, so a relayer
can't redirect or fake one. Each hash credits once (`deposits` collection,
unique index).

Without a treasury, the Deposit button is off. `ALLOW_FAKE_DEPOSITS=true`
turns it into a free credit for local development. There are no withdrawals.

---

## Persistence

Writes are batched, not synchronous. A handler mutates the in-memory record and
sets `runtime.dirty`; the 5-second flush writes every dirty document. The room
also flushes on player disconnect and on `onDispose` (process shutdown), and the
process handles `SIGTERM`/`SIGINT` by draining Colyseus before disconnecting
Mongo.

The worst case is therefore **up to five seconds of progress lost on an
unclean kill** — a `kill -9`, an OOM, a platform hard-stop. A normal deploy or
restart drains cleanly and loses nothing.

Without `MONGO_URL` the process falls back to an in-process store so that a
fresh clone runs with no setup. It warns loudly at boot and persists nothing
across restarts. `ALLOW_MEMORY_DB=false` turns that fallback into a refusal to
start, which is what production must set.

See [DATA-MODEL.md](DATA-MODEL.md) for the collections themselves.

---

## The emission monitor

`server/src/game/metrics.js` compares what the harbour actually minted — gold,
pearls, bait — against what `server/src/game/balanceModel.js` says it should have
minted for the play that occurred, and logs when the ratio exceeds
`EMISSION_MONITOR.alertRatio` (currently 2×).

It is a tripwire, not a fraud detector. Two design choices make it usable:

- **A five-minute window, not five seconds.** Appraisal is bursty by design — a
  player can hold gems for an hour and cash the lot in one tick — so a short
  window would read as a permanent spike.
- **Theory is a budget, not a quota.** Unspent theoretical mint carries into the
  next window, up to six windows. Without this, ordinary honest play tripped the
  pearl wire in two runs out of four, because pearls arrive in chunks from
  roughly one epic chest in nine.

`minSample` suppresses reports from a quiet harbour, where the ratio is noise
whatever it says.

What to do when it fires is in [OPERATIONS.md](OPERATIONS.md).

---

## Scaling limits

**These are the real ceilings of the current build. Read them before promising
concurrency to anyone.**

### One room instance holds 8 players

`MAX_CLIENTS_PER_ROOM` is 8, and the client joins with `joinOrCreate`. The ninth
concurrent player therefore does not join a full harbour — Colyseus creates a
**second** `harbor` room in the same process, and that room is a separate world:

- separate live chat (persisted history is shared, live broadcast is not)
- separate `onlineCount` and player list
- **separate in-memory bait shelf**, and this one is not merely cosmetic

The bait shelf is loaded once per room from the single `worlds` document and
written back on a timer. Two rooms each hold their own copy and overwrite each
other's, so the shared shelf stops being shared and stock figures drift.

The build is correct for a single 8-seat harbour and is what the current scope
describes. Anything beyond that needs a decision first — see
[OPERATIONS.md](OPERATIONS.md#if-you-need-more-than-eight-concurrent-players).

### One replica

`server/railway.json` pins `numReplicas: 1`, and it must stay there. A second
replica is a second process with its own rooms, its own bait shelf and its own
emission counters, writing over the first. Colyseus supports multi-process
deployments through a presence and matchmaking driver; this build configures
neither.

### Room state size

Chat history in shared state is capped at 50 lines and the leaderboard at 10
rows, so state size is bounded regardless of session length.

---

## Security posture

What is defended, and what is explicitly not.

**Defended**

- All game outcomes are server-side, from a seed no client sees.
- Every inbound payload is type- and range-validated before use
  (`server/src/util/validate.js`).
- Per-client rate limit of 20 messages/second across all types, plus a separate
  15/second budget for `move` (dropped silently — an error toast per frame would
  be worse than a stale avatar).
- Chat has its own 1.2 s cooldown and a 200-character cap.
- `CORS_ORIGIN` restricts which browser origins may reach the backend.
- Express runs with `x-powered-by` disabled, a 16 KB JSON body limit, and an
  error handler that never returns a stack trace.
- Firebase Hosting sets `X-Content-Type-Options`, `Referrer-Policy` and
  `X-Frame-Options` on every response.
- Logs never contain connection strings or player data.
- Wallet sign-in is signature-checked with one-use challenges, rate-limited,
  and rotates the session token. See [Wallet sign-in](#wallet-sign-in).
- Deposits are credited from the chain, never from a client figure, and each
  transaction credits once. See [Deposits](#deposits).

**Not defended, by design**

- **Avatar position.** Cosmetic; see above.
- **Session token theft.** Anyone with the token has the session until it is
  replaced. For wallet players that is the next sign-in, a sign-out, or 30
  days. For guests it is never.
- **Multi-accounting.** Nothing stops one person creating many guest sessions
  or using many wallets. There is no cross-player trade and no withdrawal, so
  today there is nothing to farm out. That changes the moment value can leave
  the game; see the rebalance plan's identity section before adding any.
- **Display-name uniqueness.** Names are validated for shape, not reserved. Two
  players may share one.
