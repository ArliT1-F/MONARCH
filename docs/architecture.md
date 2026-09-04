# Monarch Architecture

> Monarch — Design your Discord. A visual design studio for Discord servers.
> The dashboard is the product; the Discord bot is the integration layer.

## Current status (Phase 1 + Phase 2 complete)

Implemented: monorepo, auth (Discord OAuth2 + demo mode), server selection,
**Server Designer** (drafts, drag-and-drop, undo/redo, validation, diff
preview, apply), snapshots on apply, designated channels (Target Resolver)
with Send Test, structured logging, unit tests for the engines.

Features 2–10 of the product spec are represented as phase-labelled
placeholders in the navigation; their shared infrastructure (schemas,
validation, diff engine, renderer, target resolver, variables) already exists
and must be reused — do not fork per-feature copies.

## Monorepo layout

```
monarch/
├── apps/
│   ├── dashboard/        Next.js app — UI + API route handlers
│   └── bot/              discord.js bot (lightweight: links & quick actions)
├── packages/
│   ├── shared/           Result/errors, logger, permissions, variables, ids
│   ├── schemas/          zod: ServerDesign, targets, template envelope, guild
│   ├── validation/       validation engine + Discord limits (single source)
│   ├── design-engine/    diff engine, apply planner, template detachment
│   ├── renderer/         internal model ⇄ Discord API payloads
│   └── discord/          DiscordGateway abstraction + REST/Mock impls,
│                         target resolver, apply executor, error translation
├── prisma/               PostgreSQL schema (production persistence target)
├── docker/               compose + Dockerfiles (dashboard, bot, postgres)
└── docs/
```

Packages are consumed as TypeScript source (`transpilePackages` in Next,
`tsx` in the bot, vitest natively) — no build orchestration needed yet.

## Data flow (the mandatory pipeline)

```
Dashboard (client)
   ↓ edits
Internal Design Schema (@monarch/schemas ServerDesign)
   ↓
Validation Engine (@monarch/validation)      ← same rules client & server
   ↓
Diff Engine (@monarch/design-engine)         ← diff against LIVE state
   ↓ ApplyPlan (creates → renames/modifies → moves → deletes)
Apply Executor (@monarch/discord)            ← resolves new_* ids, stops on error
   ↓
DiscordGateway (Rest | Mock)
   ↓
Discord API v10
```

Rules that must not be violated:

- **Raw Discord JSON is never the internal model.** Conversion happens only
  in `@monarch/renderer` (outbound) and the gateways (inbound).
- **Nothing mutates Discord while editing.** Only `POST /api/guilds/:id/apply`
  mutates structure, after validation + fresh diff + destructive confirmation.
- **The diff engine is shared** by designer, restore, clone, import, templates.
- **Limits live in `@monarch/validation` `DiscordLimits`** — never inline.
- **Ids:** entities that exist on Discord carry snowflakes; new entities carry
  `new_*` local ids (`@monarch/shared` ids.ts). The diff engine keys on this.

## DiscordGateway abstraction

`DiscordGateway` (packages/discord/src/gateway.ts) is the seam between
Monarch and Discord:

- `RestDiscordGateway` — @discordjs/rest with the bot token. Rate limiting &
  retries are delegated to the library (never hardcoded).
- `MockDiscordGateway` — in-memory guilds implementing the same contract,
  used for **demo mode** and unit tests. Mutations actually work, so the
  full design → diff → apply loop runs without credentials.

Demo mode is active when Discord credentials are missing or `MONARCH_DEMO=1`.
The UI labels it; `/api/auth/login` creates a demo session instead of OAuth.

## Target Resolver

Publishing features never guess a channel. `resolveTarget()` takes a
`TargetConfig` — either `{kind:"designated", key}` (global designated
channels stored per guild) or `{kind:"explicit", guildId, channelId}` — and
performs existence, channel-kind, cross-guild and bot-permission checks
before returning a channel. "Send Test" on the Designated Channels page and
`POST /api/guilds/:id/test-message` demonstrate the pattern.

Discord interactions (slash commands) always reply in their own interaction
context — the resolver is only for generated/published content.

## Persistence

Routes depend on the `MonarchStore` interface
(apps/dashboard/lib/store.ts): sessions, drafts, snapshots, guild settings,
audit entries, demo mock state. Two implementations sit behind it:

- **PrismaStore** (apps/dashboard/lib/prisma-store.ts) — PostgreSQL via
  Prisma 7 (engine-free client + `@prisma/adapter-pg`). Active whenever
  `DATABASE_URL` is set; this is the production backend and what runs on
  Vercel (see docs/deploying-vercel.md). OAuth tokens are encrypted at
  rest with AES-256-GCM (lib/secure-token.ts, key derived from
  `SESSION_SECRET`). The swap is confined to `getStore()`.
- **FileStore** — JSON files under `.monarch-data/` (gitignored) when no
  `DATABASE_URL` is configured. Development/demo only.

Session cookies already carry only an HMAC-signed opaque id — tokens never
reach the browser. The initial migration lives in `prisma/migrations/`
(`npm run db:migrate`); the store contract is covered by tests that run
against real PostgreSQL (apps/dashboard/test/prisma-store.integration.test.ts).

## Security model

- Backend guards on every route: session → guild access → user `Manage
  Server`/`Administrator` → bot installed → bot `Manage Channels` (for apply).
  Frontend disabling is cosmetic only.
- CSRF: mutating routes reject cross-site requests via `Sec-Fetch-Site`.
- Secrets only via env; logger redacts token/secret-shaped keys.
- Raw Discord errors are translated to human-readable Monarch errors
  (packages/discord/src/errors.ts); raw payloads go to logs only.

## API surface (dashboard route handlers)

| Route | Purpose |
|---|---|
| `GET/POST /api/auth/*` | OAuth2 login/callback/logout (demo-aware) |
| `GET /api/invite[?guild_id=]` | Redirect to Discord's bot install dialog (demo-aware) |
| `GET /api/guilds` | Guild summaries (installed, permissions, members) |
| `GET /api/guilds/:id/state` | Live structure + caller's draft |
| `PUT/DELETE /api/guilds/:id/draft` | Autosave / discard draft |
| `POST /api/guilds/:id/plan` | Validation + diff vs live state (read-only) |
| `POST /api/guilds/:id/apply` | The only structural mutation (snapshot → execute → audit) |
| `GET /api/guilds/:id/snapshots` | Version history metadata |
| `GET/PUT /api/guilds/:id/settings` | Designated channels |
| `POST /api/guilds/:id/test-message` | Send Test through the Target Resolver |

The API currently lives in Next.js route handlers; all business logic is in
packages, so extracting a standalone `apps/api` service later is mechanical
(spec §3 allows this order).

## Undo/redo & drafts

Designer state is a pure reducer (components/designer/designer-state.ts)
with immutable past/future stacks (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y). Drag
operations snapshot once at drag start so a whole drag is one undo step.
Drafts autosave (debounced) per user+guild and survive reloads; applying
clears the draft and rebases the editor onto fresh live state.

## Testing

`npm test` (vitest at repo root):

- design-engine: diff semantics, apply-plan ordering, template detachment
- validation: limits, normalization warnings, referential integrity
- discord: target resolver rules; full apply-loop integration against the
  mock gateway (including local-id parent resolution and re-diff = empty)
- schemas: template envelope versioning; variable system

## Adding the next features (guidance)

1. Model in `@monarch/schemas` (extend, don't fork).
2. Limits/rules in `@monarch/validation`.
3. Discord payloads in `@monarch/renderer`; new capabilities on
   `DiscordGateway` (implement in BOTH gateways).
4. Reuse the diff engine + Review modal pattern for anything that mutates.
5. Publishing features must accept a `TargetConfig`.
6. Register the nav entry in components/nav/SidebarNav.tsx.

Explicit product boundary: **no moderation features** (spec §32).
