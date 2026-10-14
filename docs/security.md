# Security, configuration and safe upgrades

This is the primary reference for runtime configuration. Deployment-specific
steps remain in [Vercel](deploying-vercel.md) and [Linux worker](hosting-laptop.md).

## Credential incident — rotation required

A credential-bearing Neon PostgreSQL URL remained in tracked `.env.example` at
base commit `758787a6f0a2e5c464c15fa1de6c5b8a39fcc413`. The older audit incorrectly
said it had been removed. It is removed from the current file in this change.
This checkout is shallow (one historical commit available), so earlier exposure
cannot be bounded from local history. Assume the password is compromised.

**The database owner must rotate that password in the provider console**, update
`DATABASE_URL` and `DIRECT_DATABASE_URL` wherever configured, redeploy/restart
clients and review database access logs. No external credentials were rotated by
the agent. Deleting a line does not remove it from clones, forks or historical
commits. History rewriting is optional, disruptive, and is not a substitute for
rotation. Never paste the old/new credential into an issue, report or CI log.

Run `npm run security:scan` before committing. The dependency-free scanner reports
only filenames, line numbers, rules and `[REDACTED]`, including for allow-listed
matches. It scans tracked and non-ignored new text source; it is pattern-based,
not proof that no secrets exist. It does not scan Git history, binary assets,
files over 2 MiB or lockfiles. Allow markers require a reason and code review.

## Runtime requirements

| Variable | Dashboard | Bot worker |
| --- | --- | --- |
| `NODE_ENV` | Next sets it; deployed runtime must be production | Explicit `production` in deployed environment; `development` for local use |
| `APP_URL` | Required public HTTPS **origin** in production | Same public URL, for links sent to members |
| `DISCORD_CLIENT_ID` | Required outside explicit demo | Set for slash-command registration |
| `DISCORD_CLIENT_SECRET` | Required outside explicit demo | Not needed |
| `DISCORD_BOT_TOKEN` | Required outside explicit demo | Required to connect to Discord |
| `SESSION_SECRET` | Production: independent random secret, ≥32 characters, ≥12 distinct characters; generate with `openssl rand -hex 32` | Not needed |
| `DATABASE_URL` | PostgreSQL required in all production/serverless deployments | Not needed; worker has no SQL credentials |
| `DIRECT_DATABASE_URL` | Direct URL for Prisma CLI migrations; falls back to `DATABASE_URL` | Not needed |
| `INTERNAL_API_TOKEN` | Same independent random token as worker; absent/unusable disables internal endpoints (503) | Same value; production rejects a configured weak token; absent disables internal clients |
| `DASHBOARD_INTERNAL_URL` | Not used | Optional reachable HTTP(S) origin; defaults to `APP_URL` |
| `MONARCH_DEMO` | Explicit `1` in development/test only. Forbidden in production | Not used |
| `POSTGRES_PASSWORD` | Docker Compose database password; required, no default | Not needed by application logic |

Never reuse SESSION_SECRET as the internal token. URLs cannot contain credentials,
paths, queries or fragments (DATABASE_URL is a separate database connection URL).
The public dashboard must terminate TLS, including when TLS is at a reverse proxy.
Development permits HTTP and JSON storage. Invalid production configuration fails
initialization (`next start` exits nonzero); serverless initialization validates
independently. Builds do not need production credentials.

### Topologies

- **Local:** `npm ci`; configure dashboard `.env.local`, explicitly set
  `MONARCH_DEMO=1` for a demo, or set Discord credentials for real OAuth. Next dev
  defaults APP_URL to `http://localhost:3000`. Local worker environment should
  explicitly set `NODE_ENV=development`; export its variables before starting it.
- **Self-hosted Docker:** configure `.env` and run
  `docker compose --env-file .env -f docker/docker-compose.yml up --build -d`.
  Set APP_URL to your external HTTPS dashboard origin, set all secrets and Discord
  credentials, and place a TLS proxy in front of dashboard port 3000. The worker
  uses `http://dashboard:3000` internally (Compose config, not hard-coded logic).
  Compose service `environment` overrides NODE_ENV to production even if the
  copied local example says development. Use a URL-safe generated database
  password, e.g. hex, because Compose embeds it in the PostgreSQL URL.
  **Existing pgdata volumes:** changing POSTGRES_PASSWORD does not change an
  already-initialized PostgreSQL role password. Rotate that role through an
  authorized database administration session first, then update configuration.
  Do not delete the volume to make the new password take effect.
- **Vercel dashboard + separate worker:** set public APP_URL on both, keep
  DASHBOARD_INTERNAL_URL unset unless a different private URL is needed. Set the
  matching internal token on both. Only Vercel gets DATABASE_URL/SESSION_SECRET.
- **Vercel + Linux/laptop worker:** identical API topology; the worker makes
  outbound HTTPS calls and Discord connections. No inbound listener or port
  forwarding is needed on the worker. Preserve required outbound UDP for the
  existing music implementation; do not run two workers on the same bot token.

## Sessions, OAuth and CSRF

Session IDs now use 128 CSPRNG bits. Cookies remain HTTP-only, SameSite=Lax and
Secure for HTTPS; session lifetime is 14 days. Both adapters reject expired
sessions; legacy file records use createdAt + 14 days. Logout revokes the stored
session and clears the browser cookie even if revocation fails, returning an
error rather than a false success in that case.

Signing keys are now HKDF-separated for session cookies and OAuth state. **This
signs existing users out once** and invalidates pending old OAuth flows. Saved
designs, templates and snapshots are not changed. OAuth token encryption stays
AES-256-GCM with the existing scrypt context and `v1` format; retaining the same
SESSION_SECRET retains readability. An independent compatibility test decrypts
ciphertext generated with the old algorithm.

OAuth state is random, signed and expires after ten minutes. Callback requires
an identical browser cookie, clears it on returned success/error, and checks
state before contacting Discord. Cookie clearing prevents normal repeat callbacks;
there is no new server-side nonce replay ledger. Discord enforces single-use
authorization codes. Do not claim this prevents replay of a stolen cookie/code
pair independently of Discord.

Browser mutations require Origin equal to configured APP_URL. If Origin is
omitted, positive `Sec-Fetch-Site: same-origin` is required. Explicit cross-site
metadata is rejected even with a matching Origin. Missing both headers is rejected.
Clients using curl must set Origin; bot internal routes instead require the bearer
token and intentionally do not use this browser guard. APP_URL, not Host or
forwarded headers, defines trust. This is defense in depth alongside SameSite and
JSON body handling; the audit did not demonstrate an existing browser CSRF exploit.

If a proxied development preview uses a different browser origin, set APP_URL to
that exact origin and register its callback URL for real Discord OAuth. There is
no wildcard trusted-origin bypass.

## Migration, backup and recovery

No schema migration is introduced here. Back up PostgreSQL using your provider's
snapshot mechanism or `pg_dump` **before upgrading**; protect backups as secrets.
Then run `npm run db:migrate` with DIRECT_DATABASE_URL configured to reach the
actual database, not a transaction pooler. Prisma 7 uses this as `datasource.url`;
`datasource.directUrl` is not a supported configuration key.

Keep .monarch-data backups for any existing development file store. Corrupt or
unreadable JSON now throws instead of being treated as an empty store and
silently overwritten. Repair from backup; do not delete the file to hide errors.
Other development file-store concurrent read/modify/write limitations remain.

Rotating SESSION_SECRET invalidates cookies and old encrypted OAuth tokens.
There is no dual-key token migration in this release. Reauthenticate affected
users to replace their short-lived OAuth sessions; this does not destroy saved
server data. If continued access to old encrypted tokens is required, coordinate
a separate reviewed token re-encryption migration before changing the secret.

For internal API errors: 401 means wrong/missing Bearer credential; 503 means the
internal token is disabled (missing/placeholder/weak in production). Compare
configuration names and deployment targets, **never log the token**. Verify the
worker's DASHBOARD_INTERNAL_URL is reachable and migrations have run. Runtime
initialization errors name the offending variable without printing its value.

## Verification

```sh
npm ci
npx prisma validate
npm run security:scan
npm run typecheck
npm test
NEXT_TELEMETRY_DISABLED=1 npm run build
```

CI runs these without production credentials. The PostgreSQL/PGlite integration
suite applies every committed migration; it is not a production migration rehearsal
or a live Discord end-to-end test. See [engineering status](engineering-audit.md)
for the exact executed checks and remaining work.
