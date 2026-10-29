# Release checklist

Run through this before every deploy that reaches players. It takes about twenty
minutes, most of which is the smoke test running unattended.

Mechanics for each step are in [DEPLOYMENT.md](../DEPLOYMENT.md); this is the
order and the gates.

---

## Before you build

- [ ] `git status` is clean and you are on the branch you mean to ship.
- [ ] `npm run verify` passes — tests then production build.
- [ ] `npm run balance` output has been **read**, not just run. If any config
      changed, the hourly gold and XP pacing moved; know by how much.
- [ ] If config changed: `node server/tools/gdd-balance.js --write` was run and
      `design/balance-tables.md` is committed alongside the config change.
- [ ] Dependency changes reviewed. `npm audit` in both workspaces; take security
      patches, don't take major bumps on a release day.
- [ ] `CHANGELOG` or release notes say what a player will notice.

## Backend

- [ ] Variables set in the platform, all five:
      `MONGO_URL`, `ALLOW_MEMORY_DB=false`, `CORS_ORIGIN`, `LOG_LEVEL=info`,
      and `PORT` **unset**.
- [ ] `CORS_ORIGIN` lists every origin players actually use — `web.app`,
      `firebaseapp.com`, and any custom domain, scheme included.
- [ ] `NODE_ENV=production` and `TRUST_PROXY=1` (Railway/Heroku have one
      proxy in front). Without `TRUST_PROXY` every player shares the proxy's
      IP for the sign-in rate limit; with it set off-platform, clients can
      spoof their IP.
- [ ] `numReplicas` is still `1` in `server/railway.json`.
- [ ] A verified database backup exists, dated today. Verified means restored
      into a scratch database, not merely listed in a console.
- [ ] Deploy.
- [ ] `curl https://YOUR-APP/health` → `"status": "ok"` **and**
      `"database": "mongodb"`. Not "memory". This is the single most important
      line in this checklist.
- [ ] `curl https://YOUR-APP/catalog` shows the config you meant to ship.

## Frontend

- [ ] `client/.env.production` points at the **production** backend, not
      staging or localhost.
- [ ] `npm run build` — and confirm no `.map` files landed in `client/dist`.
      Source maps are off by default; a build with `SOURCEMAP=true` set in the
      shell must never be deployed.
- [ ] Deploy to Firebase Hosting.
- [ ] Hard-reload the live URL. `index.html` is served `no-cache`, so a stale
      page means something is wrong with the deploy, not with the browser.

## End to end

- [ ] Smoke test against **staging**, never production — it creates guest
      sessions and posts chat:
      `npm --prefix client run smoke -- wss://YOUR-STAGING-APP.up.railway.app`

      > **This currently fails.** See
      > [HANDOFF.md](HANDOFF.md#1-the-end-to-end-smoke-test-fails) — the chest
      > assertion is unreliable after the chest rarity rebalance. Until it is
      > fixed, run it and confirm the failures are *only* the chest, gem and
      > appraisal phases, and that everything before them passes.

- [ ] Play it yourself on the live URL: enter a name, watch a cast resolve,
      **reload the page and confirm progress survived**. That last step is the
      only thing that proves the session-token round-trip and the database write
      both work.
- [ ] Open it on a phone. The HUD is responsive and the layout is worth eyeing
      on a small screen after any UI change.
- [ ] Two browsers at once: confirm both appear in the player list, chat
      crosses between them, and the leaderboard populates within ~10 seconds.

## After deploy

- [ ] Watch the log for five minutes. No `Persist failed:`, no unexpected
      `Harbor room … created.` (a second one means you have more than eight
      concurrent players — see
      [Scaling limits](ARCHITECTURE.md#scaling-limits)).
- [ ] Check the log again after the first emission window (5 minutes). A
      warning right after a balance change is expected if the model was not
      updated with it — see
      [OPERATIONS.md](OPERATIONS.md#the-emission-monitor-fired).
- [ ] Note the rollback path: which Firebase release and which platform
      deployment you would return to. Knowing it now is cheaper than finding it
      during an incident.

---

## Do not ship if

- `/health` reports `"database": "memory"`.
- `ALLOW_MEMORY_DB` is unset or `true` in production.
- `CORS_ORIGIN` is unset or `*` in production.
- There is no backup from today.
- `npm test` does not pass.
- The client bundle was built against the wrong `VITE_SERVER_URL` — it is baked
  in at build time, so redeploying will not fix it.
