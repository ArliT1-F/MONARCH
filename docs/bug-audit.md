# Bug audit — September 2026

Scope: the whole monorepo (`apps/bot`, `apps/dashboard`, `packages/*`, scripts,
deploy config, docs), with extra attention to the music subsystem, because
`/music` was the reported breakage. Each finding was reproduced, fixed on this
branch, and covered by the checks listed at the bottom.

## Critical

### 1. Playback depended on an external Lavalink node, with no fallback

`apps/bot/src/music/lavalink.ts` (869 lines) made the bot a *client* of a JVM
service: `/music` could do nothing unless a Lavalink node was reachable, and the
code had no second path ("no reachable node ⇒ the music backend is down"). The
documented ways to get a node were Docker (which crashes the reporter's laptop)
or a 512 MB JVM plus a JAR download. The whole yt-dlp/ffmpeg/`@discordjs/voice`
stack had been deleted when the node was introduced.

**Fixed** — the bot now owns the audio path in-process:

| New file | What it does |
| --- | --- |
| `apps/bot/src/music/ytdlp.ts` | finds (or downloads) yt-dlp, metadata via `-J`, audio via `-f … -o -`, and translates stderr into a human sentence |
| `apps/bot/src/music/audio.ts` | voice backend: `yt-dlp → ffmpeg → PCM → Opus` with volume, or `yt-dlp → Opus passthrough` on machines without ffmpeg |
| `scripts/setup-music.mjs` | `npm run music:setup` — pre-fetches yt-dlp into `.monarch/bin` |
| `scripts/music-doctor.mjs` | `npm run music:check [-- --probe]` — verifies yt-dlp, ffmpeg, Opus, DAVE, encryption, and reaches out to YouTube on demand |

No Java, no Lavalink, no Docker, and no second service. `apps/bot/src/index.ts`
probes the toolchain at boot; `/music` explains the fix instead of failing
silently. `music:local` / `music:up` / `music:logs` / `music:down` and the
Lavalink Docker service, `render.yaml` entry, `deploy/laptop-install.sh` units
and docs are gone (the pre-yt-dlp versions of those files were restored and
updated).

### 2. A live database credential was committed to the repository

`.env.example` — a *tracked* file — contained a real Neon connection string:

```
DATABASE_URL=postgresql://neondb_owner:npg_…@ep-curly-bonus-…aws.neon.tech/neondb…
```

It is present in `main` (`38489c0`), so it is in GitHub history and in every
clone and fork. Redacting the file (done here) does **not** unpublish it.

**Action needed:** rotate that database password in the Neon console
(*Project → Roles → Reset password*), then update `DATABASE_URL` wherever it is
set (Vercel/env files). Rotating is the only fix that matters; rewriting public
history is optional and disruptive. The same file previously carried
`SESSION_SECRET=dev-only-secret-change-me`; that one is a placeholder, not a
leak.

## Medium

| # | Finding | Fix |
| --- | --- | --- |
| 3 | `CONFESSION_COOLDOWN_MS` was **3 h** while the docs, `/monarch help` text and both test suites said **6 h** — two test files failed. | `packages/shared/src/confessions.ts` → 6 h; the slow integration assertions got explicit leeway instead of relying on wall-clock luck. |
| 4 | Root `npm run typecheck` ran `tsc --build --force`, but there is no root `tsconfig.json` — the script always printed an error before falling back. | Script now runs the workspace typechecks plus `packages/music`; `npm run typecheck` exits 0. |
| 5 | `npm run music:check` / `music:local` / `music:up` / `music:logs` / `music:down` pointed at files deleted with the Lavalink migration. | Replaced with `music:setup` + `music:check` (both new scripts). |
| 6 | `scripts/setup-music.mjs` used `await import` inside a non-async function: `npm run music:setup` died with a `SyntaxError` instead of downloading anything. | `createRequire` hoisted to module scope; the script reports yt-dlp/ffmpeg status and exits 0/1. |
| 7 | `.monarch/` — where a ~30 MB yt-dlp binary is downloaded — was not gitignored, and `apps/dashboard/tsconfig.tsbuildinfo` was tracked. | `.gitignore` covers `.monarch/` and `*.tsbuildinfo`; the stale build artifact was untracked. |
| 8 | On the Opus-passthrough path, a *failed download* was reported to the user as "install ffmpeg", and `createAudioResource` could surface prism-media's raw `FFmpeg/avconv not found!`. | yt-dlp's own failure is checked and reported first; resource creation is wrapped in `AudioError` with a readable message. |
| 9 | `apps/bot/package.json` still depended on `ws`, needed only by the deleted Lavalink client. | Removed (no imports remained). |
| 10 | `ytdlpBinDir()` ignored `MONARCH_BIN_DIR` while the ffmpeg resolver honoured it — one variable couldn't move both binaries. | `MONARCH_BIN_DIR` is now the shared override. |
| 11 | `docker/docker-compose.yml` `env_file: ../.env` fails on a fresh clone with no `.env`. | `required: false` on every service. |
| 12 | `MUSIC_AUDIO_PIPELINE` (pcm/opus) was described in no code and `YTDLP_FORMAT` was not overridable, so an operator with no ffmpeg had no supported way to steer the pipeline. | Both are implemented and documented. |
| 13 | `docs/troubleshooting-music.md`, `docs/hosting-laptop.md`, `README.md`, `agent.md` and `.env.example` described the Lavalink architecture — every "fix" they offered was wrong for this code. | Rewritten for the yt-dlp stack, including a symptom → cause → fix table. |

## Minor

| # | Finding | Fix |
| --- | --- | --- |
| 14 | HTTP 403/404 from a source were reported as "network problem or a blocked IP". | Dedicated messages (dead link, refused/blocked download → cookies). |
| 15 | The bot's boot hint said "set `YTDLP_AUTO_DOWNLOAD=1` to let the bot fetch the binary" — 1 is already the default, so the advice did nothing. | Reworded; the boot log now prints the pipeline the backend will actually use. |
| 16 | `apps/bot/test/music-fakes.ts` still used the pre-refactor one-argument `join(target)` signature, so two tests asserted `[undefined, undefined]`. | Fake updated to `join(guildId, channel)`; regressions in the suite are visible again. |
| 17 | `agent.md` documented `volumeToGain`, which the code no longer exports (`volumeGain`), and described the removed InnerTube/`youtubei.js` path. | Music section rewritten around the current modules. |
| 18 | `npm audit --omit=dev`: 6 advisories (5 high, 1 moderate) — `postcss` bundled inside `next`, plus `mysql2`/`deepmerge-ts` pulled in by the Prisma **CLI**. | Left as-is deliberately: the offered fix is a *downgrade* of Prisma 7 → 6 and a major Next 15 → 16 jump. Neither is reachable from runtime code here (Prisma CLI is dev-time and Monarch speaks Postgres, not MySQL; the postcss issues require attacker-authored CSS). Worth doing as a planned dependency bump, not as a hotfix. |

## Follow-up: will YouTube throttle the new player?

This was the reason the old stack carried a `⚠️ Track cut short` message at all
(a track that starts fine and stops ~1 minute in). yt-dlp is far better at this
than the removed InnerTube path was, and three defences were added or confirmed:

| Defence | What it does |
| --- | --- |
| `--http-chunk-size 16384` (new) | YouTube throttles a *connection*, not an account: one long download starts fast, then crawls. Requesting 16 KiB ranges turns it into many short requests that each come back at full speed. Verified byte-identical on the stdout path, and harmless for servers without range support. |
| `--js-runtimes node:<this node>` (new, capability-detected) | yt-dlp needs a JS runtime to solve the `n`/signature challenge; only Deno is enabled by default and this is a Node process. An unsolved challenge is exactly what YouTube rate-limits. Detected from the binary's `--help`, overridable (`YTDLP_JS_RUNTIME=deno|none`), skipped for old builds. |
| `--retries 5`, `--fragment-retries 5` (verified) | yt-dlp resumes a *stdout* download from the byte it last wrote (`ctx.resume_len = byte_counter`), so an interruption reopens a range request instead of starting over or duplicating audio. |
| One silent retry for a track that dies within 6 s (new) | Transient extractor/403 hiccups ("try again and it works") no longer surface as a failed track: `audio.ts` restarts it once, without telling the queue. Permanent reasons (private, removed, region-locked, live, no bot-cookies) are never retried. |

Not enabled by default: `--throttled-rate`, which re-extracts whenever the
stream drops below a threshold. On a genuinely slow link that hurts more than
it helps, and on the stdout path a re-extract restarts the stream — so it is
documented as `YTDLP_ARGS=--throttled-rate 100K` for machines that are
consistently throttled (a datacenter IP), not switched on for everyone.

Live YouTube could not be reached from the build sandbox, so throttling itself
was verified by construction and by unit tests, not by playing a real video
from a throttled IP.

## Verified clean (looked at, no bug found)

- Internal bot → dashboard auth: constant-time SHA-256 comparison, 503 when the
  token is unset (`apps/dashboard/lib/internal-auth.ts`).
- Every browser-facing `POST`/`PUT`/`PATCH`/`DELETE` route calls
  `assertSameOrigin`; the `/api/internal/*` routes authenticate by bearer token
  instead (correct — the bot has no origin).
- `JSON.parse` call sites are guarded (template import, file store, yt-dlp
  metadata), no `TODO`/`FIXME` markers, no floating promises in event handlers.

## How this was verified

- `npx vitest run` — **40 files / 562 tests pass** (the deleted Lavalink suite
  accounted for the previous 41/586).
- `npm run typecheck` — bot, dashboard and `packages/music` all clean.
- `npm run music:check` and `npm run music:setup` exercised for real.
- Audio path exercised end to end against a local audio file, without Discord:
  `yt-dlp → ffmpeg → PCM → volume → Opus` produced 150 packets; the passthrough
  path (`demuxProbe → webm/opus`) produced 150 packets and correctly reported
  volume as unavailable. Live YouTube could not be reached from the build
  sandbox (TLS-blocked), which is also why the doctor's `--probe` failure path
  was checked instead.
