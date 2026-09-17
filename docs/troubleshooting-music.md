# Troubleshooting Music — Lavalink

If `/music play` answers:

> **The music backend (Lavalink) isn't answering, so nothing can play right now.**
> **Node says: Couldn't reach the Lavalink node at localhost:2333 (TypeError: fetch failed).**
> **Check that the node is running and that LAVALINK_NODES / LAVALINK_PASSWORD match its application.yml.**

The bot is running, but the Lavalink node (the JVM service that owns the Discord voice socket and fetches audio) is not.

---

## 1. Quick check

```bash
npm run music:check
# or
node scripts/check-lavalink.mjs
```

It reads your `.env` and tries:

- `GET http://localhost:2333/version`
- `GET http://localhost:2333/v4/info`
- `GET http://localhost:2333/v4/stats`

If it prints `fetch failed`, the node is down. If it prints `401`, password mismatch.

---

## 2. Start the bundled node (Docker)

The repo ships a node in `docker/docker-compose.yml`:

```bash
# from repo root (recommended, env_file now reads ../.env automatically)
docker compose -f docker/docker-compose.yml up -d lavalink

# check it
curl http://localhost:2333/version
docker logs monarch-lavalink -f
npm run music:check
```

`docker-compose.yml` now declares `env_file: [../.env, .env]` for every service, so both of these work:

```bash
docker compose -f docker/docker-compose.yml up -d lavalink   # repo root
cd docker && docker compose up -d lavalink                   # inside docker/
```

Without that, `${LAVALINK_PASSWORD}` expands to empty and the node falls back to `youshallnotpass` while your bot uses a custom password → 401.

### If you run the bot locally (`npm run dev:bot`) + node in Docker

- Keep `.env` with:

  ```
  LAVALINK_NODES=              # blank → uses HOST/PORT below
  LAVALINK_HOST=localhost
  LAVALINK_PORT=2333
  LAVALINK_PASSWORD=your-generated-password
  ```

- The compose file maps `2333:2333`, so `localhost:2333` reaches the container.

### If you run both bot and node in Docker

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

The bot service defaults `LAVALINK_NODES=ws://lavalink:2333` (the Docker DNS name). No need to set `LAVALINK_HOST`.

---

## 3. Start the node on your own machine (systemd)

No Docker, needs Java 17+ (21 recommended):

```bash
./deploy/laptop-install.sh --check   # preflight
./deploy/laptop-install.sh           # installs monarch-bot + monarch-lavalink user units
systemctl --user status monarch-lavalink
journalctl --user -u monarch-lavalink -f
```

See `docs/hosting-laptop.md` for full guide (linger, sleep masks, TLP, etc.).

---

## 4. Password mismatch (401)

```
Node says: Lavalink GET /v4/loadtracks?identifier=... failed: HTTP 401
handshake refused (HTTP 401) — wrong LAVALINK_PASSWORD?
```

Fix:

1. Open `.env` → copy `LAVALINK_PASSWORD`
2. Open `docker/lavalink/application.yml` → it uses `${LAVALINK_PASSWORD:youshallnotpass}`. The env var must match.
3. If using Docker: `docker compose -f docker/docker-compose.yml up -d --force-recreate lavalink`
4. If using systemd: `systemctl --user restart monarch-lavalink monarch-bot`

Generate a strong one: `openssl rand -hex 32`

Never expose a node with `youshallnotpass` on public internet.

---

## 5. Render / Vercel / Railway

- **Dashboard** can run anywhere (Vercel).
- **Bot worker** can run on Render (no UDP needed).
- **Lavalink node** cannot run on Render (no outbound UDP). Host it on:
  - a cheap VPS (Hetzner, DigitalOcean),
  - Fly.io (`fly deploy` with UDP allowed),
  - your own always-on laptop (`deploy/laptop-install.sh`)

Then set:

```
LAVALINK_NODES=wss://your-node.example.com:2333
LAVALINK_PASSWORD=...
```

on the bot worker.

---

## 6. Still failing?

Checklist:

```bash
# 1. Is the port listening?
ss -tlnp | grep 2333
curl -v http://localhost:2333/version -H "Authorization: your-password"

# 2. Env files?
cat .env | grep LAVALINK
cat docker/.env 2>/dev/null | grep LAVALINK

# 3. Docker?
docker ps | grep lavalink
docker logs monarch-lavalink --tail 100

# 4. Systemd?
systemctl --user status monarch-lavalink monarch-bot
journalctl --user -u monarch-lavalink -n 100

# 5. Bot logs?
# Look for "lavalink configured" and "lavalink ready" or "reconnect scheduled"
```

If `curl` works but bot says fetch failed:

- Bot and node are on different hosts/containers → use `LAVALINK_NODES=ws://lavalink:2333` inside compose, `ws://localhost:2333` outside.
- Firewall / Docker network isolation → `docker compose -f docker/docker-compose.yml up -d lavalink` exposes `0.0.0.0:2333`.

If YouTube says "Video returned by YouTube isn't what was requested":

- Update `youtube-source` plugin version in `docker/lavalink/application.yml` (YOUTUBE_PLUGIN_VERSION)
- Enable IP rotation / OAuth / poToken in same file — see comments there.

---

## 7. What we fixed in code

- `docker/docker-compose.yml` now has `env_file: [../.env, .env]` and a healthcheck, so `docker compose -f docker/docker-compose.yml up` from repo root works without `--env-file`.
- Error messages in `apps/bot/src/music/lavalink.ts` and `sources.ts` now include the exact `docker compose` command to start the node.
- New helper: `npm run music:check` → `scripts/check-lavalink.mjs` probes the node and explains 401 vs fetch failure.
- `.env.example` documents the diagnostics.
