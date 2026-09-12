# Monarch Architecture

> Monarch — Design your Discord. A visual design studio for Discord servers.
> The dashboard is the product; the Discord bot is the integration layer.

## Current status (Phase 1–4 + Backups, Templates, mobile)

Implemented: monorepo, auth (Discord OAuth2 + demo mode), server selection,
**Server Designer** (drafts, drag-and-drop, undo/redo, validation, diff
preview, apply), snapshots on apply, designated channels (Target Resolver)
with Send Test, **Embed Builder** (Phase 3) and **Message Designer**
(Phase 4) — both with live preview, {variables}, validation, autosaved
per-guild workspaces, Send Test / Publish through the Target Resolver, audit
entries — plus **Backups & Restore**, **Templates (Import / Export)**, a
responsive/mobile dashboard shell, and the bot's `help`, `backup`, `export`,
`jail`/`unjail`/`jailed` and the standalone `/burg` slash command — every one
of which also answers as a **prefix (text) command** (`!help`, `!play`,
`@Monarch status`) with a per-server prefix set by `!prefix set ?`.

Role Designer, Welcome Designer, Branding and Analyzer are represented as
phase-labelled placeholders in the navigation; their shared infrastructure
(schemas, validation, diff engine, renderer, target resolver, variables)
already exists and must be reused — do not fork per-feature copies.

## Backups, restore, templates

All four flows share one module, `apps/dashboard/lib/backups.ts`, used by
both the user-facing routes and the bot-facing `/api/internal/*` routes:

- **Backup** = `fetchCurrentDesign` → `SnapshotRecord{kind:"manual"}` +
  audit entry. Apply still records `pre-apply` / `post-apply` snapshots.
- **Restore never touches Discord directly.** It stages the snapshot as the
  caller's *draft* (`putDraft`) and sends them to the Server Designer, so the
  normal validate → diff → confirm-destructive → apply pipeline runs. Before
  staging, `rebaseDesign` (@monarch/design-engine `compose.ts`) makes the
  snapshot applicable on top of the live server: ids that still exist are
  kept (modify/rename/move), ids that vanished are *adopted* onto a live
  entity of the same kind + name when one exists (so history isn't lost by a
  delete-and-recreate), and whatever is left becomes a `new_*` local id — a
  plain create — with parent links rewritten. Roles and designated channels
  always come from the live server.
- **Export** = `detachDesign` → `TemplateEnvelope` (`format:
  "monarch-template"`, `version: 1`). **Import** parses with
  `parseServerTemplate`, forces every id to a local id (`localiseIds`, so a
  hand-edited file can't "modify" an unrelated live channel), then either
  appends under the current structure (`mergeDesigns`, "add") or replaces
  categories/channels wholesale ("replace"), validates, and stages a draft.

## Jail (bot-side moderation gag)

`/monarch jail @user [duration]` is the one feature the bot runs on its own,
because it needs live `messageCreate` events. State is an in-memory
`JailRegistry` (apps/bot/src/jail.ts) with per-entry timers — a restart
releases everyone, by design (no bot database access). The relay deletes the
original and re-posts it through a per-channel webhook named "Monarch Jail"
using the member's display name and avatar, with the text transliterated to
the Standard Galactic Alphabet (apps/bot/src/galactic.ts; mentions, custom
emoji, timestamps, links and code spans are preserved so formatting can't be
broken or bypassed). Requires the `GuildMessages` + privileged
`MessageContent` intents and `Manage Messages`; if the intent is not enabled
the bot falls back to Guilds-only and the command says so. Invokers must hold
Administrator or Kick Members, and can only jail members below their highest
role; owners and bots can't be jailed.

### Burg relay

`/burg @user [duration] [style]` uses the same permissions, duration parser,
role checks, Message Content intent and Manage Messages requirement as the
jail, but it is a single toggle: invoking it for an active member releases
them. `BurgRegistry` (apps/bot/src/burg.ts) owns the in-memory timers and the
uwu/owo transformer. Messages are re-posted through a separate per-channel
"Monarch Burg" webhook so the member's display name and avatar remain visible.
The transformer preserves mentions, custom emoji, timestamps, links and code
spans, then adds readable spelling changes and selectable soft, cat, chaotic or
random cute flourishes. A member cannot be in both relays at once; the command
handler rejects that combination so relay precedence cannot surprise anyone.

## Command surface: slash + prefix (two ways to type one command)

Every bot command exists twice, and the second time is not a copy. Handlers
are written against one surface-neutral interface, `CommandContext`
(apps/bot/src/context.ts): `SlashCommandContext` (apps/bot/src/slash-context.ts)
implements it for `/monarch`, `/burg`, `/music`; `PrefixCommandContext`
(apps/bot/src/prefix/context.ts) implements it for text messages. The handler
layer (apps/bot/src/monarch-commands.ts, apps/bot/src/music/commands.ts) never
learns which one it is talking to, so permissions, wording and registry state
cannot drift between surfaces — apps/bot/test/slash-context.test.ts asserts the
parity.

**Prefix resolution.** Per server, stored as `GuildSettings.commandPrefix`
(`NULL` = the shared default `!`) and read/written through
`GET|PUT /api/internal/guilds/:id/prefix` with the same `INTERNAL_API_TOKEN`
as the other bot routes — the bot keeps no database of its own. The gateway
side caches it for 60 s per guild, including *negative* entries (no custom
prefix), and a `peek()` sync read decides whether a message could be a command
before anything is awaited; if the dashboard is unreachable the default prefix
and @Monarch mentions keep working. Legality is decided in exactly one place,
`packages/shared/src/prefix.ts` (`parseCommandPrefix`): ≤4 characters, no
whitespace, must end in punctuation — so `!`, `?`, `m!`, `>>` are valid and
`hey` is not.

**Matching.** `@Monarch` first (zero configuration, and the escape hatch when
nobody knows the prefix), then text prefixes longest-first and
case-insensitively; the rest of the message is tokenized by `prefix/parse.ts`
(quotes keep arguments together, mentions become snowflakes, URLs stay whole).
The router mirrors the slash tree (`!monarch jail @user 10m`, `!music play x`)
plus short aliases (`!play`, `!p`, `!np`, `!q`, `!jail`, `!burg`, `!help`,
`!invite`) that the shared command catalog documents and tests keep in sync.

**Nothing harmless is gated.** `help`, `dashboard`, `status`, `prefix` (show)
and `invite` run for any member; only commands that read or change server data
ask for Manage Server / Administrator (`backup`, `export`, `embed`, `test`,
`prefix set`) or Administrator / Kick Members (the jail and burg gags).
`!invite` builds its link with `packages/shared/src/invite.ts` — the same
builder behind the dashboard's `GET /api/invite` and "Add Monarch to Discord"
button — so a member who finds Monarch in somebody else's server can install it
on their own with the identical least-privilege permission set.

**Response policy.** A jail/burg relay entry outranks a command reply (a jailed
user's `!help` becomes galactic text — asserted in the tests). Unknown `!words`
are answered with **silence** so servers with several bots don't collect a pile
of "unknown command" replies; only an explicit `@Monarch <typo>` or a bare
`!monarch` / `!music` group root gets a helpful reply, and a bare `@Monarch`
gets a greeting. Prefix replies are public (there is no ephemeral text message)
and always send an explicit `allowedMentions`, so a `!jail <@someone>` reply
can't ping the room.

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

Content designs (embeds/messages) follow their own small pipeline, shared by
the dashboard UI and the bot's `/monarch test`:

```
Design (@monarch/schemas content.ts) → validate (@monarch/validation
content-rules) → resolveTarget (@monarch/discord) → {variables} resolved
(@monarch/shared) → payload (@monarch/renderer content-renderer) →
gateway.sendMessage → audit
```

The service lives in `apps/dashboard/lib/workspace.ts`; route handlers are
thin. `/monarch embed` and `/monarch test` reach it through `/api/internal/*`
with `Authorization: Bearer INTERNAL_API_TOKEN` (constant-time compare in
`lib/internal-auth.ts`). Both entry points go through the exact same
pipeline, so the bot can never send something the editor would not send.

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
reach the browser. Migrations live in `prisma/migrations/` (`npm run db:migrate`);
the store contract is covered by tests that run against real PostgreSQL
(apps/dashboard/test/prisma-store.integration.test.ts). Adding a column to
`GuildSettings` (as `commandPrefix` did) means touching the schema + a
migration, the `MonarchStore` interface, both store implementations' mappers,
and the internal route the bot uses — the dashboard's own settings form must
not clobber it, which apps/dashboard/test/command-prefix.test.ts pins.

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
| `GET/POST /api/guilds/:id/snapshots` | Version history metadata / take a manual backup |
| `POST /api/guilds/:id/snapshots/:snapshotId/restore` | Stage a snapshot as the caller's draft (rebase, no Discord writes) |
| `GET/POST /api/guilds/:id/template` | Download the live structure as a template / import one as a draft (`mode: add\|replace`) |
| `GET/PUT /api/guilds/:id/settings` | Designated channels |
| `POST /api/guilds/:id/test-message` | Send Test through the Target Resolver |
| `GET/PUT /api/guilds/:id/workspace` | Autosaved embed/message content designs |
| `POST /api/guilds/:id/workspace/send` | Test/Publish a content design (validate → Target Resolver → render → send → audit) |
| `GET/POST /api/internal/guilds/:id/workspace(+/send)` | Bot-facing counterparts, guarded by `INTERNAL_API_TOKEN` (Bearer) |
| `GET/POST /api/internal/guilds/:id/backup` · `GET …/template` | Bot-facing backup list/create and template export (`/monarch backup`, `/monarch export`) |
| `GET/PUT /api/internal/guilds/:id/prefix` | Bot-facing per-server command prefix (`!prefix` / `/monarch prefix`); `PUT {prefix: null}` resets to `!` |

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
- shared: command-prefix legality; command catalog ⇄ manifest sync
- bot: prefix tokenizer/router + alias tables ⇄ catalog, prefix registry
  caching/degradation/validation, end-to-end prefix dispatch against real
  handlers and registries, and slash/text parity of the same handlers

## Adding the next features (guidance)

1. Model in `@monarch/schemas` (extend, don't fork).
2. Limits/rules in `@monarch/validation`.
3. Discord payloads in `@monarch/renderer`; new capabilities on
   `DiscordGateway` (implement in BOTH gateways).
4. Reuse the diff engine + Review modal pattern for anything that mutates.
5. Publishing features must accept a `TargetConfig`.
6. Register the nav entry in components/nav/SidebarNav.tsx.

Explicit product boundary: **no moderation features** (spec §32).
