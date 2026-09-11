# Monarch

**Monarch — Design your Discord.**

A visual design and customization studio for Discord servers. Connect
Discord, pick a server, redesign it visually, preview the exact diff, and
apply it — with drafts, undo/redo, validation and snapshots along the way.
Monarch is not a moderation bot and will not become one.

```
Draft → Preview → Validate → Diff → Confirm → Apply
```

## What works today (Phase 1–4 + Backups & Templates)

- 🔐 Discord OAuth2 sign-in (or zero-config **demo mode** with mock servers)
- 🏰 Server selection with install/permission awareness
- ➕ One-click **bot invite** from the web UI (per-server, least-privilege)
- 🎨 **Server Designer** — categories & channels, drag-and-drop, inline
  properties, duplicate/delete, undo/redo (Ctrl+Z / Ctrl+Shift+Z)
- 💾 Per-user drafts with autosave; Discord is never touched while editing
- ✅ Centralized validation with human-readable errors and fixes
- ± Diff preview against live state; deletions require explicit confirmation
- 📸 Automatic before/after snapshots and an audit trail on every apply
- 🎯 Designated channels + Target Resolver with "Send Test" (never #general)
- 📦 **Embed Builder** (Phase 3) — three-panel visual editor with a
  pixel-faithful Discord preview, {variable} support, validation, autosave,
  Send Test and Publish through the Target Resolver
- 💬 **Message Designer** (Phase 4) — full messages as content + embeds +
  link buttons with live preview, validation, autosave, Send Test and Publish
- 🗄️ **Backups & History** — save a snapshot any time (dashboard or
  `/monarch backup`) and **restore** any snapshot: it loads into the Server
  Designer as a draft, deleted channels come back as creates, channels added
  since show as deletes, renames revert — reviewed and applied like any change
- 📤 **Templates · Import / Export** — download the layout as a portable
  `monarch-template` JSON (no snowflakes, no server-specific settings) and
  import it into any server, either *added under* the existing structure or
  *replacing* it, always with the full diff preview first
- 👑 **Role Designer (Phase 5)** — rename, recolor, hoist, mentionable,
  position and a curated permission grid for every non-managed role, through
  the same draft → diff → apply pipeline
- 📚 **Template Library (FEATURE 7)** — your saved layouts, independent of
  any server: save the live structure as a template, upload `monarch-template`
  files, rename / duplicate / download them, and install any of them into a
  server in one click (still via the diff-first import pipeline)
- 🩺 **Design Analyzer (FEATURE 9)** — a deterministic 0–100 design score
  (organization · naming · role consistency · branding) with concrete,
  human-readable suggestions, "mark as intentional" per check, and a
  Markdown report export. Read-only: it never changes your server
- 📱 **Mobile-friendly dashboard** — collapsible navigation drawer, one-pane
  designer/builder views with tabs, touch drag-and-drop
- 📚 **Help & Commands page** — every command with options, examples,
  permissions and requirements, searchable, at `/s/<server>/help` (the same
  catalog `/monarch help` renders in Discord — one source of truth)
- 🎵 **Music player** — YouTube videos *and* playlists, Spotify tracks,
  albums and playlists, plus plain search. Per-server queue with
  pause / resume / stop / volume / loop / shuffle / remove / clear,
  now-playing progress, and a skip system: **DJ, Moderator/Staff and the
  requester skip instantly; everyone else votes** and a majority of the
  listeners passes it
- 🤖 Slash commands (the full manual lives at **Help → Commands & Help** in
  the dashboard; `/monarch help` shows the short version):

  | Command | What it does | Who |
  | --- | --- | --- |
  | `/monarch help` | List every command | everyone |
  | `/monarch dashboard` · `/monarch status` | Dashboard link / status | everyone |
  | `/monarch backup [name]` | Snapshot the server structure | Manage Server / Admin |
  | `/monarch export` | Post the layout as a `.json` template file | Manage Server / Admin |
  | `/monarch embed` · `/monarch test` | Embed Builder link · test/publish the saved design | Manage Server / Admin |
  | `/monarch jail @user [duration] [reason]` | Delete everything the user posts and re-post it in the **Standard Galactic Alphabet** (the Minecraft enchanting script) under their name and avatar. No duration = until `/monarch unjail`; `10m`, `2h`, `1d`, `1h30m` auto-release | Administrator or Kick Members |
  | `/monarch unjail @user` · `/monarch jailed` | Release early · list jailed members | Administrator or Kick Members |
  | `/music play <link or search>` | Play/queue YouTube & Spotify tracks, playlists and albums | everyone in voice |
  | `/music pause` · `/music resume` · `/music stop` | Pause · resume · stop + clear + leave | everyone in the bot's channel |
  | `/music skip` | Skip — instantly with a **DJ** or **Moderator/Staff** role (or if it's your song), otherwise by listener vote | everyone |
  | `/music queue [page]` · `/music nowplaying` | Show the queue · now playing with progress | everyone |
  | `/music volume [0-150]` · `/music loop [off\|track\|queue]` · `/music shuffle` · `/music remove <#>` · `/music clear` | Playback controls | everyone in the bot's channel |
  `backup`, `export`, `embed` and `test` need `INTERNAL_API_TOKEN` set in
  both the dashboard and the bot. The jail needs the **Message Content**
  privileged intent (see below) and the **Manage Messages** permission.
  Spotify links need `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` on the
  bot (free app at developer.spotify.com — see `.env.example`); YouTube
  links and search work out of the box. Playback needs **ffmpeg** — the
  Docker image ships it, and local installs fall back to the bundled
  `@ffmpeg-installer/ffmpeg`. DJ roles are recognized by name (`DJ` by
  default; `MUSIC_DJ_ROLE_NAMES`, staff roles via `MUSIC_STAFF_ROLE_NAMES`).

Welcome Designer and Branding Studio are phased next — see
[docs/architecture.md](docs/architecture.md).

## Quick start (demo mode — no Discord app needed)

```bash
npm install
npm run dev          # dashboard on http://localhost:3000
npm test             # engine unit tests
```

Without Discord credentials Monarch boots in demo mode: a mock Discord
gateway with seeded servers where the entire design → diff → apply loop
actually executes.

## Running against real Discord

1. Create an application at https://discord.com/developers, add a bot, and
   set the OAuth2 redirect to `{APP_URL}/api/auth/callback`.
2. Copy `.env.example` → `apps/dashboard/.env.local` and fill in
   `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
   `SESSION_SECRET`.
3. Invite the bot from the dashboard: **Add Monarch to Discord** on the
   landing page, or **Invite Monarch** next to any server on the select
   screen (that one pre-selects the server). The link is built server-side by
   `GET /api/invite` and requests only the permissions Monarch uses —
   `Manage Channels`, `Manage Roles`, `Manage Webhooks`, `Manage Messages`
   (jail), `View Channel`, `Send Messages`, `Send Messages in Threads`,
   `Embed Links`, `Attach Files`. Never Administrator. If Monarch was
   installed before `Manage Messages` was added, re-run the invite link or
   grant it in Server Settings → Roles.
4. In the developer portal, under **Bot → Privileged Gateway Intents**,
   enable **Message Content**. The jail relay needs it to read messages; if
   it is off the bot still starts (Guilds-only) and `/monarch jail` explains
   what is missing. Free below 100 servers; Discord verification above.
5. `npm run dev` — then `npm run dev:bot` in another terminal for slash
   commands.

   `/monarch backup`, `/monarch export`, `/monarch embed` and `/monarch test`
   call the dashboard's `/api/internal/*` routes — set the same
   `INTERNAL_API_TOKEN` in both environments. `/monarch dashboard`, `help`,
    `status` and all of `/music` work without it.

   The bot also needs the **Server Voice States** intent for `/music`
   (not privileged — on by default). For Spotify links set
   `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`; DJ and staff skip roles
   are tuned with `MUSIC_DJ_ROLE_NAMES` / `MUSIC_STAFF_ROLE_NAMES`. See
   `.env.example` for the full list.

Docker (dashboard + bot + PostgreSQL):

```bash
cd docker && docker compose up --build
```

Deploying to **Vercel + Postgres (Prisma)** — see
[docs/deploying-vercel.md](docs/deploying-vercel.md). Vercel runs the dashboard;
the Discord Gateway bot must run as a long-lived worker (Render, Railway,
Fly.io, a VM, or Docker). Set the same `DISCORD_BOT_TOKEN` and `APP_URL` in
both services so slash commands and dashboard changes stay online together.
Set `DISCORD_CLIENT_ID` on the worker so it can register `/monarch` and
`/music`; optionally set `DISCORD_GUILD_ID` while testing for immediate
slash-command updates (global Discord commands can take up to an hour to
propagate). `render.yaml` is ready for a Render worker. Set `DATABASE_URL`
(anywhere:
Vercel, Docker, local) and Monarch swaps its file store for the PostgreSQL-
backed `PrismaStore` automatically; migrations ship in `prisma/migrations/`
and apply with `npm run db:migrate`.

## Repository layout

```
apps/dashboard    Next.js studio (UI + API routes)
apps/bot          discord.js bot (dashboard links, status, jail, music player)
packages/*        shared · schemas · validation · design-engine · renderer · discord · music
prisma/           PostgreSQL schema (production persistence target)
docker/           Compose + Dockerfiles
docs/             Architecture & decisions
```

The music player is split the same way as everything else:
`packages/music` is a pure engine (queue ordering, loop modes, skip
elections, source-URL classification, role policy — fully unit-tested) and
`apps/bot/src/music` is the adapter (voice connection, YouTube via
youtubei.js, Spotify via the Web API, Discord embeds).

## Principles

- Preview first → validate → diff → confirm → apply. Never blind writes.
- The internal design schema — not raw Discord JSON — is the source of truth.
- Everything Discord-specific sits behind the `DiscordGateway` abstraction.
- Errors are for humans; raw API errors stay in logs.
- What Discord's API can't do, Monarch says it can't do.
