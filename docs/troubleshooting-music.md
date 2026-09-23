# Music troubleshooting

`/music` plays through **yt-dlp** — one external binary, no Java, no node, no
Docker. This page is the order in which things fail, and what each failure means.

```
/music play  →  yt-dlp (extract + download audio)
             →  ffmpeg (optional: PCM + volume)
             →  Opus encoder  →  Discord voice (UDP)
```

## 1. Run the doctor

```bash
npm run music:setup     # downloads yt-dlp into .monarch/bin (once)
npm run music:check     # checks yt-dlp, ffmpeg, Opus, DAVE, encryption
npm run music:check -- --probe   # …and asks YouTube for a track
```

`music:setup` is the whole install: it drops the official yt-dlp build into
`.monarch/bin/yt-dlp` and reports whether an ffmpeg was found. `music:check`
prints a ✓/✗ line per component plus the fix for every ✗. If the bot is running,
its boot log shows the same summary: `describeAudio()` prints
`yt-dlp → ffmpeg → Opus (volume ✓)` or `yt-dlp → Opus passthrough`.

The bot also downloads yt-dlp by itself the first time a track is played
(`YTDLP_AUTO_DOWNLOAD=0` opts out) — the two scripts just make that happen
before you ever type a command.

## 2. "The downloader (yt-dlp) isn't installed"

The bot looked in `YTDLP_PATH`, then `.monarch/bin/yt-dlp`, then the `PATH`, then
tried to download it. All four failed — usually a container without egress, a
read-only filesystem, or a proxy that blocks GitHub release assets.

- `npm run music:setup` on the worker host (or `pipx install yt-dlp`), or
- set `YTDLP_PATH=/usr/local/bin/yt-dlp`, or
- point `YTDLP_BIN_DIR` / `MONARCH_BIN_DIR` at a writable volume so the
  auto-download sticks across restarts.

Keep yt-dlp fresh: YouTube breaks extractors every few weeks. `yt-dlp -U`, or
re-run `npm run music:setup -- --force`. `npm run music:check` warns when the
binary is more than 90 days old.

## 3. "YouTube asked the downloader to prove it isn't a bot"

Datacenter IPs (VPS, Fly.io, Render, CI) get this regularly; a home connection
almost never does.

1. In a browser, log into a **throwaway** YouTube account, export cookies in
   Netscape format (`Get cookies.txt`), and copy the file to the worker host.
2. Set `YTDLP_COOKIES=/path/to/cookies.txt` (or `YTDLP_COOKIE_FILE`).
3. Restart the bot. `npm run music:check -- --probe` tells you whether the IP
   is still challenged.

Cookies expire in a few weeks — re-export when `/music` starts failing again.
`YTDLP_PROXY` (e.g. `socks5://127.0.0.1:1080`) is the other way out, and it is
what a residential proxy is for.

## 4. It plays, but there is no sound

- **`/music volume` says volume is unavailable.** This machine has no ffmpeg (or
  no Opus encoder), so Monarch passes YouTube's Opus through untouched —
  cheaper, but volume can't change without re-encoding. Install ffmpeg to get it.
- **Silence, no error.** Check the bot's voice permissions in the channel
  (Connect + Speak) and that the *bot's* host allows outbound UDP; Discord voice
  is UDP, and containers on hosts without UDP egress join the channel, then sit
  in `signalling` until they time out.
- **Track cut short / `⚠️ Track cut short`.** The audio stream ended before the
  advertised length. See §6 — that is YouTube throttling, and there are three
  things to check. A track that dies within a few seconds *is* retried
  automatically once, silently; if it still fails you get the reason.

## 5. Throttling, "the song stops after a minute", robot voices

YouTube throttles a *connection*, not an account: the download starts at full
speed and then crawls to a few KB/s, the player runs out of buffered audio and
the track ends early. Monarch ships three defences, in order of how much they
usually matter:

1. **Chunked downloads.** Every download is requested as 16 KiB ranges
   (`--http-chunk-size`), which turns one throttled long-lived connection into
   a series of short requests — each answered at full speed. Nothing to
   configure; `npm run music:check` prints the flags in use.
2. **A JS runtime for the challenge solver.** yt-dlp needs JavaScript to solve
   YouTube's `n`/signature challenge; a stream whose challenge went unsolved is
   exactly the stream YouTube rate-limits. yt-dlp only enables Deno by default,
   so Monarch hands it the Node it is already running (`--js-runtimes
   node:…`). `YTDLP_JS_RUNTIME=deno` if you have Deno, `=none` to opt out.
3. **A fresh yt-dlp.** Extractors are updated within hours of a YouTube change
   and a stale binary *is* a throttled binary. `yt-dlp -U`, or
   `npm run music:setup -- --force`; `music:check` warns past 90 days.

If a track still stops early on a specific machine:

```
YTDLP_ARGS=--throttled-rate 100K      # re-extract when the stream drops below that rate
YTDLP_COOKIES=/path/cookies.txt       # a logged-in session is throttled far less
YTDLP_PROXY=socks5://…                # residential/proxy IP, when the host is the problem
```

`--throttled-rate` is the aggressive one: on a slow-but-honest connection it
will re-extract instead of just being slow, so try it *after* the first two.
The bot logs `elapsed vs expected` for every premature end, and the yt-dlp
stderr tail sits next to it in the logs — that is what tells "throttled" apart
from "the source 403'd us".


ffmpeg is **optional**: with it, Monarch decodes to PCM and re-encodes Opus, so
volume works and every source (AAC/M4A, MP3, radio) plays. Without it, only
Opus sources work (YouTube WebM/Opus does).

Where Monarch looks, in order: `MUSIC_FFMPEG_PATH`, `FFMPEG_PATH`,
`$MONARCH_BIN_DIR/ffmpeg` (or `.monarch/bin/ffmpeg`), the bundled
`@ffmpeg-installer/ffmpeg` npm package, then `ffmpeg` on the `PATH`.

```bash
sudo apt install ffmpeg        # Debian/Ubuntu
brew install ffmpeg            # macOS
winget install Gyan.FFmpeg     # Windows
```

Force a path with `MUSIC_AUDIO_PIPELINE=opus` (never transcode — lowest CPU) or
`=pcm` (always transcode).

## 6. "no suitable opus encoder"

`@discordjs/voice` needs an Opus encoder for the PCM path:
`opusscript` (pure JS, ships with Monarch) or `@discordjs/opus` (native, faster).
A missing encoder means `npm install` didn't complete — run it again. DAVE
(end-to-end encryption, which Discord now requires in most servers) comes from
`@snazzah/davey`, installed with `@discordjs/voice`; `music:check` verifies both.

## 7. Spotify links do nothing

Spotify needs `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` (free app at
developer.spotify.com). Without them, YouTube links, searches and playlists
still work; only Spotify links are refused. With them, the track's metadata is
read from Spotify and matched to YouTube at play time.

## 8. Which hosts can run `/music`

Voice is UDP **from the bot's host**. That is the only hard requirement:

| Host | `/music` | Notes |
| --- | --- | --- |
| Your own machine / VPS | ✅ | `deploy/laptop-install.sh` sets up both services |
| Fly.io / Railway (Docker) | ✅ | UDP egress is allowed |
| Docker anywhere | ✅ | `docker compose -f docker/docker-compose.yml up -d`; the bot image ships ffmpeg + yt-dlp |
| Render (worker) | ❌ | no UDP egress: joins, then times out in `signalling` |
| Vercel | ❌ | serverless; the bot is not a Vercel workload at all |

## 9. Knobs

| Variable | What it does |
| --- | --- |
| `YTDLP_PATH` | Use your own yt-dlp instead of the managed copy |
| `YTDLP_BIN_DIR` / `MONARCH_BIN_DIR` | Where the managed binaries live (default `.monarch/bin`) |
| `YTDLP_AUTO_DOWNLOAD=0` | Never download yt-dlp automatically |
| `YTDLP_DISABLED=1` | Turn the music player off entirely (commands explain why) |
| `YTDLP_COOKIES` / `YTDLP_COOKIE_FILE` | cookies.txt for age/bot checks |
| `YTDLP_PROXY` | SOCKS/HTTP proxy for every yt-dlp call |
| `YTDLP_ARGS` | Extra argv; quoted values stay together (`--throttled-rate 100K`, `--extractor-args "youtube:player_client=tv"`) |
| `YTDLP_JS_RUNTIME` | JS runtime for YouTube's challenge solver: default `node:<this bot's node>`, or `deno`, or `none` |
| `YTDLP_FORMAT` | Format selector; default prefers Opus-in-WebM |
| `YTDLP_CACHE_DIR` | Where yt-dlp keeps its cache |
| `MUSIC_FFMPEG_PATH` / `FFMPEG_PATH` | ffmpeg to use |
| `MUSIC_AUDIO_PIPELINE=pcm\|opus` | Force transcode or passthrough |
| `MUSIC_MAX_QUEUE`, `MUSIC_MAX_PLAYLIST_TRACKS` | Queue and import caps |
| `MUSIC_SEARCH_PREFIX` | Search backend for plain-text queries (`ytsearch`, `ytmsearch`, `scsearch`) |
| `MONARCH_OWNER_USER_ID` | The only account allowed to run `/monarch debug on` (and be immune to `!burg`) |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify link support |
| `MUSIC_DJ_ROLE_NAMES`, `MUSIC_STAFF_ROLE_NAMES` | Who can force-skip |

The bot's boot log (`apps/bot/src/index.ts`) prints which of these are in
effect; `npm run music:check` prints the resolved paths.

## 10. Reading the error messages

Every user-facing music error comes from one place — `explainYtdlpFailure()`
in `apps/bot/src/music/ytdlp.ts` — and it names the fix, not just the failure:

| Message | Meaning |
| --- | --- |
| "YouTube asked the downloader to prove it isn't a bot" | cookies (see §3) |
| "couldn't reach the source (network problem or a blocked IP)" | DNS/TLS/firewall, not the bot |
| "the site answered 404" | the link is dead |
| "the source refused the download (403)" | bot check or region block |
| "region-locked for the machine running the bot" | geo-restricted track |
| "live stream — wait for it to end" | live URLs aren't supported mid-stream |
| `⚠️ Track cut short` in Discord, `elapsed vs expected` in the log | the download stopped early — throttling or a network flap; §5 |
| `⚠️ Track failed` right after `/music play` | the download never started; the message says why (bot check → cookies, 404, 403, private…) — a *transient* failure here is retried once on its own |
| "isn't in a format Discord takes directly … no ffmpeg" | install ffmpeg (§5) |
| "**<track>** isn't on YouTube Music in a form I can play — I searched for …" | the search itself worked and every hit was live, silent or removed — not the same as "the download failed" |

The raw yt-dlp stderr tail is in the bot's logs next to the message — that is
what to paste into a bug report (it never contains your cookies).

### Seeing the raw error in Discord

Whoever holds the Monarch application (`MONARCH_OWNER_USER_ID`) can flip one
switch: `/monarch debug on` (or `!debug on`). While it is on, every music
failure is followed by the raw detail — yt-dlp's stderr tail, the exit code,
ffmpeg's output, stack traces — posted in the same channel as the tidy
message. `off` (or a bot restart: the switch is memory-only on purpose)
returns to one line. Everyone else gets the same refusal and never learns
whether the switch is on. Use it before pasting a failure into a bug report:

```
/monarch debug on
/music play <the failing track>
/monarch debug off
```
