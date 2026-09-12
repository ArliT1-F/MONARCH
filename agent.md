# Monarch — Agent Reference

> Internal reference for future me. Treat this as a map of the codebase, not
> a copy of it. Section 1 is the project at a glance; later sections are the
> things I keep wanting to re-check (`/api/...` route table, Prisma model
> inventory, shared-module APIs, design-system rules, env-var contract, etc.).
> A full PR/commit log is at the end.

---

## 1. What this repo is

**Monarch — Design your Discord.** A visual design studio for Discord servers:
connect Discord, pick a server, redesign it, preview the exact diff, and apply.
`Draft → Preview → Validate → Diff → Confirm → Apply`. The dashboard (Next.js)
is the product; the bot (discord.js) is the integration layer. **Monarch is
not a moderation bot and will not become one.** The only "moderation" surface
is `/burg` — a joke gag feature, not a real moderation system.

**Repo:** `ArliT1-F/MONARCH` (GitHub). **Local path:** `/home/user/MONARCH`.
**Session branch:** `arena/01a08380-monarch` (fixed for this Arena session —
push/PR/commit only here).

### Layout

```
apps/
  dashboard/    Next.js 15 app — UI + API route handlers
  bot/          discord.js bot — links, status, /monarch *, burg relay
packages/
  shared/       Result, MonarchError, logger, permissions, variables, ids
  schemas/      zod — ServerDesign, content, targets, template envelope
  validation/   validation engine + DiscordLimits
  analyzer/     Design Analyzer (FEATURE 9) — pure checks, scores, suggestions
  design-engine/ diff, apply-plan, detach/merge/rebase for templates
  renderer/     internal model ⇄ Discord API v10 payloads
  discord/      DiscordGateway abstraction (REST + Mock), Target Resolver, executor
prisma/         PostgreSQL schema + 3 migrations
docker/         compose + 2 Dockerfiles
docs/           architecture.md, deploying-vercel.md
```

Packages are consumed as TS source via `transpilePackages` (Next) and `tsx`
(bot, tests). No build step in the workspace layer.

### Pipeline (must not be violated)

```
Dashboard edits → ServerDesign (@monarch/schemas) →
  validate (@monarch/validation) →
  diff (@monarch/design-engine) →
  ApplyPlan →
  executor (@monarch/discord) → DiscordGateway (Rest|Mock) → Discord
```

- **Internal schema is the source of truth.** Raw Discord JSON never crosses
  internal boundaries. Only `@monarch/renderer` and the gateways know Discord
  shapes.
- **Only `POST /api/guilds/:id/apply` mutates Discord.** Everything else
  (plan, draft, snapshot, restore, import) stages changes for review.
- **Limits live in `@monarch/validation` `DiscordLimits` only** — never inline.
- **Ids:** snowflake = exists on Discord; `new_*` = local id (creation).
  See `packages/shared/src/ids.ts`.

---

## 2. Tech stack & scripts

| Tool | Version | Notes |
|---|---|---|
| Node | >= 20 | engines.node in root `package.json` |
| Next.js | ^15.1.6 | App Router, React 19, `transpilePackages` for workspaces |
| React | ^19.0.0 | |
| discord.js | (imported as `discord.js`) | `discord-api-types/v10` for payload types |
| @discordjs/rest | (in packages/discord) | For the bot + dashboard's REST gateway |
| Prisma | ^7.10.0 | **Engine-free**: query compiler is WASM, `pg` driver adapter |
| PostgreSQL | 16 (docker) / Neon / Vercel Postgres | |
| vitest | ^2.1.8 | `npm test` at repo root |
| TypeScript | ^5.6.3 | `strict`, `noUncheckedIndexedAccess` |

**Root scripts (`package.json`):**
- `dev` / `dev:bot` / `build` / `test` / `typecheck` (root + workspaces)
- `db:generate` (prisma generate) · `db:migrate` (deploy) · `db:dev` (dev)
  · `db:push` (no migrations) · `db:studio`
- `postinstall: prisma generate` — runs on every install

**Dashboard dev:** `npm run dev` → `next dev -H 0.0.0.0 -p 3000`.
**Bot dev:** `npm run dev:bot`.

### Sandbox caveats (this environment)

- `binaries.prisma.sh` is **unreachable** (TLS fails). `npm install` partially
  succeeds (packages install) but `prisma generate` errors out because the
  query-engine binary download fails. Tests that need the generated Prisma
  client (e.g. `prisma-store.integration.test.ts`) will fail here.
- Workaround used by the Template Library + Analyzer session: a **type-only
  stub** at `apps/dashboard/lib/generated/prisma/client.ts` (the directory is
  gitignored) lets `tsc --noEmit` and all non-DB tests run. Every delegate
  method throws at runtime — never run database code against it. A real
  `prisma generate` overwrites it.
- The fix is environment-only; in any normal environment with network
  access, `npm install` runs `prisma generate` cleanly via the root
  `postinstall` hook.

---

## 3. Data model (Prisma)

`prisma/schema.prisma`. Provider is `postgresql`. URLs are NOT in the schema —
they live in `prisma.config.ts` (CLI) and `apps/dashboard/lib/prisma.ts`
(runtime, via the pg driver adapter).

### Models (10 total, all in 2 migrations)

| Model | Migration | Key fields | Relations |
|---|---|---|---|
| `User` | init | id, username, avatarUrl, createdAt | sessions[], drafts[], auditEntries[] |
| `Session` | init | id, userId, accessTokenEnc (AES-GCM), createdAt, expiresAt | → User CASCADE |
| `Guild` | init | id, name, iconUrl, createdAt | settings, workspace, drafts[], versions[], auditEntries[] |
| `GuildSettings` | init + `…_add_analyzer_dismissed` + `…_add_command_prefix` + `…_add_confession_channels` | guildId, welcomeChannelId, announcementsChannelId, testingChannelId, templateTestingChannelId, analyzerDismissed (Json? — string[] of dismissed analyzer check ids), commandPrefix (String? — the guild's text-command prefix; NULL = the shared default `!`), confessionChannelId (String? — the anonymous confession channel; NULL = off), confessionLogChannelId (String? — optional staff-only log channel; NULL = no logs) | → Guild CASCADE |
| `GuildWorkspace` | guild_workspace | guildId, embed (Json?), message (Json?), updatedAt | → Guild CASCADE |
| `DesignDraft` | init | id (cuid), guildId, userId, design, baseDesign, updatedAt — UNIQUE(guildId, userId) | → Guild, → User CASCADE |
| `DesignVersion` | init | id (cuid), guildId, name, kind, design, createdAt | → Guild CASCADE; INDEX(guildId, createdAt) |
| `Template` | init | id (cuid), ownerId (plain column, no FK), name, type, format, data, createdAt, updatedAt | INDEX(ownerId) — **used by the Template Library (§17)** |
| `AuditEntry` | init | id (cuid), guildId, userId, action, summary, createdAt | → Guild, → User CASCADE; INDEX(guildId, createdAt) |
| `MockDiscordState` | init | id (default "singleton"), state, updatedAt | — (singleton row for demo mode) |

### Important non-uses

- **`Template` model** — used by the Template Library since the
  Template Library + Design Analyzer session (see §17). `ownerId` is a plain
  column (no FK relation) by design: reads/writes are always owner-scoped in
  the store methods.
- **`@default(cuid())` and `@default(now())`** — these have no SQL-level default
  in the migrations (cuid is generated in app code; `now()` is `CURRENT_TIMESTAMP`).
  This is the standard Prisma behavior; not a mismatch.

### Stores

**The store interface also covers** the Template Library (`listTemplates`/
`getTemplate`/`putTemplate`/`deleteTemplate` — every read is owner-scoped;
`putTemplate` refuses to overwrite an id that belongs to a different owner)
and the analyzer dismissals (`getAnalyzerDismissals`/`putAnalyzerDismissals`
— per-guild string[] of check ids, stored on `GuildSettings.analyzerDismissed`
in Prisma and in its own JSON file in the FileStore, deliberately OUTSIDE
`GuildSettingsRecord` so the designated-channels form can never clobber it).

`apps/dashboard/lib/store.ts` defines the `MonarchStore` interface. Two impls:
- **`PrismaStore`** (`prisma-store.ts`) — picked when `DATABASE_URL` is set.
  Production target. **OAuth tokens encrypted at rest** in
  `Session.accessTokenEnc` via `lib/secure-token.ts` (AES-256-GCM, key from
  `SESSION_SECRET` via scrypt, format `v1.<iv>.<tag>.<ciphertext>`).
  Expired sessions reaped on read.
- **`FileStore`** — JSON files under `.monarch-data/` (gitignored). Dev/demo
  only. **On Vercel/serverless, `getStore()` THROWS a config error** if
  `DATABASE_URL` is missing (PR #3 — previously the file store crashed with
  `ENOENT /var/task/.monarch-data` during OAuth callback).

**The integration test** (`apps/dashboard/test/prisma-store.integration.test.ts`)
proves migrations are valid SQL: it boots PGlite (Postgres-in-WASM), sorts
all migration directories alphabetically, splits each `migration.sql` on `;`,
and runs every statement before exercising the full `MonarchStore` contract.

---

## 4. Module API index — what lives where

This is the cheat sheet for "where do I make change X".

### `packages/shared`
- `ids.ts` — `LOCAL_ID_PREFIX = "new_"`, `isLocalId`, `createLocalId`
- `result.ts` — `Result<T,E>`, `ok`, `err`, `MonarchError` (code/message/reason/fix/detail), `monarchError()`
- `logger.ts` — `createLogger(scope)`; **redacts keys matching `/token|secret|authorization|password|cookie/i`**
- `variables.ts` — `VariableContext`, `registerVariable`, `listVariables`,
  `renderVariables`, `renderVariableExamples`. Built-ins: `user`, `username`,
  `display_name`, `server`, `member_count`, `channel`. Pattern: `\{([a-z_]+)\}`.
- `permissions.ts` — `Permission` (bigint bitflags for Discord v10), `hasPermission`,
  `canDesignGuild` (ManageGuild OR Administrator), `missingPermissions`
- `invite.ts` — `INVITE_PERMISSIONS`, `INVITE_SCOPES`, `invitePermissionBits()`,
  `isValidGuildId`, `buildBotInviteUrl({clientId, guildId})`. **The one place the
  "Add to Server" link is built** — the dashboard's `lib/invite.ts` wraps it with
  env/demo-mode awareness and `GET /api/invite` redirects to it, while the bot's
  `!invite` / `/monarch invite` posts the identical URL in chat. Never
  Administrator (spec §32); tests on both sides assert the bitfield.
- `prefix.ts` — `DEFAULT_COMMAND_PREFIX = "!"`, `MAX_COMMAND_PREFIX_LENGTH = 4`,
  `COMMAND_PREFIX_CHARS` (punctuation a prefix may end with),
  `parseCommandPrefix(input)` → `{ok:true,prefix} | {ok:false,message}` and
  `isCommandPrefix`. **The one place prefix legality is decided** — the bot's
  `!prefix set` and the dashboard's internal route both call it, so they can't
  disagree. Rule: ≤4 chars, no whitespace, never `@` `/` quotes/brackets, and
  it must *end* in punctuation (so `m!` and `>>` are fine, `hey` is not).

### `packages/schemas` (zod)
- `server-design.ts` — `DESIGN_SCHEMA_VERSION = 1`; `CategoryDesign`, `ChannelDesign`
  (kinds: text/voice/announcement/forum/stage), `RoleDesign`, `Branding`,
  `DesignatedChannels` (welcome/announcements/testing/templateTesting),
  `ServerDesign`, `emptyServerDesign(guildId, name)`. Channel topic only on
  text/announcement/forum (`supportsTopic` in renderer).
- `content.ts` — `CONTENT_SCHEMA_VERSION = 1`; `EmbedDesign` (max 25 fields,
  author/footer/image/thumbnail, timestamp: ISO | "now"), `MessageDesign`
  (content ≤2000, ≤10 embeds, ≤25 buttons), `MessageButton` (5 styles;
  Monarch today only ships link buttons; non-link styles get a placeholder
  `custom_id: "monarch:<id>"` and would need interaction handling — later
  feature), `GuildWorkspace`, `emptyEmbedDesign`, `emptyMessageDesign`.
- `targets.ts` — `TargetConfig` discriminated union: `{kind:"designated", key}`
  or `{kind:"explicit", guildId, channelId, threadId?}`; `DesignatedChannelKey`,
  `ResolvedTarget` (guildId/channelId/threadId/channelName).
- `template.ts` — `TEMPLATE_FORMAT = "monarch-template"`, `TemplateEnvelope`
  (format/version/type/name/data), `ServerTemplate` (ServerDesign with
  `guildId` optional), `parseServerTemplate` returns `{ok:true, template}`
  or `{ok:false, error: string}`.
- `guild.ts` — `GuildSummary` (id, name, iconUrl, memberCount, botInstalled,
  userCanDesign, botPermissions), `GuildChannelInfo`, `GuildRoleInfo`.

### `packages/validation`
- `limits.ts` — **`DiscordLimits`** (SINGLE SOURCE; never inline). Channel
  nameMin/Max=1/100, topicMax=1024 (4096 forum), slowmodeMax=21600; guild
  maxChannels=500, perCategory=50, maxRoles=250; embed titleMax=256,
  descriptionMax=4096, fieldsMax=25, fieldName/Value=256/1024, footerMax=2048,
  authorNameMax=256, totalMax=6000, perMessageMax=10; message contentMax=2000,
  actionRowsMax=5, buttonsPerRowMax=5.

### `packages/analyzer` (FEATURE 9)
- `types.ts` — `AnalyzerReport`, `AnalyzerCategoryScore`, `AnalyzerCheckResult`
  (stable `id`, 0..1 `score`, optional `suggestion`, optional `dismissed`),
  `ANALYZER_CATEGORIES` (organization 0.3 · naming 0.3 · roles 0.2 ·
  branding 0.2), `SCORE_GOOD=80`/`SCORE_FAIR=60` (same breakpoints as the
  proposed `/monarch health`), `MAX_AFFECTED=6`.
- `checks.ts` — 15 pure checks. **Check ids are stable API** — they are the
  keys stored in `GuildSettings.analyzerDismissed`; never rename without a
  data migration. `naming.duplicates` reuses `normalizeTextChannelName` from
  `@monarch/validation` (no second copy of the normalization rules).
  `@everyone` (role id === guildId) and `managed` roles are never flagged.
- `analyze.ts` — `analyzeServerDesign(design, {dismissed?}): AnalyzerReport`.
  Deterministic; dismissed checks stay in the report but are excluded from
  every average; `org.has-structure` has intra-category weight 3 so an
  empty server can't ride to a high score on vacuous passes.
- `engine.ts` — `ValidationIssue{severity, code, message, fix?, target?}`,
  `ValidationReport{valid, errors, warnings, issues}`, `runRules(subject, rules)`.
- `server-rules.ts` — `validateServerDesign(design)`. Rules: channelNames,
  channelTopics, structureLimits, referentialIntegrity, duplicateNames.
  **Has helper `normalizeTextChannelName`** (mirrors Discord: drops ASCII
  punctuation only, keeps emoji/non-ASCII separators like "︱"). Used for
  collapse-to-nothing + duplicate detection only — no longer warns about
  cosmetic rewrites.
- `content-rules.ts` — `validateEmbedDesign`, `validateMessageDesign`.
  Embeds must have at least one content-bearing field. Button URL on non-link
  is a warning. Empty message is an error.

### `packages/design-engine`
- `diff.ts` — `diffServerDesign(current, desired): ServerDiff`. Operations:
  `create` (new_*), `modify` (non-name field changes), `rename`, `move`,
  `delete`, `unsupported` (snowflake no longer on Discord, or incompatible
  type change). Channel diff fields: `topic`, `nsfw`, `slowmode`.
- `apply-plan.ts` — `planApply(diff): ApplyPlan`. Order: creates (categories
  before channels) → renames/modifies → moves → deletes (last; "destructive"
  = any deletes, requires explicit confirmation). `desiredPositions(design)`
  for the post-apply position sync.
- `detach.ts` — `detachDesign(design)`: portable template, all snowflakes
  become `new_*` local ids, designatedChannels reset to {}.
- `compose.ts` — **`rebaseDesign(current, desired): {design, recreated, adopted}`**:
  keep live ids, *adopt* vanished ids onto same-kind/same-name live entities
  (preserves message history), recreate the rest. **`mergeDesigns(current, incoming)`**:
  append under current structure (used by template "add" mode).
  **`localiseIds(design)`**: force all ids to local — used for hand-edited
  templates.

### `packages/renderer`
- `discord-renderer.ts` — `channelKindToDiscordType`, `discordTypeToChannelKind`
  (undefined for non-managed types), `renderCreateChannel` (uses
  `supportsTopic`), `renderCreateCategory`, `renderModifyChannel`,
  `supportsTopic`. **The only place that builds Discord v10 channel payloads.**
- `content-renderer.ts` — `applyVariablesToEmbed`, `applyVariablesToMessage`
  (resolve `{variables}`), `renderEmbedPayload`, `renderButtonPayload`
  (link buttons carry `url`; non-link get `custom_id: "monarch:<id>"`),
  `renderMessagePayload` (chunks buttons into rows of ≤5).

### `packages/discord`
- `gateway.ts` — `DiscordGateway` interface (the seam). Two impls.
  `BotGuildInfo{id, botPermissions, botHighestRolePosition}` where
  `botPermissions === null` means *unknown* (Discord hiccup; let Discord
  enforce). `computeBotPermissions(member, roles, guildId)` prefers
  Discord-computed `member.permissions`, falls back to OR-ing role bitfields
  + @everyone. `buildGuildSummaries(userGuilds, botGuildIds, extras, canDesign)`.
- `rest-gateway.ts` — `RestDiscordGateway` (real). `getBotGuildInfo`
  resolves bot userId from `GET /users/@me` once per process, then uses
  `GET /guilds/:id/members/:botId` (NOT `/members/@me` — doesn't exist).
  `isNotInGuildError` checks codes 10004/10007/50001 OR status 403/404.
  Other errors → permissions-unknown, never "not installed".
- `mock-gateway.ts` — `MockDiscordGateway` (in-memory, persisted via
  `MockStateStore`). `mockSnowflake()` returns 900000000000000000+ counter.
  `listUserGuilds` returns all mock guilds as if owned (permissions "8" =
  Administrator). **Seed data is in `apps/dashboard/lib/discord.ts`
  `seedMockState()`** — 3 mock guilds: Nebula Community (installed),
  Pixel Arcade (installed), Design Lounge (uninstalled).
- `target-resolver.ts` — `resolveTarget(gateway, guildId, target, opts?)`.
  **Never assume #general.** Returns MonarchError if: not designated, wrong
  guild, channel missing, voice/stage (not messageable), bot not installed,
  bot missing ViewChannel/SendMessages. `null` bot permissions → skip the
  check. `messageableChannels(design)` for pickers.
- `executor.ts` — `executeApplyPlan(gateway, plan, desired): ApplyResult`.
  Sequential. Resolves `new_*` ids as creations complete (so a new channel
  inside a new category follows it). Stops on first error; reports per-step
  status. Final pass: `desiredPositions(design)` syncs ordering.
- `errors.ts` — `translateDiscordError(e, context)`. 403/50013 → permissions,
  404/10003 → not-found, 429 → rate-limited, else unknown. Raw error in
  `detail` (logs only).

### `apps/dashboard/lib`
- `env.ts` — **the only place that reads `process.env`.** `isDemoMode()`
  returns true when `MONARCH_DEMO=1` OR Discord creds are missing.
- `session.ts` — Cookie `monarch_session` = `<id>.<HMAC-SHA256(secret,id)>`.
  httpOnly, sameSite=lax, secure iff APP_URL starts https, maxAge 14d. Only
  id reaches the browser; OAuth tokens stay server-side.
- `auth.ts` — Discord OAuth2 helpers. `buildAuthorizeUrl`, `signState`/
  `verifyState` (HMAC), `exchangeCode`, `fetchDiscordUser`, `avatarUrl`.
  Scopes: `identify guilds`. `prompt=none`.
- `api.ts` — Route guards. `requireSession`, `requireGuildAccess(guildId, {needBot})`
  chain: session → guild membership → user `userCanDesign` → bot installed.
  `assertSameOrigin` checks `sec-fetch-site`. `jsonError(status, error)`,
  `jsonStorageError(error, fallback)` — **never throw from a route**; missing
  table errors → `db.migration-pending` with "run npm run db:migrate" fix.
- `internal-auth.ts` — Bot-to-dashboard. `assertInternalAuth(req)`: 503 if
  `INTERNAL_API_TOKEN` unset, 401 on Bearer mismatch (constant-time over
  SHA-256 digests). All `/api/internal/*` routes call this first.
- `discord.ts` — `getGateway()` returns Rest (real) or Mock (demo).
  `StoreBackedMockStore` persists mock state via PrismaStore/FileStore.
  `fetchCurrentDesign(guildId)` merges live design with `designatedChannels`
  from `GuildSettings`. `installBotInDemoGuild(guildId)` flips
  `botInstalled` and grants `invitePermissionBits()` in demo mode.
- `prisma.ts` — Engine-free client via `PrismaPg` adapter, `max: 1` per
  serverless instance, cached on `globalThis` to survive HMR.
- `prisma-store.ts` — Full `MonarchStore` impl. Row mappers:
  `sessionRowToRecord`, `draftRowToRecord`, `snapshotRowToRecord`,
  `settingsRowToRecord` (builds the `designatedChannels` record from 4
  columns), `designatedChannelsToColumns`, `auditRowToRecord`. Helpers:
  `ensureUser`/`ensureGuild` upserts FK targets. `SESSION_TTL_MS` mirrors
  the cookie maxAge (14d).
- `store.ts` — Interface + FileStore + `getStore()`. The swap lives here
  only — routes never change.
- `secure-token.ts` — `encryptSecret(plaintext)` /
  `decryptSecret(stored)`. AES-256-GCM, scrypt key from SESSION_SECRET,
  format `v1.<iv>.<tag>.<ciphertext>` (base64url). Tampered/wrong-key
  returns `undefined` (treated as absent).
- `invite.ts` — Bot invite URL builder. **Least-privilege**: ViewChannel,
  ManageChannels, ManageRoles, ManageWebhooks, ManageMessages, SendMessages,
  SendMessagesInThreads, EmbedLinks, AttachFiles. **Never Administrator.**
  Scopes: `bot applications.commands`. `integration_type=0`. If `guild_id`
  is a valid 5-25 digit snowflake, pre-select + lock with
  `disable_guild_select=true`. `invitePermissionBits()` returns the decimal
  bitfield.
- `workspace.ts` — **Content publishing pipeline, shared by dashboard
  routes + bot internal API.** `loadWorkspace(guildId)` (parses stored
  designs with `safeParse`; corrupt rows degrade to empty with a warn log
  — no 500). `saveWorkspace`. `sendWorkspaceDesign(ctx)`: validate →
  Target Resolver → resolve variables → `renderMessagePayload` →
  `gateway.sendMessage` → audit. `pickDesign(kind, provided, saved)` uses
  in-memory design if provided, else the saved one. `sendOutcomeResponse`
  maps MonarchError codes to HTTP statuses.
- `backups.ts` — **Backups + templates, shared by user + bot routes.**
  `createBackup`: `fetchCurrentDesign` → SnapshotRecord kind:"manual" +
  audit. `stageRestore`: get snapshot → `fetchCurrentDesign` → `rebaseDesign`
  → `putDraft` (kind: "backup.restore-staged" audit, returns
  `designerUrl: "/s/:id/designer"`). `exportTemplate`: `fetchCurrentDesign` →
  `buildTemplate` (detachDesign with designatedChannels reset to {}).
  `stageImport` (modes "add" | "replace"): `parseServerTemplate` →
  localiseIds → `mergeDesigns` (add) or replace → `validateServerDesign` →
  `putDraft`. **In "add" mode roles and designatedChannels always come from
  live**; never trust the template's.
- `library.ts` — **Template Library service (FEATURE 7, §17).**
  `saveTemplateFromGuild` (fetchCurrentDesign → buildTemplate → putTemplate +
  `template.library-save` audit), `saveTemplateFromUpload`
  (parseServerTemplate → putTemplate), `renameTemplate`/`duplicateTemplate`/
  `deleteTemplate` (all owner-scoped, 404 for foreign ids),
  `templateEnvelope` (rebuilds + re-parses the `monarch-template` envelope —
  a corrupt row degrades to `template.corrupt` 410, never a junk download),
  `templateMeta`/`templateCounts` (list summaries derived from the payload).
  **Installing into a guild reuses `stageImport`** — the library never
  writes to Discord itself.
- `fetch-json.ts` — **Client-safe** safe response parsing.
  `readJsonSafe<T>(res)` returns null on empty/non-JSON (5xx HTML pages,
  empty 500s). `apiErrorMessage(data, res, fallback)` for 401/403/404/5xx.
  `networkErrorMessage(error)` for TypeError (offline).

### `apps/dashboard/components`
- `nav/GuildShell.tsx` — Responsive shell. ≥md: 240px sidebar. <md: sticky
  top bar + slide-out drawer (closes on route change + Escape, locks body
  scroll).
- `nav/SidebarNav.tsx` — Sections: Overview, Design (Designer/Embeds/
  Messages/Roles, with Welcome/Branding `soon`), Library (Template Library,
  Import/Export), Manage (History, Design Analyzer), Settings (Designated
  Channels).
- `designer/DesignerApp.tsx` — Loads state, manages undo/redo keyboard
  shortcuts, autosave (1.2s debounce), validation strip, mobile pane switch.
- `designer/designer-state.ts` — Pure reducer. HISTORY_LIMIT=100. Drag ops:
  DRAG_BEGIN snapshots once, transient moves don't push history, DRAG_COMMIT
  finalizes. `rebaseDesign` here refers to resetting to fresh `base`.
- `designer/ReviewModal.tsx` — Plan → confirm destructive → apply →
  per-step results. Calls `POST /api/guilds/:id/plan` then `…/apply`.
- `content/BuilderApp.tsx` + `EmbedEditor.tsx` + `MessageEditor.tsx` +
  `preview.tsx` + `use-workspace.ts` + `ui.tsx` — Embed/Message builder
  shell. Debounced autosave (900ms). `useWorkspace.send(mode)` always sends
  the in-memory design (never a stale saved copy).
- `history/BackupsPanel.tsx` — Manual backup + restore (confirms, then
  router.push to designerUrl). KIND_LABEL for the pill: manual (royal) /
  pre-apply (ink) / post-apply (ok).
- `settings/DesignatedChannelsForm.tsx` — Edits the 4 designated channel
  keys per guild.
- `templates/ImportExportPanel.tsx` — Template download/upload UI.
- `library/TemplateLibrary.tsx` — Template Library UI (save-from-server,
  upload, rename/duplicate/download/delete, install add/replace → stages a
  draft via the guild import endpoint and routes to the designer).
- `ui/InviteBotButton.tsx` — Opens `/api/invite` in new tab; on `focus`
  returns, `router.refresh()`. In demo mode navigates in-place.
- `analyzer/AnalyzerPanel.tsx` — Design Analyzer UI (FEATURE 9): overall
  score hero, per-category score bars, failing checks with suggestions,
  "mark as intentional"/"Undo" (PUTs the dismissals endpoint, then
  `router.refresh()`), Markdown report export (client-side Blob).
- `ui/ComingSoon.tsx` — Phase-labelled placeholder used by Welcome/Branding
  pages.

### `apps/bot/src`
- `index.ts` — **Lightweight bot.** Guilds + GuildMessages + MessageContent
  intents, with Guilds-only fallback if MessageContent isn't enabled in the
  developer portal (logs warning, disables `/burg` **and
  every prefix command** — slash commands keep working).
  Owns only what needs the live gateway: the relay webhooks, the lazy
  `MusicManager`, `onMessage` (1. prefix dispatch → 2. burg relay) and
  `onInteraction`. All command bodies live in `monarch-commands.ts` /
  `music/commands.ts` and are shared by both surfaces.
  **Graceful shutdown:** SIGTERM/SIGINT → log → `client.destroy()` → `exit(0)`.
  **Idempotent, never throws on `destroy()`.** `unhandledRejection` logged
  not fatal. Slash-command registration is non-fatal (transient Discord
  errors don't crash-loop the worker).
  - **CMD in Dockerfile: `node --import tsx apps/bot/src/index.ts`** so the
    bot is PID 1 and gets SIGTERM directly. `npm run start` absorbs the
    signal — never use that as the container entrypoint.
- `commands.ts` — `monarchCommandJSON()` is the single source of truth
  (worker + `register-commands` script). `COMMAND_HELP` manifest rendered
  for `/monarch help`; **a test enforces the help is in sync with
  registered subcommands and under Discord's 2000-char limit.**
  - `BURG_PERMISSIONS` = Administrator OR KickMembers.
  - `DESIGN_PERMISSIONS` = Administrator OR ManageGuild.
  - **All subcommands are `InteractionContextType.Guild`.**
  - `renderHelpEmbeds(appUrl, guildId?, prefix?)` + `prefixHelpLine(prefix)`
    add the prefix line and per-command `also !play, !p` aliases.
- `context.ts` — **`CommandContext`: the surface-neutral command API**
  (`reply`/`replyHidden`/`replyEmbeds`/`defer`/`edit`/`attach`, option
  readers, `args`, `resolveMember`, `memberHasAny`, `myPermissions`) plus
  `hasAnyPermission` (uses `PermissionsBitField.has`, so **Administrator
  implies everything** — never hand-roll a bitwise AND) and
  `allowedMentionsFor`.
- `slash-context.ts` — `SlashCommandContext(interaction, prefix)`: ephemeral
  replies, `deferReply` → `editReply`, `AttachmentBuilder` for `/monarch export`.
- `monarch-commands.ts` — `MonarchCommands` (help, dashboard, **invite**,
  status, **prefix**, backup, export, embed, test, burged, **confession**
  setup/disable) + `burg(ctx)`
  (bare re-run toggles off, re-run with options updates), written once
  against `CommandContext`. Also `parseGagArgs` (mention/id + duration +
  style + reason, order-free except style-before-reason) and `DURATION_ERROR`;
  a duration-*shaped* word it can't parse (`10 minutes`, `0m`) refuses the
  command rather than silently burging forever.
- `prefix/parse.ts` — **pure** prefix tokenizer + router: `parseArgs`
  (quotes, mention→snowflake), `extractPrefixCommand(content, prefixes,
  botUserId)`, `matchCommand`, and the alias tables
  `MONARCH_PREFIX_ALIASES` / `MUSIC_PREFIX_ALIASES` (tested against the
  shared catalog's `prefixAliases`).
- `prefix/context.ts` — `PrefixCommandContext(message, invocation, prefix,
  args)`: no ephemeral (text commands are public), `defer()` posts a
  placeholder it edits later, **always sends an explicit `allowedMentions`**,
  `resolveMember(id)` = mentions → cache → `guild.members.fetch`.
  `canReplyIn(message)` gates on View Channel + Send Messages.
- `prefix/dispatch.ts` — `handlePrefixMessage(message, deps)` → `boolean`
  ("was this one of mine?"). Fast path matches cached prefixes with no I/O;
  slow path resolves the guild's prefix (one internal-API call per guild per
  TTL) only for plausible messages. Silent on unknown `!words` (other bots'
  prefixes), helpful on `@Monarch <typo>`.
- `prefix/registry.ts` — `PrefixRegistry` (TTL cache, `peek` = sync cache
  read, `get`, `candidates`, `set(guildId, prefix|null)`) + `PrefixStore`
  seam + `internalPrefixStore(appUrl, token)`. **A dead dashboard degrades to
  the default prefix, never to a per-message fetch.**
- `burg.ts` — `BurgRegistry` in-memory on purpose. `setTimeout` tops out at
  ~24.8 days, so durations >2B ms are chunked. **A bot restart releases
  everyone by design.** `toBurg` rewrites text as uwu/owo; the `PRESERVE`
  regex keeps code blocks, inline code, mentions, custom emoji, timestamps,
  URLs intact so a burg'd user can't bypass or break formatting.
- `durations.ts` — `parseDuration` accepts `30s 10m 2h 1d 1h30m`, capped at
  28d (`MAX_DURATION_MS`); `formatDuration` renders confirmations.

### `apps/dashboard/app/api/*` — full route table

| Method | Path | Auth | Mutates Discord? | Body / Notes |
|---|---|---|---|---|
| GET | `/api/auth/login` | none | – | Demo? creates session, redirects to /select. Else signs state, redirects to Discord. |
| GET | `/api/auth/callback` | OAuth state cookie | – | Exchanges code, fetches user, calls createSession. Catches storage errors → friendly redirect. |
| POST | `/api/auth/logout` | session + CSRF | – | destroySession. |
| GET | `/api/invite[?guild_id=…]` | session (demo) | installs in mock (demo only) | Builds Discord authorize URL server-side; client ID/permissions never reach the browser. |
| GET | `/api/guilds` | session | – | List GuildSummary. |
| GET | `/api/guilds/:id/state` | session, design | – | `current` + `draft` + `guild`. |
| PUT | `/api/guilds/:id/draft` | session, design, CSRF | – | Autosave draft + baseDesign. |
| DELETE | `/api/guilds/:id/draft` | session, design, CSRF | – | Discard draft. |
| POST | `/api/guilds/:id/plan` | session, design, CSRF | – | Server-side validate + diff against LIVE state. Read-only. |
| POST | `/api/guilds/:id/apply` | session, design, bot ManageChannels, CSRF | **YES** | The only mutating route. Pre-snapshot → execute → post-snapshot → audit → clear draft. `confirmDestructive` required if any deletes. |
| GET | `/api/guilds/:id/snapshots` | session, design | – | List newest-first. |
| POST | `/api/guilds/:id/snapshots` | session, design, CSRF | – | Manual backup (createBackup). |
| POST | `/api/guilds/:id/snapshots/:snapshotId/restore` | session, design, CSRF | – | `stageRestore` → putDraft + designerUrl. |
| GET | `/api/guilds/:id/template` | session, design | – | Download Monarch template JSON. |
| POST | `/api/guilds/:id/template` | session, design, CSRF | – | `stageImport` (modes: add, replace). Max 2 MB. |
| GET | `/api/guilds/:id/settings` | session, design | – | Designated channels. |
| PUT | `/api/guilds/:id/settings` | session, design, CSRF | – | Save designated channels. |
| POST | `/api/guilds/:id/test-message` | session, design, CSRF | **YES** (sends) | Target Resolver + variable resolution + gateway.sendMessage. |
| GET | `/api/guilds/:id/workspace` | session, design | – | Embed/message designs. |
| PUT | `/api/guilds/:id/workspace` | session, design, CSRF | – | Save embed/message designs. |
| POST | `/api/guilds/:id/workspace/send` | session, design, CSRF | **YES** (sends) | The full workspace pipeline (validate → resolve → render → send → audit). |
| GET | `/api/library/templates` | session | – | The signed-in user's templates (owner-scoped), newest first. |
| POST | `/api/library/templates` | session (+guild access for `source:"guild"`), CSRF | – | Create: `{source:"guild",guildId,name?}` captures the live structure; `{source:"upload",template,name?}` validates a monarch-template payload. Max 2 MB. |
| GET | `/api/library/templates/:id` | session (owner) | – | Full `monarch-template` envelope. `?download=1` sets attachment disposition. |
| PATCH | `/api/library/templates/:id` | session (owner), CSRF | – | `{action:"rename",name}` or `{action:"duplicate"}`. |
| DELETE | `/api/library/templates/:id` | session (owner), CSRF | – | Remove from the library. |
| GET | `/api/guilds/:id/analyzer/dismissals` | session, design | – | "Marked as intentional" check ids. |
| PUT | `/api/guilds/:id/analyzer/dismissals` | session, design, CSRF | – | `{checkId,dismissed}` — toggle one check. checkId is validated against `@monarch/analyzer` CHECKS. |
| GET | `/api/internal/guilds/:id/workspace` | **INTERNAL_API_TOKEN** | – | Bot counterpart of workspace GET. |
| POST | `/api/internal/guilds/:id/workspace/send` | **INTERNAL_API_TOKEN** | **YES** (sends) | Bot counterpart for `/monarch test`. |
| GET | `/api/internal/guilds/:id/backup` | **INTERNAL_API_TOKEN** | – | Top-10 snapshots metadata (bot `/monarch backup` list). |
| POST | `/api/internal/guilds/:id/backup` | **INTERNAL_API_TOKEN** | – | Take a backup now (bot `/monarch backup`). |
| GET | `/api/internal/guilds/:id/template` | **INTERNAL_API_TOKEN** | – | Export template (bot `/monarch export` returns JSON; the bot attaches it as a file). |
| GET | `/api/internal/guilds/:id/prefix` | **INTERNAL_API_TOKEN** | – | The guild's command prefix (`{prefix, customized, default, maxLength}`) — bot cache refill for `!help`/`!status`/matching. |
| PUT | `/api/internal/guilds/:id/prefix` | **INTERNAL_API_TOKEN** | – | `{prefix: "?"}` to change, `{prefix: null}` to reset. Validated with the shared `parseCommandPrefix`; writes `GuildSettings.commandPrefix`. Called by `!prefix set` / `/monarch prefix`. |
| GET | `/api/internal/guilds/:id/confession` | **INTERNAL_API_TOKEN** | – | `{channelId, logChannelId}` — the guild's confession channels (both null = off). Bot cache refill for Confess buttons / modal submits. |
| PUT | `/api/internal/guilds/:id/confession` | **INTERNAL_API_TOKEN** | – | `{channelId: snowflake\|null, logChannelId: snowflake\|null}` — full reconfiguration (both null = disabled). Snowflake-checked; refuses logChannelId === channelId (the log names names). Called by `/monarch confession setup` / `disable`. |

**`guild.userCanDesign` requires `userCanDesign` (ManageGuild/Administrator OR owner)**
at the guild level — `requireGuildAccess` enforces this.

### `apps/dashboard/app/s/[guildId]/*` — pages

| Path | Component | Status |
|---|---|---|
| `/` (overview) | `page.tsx` | Hub: quick actions, recent activity, command cheat-sheet |
| `/s/:id/designer` | `designer/page.tsx` + `DesignerApp` | **Implemented** |
| `/s/:id/embeds` | `embeds/page.tsx` + `BuilderApp kind="embed"` | **Implemented** |
| `/s/:id/messages` | `messages/page.tsx` + `BuilderApp kind="message"` | **Implemented** |
| `/s/:id/history` | `history/page.tsx` + `BackupsPanel` | **Implemented** (Backups & History) |
| `/s/:id/import-export` | `import-export/page.tsx` + `ImportExportPanel` | **Implemented** |
| `/s/:id/library` | `library/page.tsx` + `TemplateLibrary` | **Implemented** (user's template library; install targets this guild) |
| `/s/:id/templates` | `templates/page.tsx` | **redirect → import-export** |
| `/s/:id/settings/channels` | `settings/channels/page.tsx` + `DesignatedChannelsForm` | **Implemented** |
| `/s/:id/analyzer` (nav) | SidebarNav | **no longer `soon`** — live page |
| `/s/:id/roles` | `roles/page.tsx` | **ComingSoon (Phase 5)** |
| `/s/:id/welcome` | `welcome/page.tsx` | **ComingSoon (Phase 5+)** |
| `/s/:id/branding` | `branding/page.tsx` | **ComingSoon** |
| `/s/:id/analyzer` | `analyzer/page.tsx` + `AnalyzerPanel` | **Implemented** (Design Analyzer; read-only) |
| `/select` | `select/page.tsx` | **Implemented** (server list) |
| `/` (landing) | `app/page.tsx` | **Implemented** |

---
### `packages/music` + `apps/bot/src/music` — music player (pure engine + adapter)

`packages/music` (no deps, fully unit-tested):
- `queue.ts` — `MusicQueue`: `add`/`addMany(cap)`, `next()` (loop off/track/queue; the single way playback advances), `remove` (1-based upcoming positions), `clear`, `shuffle`, `cycleLoop`, `snapshot()`.
- `skip.ts` — `SkipElector` per-guild vote sets; required = majority of current listeners (recomputed every vote, departed voters pruned); statuses `counted` / `passed-by-this-vote` / `already`.
- `resolve.ts` — `classifySource`: YouTube watch/youtu.be/shorts/embed/live + `list=` param; Spotify /track /album /playlist, `/intl-xx/` paths, `spotify:` URIs; anything else → search.
- `roles.ts` — `canForceSkip({roleNames, permissions, isCurrentRequester})` → `{allowed, reason: dj|staff|requester}`; `STAFF_PERMISSION_BITS` = Administrator, ManageGuild, MoveMembers, KickMembers, BanMembers, ModerateMembers.
- `format.ts` — `formatDuration` (null → "live"), `parseVolume` (0-150), `volumeToGain`, `progressBar`.

`apps/bot/src/music/` (adapter):
- `sources.ts` — YouTube via **youtubei.js** (search / getBasicInfo / playlists with continuations / `download()` audio); Spotify via the **official Web API** (client-credentials token cached in process, metadata only). Spotify tracks carry `youtubeSearch: "Artist - Title"` and are matched to a YouTube video **lazily at play time** (queuing a 200-track playlist stays instant). Live streams refused. `SourceError` → human-readable replies.
- `player.ts` — `MusicManager`: per-guild AudioPlayer + VoiceConnection driven by the pure queue. Idle handler advances (loop modes decide); `skipping`/`stopping` flags distinguish manual stop from natural end; 3 consecutive failures -> give up + teardown; empty channel -> leave after 60s; idle -> leave after 5min. Announcements post to the last music command's text channel. Volume 0-150 via `resource.volume` (**needs ffmpeg** — `ffmpeg.ts` resolves FFMPEG_PATH -> @ffmpeg-installer/ffmpeg -> system; Docker image ships the apk).
- `commands.ts` — `musicCommandJSON()` (/music: play/pause/resume/skip/queue/nowplaying/volume/loop/shuffle/remove/clear/stop) + `MusicCommands(manager).run(ctx, sub)` — surface-neutral, so `/music play` and `!play` are one code path. Skip: `canForceSkip` -> instant, else vote; controls require being in the bot's voice channel, queue/nowplaying viewable anywhere. Prefix arguments are read positionally (`!queue 2`, `!volume 80`, `!loop track`); `!play` takes the whole rest of the message as the query.
- **Intents:** `GuildVoiceStates` is in BOTH intent sets (not privileged).

### Command catalog (single source of truth)

`packages/shared/src/commands.ts` — `CommandDoc` {name, usage, **prefixUsage, prefixAliases**, group (general|design|moderation|music), summary, who, details?, args?, examples?, notes?} + `COMMAND_GROUPS` / `MONARCH_COMMANDS` / `BURG_COMMANDS` / `MUSIC_COMMANDS` / `COMMAND_CATALOG`. **The bot's `/monarch help` + `!help` embed (`renderHelpEmbeds` in apps/bot/src/commands.ts) and the dashboard Help page (`app/s/[guildId]/help` + `components/help/HelpPanel.tsx`) both render from it** — tests keep catalogs, registered manifests *and* the prefix alias tables in sync (`apps/bot/test/prefix-parse.test.ts`). Adding a command: update the SlashCommandBuilder, add the catalog entry **with its prefix form and aliases**, add the alias + handler case, run the tests (see §12 "Adding a new prefix command").

## 5. Environment variables (`.env.example`)

| Var | Required? | Used by | Notes |
|---|---|---|---|
| `DISCORD_CLIENT_ID` | for real mode | auth + invite | Omit all three for demo mode |
| `DISCORD_CLIENT_SECRET` | for real mode | auth (token exchange) | |
| `DISCORD_BOT_TOKEN` | for real mode | bot + RestDiscordGateway | **Same token on Vercel + bot worker** |
| `APP_URL` | yes | OAuth redirect, bot invocations | Must match Discord app's redirect URI |
| `SESSION_SECRET` | yes (in prod) | session cookies + AES-GCM for OAuth tokens | `openssl rand -hex 32`; rotating invalidates cookies AND stored tokens |
| `DATABASE_URL` | required on Vercel | PrismaStore (pooled URL on serverless) | The file store throws on serverless if this is missing |
| `DIRECT_DATABASE_URL` | only for migrations | prisma migrate | Set to the same as DATABASE_URL for plain Postgres |
| `MONARCH_DEMO` | optional | `isDemoMode` | `"1"` forces demo even with creds |
| `MONARCH_OWNER_USER_ID` | optional but own-protection | bot worker (`apps/bot/src/index.ts` → `MonarchCommands`) | Your Discord user id: targeting it with /burg uno-reverses onto the invoker. Missing = owner burgable like anyone else (worker logs a boot warning). Must be threaded through every deploy path (`render.yaml`, `docker/docker-compose.yml`) — not just `.env.example` |
| `INTERNAL_API_TOKEN` | optional | bot/dashboard server-to-server | `openssl rand -hex 32`; same value on dashboard + bot. Without it `/monarch backup/export/embed/test`, saving a custom prefix, confession setup, and `/api/internal/*` reply 503 — everything else (incl. all prefix commands on the default `!`) still works |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | for Spotify links | bot music | Official Web API, client credentials. Without them `/music` says Spotify isn't configured; YouTube/search work |
| `MUSIC_DJ_ROLE_NAMES` | optional | `/music skip` | Comma-separated role names that force-skip; default `dj` |
| `MUSIC_STAFF_ROLE_NAMES` | optional | `/music skip` | Default moderator/mod/staff/admin/administrator + plurals; real moderation permissions always count too |
| `MUSIC_MAX_QUEUE` / `MUSIC_MAX_PLAYLIST_TRACKS` | optional | bot music | Defaults 500 / 250 |
---

## 6. Security model (recap)

- **Server-side guards on every route** (lib/api.ts): session → guild
  access → user `Manage Server/Administrator` → bot installed → bot
  `Manage Channels` (for apply). Frontend disabling is cosmetic only.
- **CSRF:** all mutating routes check `sec-fetch-site`; cross-site → 403.
- **Session cookie:** `<opaque id>.<HMAC-SHA256>` over `SESSION_SECRET`,
  httpOnly, sameSite=lax, secure iff APP_URL starts https, maxAge 14d.
  **Tokens never reach the browser.**
- **Token at rest:** AES-256-GCM with scrypt-derived key, format
  `v1.<iv>.<tag>.<ciphertext>`. Tag check fails closed (treated as absent).
- **Logger redacts** any key matching `/token|secret|authorization|password|cookie/i`.
- **Internal auth** (bot→dashboard) compares SHA-256 digests in constant time
  so token length isn't leaked.
- **Invite is least-privilege:** no `Administrator`; explicit bitfield built
  from the named permissions Monarch uses. Pre-selected `guild_id` is
  snowflake-validated before being trusted.
- **Raw Discord errors** go to `error.detail` for logs only; the UI sees
  human-readable Monarch errors (`packages/discord/src/errors.ts`).

---

## 7. Testing

- **`npm test`** = vitest at repo root. Includes
  `packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts`.
- **Coverage:**
  - `packages/design-engine` — diff semantics, apply-plan ordering, template
    detachment/merging/rebasing.
  - `packages/validation` — limits, normalization, referential integrity.
  - `packages/discord` — target resolver rules; bot permission calculation
    (`bot-info.test.ts`); full apply-loop integration against mock gateway
    (`gateway.test.ts`); REST gateway endpoint mocking, id caching,
    definitive vs transient failures (`rest-gateway.test.ts`).
  - `packages/schemas` — template envelope, variables.
  - `packages/renderer` — content rendering + variable resolution.
  - `packages/analyzer` — `analyzer.test.ts`: determinism, per-check scoring
    semantics (uncategorized ratio, empty categories, topics, separators,
    capitalization, duplicates, palette focus, color coverage curve, hoist
    discipline, branding weights, palette alignment), dismissal exclusion
    math, @everyone/managed exemptions.
  - `apps/dashboard` — `command-prefix.test.ts` (store round-trip, settings
    form can't clobber it, the internal GET/PUT route incl. auth + validation),
    `backups.test.ts` (createBackup/stageRestore/
    export/stageImport against FileStore + stubbed Discord),
    `library.test.ts` (library store round-trips, owner scoping + hijack
    rejection, save-from-guild/upload, rename/duplicate/delete, envelope
    rebuild, install → stageImport handoff),
    `prisma-store.test.ts` (mappers incl. template rows, AES-GCM round-trip
    + tamper cases),
    `prisma-store.integration.test.ts` (PGlite + applied migrations;
    needs Prisma client — fails in this sandbox),
    `fetch-json.test.ts`, `invite.test.ts`, `workspace-parse.test.ts`.
  - `apps/bot` — `commands.test.ts` (help stays in sync + under 2000 chars,
    prefix line + aliases), `prefix-parse.test.ts` (tokenizer, mention
    prefix, routing, silence rule, **alias tables ⇄ shared catalog**),
    `prefix-registry.test.ts` (TTL cache, peek, degradation, validation,
    internal store HTTP shape), `prefix-commands.test.ts` (fake gateway
    messages through the real dispatcher + real handlers/registries),
    `slash-context.test.ts` (the slash adapter: ephemeral, defer→edit, same
    registries as prefix), `durations.test.ts`, `burg.test.ts`,
    `music-*.test.ts`, `shutdown.test.ts` (drives the real entry point with
    discord.js stubbed; mutation-checked).
  - `packages/shared` — `prefix.test.ts` (prefix legality rules).

- **Test count (most recent reported):** 198 passed, 8 failing in this
  sandbox (the PGlite Prisma integration suite — needs the generated
  Prisma client, which this sandbox can't download; in a normal
  environment those 8 pass and the count is ~206).

---

## 8. Common gotchas / rules to remember

- **New mutations go in `@monarch/discord` `DiscordGateway`.** Both `Rest` and
  `Mock` gateways must implement them. Never call `@discordjs/rest` directly
  from outside the gateway.
- **Discord payload construction is only in `@monarch/renderer`.** Routes,
  components, and packages other than `discord/`+`renderer/` may not build
  raw API shapes.
- **Limits in `DiscordLimits` only.** When Discord changes one, edit
  `packages/validation/src/limits.ts` and nothing else.
- **New ids use the `new_*` prefix.** The diff engine keys on this — do not
  invent a different convention.
- **Bot vs dashboard token use:** both use the same `DISCORD_BOT_TOKEN`.
  Dashboard uses REST through `RestDiscordGateway`; bot owns the Gateway
  connection. Keep exactly one bot worker.
- **`@discordjs/rest` member endpoint is `/guilds/:id/members/:userId`**, not
  `/members/@me` (which only exists for PATCH /nickname). `getBotGuildInfo`
  resolves bot userId from `GET /users/@me` once.
- **`botPermissions === null` ≠ "missing permissions"**, it means "couldn't
  read it right now". Only definitive codes (10004/10007/50001, 403, 404)
  mean "bot not installed".
- **Snapshots are guild-scoped.** `getSnapshot(guildId, snapshotId)` returns
  null for a foreign guild — do not pass `id` alone anywhere.
- **Restore never writes to Discord.** It stages a draft; the user applies
  from the designer. This is intentional.
- **Apply requires `confirmDestructive: true` for any deletes.** Server
  enforces; client surfaces the checkbox.
- **Session tokens in `Session.accessTokenEnc` are AES-GCM.** Rotating
  `SESSION_SECRET` invalidates them all (decryption returns undefined →
  treated as logged out).
- **Generated Prisma client lives at `apps/dashboard/lib/generated/prisma/`
  (gitignored).** Always run `prisma generate` after a schema change
  (root `postinstall` does it on `npm install`).
- **Use a 2-pass strategy when parsing Prisma schema:** back-refs like
  `sessions Session[]` reference model names not yet parsed. (My own
  verification script for the migration↔schema check had to do this — see
  `.verify_migrations.js`-style two-pass parsing.)
- **The file store is dev/demo only.** Never let it run on Vercel —
  `getStore()` throws on serverless without `DATABASE_URL`.
- **Vercel build:** `npx prisma generate --schema ../../prisma/schema.prisma
  && next build` (from `apps/dashboard/vercel.json`).

---

## 9. How to add a new feature (the IA says)

1. **Model in `@monarch/schemas`** — extend, don't fork. New types go in the
   appropriate `*.ts` and are re-exported from `index.ts`.
2. **Limits/rules in `@monarch/validation`.** Add to `DiscordLimits` if
   Discord has a new constraint, then a `Rule<T>` in `*-rules.ts`.
3. **Discord payloads in `@monarch/renderer`.** If it's a new Discord
   feature, add a renderer helper. New gateway capabilities go in
   `DiscordGateway` — implement in **both** `RestDiscordGateway` and
   `MockDiscordGateway`.
4. **Reuse the diff engine + Review modal** for anything that mutates.
5. **Publishing features must accept a `TargetConfig`** (designated key or
   explicit guild+channel+thread). Resolve through `resolveTarget`.
6. **Register the nav entry** in `components/nav/SidebarNav.tsx`.
7. **Slash command** (if any): add to `COMMAND_HELP` + `monarchCommandJSON`
   in `apps/bot/src/commands.ts`. The help test enforces sync + size limit.
8. **Database:** add a model to `prisma/schema.prisma` and a migration in
   `prisma/migrations/<timestamp>_<name>/migration.sql`. The PrismaStore
   mappers update automatically via the field types. The integration test
   re-applies all migrations against PGlite.

**Out of scope:** moderation features (spec §32). `/burg` is a gag,
not a moderation product; the README is explicit on this.

---

## 10. Key gotcha: diff semantics

The diff engine (`packages/design-engine/src/diff.ts`) matches by **id**:
- `new_*` ids → `create` (with `localId` and `detail`).
- Snowflakes not in `current` → `unsupported` (replaced or deleted server-side).
- Snowflakes in both → compare fields, emit `rename` (name changed),
  `modify` (topic/nsfw/slowmode changed), `move` (parentId or position
  changed), or nothing.
- Snowflakes in `current` but not `desired` → `delete` (the only operation
  that makes the plan `destructive`).

**Restore rebase changes this** for snapshot restores: vanished ids are
adopted onto a same-kind/same-name live entity when one exists
(`rebaseDesign` in `compose.ts`), so deleting-and-recreating #rules doesn't
wipe its history. Apply is the only step that actually deletes.

---

## 11. PR / commit log

The repo's local history is shallow — only the merge commits are in the
clone. The detailed history is on GitHub
(`github.com/ArliT1-F/MONARCH/pulls?q=is:pr+is:closed`, 9 closed PRs).
Below is the summary I can confidently reconstruct from those PRs (PR
numbers are the GitHub numbers; commit SHAs in the remote, not local).

### Authoring note

All 9 PRs were opened by the **`arena-ai-coding-agent[bot]`** and merged by
`@ArliT1-F` on the same day they were opened. Local history shows just the
final merge commit on `main`:

| Merge | When | Commit (local) |
|---|---|---|
| Merge PR #9 into main | 2026-09-07 11:52 +02:00 | `037ea3d0a9322d964bba5d5da92769b317fa44cf` |

This is the only commit on `arena/01a08380-monarch` (the Arena session
branch). Reflog:

```
HEAD@{0}: checkout: moving from main to arena/01a08380-monarch
HEAD@{1}: clone: from https://github.com/ArliT1-F/MONARCH.git
```

PR parents of `037ea3d` per the merge object: `f9168c87…` and `458073a8…`,
but those parents are not in our shallow clone (and not needed for code
work — the merge commit already contains the full tree).

### PR-by-PR log (titles, intent, what changed)

| # | Title | Date merged | Theme | Key code paths added/changed |
|---|---|---|---|---|
| 1 | Monarch Phase 1+2: foundation, Discord abstraction, and Server Designer MVP | 2026-09-02 | Bootstrap the whole repo | Monorepo, all 6 shared packages, dashboard shell, Server Designer (drag-and-drop, drafts, undo/redo, Review modal), OAuth2 + demo mode, Prisma schema (no migration yet — the file store was the only backend), Docker compose, architecture docs. `65c1a76` was the squash. |
| 2 | feat: Vercel + Prisma integration (PrismaStore, phase-1.5) | 2026-09-04 | Production persistence + Vercel deploy | `apps/dashboard/lib/prisma-store.ts`, `prisma.ts`, `secure-token.ts`, `prisma/schema.prisma` (9 models + `MockDiscordState`), `prisma/migrations/20260902000000_init`, `prisma.config.ts`, `vercel.json`, `docs/deploying-vercel.md`, Docker `migrate` one-shot service. Tests: 41/41 (17 new + PGlite integration). |
| 3 | Fix Vercel OAuth sign-in: require DATABASE_URL on serverless + Neon deploy docs | 2026-09-04 | Fix `ENOENT .monarch-data` on Vercel | `getStore()` now **throws** a config error on serverless when `DATABASE_URL` is missing. OAuth callback catches storage errors → friendly redirect, clears stale `monarch_oauth_state`. Added Neon URL mapping (pooled `POSTGRES_URL` vs unpooled `POSTGRES_URL_NON_POOLING`) to deploy docs. 3 commits: `5ffe4cf`, `9ca770c`, `d83cb72`. |
| 4 | Invite the Discord bot from the dashboard | 2026-09-04 | First-class bot install UI | `lib/invite.ts` (least-privilege bitfield, never Administrator), `GET /api/invite[?guild_id=]` (server-side redirect so client id stays server-owned), `InviteBotButton` (new tab + `router.refresh()` on focus; demo mode installs against mock), `DiscordIcon` extracted to shared UI, snowflake validation. 7 new invite tests; 40 passing. Commit `3f2c72a`. |
| 5 | Run Discord bot as persistent companion worker | 2026-09-04 | Companion-worker deploy topology | `render.yaml` (Render blueprint), `docker/bot.Dockerfile`, auto-register slash commands on bot startup, doc the Vercel + worker split. 2 commits: `7a253c0`, `565ced5` (config conflict resolution). Commit `9044777`. |
| 6 | Bot: shut down gracefully so redeploys stop looking like crashes | 2026-09-04 | Fix scary `npm error code 143` in worker logs | `apps/bot/src/index.ts` handles `SIGTERM`/`SIGINT` → `client.destroy()` → `exit(0)`. `Events.Error` and `unhandledRejection` logged, not fatal. Slash-command registration is non-fatal. **`CMD ["node", "--import", "tsx", "apps/bot/src/index.ts"]`** so bot is PID 1. Added `apps/bot/typecheck`. New `shutdown.test.ts` (mutation-checked). Commit `fe4435f`. |
| 7 | Embed Builder + Message Designer, /monarch embed & test commands, and bot permission fix | 2026-09-07 | Phase 3+4 (content design) + permission bug | **Bot permission bug fix:** `getBotGuildInfo` previously used `GET /users/@me/guilds/:id/member` (OAuth-only, fails on bot tokens → bogus "missing Manage Channels"). Now uses `GET /guilds/:id/members/:botId` (with `me.permissions` preferred, role-OR fallback). **Embed Builder** (`/s/:id/embeds`) and **Message Designer** (`/s/:id/messages`) with shared pipeline. New: `packages/schemas/src/content.ts`, `packages/validation/src/content-rules.ts`, `packages/renderer/src/content-renderer.ts`, `apps/dashboard/lib/workspace.ts`, `apps/dashboard/components/content/*`, migration `20260907000000_add_guild_workspace` (adds `GuildWorkspace` table). Routes: `GET/PUT /api/guilds/:id/workspace`, `POST …/workspace/send`, plus bot-facing internal counterparts. Bot commands `/monarch embed` and `/monarch test` (Bearer `INTERNAL_API_TOKEN`, constant-time compare). 26 new tests (66 total). Commit `0c89c30` (PR #8 follow-up, see below, was originally the JSON-parse crash fix on these new pages). |
| 8 | Fix JSON.parse crash on Embed Builder / Message Designer | 2026-09-07 | Empty-body / non-JSON 500s crashed `res.json()` in client | New `apps/dashboard/lib/fetch-json.ts` (`readJsonSafe`, `apiErrorMessage`, `networkErrorMessage`). Workspace routes wrapped so they always return JSON 500s; missing-table errors → `code: "db.migration-pending"` with "run npm run db:migrate" fix. `loadWorkspace` validates with `safeParse`; corrupt rows degrade to empty. Same hardening applied to designer, Review modal, designated-channels Send Test, server switcher. 13 new tests (86 total). Commit `0c89c30`. |
| 9 | Backups & Restore, Templates Import/Export, /monarch jail + help, mobile dashboard (+ Publish/Send Test fix) | 2026-09-07 | The big one — Phase 5-ish + UX + bug fix | (1) **Bug fix:** Publish / Send Test wrongly reported "Monarch isn't installed" — `getBotGuildInfo` used a member endpoint that doesn't exist with bot tokens. Now uses `GET /users/@me` for bot userId + `GET /guilds/:id/members/:botId`; definitive 403/404 vs transient errors. Commit `deb29f9`. (2) **Server Designer:** removed the `channel.name.normalized` cosmetic warning (normalizer now mirrors Discord: drops ASCII punctuation only). (3) **Backups & Restore:** `MonarchStore.getSnapshot(guildId, id)` (guild-scoped), `POST /api/guilds/:id/snapshots`, `POST …/snapshots/:id/restore` (stages a draft via `rebaseDesign`, never writes to Discord). (4) **Templates Import/Export:** `GET/POST /api/guilds/:id/template` (downloads detached `monarch-template` JSON; imports in `add`/`replace` mode with `localiseIds`). (5) **Bot:** `/monarch help` (rendered from a single `COMMAND_HELP` manifest; tested to stay in sync + under 2000 chars), `/monarch backup [name]`, `/monarch export` (attaches the .json), `/monarch jail @user [duration] [reason]`, `/monarch unjail`, `/monarch jailed`. (6) **Jail** needs `MessageContent` intent (with Guilds-only fallback), `ManageMessages` permission; Standard Galactic Alphabet relay via per-channel webhook named "Monarch Jail"; `JailRegistry` in-memory (restart releases); durations cap at 28d. (7) **Mobile dashboard:** `GuildShell` becomes top-bar + slide-out drawer below md; touch drag with always-visible handles; 16px inputs on coarse pointers; mobile pane-switching on Designer/Builder. (8) **Docs updated.** 136 tests passing, 8 skipped (Prisma integration). Final commit: `037ea3d`. |

### Migration history (in `prisma/migrations/`)

| Directory | Date (from name) | Adds | Committed in |
|---|---|---|---|
| `20260902000000_init/` | 2026-09-02 (filename) | All 9 base tables (User, Session, Guild, GuildSettings, DesignDraft, DesignVersion, Template, AuditEntry, MockDiscordState) + FKs + indexes | PR #2 |
| `20260907000000_add_guild_workspace/` | 2026-09-07 (filename) | `GuildWorkspace` table + FK to Guild | PR #7 |
| `20260909230000_add_analyzer_dismissed/` | 2026-09-09 (filename) | `GuildSettings.analyzerDismissed JSONB` (Design Analyzer "mark as intentional") | Template Library + Analyzer session |
| `20260912000000_add_command_prefix/` | 2026-09-12 (filename) | `GuildSettings.commandPrefix TEXT` (per-server prefix for text commands) | Prefix commands session |
| `20260912120000_add_confession_channels/` | 2026-09-12 (filename) | `GuildSettings.confessionChannelId TEXT` + `GuildSettings.confessionLogChannelId TEXT` (anonymous confession channel + optional staff log channel) | Confessions session |

`migration_lock.toml` provider is `postgresql`.

### Non-merges worth noting

- **`apps/bot/Dockerfile` entrypoint change** in PR #6 — switching from
  `npm run start` to `node --import tsx` is the entire reason bot deploys
  no longer end in `143`. Easy to revert by accident; don't.
- **`@discordjs/rest` member endpoint choice** in PR #7 and #9 — both PRs
  fixed related bugs around `getBotGuildInfo`. The current implementation
  resolves bot userId from `/users/@me` once, then calls
  `/guilds/:id/members/:botId`. **Don't reintroduce `/members/@me`.**
- **The `Template` model is unused by `PrismaStore`** (intentional, future
  feature). Not a bug.
- **Demo mode store persistence:** in `apps/dashboard/lib/discord.ts`,
  `StoreBackedMockStore` reads/writes mock state via `getStore()`. So
  `MockDiscordState` is what makes demo mode survive restarts.

### Branch conventions

- `main` is the only long-lived branch.
- Each Arena session gets a branch `arena/<id>-monarch` (e.g.
  `arena/01a08380-monarch`). It is branched from `main`, used for the
  session, then merged via a PR (and deleted on merge — see PR #9 event
  log: "deleted the arena/01a079aa-monarch branch"). The current session
  is fixed to `arena/01a08380-monarch`.
- Always push to `arena/01a08380-monarch` only.

---

## 12. Useful patterns to copy when extending

### Adding a new API route (user-facing)

```ts
// apps/dashboard/app/api/guilds/[guildId]/<name>/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonStorageError, requireGuildAccess } from "@/lib/api";
import { getStore } from "@/lib/store";

export async function POST(req: NextRequest, { params }: { params: Promise<{ guildId: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;

  const body = z.object({ /* ... */ }).safeParse(await req.json().catch(() => null));
  if (!body.success) return jsonError(400, { code: "x.invalid", message: "..." });

  try {
    // ... business logic
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't ...");
  }
}
```

### Adding a new internal (bot-facing) route

Same shape, but skip `assertSameOrigin` and `requireGuildAccess`, and use
`assertInternalAuth(req)` first. `userId: "bot"` and `username: "Monarch Bot"`
are the stand-in identity in `apps/dashboard/lib/workspace.ts`.

### Adding a new slash command

1. Add the catalog entry (`CommandDoc`) in `packages/shared/src/commands.ts`
   — `COMMAND_HELP` in `apps/bot/src/commands.ts` derives from it.
2. Add an `.addSubcommand(...)` to `monarchCommandJSON()`.
3. Add the case to `MonarchCommands.run()` in
   `apps/bot/src/monarch-commands.ts`, written against `CommandContext`
   (never against the interaction — that's what keeps both surfaces equal).
4. (If it needs API access) call `this.internalHeaders()` and the
   `/api/internal/...` route; if not, do it locally (e.g. burg relay).
5. `apps/bot/test/commands.test.ts` enforces help-sync and Discord's limits.

### Adding a new prefix command (or alias)

1. Add `prefixUsage` + `prefixAliases` to the command's catalog entry.
2. Add the alias to `MONARCH_PREFIX_ALIASES` / `MUSIC_PREFIX_ALIASES` in
   `apps/bot/src/prefix/parse.ts` (a new top-level surface needs a case in
   `matchCommand` + `runCommand`).
3. Read arguments through `ctx.args` / the option readers — never through
   `message.content`. `apps/bot/test/prefix-parse.test.ts` fails if the alias
   table and the catalog disagree, and `prefix-commands.test.ts` is where the
   end-to-end wiring test goes.

### Adding a new Discord capability

1. Add the method to `DiscordGateway` (`packages/discord/src/gateway.ts`).
2. Implement in **both** `RestDiscordGateway` (real REST) and
   `MockDiscordGateway` (in-memory).
3. Translate errors via `translateDiscordError(e, "context")` from
   `errors.ts` — never throw raw Discord errors upward.
4. (If publish) resolve WHERE through `resolveTarget` from
   `target-resolver.ts`.

### Adding a new validation rule

Add a `Rule<T>` function in `packages/validation/src/{server,content}-rules.ts`
and append it to the rules array. Re-export from `index.ts`. Reuse
`DiscordLimits` for any numeric bound.

### Adding a new Prisma model

1. Add the model + relations to `prisma/schema.prisma`.
2. Create a new migration in `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`
   (use the actual migration date in the prefix; Prisma CLI can do this for
   you with `npm run db:dev`).
3. Add any new fields the PrismaStore mappers need to read/write in
   `apps/dashboard/lib/prisma-store.ts`. The `MonarchStore` interface in
   `lib/store.ts` may need new methods.
4. Both `PrismaStore` and `FileStore` must implement the same interface.
5. The integration test (`prisma-store.integration.test.ts`) will exercise
   the new model automatically once `prisma generate` runs.

### Adding a new "coming soon" page

```tsx
// apps/dashboard/app/s/[guildId]/<feature>/page.tsx
import { ComingSoon } from "@/components/ui/ComingSoon";
export default function Page() {
  return <ComingSoon title="..." phase="Phase 5" description="..." />;
}
```

Add a nav entry to `components/nav/SidebarNav.tsx` with `soon: true` if
needed.

---

## 13. File-by-file "where do I change X" quick lookup

| I want to… | Look here |
|---|---|
| Change the OAuth scopes or callback behaviour | `apps/dashboard/lib/auth.ts`, `app/api/auth/*` |
| Change the session cookie TTL | `apps/dashboard/lib/session.ts` (also update `SESSION_TTL_MS` in `prisma-store.ts`) |
| Change invite permissions or scope | `apps/dashboard/lib/invite.ts` |
| Add a new bot slash command | `apps/bot/src/commands.ts` (builder) + `monarch-commands.ts` (handler) |
| Add a new prefix command / alias | `apps/bot/src/prefix/parse.ts` (alias tables) + the shared catalog's `prefixAliases` |
| Change the default prefix or what a legal prefix is | `packages/shared/src/prefix.ts` only |
| Change how a server's prefix is stored / cached | `apps/bot/src/prefix/registry.ts`, `app/api/internal/guilds/[guildId]/prefix/route.ts`, `GuildSettings.commandPrefix` |
| Change confession channels, embeds, the button/modal flow | `apps/bot/src/confession.ts` (registry + embeds + flow), `app/api/internal/guilds/[guildId]/confession/route.ts`, `GuildSettings.confession*ChannelId` |
| Change the uwu transformer (or anything burg-related) | `apps/bot/src/burg.ts`, `apps/bot/src/durations.ts` |
| Change the diff/apply ordering | `packages/design-engine/src/{diff,apply-plan}.ts` |
| Add a new variable | `packages/shared/src/variables.ts` (CORE_VARIABLES) |
| Change a Discord limit | `packages/validation/src/limits.ts` only |
| Add a new server rule | `packages/validation/src/server-rules.ts` |
| Add a new content rule | `packages/validation/src/content-rules.ts` |
| Change OAuth token encryption | `apps/dashboard/lib/secure-token.ts` (remember rotating `SESSION_SECRET` invalidates everything) |
| Change the bot's graceful-shutdown behaviour | `apps/bot/src/index.ts` `shutdown()` |
| Change the mobile/desktop layout | `apps/dashboard/components/nav/GuildShell.tsx` and individual page components |
| Add a guild setting | `prisma/schema.prisma` + migration, `lib/prisma-store.ts` mappers, `lib/store.ts` interface, `lib/file-backed-store.ts` (or whatever the file store is) |
| Add a bot-to-dashboard route | `app/api/internal/guilds/[guildId]/<name>/route.ts` + `assertInternalAuth` first |
| Add a new sidebar item | `apps/dashboard/components/nav/SidebarNav.tsx` |
| Add a deploy target | `render.yaml` (Render), `docker/*.Dockerfile` (Docker), or `vercel.json` (Vercel dashboard) |
| Bump a dependency | root `package.json` (workspaces) — run `npm install`, then `npm run typecheck` and `npm test` |
| Diagnose a 500 | Check `apps/dashboard/lib/api.ts` `jsonStorageError` → `code: "db.migration-pending"` ⇒ run `npm run db:migrate` |
| Diagnose a "Monarch isn't installed" wrong-error | `packages/discord/src/rest-gateway.ts` `getBotGuildInfo` (definitive vs transient) |
| Diagnose an apply that won't go through | `apps/dashboard/app/api/guilds/[guildId]/apply/route.ts` — bot `ManageChannels` check + `confirmDestructive` |
| Diagnose a bot deploy that ends in 143 | `apps/bot/Dockerfile` `CMD` must be `node --import tsx ...`, not `npm run start` |
| Diagnose "OAuth state expired" | `APP_URL` must match the Discord redirect URI; `monarch_oauth_state` cookie must be sent (same domain) |

---

## 14. What I (the agent) should not do

- Don't add **moderation features**. The spec explicitly says no. `/burg`
  is a gag and stays a gag.
- Don't introduce a **second bot worker** — two Gateway sessions with the
  same token can disconnect each other.
- Don't put `DISCORD_BOT_TOKEN` in a `NEXT_PUBLIC_*` variable — it would
  leak to the browser bundle.
- Don't call `@discordjs/rest` from anywhere outside `packages/discord/`.
  The `DiscordGateway` interface is the seam; the bot's `REST` instance in
  `apps/bot/src/index.ts` is an exception (for slash-command registration
  and gateway events), but for any *new* REST call, add a gateway method.
- Don't hardcode Discord limits. Update `DiscordLimits`.
- Don't use raw Discord JSON in routes or components. Convert through
  `@monarch/renderer` and `@monarch/discord`.
- Don't remove the "never write to Discord from restore" guarantee. It's
  intentional — every restore goes through Review + Apply.
- Don't change the order of the schema file's top comment. The "Keep both
  stores in sync" note in `prisma/schema.prisma` is load-bearing guidance.
- Don't merge the migration directories into one file. Prisma migrate
  deploy is order-sensitive.
- Don't add `Administrator` to the invite permissions. The invite is
  least-privilege by design.
- Don't make the bot persist `BurgRegistry` to the database. In-memory is
  the design choice (see `apps/bot/src/burg.ts` header).
- Don't make the file store work on serverless. The error in `getStore()`
  is the right behaviour.

---

## 15. Open / planned features (per the product IA)

- **Welcome Designer**, **Branding** — placeholder pages with
  `ComingSoon`.
- **Template Library public/shared templates + curated starter gallery**
  (Appendix F items 2+9) — the personal library shipped (§17); a
  `visibility` column and curation surface are still open. Deliberately
  not built yet: cross-user sharing is an abuse-surface decision.
- **`/monarch health`** (Appendix E) — the analyzer package can back it;
  needs an internal route + bot command when picked up.

The product's design philosophy is: anything that mutates structure
goes through the diff + Review + apply pipeline; anything that publishes
content goes through `resolveTarget`; both reuse the same engines.

---

## 16. Role Designer (FEATURE 4, Phase 5) — implemented

> The product IA section above was written before this work; this
> section supersedes the "Role Designer" bullet. Read it as the
> current truth and treat §15 as the historical record.

**Surface.** `/s/:guildId/roles` is a real designer now, not a
`ComingSoon` placeholder. The sidebar entry no longer shows the `soon`
badge (`apps/dashboard/components/nav/SidebarNav.tsx`). The page
(`apps/dashboard/app/s/[guildId]/roles/page.tsx`) reuses the same
session → guild access → bot-installed guards the Server Designer
uses, then mounts the new `RoleDesigner` component
(`apps/dashboard/components/designer/RoleDesigner.tsx`).

**Why it's a sibling component, not a tab in `DesignerApp`.** The
Server Designer is heavily oriented around tree-structured channels
inside categories. Roles are flat. Putting them in the same component
would mean a `roles: vs channels:` switch in the reducer and a parallel
"tree" view in `StructureTree` for one row of data. The sibling
component keeps each reducer small, reuses the existing
`ReviewModal` (which already speaks `ServerDiff`), and reuses the
autosave endpoint (`PUT /api/guilds/:id/draft`) which already accepts
a full `ServerDesign` — the role-only edits overwrite the in-progress
channel edits only if the user switches without saving, which is the
existing semantic.

**Files added (4).**

- `apps/dashboard/components/designer/role-designer-state.ts` —
  reducer + orderedRoles selector. Same shape as `designer-state.ts`
  but scoped to `design.roles`; `ADD_ROLE` produces a role with a
  `new_*` local id, `position = roles.length`, and the default
  permission bitfield of `"0"`.
- `apps/dashboard/components/designer/RoleInspector.tsx` — right-panel
  inspector. Name (with char count), color (hex `<input type="color">`
  + raw text field that accepts paste-from-clipboard hex), position
  (number), hoist, mentionable, and the curated permission grid.
  Managed roles get a read-only "this role is managed by X" panel
  instead of the editor.
- `apps/dashboard/components/designer/RoleDesigner.tsx` — the shell
  (toolbar, mobile pane switch, validation strip, list+inspector
  layout, Review modal). Reuses the `ReviewModal` unchanged.
- `apps/dashboard/app/s/[guildId]/roles/page.tsx` — replaces the
  `ComingSoon` placeholder with the real client component.

**Files extended (6).**

- `packages/design-engine/src/diff.ts` — adds `diffRoles()`, widens
  `DiffCreate.detail` to include `RoleDesign`, and calls `diffRoles`
  from inside `diffServerDesign`. Managed roles are reported as
  `unsupported` (with a reason) when their name is changed and skipped
  entirely when unchanged or being deleted. `diffRoles` returns
  `{ entries, unchangedCount }` so the outer `unchanged` count
  includes roles.
- `packages/design-engine/src/apply-plan.ts` — extends
  `resourceRank()` so creates order as `category → channel → role`
  and deletes order as `role → channel → category`. Extends
  `desiredPositions()` to include roles.
- `packages/discord/src/gateway.ts` — adds `createRole`, `modifyRole`,
  `deleteRole` to the `DiscordGateway` interface.
- `packages/discord/src/rest-gateway.ts` — implements the three role
  methods against `@discordjs/rest`; `colorToInt` converts `#rrggbb`
  to Discord's 24-bit integer form.
- `packages/discord/src/mock-gateway.ts` — implements the same three
  methods against the in-memory store. Managed roles throw
  ("managed and cannot be …") which the test suite asserts. The
  `createRole` mock re-sorts the roles array by position descending
  to match what real Discord returns and what `fetchServerDesign`
  expects.
- `packages/discord/src/executor.ts` — handles `create:role`,
  `rename:role`, `modify:role`, `move:role`, and `delete:role`
  cases. Position sync now walks roles; managed roles are skipped
  (their position is fixed by whoever created them).
- `packages/validation/src/server-rules.ts` — adds `roleNames`,
  `roleLimits`, and `roleDuplicates` rules. `roleNames` flags
  overlong names and malformed `#rrggbb` colors; managed roles are
  exempted from both. The full rule list is registered in
  `SERVER_RULES` so `validateServerDesign` is unchanged at the
  call site.
- `apps/dashboard/app/api/guilds/[guildId]/apply/route.ts` — adds a
  `Permission.ManageRoles` check that only fires when the diff
  actually contains role changes (the same "POSITIVELY know it's
  missing" pattern as the existing `ManageChannels` check). The audit
  summary now breaks down into `+N ~N -N (channels … · roles …)`.

**Tests added (10).**

- `packages/design-engine/test/diff.test.ts` — 6 new role cases:
  create-via-local-id, rename-bundles-field-changes, modify-emitted-
  when-only-fields-change, managed-roles-not-deleted, managed-renames-
  flagged-unsupported, position-changes-are-moves. Existing
  `unchangedCount` expectations bumped from `4` to `7` to account
  for the three roles in the test fixture.
- `packages/discord/test/role-executor.test.ts` (new file) — 4 cases
  covering the full draft → diff → apply → re-fetch loop through
  `MockDiscordGateway`: end-to-end create/modify/rename/reposition/
  delete (with a managed MEE6 role in the fixture to prove it's left
  alone); managed roles can't be deleted or modified; created role
  ids land in `ApplyResult.createdIds` for draft rebasing.
- `packages/validation/test/server-rules.test.ts` — 6 new role
  validation cases covering the well-formed / overlong / malformed-
  color / over-limit / duplicate / managed paths.

**Spec coverage.**

- FEATURE 4 (Role Designer) — partially fulfilled. Name, color,
  hoist, mentionable, and the curated permission grid are done.
  Drag-reorder of roles is not (deferred; position is editable as a
  number). The full permission editor (every Discord permission
  flag) is not (deferred; curated grid covers the common ones).
  Both deferrals are noted in `docs/objective.md` Appendix G.
- §32 boundary — held. The role operations are all server-level
  (guild roles), no DMs, no per-user state, no private reads.
  Managed roles are read-only by design (they reflect what Discord
  gives us — `managed: true`).

**Why the audit summary changed.** Before this work, the summary
was `Applied N change(s): +3 ~1 -0`. With roles, the totals would
have been misleading (e.g. "+2 channels, +1 role, ~0 channels,
-1 role" would have read "+3 ~0 -1"). The new format
`Applied N change(s): +N ~N -N (channels +c ~c -c · roles +r ~r -r)`
splits by resource so the audit log reader can tell at a glance
which surface was changed.

**Migration.** None. `ServerDesign.roles` is already in the schema
(`packages/schemas/src/server-design.ts` line 47) and is part of
the existing `prisma/migrations/20260902000000_init/` shape
(roles live inside `DesignDraft.design` and `DesignVersion.design`
as JSON, which the schema accepts).


---

## 17. Template Library (FEATURE 7, Phase 6) — implemented

> Supersedes the "Template library UI" bullets in §15 / Appendix C / F of
> `docs/objective.md`; read those as history.

**Surface.** `/s/:guildId/library` (`components/library/TemplateLibrary.tsx`),
nav entry "Template Library" in the Library section. The library itself is
**per-user** (Template rows are owned by their creator); the page lives in a
guild context so "install" always has a concrete target.

**What it does.**

- **Save this server as a template** — POST `/api/library/templates`
  `{source:"guild", guildId, name?}` → `fetchCurrentDesign` → `buildTemplate`
  (ids detached, designatedChannels reset) → stored. Requires the same
  guards as export (member + Manage Server + bot installed).
- **Upload** — POST `{source:"upload", template, name?}` — the payload is
  validated with `parseServerTemplate` before it enters the library.
- **Manage** — list (newest first, with category/channel/role counts derived
  from the payload, never stored), rename, duplicate (`"(copy)"` suffix),
  download (`?download=1` → attachment with a slug-based filename), delete
  (confirm). All owner-scoped by session: a foreign id is a plain 404.
- **Install** — "Install (add)" / "Replace structure": the client GETs the
  envelope and POSTs it to the EXISTING guild import endpoint
  (`POST /api/guilds/:id/template`), so installs always land as a staged
  draft in the Server Designer with the full diff. The library never writes
  to Discord. Replace mode warns with `confirm()` first (final confirmation
  still happens at apply).

**Storage.** `TemplateRecord { id, ownerId, name, type, format, data,
createdAt, updatedAt }`. The envelope columns (type/format) are split from
`data` so a download can rebuild a valid envelope. PrismaStore:
`updateMany({where:{id, ownerId}})` + create fallback so one user can never
overwrite another's row. FileStore: `templates.json`, same ownership
invariant (`putTemplate` throws on cross-owner id collision — unit-tested).

**Envelope safety.** `templateEnvelope(record)` re-parses the rebuilt
envelope before serving it; a row written by an older/buggier version
degrades to `template.corrupt` (410) instead of downloading junk. (The
first implementation read `parsed.data` — undefined — instead of
`parsed.template`; the library tests caught it before any user could.)

**Routes.** See the route table — `/api/library/templates[...]` (GET list /
POST create / GET+PATCH+DELETE per id). Mutations check `assertSameOrigin`;
everything is session-scoped; `source:"guild"` additionally runs
`requireGuildAccess`.

---

## 18. Design Analyzer (FEATURE 9, Phase 7) — implemented

> Supersedes the "Design Analyzer" bullets in §15 / Appendix C / F of
> `docs/objective.md`; read those as history.

**Surface.** `/s/:guildId/analyzer` replaces the ComingSoon placeholder
(nav: "Design Analyzer", no `soon` badge). Read-only by spec — the page
never writes to Discord; the only mutation is the per-guild "marked as
intentional" list, which is Monarch settings, not Discord state.

**Pipeline.** Page (server component): `fetchCurrentDesign(guildId)` →
`store.getAnalyzerDismissals(guildId)` → `analyzeServerDesign(current,
{ dismissed })` → serializable report into `AnalyzerPanel`. No analyzer API
route is needed for the report itself; dismissal toggles go through
`PUT /api/guilds/:id/analyzer/dismissals` (CSRF + `requireGuildAccess`,
`needBot:false`; `checkId` is validated against the package's CHECKS so the
stored list can't fill with junk) and then `router.refresh()` re-renders the
server-computed report.

**Scoring model.** 15 checks in 4 categories (organization/naming/roles/
branding, weights .3/.3/.2/.2). Check scores are 0..1 with partial credit
where a ratio is fairer (e.g. share of categorized channels); each category
averages its non-dismissed checks (checks may carry intra-category weights —
`org.has-structure` is weighted 3× so a near-empty server can't ride to a
high score on vacuous passes); overall is the weighted mean. Deterministic —
same design, same score. Category ids are stable API: they are the keys in
`GuildSettings.analyzerDismissed`.

**Dismissed checks** stay visible in the report (greyed, `dismissed: true`,
raw score preserved) but are excluded from all averages — "intentional"
issues stop dragging the score down without hiding the fact they exist.
`dismissedCount` is shown in the hero. All-dismissed categories score 100
by definition (nothing left to flag).

**Storage.** `GuildSettings.analyzerDismissed` (Json?, string[] of check
ids) — new migration `20260909230000_add_analyzer_dismissed`. Access goes
through `getAnalyzerDismissals`/`putAnalyzerDismissals`, deliberately NOT
through `GuildSettingsRecord`, so the designated-channels form and the
analyzer can't clobber each other (the Prisma settings update only writes
the 4 channel columns anyway).

**Export.** "Export report (.md)" builds a Markdown report client-side
(scores + every suggestion with affected entities) and downloads it via a
Blob — no API round-trip.

**UI conventions.** Score colors reuse the documented breakpoints (green
≥ 80, yellow ≥ 60, red < 60 — same as the proposed `/monarch health`).
Failing checks render ⚠ + suggestion (title/detail/fix/affected chips);
passing-but-advisory checks (e.g. palette alignment without a defined
palette) render an "advisory" pill with the nudge.

**Not in this iteration** (recorded for the next session):
- `/monarch health` (Appendix E) — the package can back it via an internal
  route; not wired.
- "Not much to analyze yet" empty-state messaging beyond the
  `org.has-structure` suggestion.
- Public/shared templates and the curated starter gallery (Appendix F 9).

---

## 19. Prefix (text) commands — implemented 2026-09-12

**Ask:** "i want to also have prefix commands." Chosen shape (the user picked
all four): **per-server prefix set from the bot only** (`per_guild_bot_only`),
surface **mirrors the slash tree plus short aliases** (`mirror_plus_short`),
**every** command group covered (`all`), **full docs pass** (`full`).

**Rule of the feature: one handler, two surfaces.** Prefix commands are *not*
a parallel implementation — `PrefixCommandContext` implements the same
`CommandContext` that `SlashCommandContext` does, and `MonarchCommands.run` /
`MusicCommands.run` / `burg` never learn which one they got. Anything that
makes them diverge is a bug: `apps/bot/test/slash-context.test.ts` exists to
catch exactly that (same burg registry instance, same moderation checks,
ephemeral ⇒ flag 64 on slash and absent on text, `/monarch backup` defers and
edits *once*).

### Files

| Path | What it is |
|---|---|
| `packages/shared/src/prefix.ts` | Prefix legality + defaults (see §4). Only place that decides "is this a valid prefix". |
| `apps/bot/src/prefix/parse.ts` | Pure tokenizer/router: `parseArgs`, `extractPrefixCommand`, `matchCommand`, `commandWordCount`, alias tables. No I/O, no discord.js beyond types. |
| `apps/bot/src/prefix/context.ts` | `PrefixCommandContext` + `PrefixInvocation` + `canReplyIn`. |
| `apps/bot/src/prefix/registry.ts` | `PrefixRegistry` (60 s TTL, negative caching, `peek`/`get`/`candidates`/`set`), `PrefixStore` seam, `internalPrefixStore`. |
| `apps/bot/src/prefix/dispatch.ts` | `handlePrefixMessage(message, deps)` — the gateway side; returns whether Monarch answered. |
| `apps/bot/src/context.ts` | `CommandContext` interface (was slash-only; now the contract both surfaces implement). |
| `apps/bot/src/monarch-commands.ts` | Handlers + the new `prefix` subcommand (`show`/`set`). |
| `apps/dashboard/app/api/internal/guilds/[guildId]/prefix/route.ts` | `GET`/`PUT` — Bearer `INTERNAL_API_TOKEN`, snowflake-checked, `parseCommandPrefix`-validated, `GuildSettings.commandPrefix` NULL = default. |
| `prisma/migrations/20260912000000_add_command_prefix/` | Adds that column (Postgres; Prisma auto-maps it on SQLite for the file store). |
| `apps/dashboard/components/help/HelpPanel.tsx` | Renders `prefixUsage` + aliases per group + a "Prefix commands" block (the dashboard has **no** prefix UI, per the chosen scope — this is read-only documentation). |
| `packages/shared/src/invite.ts` | The invite link both surfaces hand out (`!invite` ⇄ the dashboard's invite button). |

### Matching order (and why)

1. **`@Monarch` mention** — always works, zero API calls, and it is the only
   way to run a command when somebody set a prefix you don't know.
2. **Text prefixes, longest first** — `candidates` = `[default, guild prefix]`;
   longest-first so `m!!` wins over `m!`, and case-insensitive (`!HELP`).
3. Whatever follows is tokenized by `parseArgs` — **no punctuation guard**:
   `hey` is rejected by the *prefix* rules, not by the matcher.

Then `matchCommand` decides the response policy:

| Message | Result | Why |
|---|---|---|
| `!play despacito` | runs `music play` | |
| `!monarch burged` / `!music play x` | runs the full path | mirrors the slash tree |
| `!monarch` (bare group root) | help reply | ambiguous *our* prefix ⇒ teach |
| `!frobnicate` | **silence** | another bot's prefix is not our business |
| `!` (bare) | silence | |
| `@Monarch` (bare) | greeting | an explicit mention deserves an answer |
| `@Monarch frobnicate` | "I don't have that command" | a mention is unambiguous |

Silence on unknown `!words` is the deliberate design decision — a server with
three bots would otherwise get three "unknown command" replies per typo.

### Caching / degradation

`PrefixRegistry.peek(guildId)` is the **sync** cache read used to decide "could
this message possibly be mine" *before* any `await`. Careful: a cached `null`
means "this server has no custom prefix" — an answer, not a miss (that bug
cost a full-suite pass once; `prefix-registry.test.ts` now pins it).
`resolve()` validates whatever comes back from the store with
`parseCommandPrefix` and falls back to the default + a warn log, so a corrupt
row can never break matching. Store failure ⇒ default prefix still works
(`get()` returns null, never throws). `set()` writes through and refreshes the
cache entry.

### Wiring in `index.ts`

```ts
const prefixes = new PrefixRegistry(internalPrefixStore(appUrl, token));
const monarch = new MonarchCommands(...);   // shared with the slash surface
const prefixDeps: PrefixDeps = {
  client, burg, monarch, music, prefixes,
  enabled: () => messageContentEnabled,   // MessageContent intent gates text commands
};
```

`onMessage` order matters: **prefix dispatch first, then the burg
relay.** A burg'd user's `!burged` still runs as a command instead of being
relayed — that's intentional (commands win over the gag), and it's asserted in
`prefix-commands.test.ts`.

### Gotchas learned the hard way

- **Display prefix ≠ invocation prefix.** Replies must quote something the
  reader can type. `ctx.commandPrefix` is resolved by the dispatcher as
  `await deps.prefixes.get(guildId)` even for mention invocations (a raw
  `<@123>` in a help embed is useless). Help/status read `ctx.commandPrefix`
  directly — never re-query the registry inside a handler (that double lookup
  made slash `/monarch help` quote the guild prefix... correctly by accident,
  and wrongly on the text surface).
- **`allowedMentions`.** Both surfaces always send an explicit policy
  (default `{parse: []}`), so a `!burg <@someone>` reply — or an `@everyone`
  inside a burg reason — can't ping the room.
- **Durations.** `parseDuration` needs digits+unit (`10m`, `1h30m`).
  `parseGagArgs` classifies a *duration-shaped* word it can't parse
  (`ten minutes`, `0m`) as an error ⇒ `DURATION_ERROR`; a non-time word
  (`forever`, `because reasons`) is a reason. Only the text surface can
  produce that error — slash has a validated duration option.
- **Text commands are public.** No ephemeral flag; `replyHidden` just calls
  `reply`. Anything that would leak a secret must not be a command output.
- `defer()` on the text surface posts "⏳ Working on it…" then edits; the
  slash surface defers for real. `/monarch backup` therefore *must* be
  assert-on-the-API-snapshot in tests, not on a fixed filename.
- The file store round-trips through SQLite, so `commandPrefix` there is a
  plain string column; `lib/store.ts` + `lib/prisma-store.ts` both map it and
  `updateGuildSettings` must not drop it when a settings form is saved
  (regression-tested in `apps/dashboard/test/command-prefix.test.ts`).

### Who may run what (follow-up, same session)

Text commands put a bot in every member's reach, so the split is explicit:

| Open to every member | Needs Manage Server / Administrator | Needs Administrator / Kick Members |
|---|---|---|
| `help` · `dashboard` · `status` · `invite` (`add`) · `prefix` **show** · all read-only music (`queue`, `nowplaying`, `play`, `skip` by vote) | `prefix set`/`reset` · `backup` · `export` · `embed` preview · `test` | `burg` · `burged` |

None of the open ones read or change server data — they are links and status.
`!invite` deliberately hands the install link to *anybody*: Discord's install
dialog only offers servers the clicker can manage, and the link carries exactly
`INVITE_PERMISSIONS` (never Administrator), so it grants nothing. It needs an
application id: `DISCORD_CLIENT_ID` on the worker, else the bot's own user id
(the dispatcher late-binds `MonarchCommands.botUserId`), else it says what's
missing and points at the dashboard's invite button.

### Deliberately **not** done (out of the chosen scope)

- No dashboard UI for the prefix (bot command only) — the Help page documents it.
- No per-channel or per-role prefixes, no prefix in DMs (guild-only commands).
- No second bot worker, no new permissions, no raw REST outside
  `packages/discord` (the internal-API fetch is the documented exception).
- BurgRegistry stays in-memory (a restart still releases burgs).


---

## Confessions session (2026-09-12)

**Feature:** an anonymous confession channel per guild. `/monarch confession
setup [channel] [logs]` (Manage Server / Admin) stores the public confession
channel (default: the channel where the command is run) plus an optional
**staff-only log channel** through the internal API, then posts a "starter"
confession. Every confession embed carries a **Confess** button; the button
opens a modal (paragraph input, 3–2000 chars) and the submission is posted:

1. **publicly** — to the confession channel as a fully anonymous embed
   (no author/username/avatar/timestamp, `allowedMentions: {parse: []}`), and
2. **to staff** — to the log channel with everything: who (`<@id>`), when
   (`<t:…:F>`), the full text, and a link to the public message.

`/monarch confession disable` switches it off (old messages stay; their
buttons then answer "confessions aren't set up"). The confessor's id is
otherwise never stored — outside the log channel a confession is
untraceable by design. The log channel must differ from the confession
channel (the route and the registry both refuse it).

### Where it lives

- **Bot:** `apps/bot/src/confession.ts` — `ConfessionRegistry` (TTL cache +
  `ConfessionStore` seam, same pattern as `prefix/registry.ts`; degrades to
  "off" when the dashboard is unreachable), `internalConfessionStore`,
  embed builders (`starterEmbed`, `confessionEmbed`, `confessionLogEmbed`),
  `confessButtonRow` / `confessionModal` (ids: `monarch:confession:*`), and
  the button→modal→post flow (`handleConfessButton`, `handleConfessSubmit`).
  `index.ts` routes button/modal interactions to the flow with its own error
  net; `monarch-commands.ts` holds the setup/disable handlers.
- **Context:** `CommandContext.getSubcommand()` — new, for subcommand-group
  commands. Slash reads `options.getSubcommand(true)`; prefix returns the
  first argument word (`setup` in `!confession setup`). Flat commands never
  call it.
- **Manifest/catalog:** `/monarch confession` is a subcommand **group**
  (setup + disable) in `monarchCommandJSON()`; the shared catalog gained a
  `community` group (icon 🤫) and the `/monarch confession` doc
  (`prefixAliases: ["confession"]`, alias table entry in
  `prefix/parse.ts`).
- **Dashboard/store:** `GuildSettings.confessionChannelId` /
  `confessionLogChannelId` (migration `20260912120000_add_confession_channels`),
  `MonarchStore.getConfessionChannels` / `putConfessionChannels`
  (FileStore: `confession-channels.json`, deliberately outside
  `GuildSettingsRecord` like the command prefix), PrismaStore via upsert,
  internal route `…/guilds/:id/confession` (GET/PUT, snowflake-checked).
- **Tests:** `apps/bot/test/confession.test.ts` (registry cache/degradation/
  validation, embed anonymity, flow with fake interactions),
  `apps/bot/test/prefix-commands.test.ts` "confession commands (prefix
  surface)" (end-to-end through `handlePrefixMessage`),
  `apps/bot/test/commands.test.ts` (group manifest),
  `apps/dashboard/test/confession.test.ts` (store round-trip + routes on
  FileStore).

### Notes

- **Who may run what:** confessions *setup/disable* need Manage Server /
  Administrator; **confessing is open to everyone** (button + modal need no
  permission) — same bucket as playing music.
- The prefix surface reads channel mentions positionally (first = channel,
  second = logs); slash uses typed `channel` / `logs` options restricted to
  GuildText.
- A broken log channel never eats a confession: the public post goes first,
  the log is best-effort, and the submitter gets an ephemeral heads-up when
  the log failed.
- `fakeMessage` in `prefix-commands.test.ts` now collects its sent messages
  in `sentMessages` (per-message `edit` spies) — vitest's
  `mock.results[].value` is unreliable for async implementations in this
  setup (records `{}`), which is why deferred-placeholder assertions read
  from `sentMessages` instead.
