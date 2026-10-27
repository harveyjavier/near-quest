# Deployment

Backend on **Railway** (or Heroku), frontend on **Firebase Hosting**, database on
**MongoDB Atlas**. HTTPS and WSS on both ends.

> **The backend must run as a persistent process.** Colyseus holds the
> authoritative cast timers and room state in memory. Serverless functions, edge
> runtimes and anything that cold-starts per request will not work.

> **One replica, one room.** `numReplicas` must stay at 1, and the build is
> scoped to a single 8-seat harbour. Read
> [Scaling limits](docs/ARCHITECTURE.md#scaling-limits) before you promise
> anyone more concurrency than that — it is a design ceiling, not a config knob.

Day-two operations — monitoring, incidents, restores, rollback — are in
[docs/OPERATIONS.md](docs/OPERATIONS.md). The pre-flight list is
[docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md).

- [1. MongoDB](#1-mongodb)
- [2. Backend on Railway](#2-backend-on-railway)
- [3. Frontend on Firebase Hosting](#3-frontend-on-firebase-hosting)
- [4. Wire the two together](#4-wire-the-two-together)
- [5. Verify the deployment](#5-verify-the-deployment)
- [Redeploying](#redeploying)
- [Restarting the Colyseus process](#restarting-the-colyseus-process)
- [Health and monitoring](#health-and-monitoring)
- [Troubleshooting](#troubleshooting)
- [Alternative hosts](#alternative-hosts)

---

## 1. MongoDB

Any MongoDB 6+ instance works. The [Atlas](https://cloud.mongodb.com) free tier
is enough to start.

1. Create a cluster and a database user.
2. **Network access.** Railway and Heroku do not publish stable egress IPs on
   their standard plans, so `0.0.0.0/0` plus a strong password is the usual
   setup. Restrict it if your plan gives you static IPs.
3. Copy the connection string and **append the database name**:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/fishing-idle?retryWrites=true&w=majority
   ```

   Without `/fishing-idle` the driver connects to `test` and everything works
   until someone goes looking for the data.

4. Turn on backups for the cluster. Nothing in the application backs itself up,
   and there is no account recovery — see
   [docs/DATA-MODEL.md](docs/DATA-MODEL.md#backup-and-restore).

Seed it once, to create indexes and the welcome chat messages:

```bash
cd server
MONGO_URL="mongodb+srv://..." npm run seed
```

`npm run seed -- --reset` drops all players and chat first. **That deletes every
player's progress**, and there is no recovery, because there are no accounts.

---

## 2. Backend on Railway

1. **New Project → Deploy from GitHub repo**, and set the **root directory** to
   `server`. `railway.json` and `nixpacks.toml` in that folder pin Node 22, the
   start command and the `/health` check.
2. Set the variables below under **Variables**.
3. **Settings → Networking → Generate Domain.** Railway serves it over HTTPS,
   which is what gives you `wss://` for free.

### Environment variables

| Variable | Value | Notes |
|---|---|---|
| `MONGO_URL` | your Atlas connection string | **Never commit this.** |
| `ALLOW_MEMORY_DB` | `false` | Makes the process refuse to boot without a database instead of silently losing every player. |
| `CORS_ORIGIN` | `https://YOUR-PROJECT.web.app,https://YOUR-PROJECT.firebaseapp.com` | Comma-separated, scheme included. Leave unset only in development. |
| `LOG_LEVEL` | `info` | `debug` while diagnosing. |
| `PORT` | *(leave unset)* | Railway and Heroku inject it. Setting it yourself will break the health check. |

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Heroku instead

```bash
cd server
heroku create YOUR-APP
heroku config:set MONGO_URL="mongodb+srv://..." ALLOW_MEMORY_DB=false \
  CORS_ORIGIN="https://YOUR-PROJECT.web.app"
git subtree push --prefix server heroku main
```

The `Procfile` (`web: node src/index.js`) is already there. Use a dyno type that
stays awake — a sleeping dyno drops every websocket and stops the idle loop.

---

## 3. Frontend on Firebase Hosting

```bash
cd client
echo "VITE_SERVER_URL=https://YOUR-APP.up.railway.app" > .env.production
npm run build

npx firebase login
npx firebase use --add          # pick your Firebase project, alias it "default"
npx firebase deploy --only hosting
```

`VITE_SERVER_URL` accepts `https://`, `wss://` or a bare hostname — the client
upgrades it to `wss://` itself. It is baked into the bundle at build time, so
**changing it means rebuilding**, not just redeploying.

`client/firebase.json` is already configured: `dist` as the public directory,
SPA rewrites, a year of immutable caching on hashed assets, an hour with
revalidation on the stable-named sprite sheets, `no-cache` on `index.html` so a
redeploy is picked up immediately, and `X-Content-Type-Options`,
`Referrer-Policy` and `X-Frame-Options` on everything.

### Source maps

`npm run build` emits **no** source maps. That is deliberate: the Phaser map
alone is ~9.4 MB — five times the size of everything else in `dist` put together
— and it publishes readable source for the whole game.

For a build you intend to debug:

```bash
SOURCEMAP=true npm run build
```

Do not deploy that build to production.

---

## 4. Wire the two together

The backend's `CORS_ORIGIN` must list the exact Firebase origins, scheme
included:

```
https://YOUR-PROJECT.web.app,https://YOUR-PROJECT.firebaseapp.com
```

Add any custom domain to the same list. A mismatch shows up as the game sitting
on "Connecting…" with a CORS or websocket error in the browser console.

---

## 5. Verify the deployment

Four checks, in order. Do all of them — the first three can pass while the game
is unplayable.

**1. The backend is alive and has a real database.**

```bash
curl https://YOUR-APP.up.railway.app/health
```

```json
{ "status": "ok", "database": "mongodb", "players": 0, "room": "harbor" }
```

If `"database"` says `"memory"`, `MONGO_URL` did not reach the process. Fix that
before letting anyone play, or every session vanishes on the next deploy.

**2. The shipped config is the config you meant to ship.**

```bash
curl -s https://YOUR-APP.up.railway.app/catalog | head -c 400
```

**3. The whole loop works.** Run the end-to-end smoke test against the deployed
backend — from a staging deployment, not production, since it creates guest
sessions and posts chat:

```bash
npm --prefix client run smoke -- wss://YOUR-STAGING-APP.up.railway.app
```

It exits non-zero on the first failed assertion, so it can gate a release.

**4. Play it.** Open the Firebase URL, enter a name, confirm a cast resolves,
reload the page and confirm your progress is still there. That last step is what
proves the session token round-trip and the database write actually work.

---

## Redeploying

**Backend** — push to the tracked branch; Railway rebuilds and restarts
automatically. In-flight players are disconnected and reconnect on reload.
Progress is safe: the room flushes dirty player documents every 5 seconds, and
again on disconnect and on shutdown.

**Frontend**

```bash
cd client && npm run build && npx firebase deploy --only hosting
```

**After changing anything in `server/src/config/`** — that is where the game
balance lives. Restart the backend for it to take effect, and re-run
`npm run balance` first to see what the change did to pacing. The client needs
no rebuild for a balance change.

---

## Restarting the Colyseus process

**Railway** — *Deployments* → the active deployment → **Restart**, or
`railway redeploy` with the CLI.

**Heroku** — `heroku ps:restart -a YOUR-APP`.

A restart drops every connected player. They reconnect on reload with their
progress intact — it lives in MongoDB, keyed by the guest token in their
browser's `localStorage`. Chat history survives too.

What does not survive is anything mid-cast: that bait is spent and the cast is
lost. That is the correct trade for not letting a restart duplicate rewards.

---

## Health and monitoring

`GET /health` returns process uptime, which database backend is live, and the
player count. Railway is configured to poll it and restart on failure.

`GET /catalog` returns the content catalog the client renders from — useful for
confirming a config change actually shipped.

Set `LOG_LEVEL=debug` for verbose room logging. Logs never contain connection
strings or player data.

The emission monitor writes a warning to the log when minted currency outruns
what the balance model says it should be. What to do about it is in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Stuck on "Connecting…" | `VITE_SERVER_URL` wrong or not rebuilt, or `CORS_ORIGIN` does not list the Firebase origin. |
| `/health` says `"database": "memory"` | `MONGO_URL` is not reaching the process. Set `ALLOW_MEMORY_DB=false` so this fails loudly at boot instead. |
| Boot fails with "Refusing to start without a database" | Working as intended: `ALLOW_MEMORY_DB=false` and no `MONGO_URL`. Fix the variable. |
| Progress lost on reload | The browser is blocking `localStorage` (private mode, blocked site data). The game detects this and warns; there is no server-side fallback, because there is no account. |
| "You opened the harbor in another tab" | Working as intended. A guest session is single-seat, so the newer tab wins and the older is evicted. |
| Health check fails on deploy | `PORT` was set manually. Unset it. |
| Harbor background missing | `client/public/assets/harbor-environment.png` did not ship. Restore the committed image and rebuild the client. |
| Ninth player sees an empty harbour | A second room was created. Expected at the current 8-seat ceiling — see [Scaling limits](docs/ARCHITECTURE.md#scaling-limits). |
| Bait shelf figures jump around | Two rooms are writing the same world document. Same cause as above. |
| Data written but not in `fishing-idle` | The connection string has no database name; the driver used `test`. |

---

## Alternative hosts

The requirements are narrow, so substitutions are easy to judge:

**Backend** needs a persistent process, WebSocket support, and outbound access
to MongoDB. Fly.io, Render (non-sleeping instance types), a plain VPS behind a
reverse proxy, or Colyseus Cloud all qualify. **Vercel, Netlify Functions,
Cloudflare Workers and AWS Lambda do not** — the room's in-memory timers cannot
survive their execution model.

**Frontend** is static files. Any host works: Netlify, Cloudflare Pages, S3 plus
CloudFront, nginx. If you leave Firebase, port the cache headers and the three
security headers out of `client/firebase.json`, and keep the SPA rewrite.

**Database** is any MongoDB 6+ deployment. Nothing Atlas-specific is used.
