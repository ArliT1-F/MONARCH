# Engineering audit and first implementation tranche

Date: 2026-10-14. Base: `758787a6f0a2e5c464c15fa1de6c5b8a39fcc413`.
Branch: `arena/85a24770-monarch`. The working tree was clean at audit start.

**Status: partial delivery, not completion of the full roadmap.** This tranche
focuses on security/configuration, deployment correctness, persistence safeguards
and CI. The operation/recovery foundation must precede blueprints and further UI.
No existing product feature was removed. No music implementation was modified.

## Audit checklist and classification

The inspection covered workspace manifests/lockfile, Next and bot entry points,
authentication/session/encryption, API guards and routes, both persistence adapters,
Prisma schema/migrations/configuration, Docker/Render, existing tests and feature
pages, server-design schema/diff/planning/execution, template/restore workflows,
shared permissions/logging and deployment/architecture documentation. Music
interfaces and existing regression tests were retained, not redesigned.

| Finding | Classification | Verified status / disposition |
| --- | --- | --- |
| Neon URL in `.env.example` despite old “redacted” documentation | Confirmed credential exposure | Removed; external password rotation **still required** |
| Published fallback SESSION_SECRET in production | Security weakness | Production rejects missing/default/short/low-variety secrets |
| Missing Discord credentials implicitly enable demo | Security weakness | Demo now explicit development/test only; production rejects it |
| `Math.random()` server IDs | Security weakness | CSPRNG identifiers; signature already protected cookie integrity, so no session takeover exploit claimed |
| OAuth state cookie lacks Secure; state has no signed deadline | Security weakness | Shared cookie flags and signed ten-minute expiry; route tests added |
| File-store sessions do not expire server-side | Confirmed defect | Legacy/new session expiry enforced; cookie and Prisma TTL share one constant |
| Prisma logout swallows every delete failure | Confirmed defect | Idempotent deleteMany propagates actual storage failures |
| Origin guard relies only on optional Fetch Metadata | Defense-in-depth / missing coverage | Configured-origin check plus metadata; missing evidence rejected; no demonstrated browser exploit claimed |
| Known/weak internal token accepted | Security weakness | Production disables unusable token; constant-time digest comparison preserved |
| Public APP_URL reused for Docker bot calls | Confirmed deployment defect | Separate DASHBOARD_INTERNAL_URL; API destinations and public links tested |
| Missing DB rejected only on Vercel/Lambda | Reliability weakness | Every production runtime requires PostgreSQL; no fallback after initialization failure |
| Corrupt/unreadable JSON interpreted as empty store | Data-loss risk | Only ENOENT treated as empty; other errors propagate without overwriting |
| Prisma 7 datasource.directUrl | Confirmed configuration defect | Installed type supports only datasource.url/shadowDatabaseUrl; CLI now selects direct URL as url |
| Missing CI | Missing developer workflow | SHA-pinned, read-only GitHub Actions workflow added |
| Role Designer/Analyzer documented as placeholders | Documentation inconsistency | Actual pages/services exist; architecture status corrected |
| Jail vs customization-only positioning | Existing scope exception | Architecture already records opt-in exception; retained, not expanded; permission caveat corrected |
| Unhandled apply/persistence exceptions and uncertain outcomes | Confirmed reliability gap | **Deferred to next tranche** with durable operations and injected failure tests |
| Concurrent drafts/templates / file-store read-modify-write | Reliability gap | **Deferred**; no claim of concurrency safety |
| Blueprint identity maps, drift, safe undo, permission editor, health/studio/onboarding expansion | Proposed new features | **Not implemented in this tranche** |

Only one historical commit is available locally. Historical credential exposure
before that commit cannot be bounded here; no history rewriting was attempted.

## A–C. Changes and working functionality

### Security and production configuration

- `.env.example`, `docs/bug-audit.md`: remove credential, correct incident guidance.
- `apps/dashboard/lib/config.ts`, `env.ts`: pure validation and live server-side
  environment resolution; explicit demo, required PostgreSQL, strict public URL
  origins, production session-secret checks, internal-token disablement.
- `apps/dashboard/next.config.ts`, `instrumentation.ts`: validate startup/runtime
  initialization without requiring production credentials for builds.
- `apps/dashboard/lib/keys.ts`, `session.ts`, `auth.ts`, `secure-token.ts`: CSPRNG
  session IDs (via store), purpose-separated signing, expiry, revocation, unchanged
  encrypted-token format; random signed expiring OAuth state.
- `apps/dashboard/app/api/auth/{login,callback,logout}/route.ts`: integrate state,
  flags and structured failures; token endpoint/network exceptions handled.
- `apps/dashboard/lib/api.ts`, `internal-auth.ts`: stricter origin guard, fail-closed
  auth configuration, safe storage errors without raw driver exception logging.

### Deployment and persistence

- `apps/dashboard/lib/store.ts`, `prisma-store.ts`: production storage selection,
  bounded sessions, no false successful logout, no corrupt-file empty fallback.
- `prisma.config.ts`: use DIRECT_DATABASE_URL as CLI datasource.url when supplied;
  runtime still uses DATABASE_URL. Schema edits are comments only.
- `apps/bot/src/dashboard-config.ts`, `index.ts`, `monarch-commands.ts`: independently
  configurable internal API origin, normalized/validated URLs, public links kept
  public. Existing clients retain APP_URL fallback compatibility.
- `docker/docker-compose.yml`, `docker/dashboard.Dockerfile`, `render.yaml`: mandatory
  secrets, no default database password, service-name networking, production worker
  mode, reproducible install, missing workspace manifests included in build context.

### CI, regression coverage and documentation

- `.github/workflows/ci.yml`: immutable action SHAs, read-only contents permission,
  no persisted git credentials, concurrency cancellation, timeout, npm ci, schema
  validation, typecheck, full tests (including migrations through PGlite), build and
  secret scanning. No production credentials or external Discord account required.
- `scripts/scan-secrets.mjs`, `scripts/test/*`, `package.json`, `vitest.config.ts`:
  dependency-free scanner with positive/negative controls and CLI redaction tests;
  all credential material redacted, including allow-list reasons.
- New dashboard tests: `config`, `session-security`, `api-security`, `oauth-routes`,
  `storage-security`. New bot `dashboard-config` tests and prefix API/public-link
  routing regression. Existing invite fixture now explicitly requests demo mode.
- Existing `apps/bot/test/jail-manager.test.ts`: add a real union narrowing after
  assertion (Vitest matcher did not narrow TypeScript); no jail logic changed.
- `docs/security.md` is the primary configuration/upgrade guide; README and hosting
  guides link to it. Architecture now distinguishes real Role Designer/Analyzer
  from planned Welcome Designer/Branding pages.

No new blueprint, operation ledger, permission editor or onboarding UI is claimed.

## D. Tests and validation

Executed commands (final counts recorded after all code changes):

| Command | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Initial install's postinstall failed because binaries.prisma.sh is blocked in this sandbox |
| `npm ci --no-audit --no-fund --ignore-scripts` | Passed; installed locked dependencies without lifecycle scripts |
| `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true npx prisma generate` | Passed; generated the real Prisma TypeScript client without schema-engine download |
| `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true npx prisma validate` | Passed; Prisma's schema validation reported valid (WASM path; no migration engine invoked) |
| `npm run typecheck` | Passed after fixing the existing jail test narrowing |
| `npm test` | Final run: **55 files, 720 tests passed** |
| `npm run security:scan` | Passed, zero findings in scanned current source; does not certify history/binaries/ignored files |
| `NEXT_TELEMETRY_DISABLED=1 npm run build` | Passed, including dashboard compile/type validation/static generation |
| `git diff --check` | Passed |
| `env -u SESSION_SECRET -u DATABASE_URL -u DISCORD_CLIENT_ID -u DISCORD_CLIENT_SECRET -u DISCORD_BOT_TOKEN -u APP_URL NODE_ENV=production npm run start --workspace @monarch/dashboard` | Final startup probe exited **1**, naming missing variables without values; no listener remained |

The /bin/true environment override only bypassed the unnecessary binary download
for client generation/schema validation; it must **never** be used for migrations.
No production database was contacted. The integration suite used real PostgreSQL
via PGlite and the production Prisma driver adapter, applying all existing SQL
migrations. The first baseline run before generation had 576 passing tests and
five suites unable to import the not-yet-generated client, not five product regressions.

Also ran targeted regression suites during development and a formatting pass
using `npx --yes prettier@3.5.3 --write` on changed source/configuration files (no
project dependency added; unrelated formatting churn removed from large bot files).

**Not executed:** Docker/Compose builds or deployment (Docker unavailable), live
Discord OAuth/permission changes/voice playback, external credential rotation,
production migrate deploy, and GitHub-hosted CI itself. No PR/push/deploy was made.
GitHub's official workflow-syntax document was consulted through the github/docs
repository via `gh api`, since docs.github.com was outside sandbox network access.

## E, G. Configuration and safe deployment

1. Rotate the exposed Neon password and update secret stores first.
2. Back up PostgreSQL (and any development .monarch-data) and preserve the existing
   SESSION_SECRET unless deliberately forcing token/session rotation.
3. Configure production APP_URL as the exact public HTTPS origin, strong
   SESSION_SECRET, DATABASE_URL, Discord OAuth/bot credentials; **unset MONARCH_DEMO**.
4. Generate an independent INTERNAL_API_TOKEN on both dashboard and worker to
   enable internal commands; missing/unusable dashboard token returns 503 safely.
5. Set worker NODE_ENV=production. Set DASHBOARD_INTERNAL_URL only when a separate
   reachable API origin is needed; Docker defaults it to http://dashboard:3000.
6. Install using `npm ci`, run `npm run db:migrate` with the correct direct URL,
   then typecheck, test and build. There are **no new schema migrations** in this
   tranche; applying existing pending migrations remains necessary.
7. Deploy the dashboard and exactly one worker. Docker:
   `docker compose --env-file .env -f docker/docker-compose.yml up --build -d`.
   Supply POSTGRES_PASSWORD and all required variables; configure TLS externally.
8. Sign in again, confirm guild authorization and draft/history access, then test
   a harmless bot internal command. Verify no private service URL appears in links.
   Test Discord mutations only in a disposable guild after taking a manual snapshot.

See [security.md](security.md) for topology differences, CSRF client compatibility,
rotation, backups and internal API diagnosis.

## F. Remaining work / next implementation checklist

1. Apply service: catch unexpected failures, retain individual outcomes, distinguish
   pre-mutation failure, partial apply, uncertain network outcomes, and post-Discord
   persistence failures. Keep the draft if required persistence fails.
2. Durable operation model in both adapters, additive migration, idempotency keys,
   per-guild concurrency/claiming, step persistence and authorized history UI.
   Reconcile actual Discord state before any retry. No automatic whole-plan retry.
3. Safe recovery previews with intervening-change checks. Existing snapshot restore
   only stages a draft; it is not universal rollback and may adopt by kind/name.
4. Optimistic draft/template/workspace concurrency with conflict-preserving UI;
   transaction/failure integration tests. File-store multi-writer safety is not solved.
5. Blueprint extensions to the existing ServerDesign model, stable identity maps,
   strict portable schema, unmanaged-resource-safe planning, selected apply and drift.
6. Discord-correct permission evaluation/editor; evidence-based health findings;
   tracked managed-message revisions/shared components; onboarding and richer local
   template library. Do not create UI-only completion claims.
7. Complete credential/logging review across unrelated call sites: the shared logger
   still only redacts top-level sensitive keys. This tranche avoids raw exceptions
   at the changed authentication/storage paths but is not a universal log scrubber.
8. If required by a future threat model, implement a server-side OAuth nonce replay
   ledger. Current protections are signed expiry, matching/cleared browser cookie
   and Discord's one-time code exchange; stolen-cookie replay is not separately tracked.
9. Continue jail lifecycle/privacy verification in a disposable Discord guild;
   preserve the existing opt-in scope exception and do not expand moderation features.
10. Run Docker, hosted CI, production-like PostgreSQL migration rehearsal and live
    Discord end-to-end checks before shipping to users. No music rework is needed.

## H. Risk assessment

- **Expected sign-out:** purpose-separated cookie signatures reject pre-upgrade
  cookies; users must sign in again. Old pending OAuth attempts also restart.
- **Encrypted tokens:** v1 AES-GCM/scrypt stays compatible if SESSION_SECRET stays
  unchanged. Secret rotation requires reauthentication or a separately reviewed
  re-encryption migration; no hidden key fallback or destructive migration added.
- **Strict config:** deployments relying on implicit demo, weak secrets, HTTP public
  URLs or production file storage now refuse to initialize. This is intentional.
- **CSRF compatibility:** clients missing both Origin and positive same-origin
  metadata are rejected. Configure the exact public origin; do not trust Host.
- **Stored data:** no design/template/snapshot schema migration or deletion. Corrupt
  JSON now surfaces an error instead of being replaced as if no data existed.
- **Database:** CLI migrations now genuinely prefer the configured direct endpoint;
  verify it targets the intended database before running migrate deploy.
- **Discord:** no new automatic server mutations, undo actions or background polling
  were introduced. Existing apply risks remain until the next tranche is complete.
- **Music:** implementation and architecture unchanged; existing tests pass, live
  playback was not repeated or claimed verified in this sandbox.
