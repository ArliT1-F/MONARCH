# Running the bot worker (and the music node) on your own machine, 24/7

Zero hosting cost, and it still fixes the thing your provider can't: **Discord
voice is UDP**. What changed is *who* needs it. Audio no longer runs inside the
bot — it runs in a **Lavalink node**, a small JVM service that owns the Discord
voice socket, fetches the audio (YouTube through the `youtube-source` plugin),
decodes it and encodes Opus. The bot just tells it what to play, over a
websocket on `localhost:2333` plus REST.

```
laptop (two units)                              Vercel (unchanged)
  monarch-bot        gateway WSS ──────▶ Discord   dashboard + OAuth + Prisma
                     ws + REST ────┐                    │
  monarch-lavalink   ◀─────────────┘                    │
                     voice UDP ────▶ Discord            │
                     HTTPS ────────────────────────────▶ /api/internal/* ──▶ Postgres/Neon
```

Nothing connects *to* the laptop as long as both units run on it:
`apps/bot/src/index.ts` starts no HTTP listener and the node binds 2333 for the
bot next door. So there is no port forwarding, no DDNS, no TLS certificate, and
your home IP stays private. That asymmetry is the whole reason self-hosting the
worker is easy while self-hosting the dashboard is not.

`deploy/laptop-install.sh` writes **systemd user units** — no sudo, no Docker
daemon, no root — and checks your setup before it touches anything.

| | Laptop, both units | Render worker + a node elsewhere |
|---|---|---|
| `/music` | ✅ | ✅ (see the caveat at the bottom of this page) |
| Cost | ~2–4 €/month electricity | free tier + ~4 €/month for the node's host |
| Survives your ISP/power | ❌ (self-heals after) | ✅ for the bot, ❌ for a home node |
| Needs a public address | ❌ | the node does, or a tunnel |
| Restarts on crash/boot | ✅ `Restart=always` | ✅ |

## 1. The machine, once

```bash
# node ≥ 20 (root package.json engines). Mint's apt node is years old — use the
# NodeSource package or nvm. If you change node later, re-run the installer:
# it bakes an absolute path to the binary it found.
node -v

# Java 17 or newer for the music node (21 recommended). Nothing else: the bot
# has no native dependencies left, so `npm ci` needs no compiler and no ffmpeg.
sudo apt install openjdk-21-jre-headless
java -version

# start both units at BOOT instead of at login, and keep them alive when you log
# out. One time, needs sudo.
sudo loginctl enable-linger $USER

# belt and braces on sleep: the bot unit already holds a systemd-inhibit sleep
# lock while it runs (which covers the node too — same machine), masking the
# targets makes it absolute (lid-close then also does nothing — see the bag
# warning below).
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
  fan screams, `sudo apt install thermald`. The node's Opus encoding is the
  warmest thing Monarch runs; `opusEncodingQuality` and `resamplingQuality` in
  `docker/lavalink/application.yml` trade that heat for audio quality.

Use **Ethernet** if you can. Voice is ~60–100 kbps of tiny datagrams leaving the
node, so bandwidth is a non-issue — but Wi-Fi retransmits are exactly the "bot
sounds like a drive-through intercom" failure, and a laptop's power-saving
Wi-Fi driver dropping packets overnight is a classic.

## 2. Both units

```bash
git clone <your-fork> ~/MONARCH && cd ~/MONARCH
cp .env.example .env && $EDITOR .env      # see the keys below
chmod 600 .env                            # it holds the bot token
npm ci
./deploy/laptop-install.sh --check        # preflight only, touches nothing
./deploy/laptop-install.sh                # writes + enables + starts both units
```

What the installer does beyond writing the bot unit:

- downloads `Lavalink.jar` **4.2.2** (pinned by `LAVALINK_VERSION` at the top of
  the script) into `~/.local/share/monarch-lavalink/`;
- copies the repo's `docker/lavalink/application.yml` next to it, so the node
  config is version-controlled and one `git pull` + re-run updates it;
- writes `monarch-lavalink.service` and orders the bot unit after it. On its
  first boot the node downloads the `youtube-source` plugin into `./plugins` —
  give it ~30 s, the bot reconnects on its own until it answers.

Already run a node somewhere else? Set `LAVALINK_NODES` in `.env` and the
installer skips all of the above (`--no-lavalink` says the same thing without
editing `.env`).

The keys that actually matter for a laptop worker:

| Key | Why it's different here |
|---|---|
| `DISCORD_BOT_TOKEN` | `start()` exits 1 without a login, so a wrong token = a restart loop every 10 s. Loud, not silent. |
| `DISCORD_CLIENT_ID` | slash command registration happens at **every boot** |
| `APP_URL` | must be the **deployed dashboard** (your Vercel URL). It is no longer "wherever the bot lives". `--check` warns if it still says `localhost`. |
| `INTERNAL_API_TOKEN` | the bot has no database of its own; `/monarch backup`, `export`, `embed`, `test`, `!prefix set` and confessions are HTTP calls to `APP_URL`. Must match Vercel's value exactly. |
| `LAVALINK_NODES` | unset means `ws://localhost:2333`, i.e. the node this script installs. Set it only to use a node elsewhere. |
| `LAVALINK_PASSWORD` | must equal `lavalink.server.password` in `application.yml`. Unset = Lavalink's published default on both sides, which is fine for localhost and unforgivable on a public IP. |

`MONARCH_OWNER_USER_ID` is worth setting while you're in the file (the
`/burg` uno-reverse). Add `--headless` to the installer if the laptop will run
**lid closed** — it also refuses lid-close suspend, which is what you want on a
shelf and *not* what you want before the laptop goes into a bag:

```bash
systemctl --user status monarch-bot monarch-lavalink   # are they up?
journalctl --user -u monarch-bot -f                    # the worker's logs
journalctl --user -u monarch-lavalink -f               # the node's logs
systemctl --user cat monarch-bot.service               # what was generated
```

A healthy boot looks like this in the bot journal — note the `music` field,
which is the node handshake seen from the bot's side:

```
bot ready  { instance: "arli-laptop", guilds: 3, burg: true, prefixCommands: true,
             music: "node-1(localhost:2333) ready:8f2c1a…" }
```

and in the node journal:

```
Lavalink is ready to accept connections.
```

`instance` is `os.hostname()` on purpose — if you ever forget whether the old
worker is still alive, this tells you which box answered. `music: "…down"` at
boot is not fatal (the bot retries with backoff), but it means `/music` will
answer "the music backend isn't answering" until the node comes up.

## 3. Take Render out of the pool

Two workers sharing `DISCORD_BOT_TOKEN` is not "redundancy":

- both receive every `MessageCreate`, so `!burg` deletes and re-posts **twice**,
  and every prefix command runs twice;
- two `MusicManager`s each believe they own the guild's player on the node →
  flapping joins, a song that restarts, `!music stop` that doesn't stick;
- confession cooldowns and prefix caches live in memory per process, so they
  disagree.

In the Render dashboard: **Services → monarch-bot → Files/Options → Pause
Service** (or delete it — `render.yaml` stays in the repo as the recipe for any
worker host). If you'd rather keep the Render worker as a fallback, give it a
different token-less config: with `DISCORD_BOT_TOKEN` unset the bot logs one
warning and exits 0, which is a perfectly idle service.

## 4. Prove the music path, not just the gateway

The gateway is TLS over TCP, so "the bot is online" proves **nothing** about the
node or about UDP. Three checks, in order:

```bash
# 1. Is the node up and is it the version the bot expects?
curl -s localhost:2333/version      # prints the node's version JSON
systemctl --user status monarch-lavalink

# 2. Is outbound UDP actually leaving this machine? The node needs it, and this
#    sends a real DNS query to Cloudflare over UDP/53. A reply proves egress
#    works; five silent seconds means something between you and 1.1.1.1 drops
#    UDP — router firewall, ISP, or ufw with a default-deny OUTPUT rule.
node -e 'const d=require("node:dgram").createSocket("udp4");d.on("message",m=>{console.log("UDP egress OK:",m.length,"bytes");process.exit(0)});d.send(Buffer.from("0000010000010000000000000377777706676f6f676c6503636f6d0000010001","hex"),53,"1.1.1.1");setTimeout(()=>{console.log("no reply — UDP blocked");process.exit(1)},5000)'

# 3. Then the actual thing: join a voice channel and run /music play <link>
#    (or !play <search terms>) in Discord, with both journals open beside it.
```

What each failure looks like from here:

- `/music` answers *"The music backend (Lavalink) isn't answering"* → the node
  is down, unreachable, or the password differs. `journalctl --user -u
  monarch-lavalink -n 40`, then compare `LAVALINK_PASSWORD` in `.env` with
  `lavalink.server.password` in the node's `application.yml`.
- bot log says `handshake refused (HTTP 401) — wrong LAVALINK_PASSWORD?` →
  exactly that. Restart **both** units after fixing it: the node reads the env
  file at start.
- node journal says it could not load the YouTube plugin → first boot needs
  egress to `maven.lavalink.dev`. Check `~/.local/share/monarch-lavalink/plugins`
  for the jar once it succeeds.
- node **crash-loops** (Docker) with `java.io.FileNotFoundException:
  ./plugins/youtube-plugin-…jar (Permission denied)` → the plugins volume is
  root-owned and the node's uid 322 cannot write into it; it never reaches
  `Lavalink is ready to accept connections`. `docker run --rm --volumes-from
  monarch-lavalink busybox chown -R 322:322 /opt/Lavalink/plugins && docker
  restart monarch-lavalink` (the compose file's `lavalink-perms` job does this on
  a fresh stack — see the Docker section at the bottom).
- `voice re-handshake failed` / a join that never starts → Discord never sent
  voice credentials, or the node refused them. The bot logs `voice credentials
  handed to the node` on success; if that line is missing after 15 s, look at
  the node journal for the same guild id.
- `track exception on the node` / `track stuck on the node`, or a user-visible
  *"YouTube refused this video for the node's IP"* → the node's address is being
  rate-limited or the plugin is behind YouTube. Fix it node-side, in
  `docker/lavalink/application.yml`: update `YOUTUBE_PLUGIN_VERSION`, reorder
  `plugins.youtube.clients`, enable `lavalink.server.ratelimit` with an IPv6
  block, or turn on OAuth / a poToken (all commented out there, with links).
  A single failing track while others play is just that video (blocked,
  removed, age-gated) — not the worker.
- `track ended prematurely` in the bot journal → the node ended the track more
  than 15 s early and the bot says so out loud (`⚠️ Track cut short`) instead of
  silently moving on. Read the node journal around the same timestamp: it names
  the client and the reason. This is the log line that started the move off
  yt-dlp, and on the node it is a config problem, not a code one.
- `node lost the Discord voice socket` with code **4006/4007/4009** → the bot
  re-handshakes and resumes the same track at the same position; nothing to do.
  Code **4014** means Discord disconnected the bot (kicked, channel deleted,
  moved by someone with permissions) and it leaves cleanly.
- `🔁 Music node restarted` in the music channel → the node came back after
  longer than `LAVALINK_RESUME_SECONDS` (60 s), so the session was not resumable
  and the bot rebuilt every guild's player. Within the window it resumes
  silently instead.
- 401/403 on `PUT /applications/…/commands` → `DISCORD_CLIENT_ID`/token mismatch
- `interaction expired before the bot answered` (code 10062) on the first
  command after a boot → the dashboard was still cold-starting when Discord's
  3-second interaction window passed; the next try works. If it repeats,
  something is slow on every request (dashboard, network) — or a second
  worker is racing this one (code 40060 means exactly that: pause the Render
  worker, step 3).

## Day 2

| I want to | command |
|---|---|
| read logs since boot | `journalctl --user -u monarch-bot -b` |
| read the node's logs | `journalctl --user -u monarch-lavalink -b` |
| stop it (before travel!) | `systemctl --user stop monarch-bot monarch-lavalink` |
| start it again | `systemctl --user start monarch-lavalink monarch-bot` |
| restart only the node | `systemctl --user restart monarch-lavalink` |
| change an env value | edit `.env`, then `systemctl --user restart monarch-bot` (and the node, if it reads that key: `LAVALINK_PASSWORD`, `LAVALINK_PORT`) |
| change node config | edit `docker/lavalink/application.yml`, re-run the installer (it re-copies), `systemctl --user restart monarch-lavalink` |
| upgrade the bot | `cd ~/MONARCH && git pull && npm ci && systemctl --user restart monarch-bot` |
| upgrade Lavalink | bump `LAVALINK_VERSION` in `deploy/laptop-install.sh`, re-run it (the jar re-downloads, the plugin stays) |
| full re-check + reinstall | `./deploy/laptop-install.sh --check && ./deploy/laptop-install.sh` |
| remove it entirely | `./deploy/laptop-install.sh --uninstall` (then `rm -rf ~/.local/share/monarch-lavalink`) |
| confirm it starts at boot | `systemctl --user is-enabled monarch-bot monarch-lavalink && ls /var/lib/systemd/linger/` |

Restarting the *worker* mid-song is quieter than it used to be: the node keeps
the track playing for up to `LAVALINK_RESUME_SECONDS` (60 s) waiting for the bot
to come back with the same session, then cleans the player up. `git pull` +
`systemctl --user restart monarch-bot` usually lands inside that window, so the
song survives — the queue does not, it lives in the worker's memory.

Global slash-command updates can take up to an hour to propagate — while you're
testing, put your test server's id in `DISCORD_GUILD_ID` and registration
becomes instant.

## If it misbehaves

| Symptom | What it actually is |
|---|---|
| works all day, dead at 3 am, logs just stop | the laptop slept. `journalctl -b -1 -n 40` will end mid-sentence. The `systemd-inhibit` lock covers idle suspend; `--headless` covers the lid; masking the targets covers everything. |
| bot is online, `/music` says the backend is down | the node. `systemctl --user status monarch-lavalink`, then `curl -s localhost:2333/version`. |
| bot joins the channel and nothing plays | voice credentials never reached the node, or the node has no UDP egress (step 4.2). The bot logs `voice credentials handed to the node` when its half worked. |
| audio crackles / sounds like an intercom | Wi-Fi retransmits or a CPU-starved node. Ethernet first; then drop `opusEncodingQuality` to 8 and `resamplingQuality` to `LOW` in `application.yml`. |
| `/burg` or `!help` do nothing, slash works | Message Content intent off in the developer portal. The bot falls back to Guilds+VoiceStates instead of crash-looping, and says so at boot. |
| unit `failed` with exit 1, repeats every 10 s | bad token, or Discord unreachable at boot. `--check` first, then `journalctl -n 30`. |
| node uses a whole core while playing | Opus encoding at quality 10. Fine for a handful of guilds; lower the quality or move the node to a VPS for more. |
| bot process at 100 % CPU | something else — it does no audio work any more. Check whether a second worker is racing it (step 3). |
| only works while your terminal is open | lingering is off: `sudo loginctl enable-linger $USER` |
| replies arrive twice | there are two workers (Render). See step 3. |
| **no** command answers, bot offline in Discord | the worker isn't logged in. `systemctl --user status monarch-bot` / `docker compose ps -a` — a bot container `Exited (0)` means compose interpolated an empty `DISCORD_BOT_TOKEN` (missing `--env-file .env`, see the Docker section) |
| node container restarts every few seconds | plugins dir not writable by uid 322 → `Permission denied` on `./plugins/youtube-plugin-…jar`. `docker run --rm --volumes-from monarch-lavalink busybox chown -R 322:322 /opt/Lavalink/plugins` |
| yt-dlp / ffmpeg errors in Discord | an **old worker** is still running and answering the gateway — this codebase has no yt-dlp path at all. Find and stop it (step 3), then `git pull && npm ci` and restart |

## Prefer Docker on the laptop?

Also fine, and it's the path you'd reuse on a VPS later. `docker/docker-compose.yml`
has both services; `--no-deps` keeps it from dragging the dashboard and Postgres
along when your dashboard lives on Vercel:

```bash
cd ~/MONARCH
docker compose --env-file .env -f docker/docker-compose.yml up -d lavalink
docker compose --env-file .env -f docker/docker-compose.yml up -d --no-deps bot
```

**`--env-file .env` is not optional.** Compose interpolates `${DISCORD_BOT_TOKEN}`
&co. from a `.env` in the *project directory*, which defaults to the folder
holding the compose file — `docker/`, not the repo root. Without it every value
expands to empty, the worker logs `DISCORD_BOT_TOKEN is not set — bot not
started.` and **exits 0**: a container that looks healthy and a bot that is
simply never online, so *no* command answers (not even `!help`). Same trap from
inside the folder: `cd docker && docker compose --env-file ../.env up -d`, or
`ln -s ../.env docker/.env` once (`.env` is gitignored either way). The systemd
units read `$REPO/.env` through `EnvironmentFile=` directly and have no such
trap — one more reason to prefer them on a laptop.

It also silently desyncs the password: the node falls back to
`youshallnotpass` while a systemd bot sends the real `LAVALINK_PASSWORD` from
`.env`, and the bot then logs `handshake refused (HTTP 401) — wrong
LAVALINK_PASSWORD?`. Both sides must read the same file.

Mix and match freely — they only need to reach each other on 2333:

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d lavalink  # node in Docker…
./deploy/laptop-install.sh --no-lavalink                                    # …bot as a unit
# .env: LAVALINK_NODES=ws://localhost:2333
```

The compose node publishes 2333 on the host (so a systemd bot can reach it) and
keeps its plugins in a named volume, which a one-shot `lavalink-perms` service
chowns to the node's uid 322 before the JVM starts: the official image runs as
322 but has no `/opt/Lavalink/plugins` directory, so Docker creates that mount
point **root-owned** and the node dies downloading its first plugin
(`java.io.FileNotFoundException: ./plugins/youtube-plugin-…jar (Permission
denied)`, then a `restart: unless-stopped` loop that never reaches `Lavalink is
ready to accept connections`). If you hit that loop on a volume that already
exists, fix it in place instead of recreating it:

```bash
docker run --rm --volumes-from monarch-lavalink busybox chown -R 322:322 /opt/Lavalink/plugins
docker restart monarch-lavalink
docker logs -f monarch-lavalink      # want: Loaded youtube-plugin…, Lavalink is ready to accept connections
```

(A panel-managed container with a *bind* mount for `plugins/` fails the same way:
`sudo chown -R 322:322 /host/path/to/plugins`.)

The bot image is a plain `node:22-alpine` now — no ffmpeg layer, no yt-dlp, no
native modules to compile, which is why musl stopped being a problem.

## When the laptop stops being the right host

Same `.env`, same `deploy/` folder, one different box. `deploy/laptop-install.sh`
is not laptop-specific — on a €4 VPS or a Raspberry Pi 5 it generates the exact
same two units, and it's the first thing to run there. Consider the move when any
of these is true:

- several guilds play at the same time (the node's CPU cost is per-playing-guild,
  and the JVM wants ~1 G of headroom);
- people start scheduling things around the bot, and "my building lost power"
  stops being a funny excuse;
- the laptop needs to travel, or you notice you're afraid to `apt upgrade`.

The bot and the node do **not** have to live together. Any host that passes
outbound UDP can run the node while the worker stays on Render — that is what
`LAVALINK_NODES` is for, and it's the reason `/music` is no longer tied to where
the gateway runs.

## Which hosts carry `/music`

Two independent questions now: can the host hold a gateway connection (the bot),
and can the host open outbound UDP to Discord (the node)?

| Bot host | Node host | `/music` | Notes |
|---|---|---|---|
| your own box | same box (`deploy/laptop-install.sh`) | ✅ | free, and this page |
| Render | a VPS / Fly.io / this laptop* | ✅ | set `LAVALINK_NODES`; the node cannot run *on* Render (no UDP egress) |
| Fly.io, Railway, any VPS | same box | ✅ | same units, same `.env` |
| Docker Compose on any server | the `lavalink` service | ✅ | `docker compose --env-file .env … up -d bot lavalink` |
| Vercel / Netlify / Cloudflare Workers | anywhere | ❌ | serverless can't hold a gateway connection at all |
| Render | Render | ❌ | the bot is fine; there is nowhere for the node to send UDP |

\* A node on your laptop needs an address the Render worker can dial — a VPS, a
`cloudflared`/`tailscale funnel` in front of 2333, or a static IP with port
forwarding. That is the one setup where something connects *to* your machine, so
give the node a real `LAVALINK_PASSWORD` and put TLS in front of it
(`wss://`, `LAVALINK_SECURE=1`). If that sounds like more than you signed up
for, run both units at home and skip Render entirely.
