# Monarch

**Monarch — Design your Discord.**

A visual design and customization studio for Discord servers. Connect
Discord, pick a server, redesign it visually, preview the exact diff, and
apply it — with drafts, undo/redo, validation and snapshots along the way.
Monarch is not a moderation bot and will not become one.

```
Draft → Preview → Validate → Diff → Confirm → Apply
```

## What works today (MVP: Phase 1 + 2)

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

Embed Builder, Message/Component Designer, Role Designer, Welcome Designer,
Branding, Templates, Backups, Analyzer and Import/Export are phased next —
see [docs/architecture.md](docs/architecture.md).

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
   `Manage Channels`, `Manage Roles`, `Manage Webhooks`, `View Channel`,
   `Send Messages`, `Embed Links`, `Attach Files`. Never Administrator.
4. `npm run dev` — then `npm run dev:bot` in another terminal for slash
   commands (`/monarch dashboard`).

Docker (dashboard + bot + PostgreSQL):

```bash
cd docker && docker compose up --build
```

Deploying to **Vercel + Postgres (Prisma)** — see
[docs/deploying-vercel.md](docs/deploying-vercel.md). Set `DATABASE_URL`
(anywhere: Vercel, Docker, local) and Monarch swaps its file store for the
PostgreSQL-backed `PrismaStore` automatically; migrations ship in
`prisma/migrations/` and apply with `npm run db:migrate`.

## Repository layout

```
apps/dashboard    Next.js studio (UI + API routes)
apps/bot          Lightweight discord.js bot (dashboard links, status)
packages/*        shared · schemas · validation · design-engine · renderer · discord
prisma/           PostgreSQL schema (production persistence target)
docker/           Compose + Dockerfiles
docs/             Architecture & decisions
```

## Principles

- Preview first → validate → diff → confirm → apply. Never blind writes.
- The internal design schema — not raw Discord JSON — is the source of truth.
- Everything Discord-specific sits behind the `DiscordGateway` abstraction.
- Errors are for humans; raw API errors stay in logs.
- What Discord's API can't do, Monarch says it can't do.
