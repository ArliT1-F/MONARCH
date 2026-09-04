# Deploying Monarch to Vercel (+ PostgreSQL via Prisma)

The dashboard is a Next.js app and deploys cleanly to Vercel. The **bot**
keeps a live Discord gateway connection and must run somewhere long-lived
(the provided Docker Compose stack, a VM, or a container platform) — never
on serverless.

```
┌────────────┐   HTTPS    ┌──────────────────────┐   pooled PG wire
│  browser   │ ─────────▶ │  Vercel              │ ────────────────┐
└────────────┘            │  apps/dashboard      │                 ▼
                          │  (Next.js + Prisma)  │        ┌───────────────┐
┌────────────┐  gateway   └──────────────────────┘        │ PostgreSQL     │
│  bot       │ ─────────▶ Discord                 ◀────── │ (Neon / Vercel │
└────────────┘            (docker/VPS, not Vercel)  direct │  Postgres/…)   │
                                                  (migrate)└───────────────┘
```

## What's already wired up in this repo

| Piece | Where | Notes |
|---|---|---|
| Prisma schema (9 models) | `prisma/schema.prisma` | Prisma 7, `prisma-client` generator, output `apps/dashboard/lib/generated/prisma` (gitignored) |
| CLI config | `prisma.config.ts` | Holds `DATABASE_URL` / `DIRECT_DATABASE_URL` for migrate (URLs no longer live in the schema) |
| Initial migration | `prisma/migrations/20260902000000_init/` | Applied via `npm run db:migrate` |
| Client generation | root `package.json` → `postinstall: prisma generate` | Runs on every `npm install` (local, Docker, Vercel) |
| Runtime client | `apps/dashboard/lib/prisma.ts` | Engine-free client + `@prisma/adapter-pg`, `max: 1` per serverless instance, globalThis-cached across HMR |
| Store swap | `apps/dashboard/lib/store.ts` `getStore()` | `DATABASE_URL` set → `PrismaStore`; unset → file store (demo/dev) |
| Token encryption | `apps/dashboard/lib/secure-token.ts` | OAuth tokens AES-256-GCM encrypted at rest (`Session.accessTokenEnc`) |
| Next config | `apps/dashboard/next.config.ts` | `serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"]` |
| Vercel build | `apps/dashboard/vercel.json` | `prisma generate && next build` |
| Tests | `apps/dashboard/test/prisma-store*.ts` | Full store contract verified against real Postgres (PGlite) |

The Prisma 7 client ships **no Rust engine binaries** — the query compiler
is WASM inside `@prisma/client` and connections go through the `pg` driver
adapter. That keeps Vercel cold starts small and avoids engine tracing
issues entirely.

## 1. Create the database

Use any Postgres that offers a pooled connection string (recommended for
serverless): **Neon**, **Vercel Postgres**, or Supabase. You need **two**
URLs from the provider dashboard:

- **Pooled URL** (through pgbouncer / the HTTP-pool proxy) — used by the
  running dashboard. Neon: the `-pooler` host. Vercel Postgres: the
  `?pgbouncer=true` string.
- **Direct URL** (no pooler) — used by migrations. Neon: host without
  `-pooler`. Vercel Postgres: same string minus `pgbouncer` params.

Local dev against plain Postgres (Docker Compose) only needs one URL —
set both variables to the same value.

### Neon ✓ (recommended for this app)

1. Create a Neon project and a database (e.g. `monarch`).
2. In **Dashboard → Connect**, Neon shows two connection strings:
   - **Pooled** (host contains `-pooler`) and usually labelled
     `DATABASE_URL` / `POSTGRES_URL` / **Recommended for most uses**.
   - **Direct** (host has no `-pooler`) and usually labelled
     `DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING`.
3. Map Neon's names to this repo's names:

   ```text
   DATABASE_URL        = Neon "pooled / POSTGRES_URL"  (−pooler host)
   DIRECT_DATABASE_URL = Neon "DATABASE_URL_UNPOOLED / POSTGRES_URL_NON_POOLING"
   ```

   Example shape:

   ```text
   DATABASE_URL=postgresql://<user>:<password>@<project>-pooler-01.region.aws.neon.tech/monarch?sslmode=require
   DIRECT_DATABASE_URL=postgresql://<user>:<password>@<project>-01.region.aws.neon.tech/monarch?sslmode=require
   ```

   Neon's pooled URL may include `channel_binding=require` (e.g.
   `?channel_binding=require&sslmode=require`). Keep it if the `pg` adapter
   connects fine; if you see a `channel_binding` / SCRAM error locally or on
   Vercel, strip `channel_binding=require` and keep `sslmode=require`.

4. Run the migration with both URLs (step 2 below), then put only the
   **pooled** `DATABASE_URL` into Vercel.

### Neon + Vercel Postgres template

If you connected Vercel to Neon via the **Neon Postgres** integration,
Vercel injects `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, etc. This app
does **not** read those names — it expects `DATABASE_URL` /
`DIRECT_DATABASE_URL`. Either set those explicitly in Vercel, or map them
when running scripts locally:

```bash
DATABASE_URL="$POSTGRES_URL" DIRECT_DATABASE_URL="$POSTGRES_URL_NON_POOLING" npm run db:migrate
```

## 2. Run migrations

From your machine (or CI), once:

```bash
DATABASE_URL="<pooled>" DIRECT_DATABASE_URL="<direct>" npm run db:migrate
```

`prisma migrate deploy` is idempotent and safe to re-run; it applies any
new committed migrations. (Migrations are a deploy-time concern — don't run
them from serverless functions.)

<details>
<summary>Optional: run migrations from GitHub Actions</summary>

```yaml
# .github/workflows/migrate.yml
name: migrate
on: { workflow_dispatch: {} }   # run manually
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run db:migrate
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}          # pooled
          DIRECT_DATABASE_URL: ${{ secrets.DIRECT_DATABASE_URL }}  # direct
```

</details>

## 3. Import the project on Vercel

1. Push the repo to GitHub, then **Add New → Project** on Vercel.
2. Keep the preset; set **Root Directory** to `apps/dashboard`
   (Vercel auto-detects the npm-workspaces monorepo and still installs
   from the repo root, which triggers `prisma generate` via postinstall).
3. Framework preset **Next.js**, build command comes from
   `apps/dashboard/vercel.json`: `npx prisma generate --schema
   ../../prisma/schema.prisma && next build`.
4. Add environment variables (Production + Preview):

| Variable | Value |
|---|---|
| `DATABASE_URL` | **pooled** connection string |
| `SESSION_SECRET` | `openssl rand -hex 32` — signs cookies **and** encrypts OAuth tokens at rest |
| `APP_URL` | `https://<your-app>.vercel.app` |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_BOT_TOKEN` | from the Discord developer portal (omit all three for **demo mode**) |

5. Deploy.

> `DIRECT_DATABASE_URL` is **not** needed on Vercel — nothing serverless
> runs migrations.

## 4. Run the bot beside Vercel (required for slash commands)

Vercel cannot keep a Discord Gateway connection alive: its functions are
short-lived and may be frozen between requests. Therefore do **not** try to
start `apps/bot` from a Vercel build command or API route. Run the dashboard
on Vercel and the bot as one long-lived worker on Render, Railway, Fly.io, a
VM, or Docker. This repository includes a ready-to-use `render.yaml` for the
Render worker.

### Render worker (recommended quick setup)

1. Create a new Render Blueprint connected to this repository. Render detects
   `render.yaml` and creates `monarch-bot`.
2. Set `DISCORD_BOT_TOKEN` to the **same token** used by the Vercel dashboard
   and set `APP_URL` to the exact Vercel URL, for example
   `https://monarch.vercel.app`.
3. Deploy and check the worker logs for `bot ready`. Keep exactly one worker
   running; two Gateway sessions with the same bot token can disconnect each
   other.

The dashboard and worker are not separate copies of the Discord state. The
Vercel API uses Discord REST with that same bot token, while the worker owns
the Gateway connection for slash commands. Discord is the source of truth,
so an apply from the dashboard is immediately visible to the bot and to
Discord. `DATABASE_URL` is still required on Vercel for dashboard sessions,
drafts, and audit data; it is not a substitute for the Gateway worker.

For another provider, run the equivalent long-lived command from the repo
root:

```bash
npm ci
npm run start --workspace @monarch/bot
```

Set `DISCORD_BOT_TOKEN` and `APP_URL` in that worker's environment. Never
put the bot token in browser-exposed `NEXT_PUBLIC_*` variables.

## 5. Point Discord at the deployment

In the Discord developer portal add
`https://<your-app>.vercel.app/api/auth/callback` as an OAuth2 redirect,
matching `APP_URL` exactly. Then sign in, pick a server (the bot must be
installed with *Manage Channels*), and design away.

## Notes & troubleshooting

- **Demo mode on Vercel:** with no Discord credentials the dashboard runs
  the mock gateway; its state persists through `PrismaStore`
  (`MockDiscordState` table), so seeded guilds survive cold starts.
- **`Error: ENOENT ... mkdir '/var/task/.monarch-data'`** (or a `500`
  with `oauth callback storage failed`) → `DATABASE_URL` is not set where
  the function runs, so `getStore()` falls back to the JSON file store.
  That store writes to the Lambda filesystem, which is read-only on Vercel.
  Put the **pooled** `DATABASE_URL` in **both Production and Preview** in
  the Vercel project settings, run the migration (step 2), then redeploy.
- **`Sign-in session expired. Please try again.`** at the OAuth callback →
  the `monarch_oauth_state` cookie wasn't sent (or didn't match). The usual
  causes are `APP_URL` pointing at a different domain than the page you
  clicked from, a redirect URI not matching `APP_URL` in the Discord app,
  or the state cookie expiring before Discord returned. Make `APP_URL` and
  the Discord OAuth redirect match exactly, use the same domain for login
  and callback, and reopen Discord sign-in from the same site.
- **`P1003: Table does not exist`** → migrations weren't applied; re-run
  step 2.
- **`P1001: Can't reach database`** → check `DATABASE_URL` in the Vercel
  project (Production environment) and the provider's availability.
- **Rotating `SESSION_SECRET`** invalidates cookie signatures *and*
  renders stored OAuth tokens undecryptable (they are treated as absent —
  users just sign in again). Rotate deliberately.
- **Connection limits:** each serverless instance holds at most **one**
  backend connection (`max: 1` in `lib/prisma.ts`). Use the pooled URL;
  the direct URL is for migrations only.
- **Schema changes:** edit `prisma/schema.prisma`, run
  `npm run db:dev` (creates + applies a migration locally), commit the new
  `prisma/migrations/*` folder, then `npm run db:migrate` against
  production and deploy. Keep `lib/store.ts` records and the schema in
  sync (see the note at the top of the schema file).
- **Local dev with Postgres:** `cd docker && docker compose up` boots
  Postgres, applies migrations, and runs the dashboard + bot; or set
  `DATABASE_URL` in `apps/dashboard/.env.local` and `npm run dev`.
