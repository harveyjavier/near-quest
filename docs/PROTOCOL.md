# Network protocol

Everything that crosses the socket, and the two HTTP endpoints beside it.

Transport is Colyseus 0.16 over WebSocket (`wss://` in production). The room
name is `harbor`. The client joins with `joinOrCreate`.

- [HTTP endpoints](#http-endpoints)
- [Join handshake](#join-handshake)
- [Client to server](#client-to-server)
- [Server to client](#server-to-client)
- [Synchronised room state](#synchronised-room-state)
- [Error codes](#error-codes)
- [Rate limits](#rate-limits)
- [Liveness](#liveness)

---

## HTTP endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{ status, uptimeSeconds, database, players, room, time }` |
| `GET` | `/catalog` | The full `CLIENT_CATALOG` payload (same object sent on join) |
| `GET` | `/` | `{ name, endpoints }` |
| `GET` | `/auth/near/challenge` | `{ nonce, message, recipient, network }`. The nonce works once and expires after 5 minutes. |
| `POST` | `/auth/near` | `{ accountId, publicKey, signature, nonce, callbackUrl?, sessionToken?, displayName? }` → `{ sessionToken, displayName, accountId, source }`, or `{ code, error }` with 401 / 429 / 503 |

`database` is `"mongodb"` or `"memory"`. In production it must read
`"mongodb"` — see [OPERATIONS.md](OPERATIONS.md).

`/health` deliberately does not depend on a room existing, so it answers during
startup and while the harbour is empty. The platform health check points at it.

`/auth/near` checks the NEP-413 signature, then asks NEAR RPC whether
`publicKey` is a full-access key of `accountId`. The client joins the room with
the `sessionToken` it gets back.

Which player you get:

1. The player already bound to the wallet (`source: "existing"`).
2. Otherwise the guest `sessionToken` sent with the request, if it is not bound
   yet (`source: "guest"`).
3. Otherwise a new player (`source: "new"`).

One wallet has at most one player.

Each sign-in gives the player a new `sessionToken`. The old one stops working,
and anyone seated on it is saved and kicked with code 4001. A wallet device
joins with `walletSession: true`. If its token has been replaced, the join fails
with code 4401 and the client asks the player to sign in again, instead of
creating a new guest.

Both endpoints allow 20 requests per IP per minute and return 429 after that.

`/catalog` exists so the client can render the shop and fish list before opening
a socket, and so you can confirm from a terminal that a config change actually
shipped.

---

## Join handshake

Join options are sent by the client with `joinOrCreate`:

```js
{
  sessionToken: "<64 hex chars>",   // optional; omitted on a first visit
  displayName: "Angler"             // used only when no valid token is presented
  walletSession: true               // optional; set by wallet devices, see /auth/near
}
```

The server then sends, in order:

1. `catalog` — the static content catalog
2. `session` — **only on a new session**, carrying the token to store
3. `me` — the full private snapshot

A returning player is looked up by token; the stored display name wins, and the
`displayName` option is ignored. A token already playing in the room causes the
older connection to be evicted (see `error_msg` code `SESSION_TAKEN_OVER`).

---

## Client to server

All handlers except `ping` and `move` run through `HarborRoom.handle`, which
enforces the rate limit, resolves the player record, and converts a validation
failure into an `error_msg`.

| Message | Payload | Effect |
|---|---|---|
| `ping` | — | Liveness only. Answered with `pong` even while rate-limited. |
| `cast` | — | Start one cast. Ignored if a cast is already in flight. |
| `set_auto` | `{ enabled: boolean }` | Toggle the idle loop. Turning it **off aborts the cast already in the water**. |
| `set_stake` | `{ stake: number }` | Set the stake rung. Applies to the next cast, not the current one. |
| `open_chest` | `{ chestId: string }` | Open one chest; pays exactly one reward. |
| `appraise_gem` | `{ gemId: string }` | Grade one uncut gem and pay gold. |
| `upgrade_rod` | — | Spend the upgrade cost to gain a rod level. |
| `use_consumable` | `{ itemId: string }` | Consume one inventory item. |
| `cash_out_species` | `{ speciesId: string }` | Cash in every fish of one species for XP. |
| `cash_out_all_fish` | — | Cash in the whole bag for XP. |
| `buy` | `{ itemId: string, quantity: number }` | Purchase from the shop. |
| `chat` | `{ text: string }` | Post a chat line (≤200 chars, 1.2 s cooldown). |
| `request_me` | — | Ask for a fresh `me` snapshot. |
| `request_catch_log` | — | Ask for the species catch log. |
| `move` | `{ x, y, facing, moving }` | Cosmetic avatar position. Not authoritative. |

Anything not in this table is not a message the room accepts. There is no
message that grants a currency, sets a balance, or reports an outcome — by
design. A client that wants gold has to buy, catch or appraise for it.

---

## Server to client

### Addressed to one client

| Message | Payload | When |
|---|---|---|
| `catalog` | `CLIENT_CATALOG` | On join |
| `session` | `{ sessionToken }` | On join, new sessions only |
| `me` | Full private snapshot (below) | On join and after every change affecting this player |
| `pong` | `{ at }` | In answer to `ping` |
| `cast_started` | `{ endsAt, ... }` | A cast entered the water |
| `cast_result` | Catch, chest drop, XP, log entry | A cast resolved |
| `cast_cancelled` | `{ reason, ... }` | Auto-fishing turned off mid-cast |
| `chest_opened` | The single reward drawn | After `open_chest` |
| `gem_appraised` | Grades, traits, gold paid | After `appraise_gem` |
| `rod_upgraded` | New level and rod | After `upgrade_rod` |
| `consumable_used` | Effect applied | After `use_consumable` |
| `fish_cashed` | XP gained, species | After `cash_out_species` |
| `fish_cashed_all` | XP gained, totals | After `cash_out_all_fish` |
| `purchased` | Item, quantity, cost | After `buy` |
| `catch_log` | `{ entries: [...] }` | After `request_catch_log` |
| `error_msg` | `{ code, message }` | Any rejected action |

### The `me` payload

Built by `meView` in `server/src/rooms/views.js`. This is the private half of
the protocol and holds everything the shared state deliberately omits.

| Group | Fields |
|---|---|
| Identity | `displayName` |
| Progression | `rodLevel`, `rodName`, `maxRodLevel`, `xp`, `xpToNext`, `totalXp`, `upgrade` |
| Wallet | `bait`, `gold`, `pearls` |
| Cast setup | `stake`, `autoFishing`, `baitPerCast`, `castMs` |
| Live cast | `casting`, `castEndsAt`, `serverTime` |
| Counters | `totalCasts`, `totalCatches` |
| Odds | `odds` (this rod and stake), `oddsUnlock` (what a locked chest tier would read) |
| Species gate | `unlockedSpecies` |
| Bags | `fish`, `maxFish`, `fishStackSize`, `fishSlots`, `fishSlotsUsed`, `fishBagFull`, `chests`, `uncutGems` |
| Misc | `inventory`, `buffs`, `catchCounts`, `rewardLog` (last 30) |

`serverTime` travels with every payload so the client can draw a cast bar
against the server clock rather than its own.

`odds` is recomputed per rod-and-stake and memoised, so pushing it on every
state change costs a map lookup.

---

## Synchronised room state

`HarborState`, in `server/src/rooms/schema/HarborState.js`. Broadcast to every
client by Colyseus. **Nothing private may be added here.**

```
HarborState
  players            map<sessionId, PlayerState>
  messages           ChatEntry[]      last 50
  leaderboard        LeaderEntry[]    top 10
  onlineCount        uint16
  serverTime         number
  baitStock          uint32           shared shop shelf
  baitStockCapacity  uint32

PlayerState
  name, rodLevel, totalCatches, dockSlot,
  casting, castProgress, stake, online,
  x, y, facing, moving

ChatEntry     name, text, at          server clock, never client-supplied
LeaderEntry   rank, name, rodLevel, totalCatches
```

`baitStock` is public on purpose: the shelf belongs to the harbour, and everyone
buying out of it has to see it move.

---

## Error codes

Delivered as `error_msg` with a human-readable `message` beside the code.

| Code | Meaning |
|---|---|
| `RATE_LIMITED` | Over 20 messages in one second. |
| `CHAT_COOLDOWN` | Chat sent within 1.2 s of the last one. |
| `NO_BAIT` | Not enough bait to start a cast at the current stake. |
| `FISH_BAG_FULL` | Every fish slot is occupied; casting is blocked until you cash in. |
| `SESSION_TAKEN_OVER` | The same session token joined elsewhere; this seat was evicted. |
| `SERVER_ERROR` | Unexpected failure. Details are logged server-side only. |

Plus per-action failures returned by the game modules — an unavailable chest or
gem id, insufficient gold for an upgrade or purchase, no fish of the requested
species, an empty inventory slot. These carry the module's own code and a
message safe to show a player.

Errors never carry a stack trace or any internal detail.

---

## Rate limits

| Budget | Limit | On breach |
|---|---|---|
| All messages | 20 per second per client | `error_msg` with `RATE_LIMITED` |
| `move` | 15 per second per client | Silently dropped |
| `chat` | 1 per 1.2 s per client | `error_msg` with `CHAT_COOLDOWN` |
| `buy` quantity | 1000 per message | Validation error |

`ping` is registered outside the wrapper and keeps answering while a client is
rate-limited — a player hammering the buttons has not lost their connection and
must not be told they have.

---

## Liveness

A socket can die quietly: a machine sleeps, a proxy drops an idle connection,
the process goes away. The browser still believes it is connected, because
nothing closed the socket from its end, and it cannot tell that from a harbour
where nothing is happening.

So the client asks.

| Setting | Value | Where |
|---|---|---|
| Client heartbeat | `ping` every 10 s | `client/src/net/NetClient.js` |
| Client gives up after | 32 s of unanswered pings | same |
| Wake probe timeout | 8 s | same |
| Transport ping | 15 s × 4 retries ≈ 60 s | `CONNECTION` in `game.config.js` |
| Reconnection grace | 180 s | `CONNECTION.reconnectGraceSeconds` |

The transport defaults (3 s × 2 ≈ 6 s) are far too strict for a game players
leave running — a backgrounded tab, a closing lid or a phone changing networks
blows past six seconds — which is why they are raised here.

Within the 180-second grace the room holds the dock slot and the idle loop. A
player returning on the same token evicts their own stale seat on the way in, so
a generous grace only ever holds a seat against other people, and only for as
long as it takes to notice.
