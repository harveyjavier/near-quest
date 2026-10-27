# Operations runbook

For whoever is on the hook once this is live. Day-one setup is in
[DEPLOYMENT.md](../DEPLOYMENT.md).

- [What to watch](#what-to-watch)
- [Daily and weekly](#daily-and-weekly)
- [Incident playbooks](#incident-playbooks)
- [The emission monitor fired](#the-emission-monitor-fired)
- [Rolling back](#rolling-back)
- [Restoring from backup](#restoring-from-backup)
- [Handling a player request](#handling-a-player-request)
- [If you need more than eight concurrent players](#if-you-need-more-than-eight-concurrent-players)
- [Known limitations](#known-limitations)

---

## What to watch

Four signals. Everything else is noise until one of these moves.

| Signal | Where | Healthy | Act when |
|---|---|---|---|
| Process liveness | `GET /health` → `status` | `"ok"` | Anything else, or no response. Railway restarts on failure; repeated restarts mean a crash loop. |
| Database backend | `GET /health` → `database` | `"mongodb"` | It reads `"memory"`. **Urgent** — every session is being discarded. |
| Emission ratio | Server log, every 5 min | No warning | A warning appears. See below. |
| Restart frequency | Railway deployments/log | Rare | Unexplained restarts, especially near a memory ceiling. |

Set an uptime check against `/health` from outside the platform. Railway's own
health check restarts the process but does not tell you it happened.

### Reading the logs

Prefixed and levelled: `[timestamp] [LEVEL] message`. `LOG_LEVEL=info` is the
production setting; `debug` adds per-room detail and is for diagnosing, not for
leaving on.

Lines that mean something:

| Log line | Meaning |
|---|---|
| `MONGO_URL not set -- using the IN-MEMORY store.` | **Data is not being saved.** Must never appear in production. |
| `Harbor room <id> created.` | A room started. A **second** one on the same process means you passed 8 concurrent players. |
| `New guest session for "<name>".` | A first-time player. |
| `Persist failed:` | A write to MongoDB failed. Isolated lines are transient; repeats mean the database is unreachable. |
| `Final flush failed:` | A shutdown could not save. Up to 5 seconds of progress was lost for whoever was online. |
| `Emission ratio …` warning | See below. |

Logs never contain connection strings or player data.

---

## Daily and weekly

**Daily** — glance at `/health`: `status` ok, `database` mongodb. Ten seconds.

**Weekly**

- Scan the log for emission warnings and `Persist failed:` repeats.
- Check the Atlas storage graph. `chatmessages` grows unbounded (see below).
- Confirm the backup schedule ran and a snapshot exists. A backup nobody has
  ever restored is a hypothesis, not a backup.

**Monthly**

- Restore the newest snapshot into a scratch database and point a staging
  backend at it. This is the only way to know the restore path works.
- `npm audit` in both workspaces; take security patches.

---

## Incident playbooks

### Nobody can connect

1. `curl https://YOUR-APP/health`. No answer → the process is down; check the
   platform deploy log for a crash loop.
2. It answers, but the browser sits on "Connecting…" → almost always CORS or a
   stale bundle. Open the browser console. A CORS error means `CORS_ORIGIN` does
   not list the exact origin, scheme included. A websocket failure to the wrong
   host means the bundle was built with the wrong `VITE_SERVER_URL` — rebuild,
   don't just redeploy.
3. Health is ok and CORS is right → check whether Atlas is reachable. A database
   that hangs on connect can leave the process alive but unable to admit anyone.

### `/health` says `"database": "memory"`

Every session created since the process started is in RAM and will be lost.

1. Fix `MONGO_URL` in the platform variables.
2. Set `ALLOW_MEMORY_DB=false` so this can never happen silently again.
3. Restart. Whoever was playing loses that session; there is no way to migrate
   in-memory records to the database.

### Progress is not saving

Look for `Persist failed:` in the log.

- **Repeats** → MongoDB is unreachable or rejecting writes. Check Atlas status,
  the IP allowlist, and whether the database user's password rotated.
- **None, and `/health` says mongodb** → the player is probably hitting blocked
  `localStorage`, not a server problem. Ask whether they are in private
  browsing or blocking site data. There is no server-side fallback, by design.

### The process is restarting repeatedly

1. Read the deploy log for the actual error. A boot failure with `Refusing to
   start without a database` is `ALLOW_MEMORY_DB=false` doing its job.
2. Check whether `PORT` was set manually — that breaks the health check, and the
   platform kills a failing health check on a loop.
3. Check the memory graph. Room state is bounded (50 chat lines, 10 leaderboard
   rows, 8 players) so a climbing baseline points at a leak worth a bug report,
   not at load.

### Chat is full of abuse

There is no moderation tooling in this build. The immediate levers:

- Delete offending documents from `chatmessages` directly, and restart the
  backend so the room reloads its history.
- Lengthen `CHAT.cooldownMs` in `server/src/config/game.config.js` to slow it
  down, then redeploy.

If the game is going to be public, moderation is a feature that needs building.
It is on the open-items list in [HANDOFF.md](HANDOFF.md).

### `chatmessages` is growing without limit

Nothing prunes it. The room only ever reads the most recent 200, so old rows are
dead weight.

```js
// Delete chat older than 30 days
db.chatmessages.deleteMany({ at: { $lt: Date.now() - 30*24*60*60*1000 } })
```

An Atlas scheduled trigger or a cron job running that is the fix. Do it before
storage becomes the reason for an outage.

---

## The emission monitor fired

Every five minutes the room compares what it actually minted — gold, pearls,
bait — against what `server/src/game/balanceModel.js` says the play that occurred
should have produced. A ratio above 2× logs a warning.

**It is a tripwire, not a fraud detector.** Treat one warning as a question, not
an answer.

1. **Is it above the sample floor?** Below 500 gold, 200 pearls or 500 bait in a
   window the ratio is noise and the monitor suppresses it. If you are reading a
   warning, it cleared the floor.
2. **Did it repeat?** Theory carries across six windows precisely so that bursty
   honest play — a player hoarding gems for an hour and appraising the lot at
   once — does not trip it. A single warning after a quiet period is usually
   exactly that. **Three or more consecutive windows is the real signal.**
3. **Did balance change recently?** A config edit that raised a payout without a
   re-run of `npm run balance` will trip this legitimately. The model and the
   config have to move together — check `git log server/src/config/`.
4. **Did the code change?** A new reward path that mints currency without being
   represented in `balanceModel.js` shows up here as an over-mint. That is the
   monitor working: the model is the spec, and the fix is to update it in the
   same commit.
5. **Only after all four** consider an exploit. Compare the lifetime totals on
   the `worlds` document against the player population. A single account far
   ahead of the rest is visible in the leaderboard and in `totalXp`.

**Never "fix" this by resetting `emission` on the world document.** Those totals
are cumulative on purpose; resetting them destroys the comparison that makes
them worth having. If you must, record the pre-reset values first.

---

## Rolling back

**Frontend** — Firebase keeps previous releases:

```bash
npx firebase hosting:releases:list
npx firebase hosting:rollback
```

Instant, and safe on its own: an older bundle talks to the same backend.

**Backend** — Railway: *Deployments* → an earlier successful deployment →
**Redeploy**. Heroku: `heroku releases:rollback -a YOUR-APP`.

**The one thing to check before rolling the backend back:** whether the newer
version wrote a field the older one does not understand. Additive schema changes
are safe to roll back through. A rename or a removal is not — see
[DATA-MODEL.md](DATA-MODEL.md#changing-the-schema). If in doubt, take a backup
first.

Rolling the backend back also rolls back game balance. Players who levelled
under the newer numbers keep their progress; the pacing changes under them.

---

## Restoring from backup

1. **Do not restore over the live database.** Restore into a new one.
2. `mongorestore` the snapshot (commands in
   [DATA-MODEL.md](DATA-MODEL.md#backup-and-restore)).
3. Point a staging backend at it and confirm `/health` reports the expected
   player count and that a session loads.
4. Only then repoint production's `MONGO_URL` and restart.

Everything between the snapshot and now is gone. With no accounts there is no
partial-recovery path, so the snapshot's age is exactly the data loss.

---

## Handling a player request

**"I lost my progress."** Their browser lost the session token — cleared site
data, a different browser or device, or private browsing. There is nothing to
look them up by: no email, no password, no device id. The only field that could
identify them is their display name, which is not unique and not proof of
anything. Be straight with them: the design trades recovery for requiring no
sign-up. If manual restoration is something the operator wants to offer, it
needs accounts, and that is a feature, not a support process.

**"Delete my data."** One document:

```js
db.players.deleteOne({ sessionToken: "<their token>" })
```

They can read the token from `localStorage` under `fishing-idle.sessionToken`.
Their chat lines carry a display name and stay unless you remove them by name.
No other collection holds anything about them.

**"Someone is cheating."** Check the leaderboard and `totalXp` against the
emission log for the same period. Every outcome is server-side, so the plausible
routes are a bug rather than a client hack. Reproduce it before acting.

---

## If you need more than eight concurrent players

`MAX_CLIENTS_PER_ROOM` is 8, and the ninth concurrent player gets a **second**
harbour: separate live chat, separate player list, and — the part that matters —
a separate in-memory copy of the shared bait shelf, which the two rooms then
overwrite for each other.

**Raising the constant is not the fix.** It changes where the seam falls without
removing it, and it puts more players into a room whose state was sized for
eight.

Doing this properly is a piece of work, roughly:

1. Decide whether the harbour is *one* world or *many*. That is a design
   question, not a technical one, and everything else follows from it.
2. If one world: move the bait shelf out of room memory and behind an atomic
   MongoDB operation (`findOneAndUpdate` with `$inc`), so concurrent rooms
   contend correctly instead of last-write-wins. The same applies to the
   emission counters.
3. Broadcast chat across rooms — via a Colyseus presence driver, or by having
   rooms poll the collection.
4. Only then raise the seat count and load-test it. Room state is broadcast to
   every client on change; 8 → 50 players is not a linear cost.
5. For more than one process, configure Colyseus's presence and matchmaking
   drivers (Redis) and lift `numReplicas`. This build configures neither.

Until that work is done, treat 8 concurrent players as the supported ceiling and
`numReplicas: 1` as non-negotiable.

---

## Known limitations

Stated plainly, because each one is a design decision rather than a defect, and
each one will eventually generate a question:

- **8 concurrent players per harbour.** Above that the world silently splits.
- **Single replica.** No horizontal scaling without presence and matchmaking
  drivers.
- **Up to 5 seconds of progress lost on an unclean kill** (`kill -9`, OOM,
  platform hard-stop). Normal restarts drain and lose nothing.
- **In-flight casts are lost on restart.** Bait spent, cast gone — deliberately,
  so a restart cannot duplicate rewards.
- **No account recovery.** Clearing site data ends a session permanently.
- **No moderation tooling.** Chat is rate-limited and length-capped, not
  filtered.
- **`chatmessages` is never pruned.** Needs an external job.
- **Avatar position is not authoritative.** Cosmetic by design.
- **No automated backups from the application.** Configure them at the database.
