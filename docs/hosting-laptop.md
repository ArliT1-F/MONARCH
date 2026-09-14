# Running the bot worker on your own machine, 24/7

Zero hosting cost, and it fixes the thing your provider can't: **Discord voice
is UDP**, and `@discordjs/voice` has no TCP fallback. Render's containers have
no UDP egress, so `/music` joins the channel, sits in `signalling`, and times
out. A laptop on your home network sends outbound UDP without asking anyone.

```
laptop (this worker)                     Vercel (unchanged)
  gateway WSS  ───────▶ Discord           dashboard + OAuth + Prisma
  voice UDP    ───────▶ Discord                │
  HTTPS ─────────────────────────────────────▶ /api/internal/*  ──▶ Postgres/Neon
```

Nothing connects *to* the laptop. `apps/bot/src/index.ts` starts no HTTP
listener, so there is no port forwarding, no DDNS, no TLS certificate, and your
home IP stays private. That asymmetry is the whole reason self-hosting the
worker is easy while self-hosting the dashboard is not.

`deploy/laptop-install.sh` writes a **systemd user unit** — no sudo, no Docker
daemon, no root — and checks your setup before it touches anything.

| | Laptop 24/7 | Render worker |
|---|---|---|
| `/music` (UDP) | ✅ | ❌ silently broken |
| Cost | ~2–4 €/month electricity | free tier |
| Survives your ISP/power | ❌ (self-heals after) | ✅ |
| Needs a public address | ❌ | ❌ |
| Restarts on crash/boot | ✅ `Restart=always` | ✅ |

## 1. The machine, once

```bash
# node ≥ 20 (root package.json engines). Mint's apt node is years old — use the
# NodeSource package or nvm. If you change node later, re-run the installer:
# it bakes an absolute path to the binary it found.
node -v

# optional. Not required: the bot falls back to the static build bundled with
# @ffmpeg-installer/ffmpeg (see apps/bot/src/music/ffmpeg.ts).
sudo apt install ffmpeg

# start the worker at BOOT instead of at login, and keep it alive when you log
# out. One time, needs sudo.
sudo loginctl enable-linger $USER

# belt and braces on sleep: the unit already holds a systemd-inhibit sleep lock
# while it runs, masking the targets makes it absolute (lid-close then also does
# nothing — see the bag warning below).
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# keep a 24/7 service from filling the disk with JSON logs
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nRuntimeMaxUse=100M\n' | sudo tee /etc/systemd/journald.conf.d/monarch.conf
sudo systemctl restart systemd-journald
```

Two things that eat laptops run 24/7 and cost €0 to fix:

- **Battery.** Pinned at 100% for months, on a desk, at 40 °C, is how packs
  swell. `sudo apt install tlp`, then in `/etc/tlp.conf` set
  `START_CHARGE_THRESH_BAT0=55` / `STOP_CHARGE_THRESH_BAT0=60` (ThinkPad,
  Lenovo, ASUS; `tlp-stat -b` tells you if your firmware supports it) and
  `sudo tlp fullcharge && sudo tlp setcharge`.
- **Heat/dust.** Blow the vents out twice a year, keep it off fabric, and if the
  fan screams, `sudo apt install thermald`.

Use **Ethernet** if you can. Voice is ~60 kbps of tiny datagrams, so bandwidth
is a non-issue — but Wi-Fi retransmits are exactly the "bot sounds like a
drive-through intercom" failure, and a laptop's power-saving Wi-Fi driver
dropping packets overnight is a classic.

## 2. The worker

```bash
git clone <your-fork> ~/MONARCH && cd ~/MONARCH
cp .env.example .env && $EDITOR .env      # see the four keys below
chmod 600 .env                            # it holds the bot token
npm ci
./deploy/laptop-install.sh --check        # preflight only, touches nothing
./deploy/laptop-install.sh                # writes + enables + starts the unit
```

The four that actually matter for a laptop worker:

| Key | Why it's different here |
|---|---|
| `DISCORD_BOT_TOKEN` | `start()` exits 1 without a login, so a wrong token = a restart loop every 10 s. Loud, not silent. |
| `DISCORD_CLIENT_ID` | slash command registration happens at **every boot** |
| `APP_URL` | must be the **deployed dashboard** (your Vercel URL). It is no longer "wherever the bot lives". `--check` warns if it still says `localhost`. |
| `INTERNAL_API_TOKEN` | the bot has no database of its own; `/monarch backup`, `export`, `embed`, `test`, `!prefix set` and confessions are HTTP calls to `APP_URL`. Must match Vercel's value exactly. |

`MONARCH_OWNER_USER_ID` is worth setting while you're in the file (the
`/burg` uno-reverse). Add `--headless` to the installer if the laptop will run
**lid closed** — it also refuses lid-close suspend, which is what you want on a
shelf and *not* what you want before the laptop goes into a bag:

```bash
systemctl --user status monarch-bot          # is it up?
journalctl --user -u monarch-bot -f          # the logs
systemctl --user cat monarch-bot.service     # what was generated
```

A healthy boot line looks like:

```
bot ready  { instance: "arli-laptop", guilds: 3, burg: true, prefixCommands: true }
```

`instance` is `os.hostname()` on purpose — if you ever forget whether the old
worker is still alive, this tells you which box answered.

## 3. Take Render out of the pool

Two workers sharing `DISCORD_BOT_TOKEN` is not "redundancy":

- both receive every `MessageCreate`, so `!burg` deletes and re-posts **twice**,
  and every prefix command runs twice;
- two `MusicManager`s each believe they own the guild's voice connection →
  flapping joins, a song that restarts, `!music stop` that doesn't stick;
- confession cooldowns and prefix caches live in memory per process, so they
  disagree.

In the Render dashboard: **Services → monarch-bot → Files/Options → Pause
Service** (or delete it — `render.yaml` stays in the repo as the recipe for any
non-voice host). If you'd rather keep the Render worker as a fallback, give it a
different token-less config: with `DISCORD_BOT_TOKEN` unset the bot logs one
warning and exits 0, which is a perfectly idle service.

## 4. Prove the voice path, not just the gateway

The gateway is TLS over TCP, so "the bot is online" proves **nothing** about
UDP. Two checks, in order:

```bash
# 1. Is outbound UDP actually leaving this machine? This sends a real DNS query
#    to Cloudflare over UDP/53. A reply proves egress works; five silent
#    seconds means something between you and 1.1.1.1 drops UDP — router
#    firewall, ISP, or ufw with a default-deny OUTPUT rule.
node -e 'const d=require("node:dgram").createSocket("udp4");d.on("message",m=>{console.log("UDP egress OK:",m.length,"bytes");process.exit(0)});d.send(Buffer.from("0000010000010000000000000377777706676f6f676c6503636f6d0000010001","hex"),53,"1.1.1.1");setTimeout(()=>{console.log("no reply — UDP blocked");process.exit(1)},5000)'

# 2. Then the actual thing: join a voice channel and run /music play <link>
#    (or !play <search terms>) in Discord, with the journal open beside it.
```

Watch `journalctl --user -u monarch-bot -f` while it rings. What each failure
looks like from here:

- nothing at all, no error → connection stuck pre-`Ready`: UDP (step 1) or an
  outdated `@discordjs/voice` (see the DAVE note below)
- `Cannot find module 'opusscript'` → stale `node_modules`: `npm ci`
- `spawn ffmpeg ENOENT` → no ffmpeg and no bundled fallback
- 401/403 on `PUT /applications/…/commands` → `DISCORD_CLIENT_ID`/token mismatch
- `interaction expired before the bot answered` (code 10062) on the first
  command after a boot → the dashboard was still cold-starting when Discord's
  3-second interaction window passed; the next try works. If it repeats,
  something is slow on every request (dashboard, network) — or a second
  worker is racing this one (code 40060 means exactly that: pause the Render
  worker, step 3).
- `track resolution failed` / `YouTube only offered SABR streams` → YouTube
  gave no direct audio URL on any InnerTube client. Install `yt-dlp` on the
  laptop (`pip install yt-dlp` — the bot picks it up automatically as a
  fallback); if tracks fail with `requires login`, export a `YOUTUBE_COOKIE`
  from your browser into `.env` (see `.env.example`). A single failing track
  while others play is just that video (blocked/removed) — not the worker.

## Day 2

| I want to | command |
|---|---|
| read logs since boot | `journalctl --user -u monarch-bot -b` |
| stop it (before travel!) | `systemctl --user stop monarch-bot` |
| start it again | `systemctl --user start monarch-bot` |
| change an env value | edit `.env`, then `systemctl --user restart monarch-bot` |
| update the bot | `cd ~/MONARCH && git pull && npm ci && systemctl --user restart monarch-bot` |
| full re-check + reinstall | `./deploy/laptop-install.sh --check && ./deploy/laptop-install.sh` |
| remove it entirely | `./deploy/laptop-install.sh --uninstall` |
| confirm it starts at boot | `systemctl --user is-enabled monarch-bot && ls /var/lib/systemd/linger/` |

`git pull` mid-song drops the voice connection (the process dies, ffmpeg with
it). Say `!music stop` first, or tell your friends the bot restarts when the
code changes. Global slash-command updates can take up to an hour to propagate —
while you're testing, put your test server's id in `DISCORD_GUILD_ID` and
registration becomes instant.

## If it misbehaves

| Symptom | What it actually is |
|---|---|
| works all day, dead at 3 am, logs just stop | the laptop slept. `journalctl -b -1 -n 40` will end mid-sentence. The `systemd-inhibit` lock covers idle suspend; `--headless` covers the lid; masking the targets covers everything. |
| bot joins, plays nothing, logs `signalling` | Discord voice now requires **DAVE**. This repo pins `@discordjs/voice@0.19.2` + `@snazzah/davey` — don't downgrade it, and don't blame your network until step 1 above passes. |
| "no suitable opus encoder" | the encoder is a hard requirement: `player.ts` uses `StreamType.Arbitrary` + `inlineVolume`, so every frame goes ffmpeg → PCM → Opus. `opusscript` is in `apps/bot/package.json`; a missing one means `npm ci` didn't run. |
| `/burg` or `!help` do nothing, slash works | Message Content intent off in the developer portal. The bot falls back to Guilds+VoiceStates instead of crash-looping, and says so at boot. |
| unit `failed` with exit 1, repeats every 10 s | bad token, or Discord unreachable at boot. `--check` first, then `journalctl -n 30`. |
| 100 % CPU on one core while playing | `opusscript` is JS. Fine for a handful of guilds; for more, `npm i @discordjs/opus -w @monarch/bot` (needs `build-essential python3`), or run the alpine image where it must compile — see below. |
| only works while your terminal is open | lingering is off: `sudo loginctl enable-linger $USER` |
| replies arrive twice | there are two workers (Render). See step 3. |

## Prefer Docker on the laptop?

Also fine, and it's the path you'd reuse on a VPS later:

```bash
docker build -f docker/bot.Dockerfile -t monarch-bot .        # ships ffmpeg
docker run -d --name monarch-bot --env-file .env \
  --restart unless-stopped --log-opt max-size=10m --log-opt max-file=3 monarch-bot
```

Three notes: the bot needs **no** database and no `dashboard`/`postgres`
containers, so don't start `docker/docker-compose.yml` for this; `--env-file`
takes the same `.env`; and the image is alpine (musl), which is precisely why
`opusscript` is the default encoder here instead of the native `@discordjs/opus`
— musl has no prebuilt binary for it and the build would need toolchain layers.
Docker buys you nothing on the laptop except a second always-on daemon; a
`[Service]` unit does the same job with fewer moving parts, which is why the
script writes one.

## When the laptop stops being the right host

Same `.env`, same `deploy/` folder, one different box. `deploy/laptop-install.sh`
is not laptop-specific — on a €4 VPS or a Raspberry Pi 5 it generates the exact
same unit, and it's the first thing to run there. Consider the move when any of
these is true:

- several guilds play at the same time (CPU is per-playing-guild, and ffmpeg +
  JS opus is the cost);
- people start scheduling things around the bot, and "my building lost power"
  stops being a funny excuse;
- the laptop needs to travel, or you notice you're afraid to `apt upgrade`.

And the reason to leave Render forever: `render.yaml` will run everything about
Monarch *except* voice. No amount of config changes that — it's a missing
protocol, not a missing setting.

## Which hosts carry `/music`

The gateway and every non-voice command work anywhere long-lived. Voice is the
outlier, because `@discordjs/voice` speaks **UDP only**:

| Host | Outbound UDP | `/music` | Notes |
|---|---|---|---|
| your own box, `deploy/laptop-install.sh` | ✅ | ✅ | free, and this page |
| Fly.io | ✅ | ✅ | no `[http_service]` in `fly.toml` — the worker listens on nothing |
| Railway, a VPS, Hetzner/DO droplet | ✅ | ✅ | same unit, same `.env` |
| Docker Compose on any server | ✅ | ✅ | `docker/bot.Dockerfile`, no `postgres` container needed |
| **Render** | ❌ | ❌ | everything else works; joins the channel, then times out |
| Vercel / Netlify / Cloudflare Workers | ❌ | ❌ | serverless can't hold a gateway connection at all |
| Oracle "always free" VM | ✅ | ✅ | it works; it just costs a card and an account you didn't want |

If you ever go back to Render on purpose, leave `SPOTIFY_*` and the voice
commands alone and know they'll fail — a `DISCORD_BOT_TOKEN`-less Render service
is the tidier version of that.

