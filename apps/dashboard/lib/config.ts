/** Pure, server-only runtime configuration validation. Messages never contain values. */
export type MonarchEnvName = "production" | "development" | "test";
export type StorageMode = "postgres" | "file";
export interface ConfigIssue {
  level: "error" | "warning";
  code: string;
  variable: string;
  message: string;
  fix?: string;
}
export interface ConfigInput {
  NODE_ENV?: string;
  SESSION_SECRET?: string;
  DATABASE_URL?: string;
  DIRECT_DATABASE_URL?: string;
  INTERNAL_API_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  APP_URL?: string;
  MONARCH_DEMO?: string;
  VERCEL?: string;
  AWS_LAMBDA_FUNCTION_NAME?: string;
}
export interface ResolvedConfig {
  envName: MonarchEnvName;
  isProduction: boolean;
  demoMode: boolean;
  storageMode: StorageMode;
  sessionSecret: string;
  internalApiToken: string | null;
  appUrl: string;
  databaseUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  discordBotToken: string;
  isServerless: boolean;
  issues: ConfigIssue[];
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}
export const DEVELOPMENT_SESSION_SECRET = "dev-only-secret-change-me";
export const MIN_SECRET_LENGTH = 32;
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;
export const KNOWN_WEAK_SECRETS = [
  DEVELOPMENT_SESSION_SECRET,
  "change-me",
  "changeme",
  "change_me",
  "please-change-me",
  "replace-me",
  "secret",
  "supersecret",
  "session-secret",
  "monarch",
  "monarch-secret",
  "development",
  "dev-secret",
  "example",
  "your-secret-here",
  "your_secret_here",
  "password",
  "admin",
  "test",
  "testing",
  "default",
  "todo",
  "none",
  "null",
];
export function resolveEnvName(value: string | undefined): MonarchEnvName {
  if (value === "development" || value === "test") return value;
  return "production"; // Unknown environments fail closed, too.
}
export function isKnownWeakSecret(value: string | undefined): boolean {
  const v = (value ?? "").toLowerCase();
  return KNOWN_WEAK_SECRETS.includes(v) || /change[-_]?me|placeholder|your[-_]secret/.test(v);
}
export function secretStrength(value: string | undefined): {
  ok: boolean;
  reason: "missing" | "known-value" | "too-short" | "low-variety" | null;
} {
  if (!value?.trim()) return { ok: false, reason: "missing" };
  if (isKnownWeakSecret(value)) return { ok: false, reason: "known-value" };
  if (value.length < MIN_SECRET_LENGTH) return { ok: false, reason: "too-short" };
  if (new Set(value).size < 12) return { ok: false, reason: "low-variety" };
  return { ok: true, reason: null };
}
export function isPostgresUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return ["postgres:", "postgresql:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}
/** Public URLs are origins, not paths; never derive trust from request Host headers. */
export function parseAppUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function resolveConfig(input: ConfigInput): ResolvedConfig {
  const envName = resolveEnvName(input.NODE_ENV);
  const isProduction = envName === "production";
  const issues: ConfigIssue[] = [];
  const issue = (
    code: string,
    variable: string,
    message: string,
    fix: string,
    level: ConfigIssue["level"] = "error",
  ) => issues.push({ level, code, variable, message, fix });
  const demoRequested = input.MONARCH_DEMO === "1" || input.MONARCH_DEMO === "true";
  if (isProduction && demoRequested)
    issue(
      "demo-mode.production",
      "MONARCH_DEMO",
      "Demo authentication is forbidden in production.",
      "Unset MONARCH_DEMO and configure Discord OAuth.",
    );
  const demoMode = !isProduction && demoRequested;
  const sessionSecret = input.SESSION_SECRET || (!isProduction ? DEVELOPMENT_SESSION_SECRET : "");
  const strength = secretStrength(input.SESSION_SECRET);
  if (isProduction && !strength.ok)
    issue(
      `session-secret.${strength.reason}`,
      "SESSION_SECRET",
      "SESSION_SECRET must be at least 32 characters, varied, and not a known placeholder.",
      "Generate an independent random secret with openssl rand -hex 32.",
    );
  const databaseUrl = input.DATABASE_URL ?? "";
  const isServerless = input.VERCEL === "1" || Boolean(input.AWS_LAMBDA_FUNCTION_NAME);
  if (!databaseUrl && (isProduction || isServerless))
    issue(
      "database-url.missing",
      "DATABASE_URL",
      "PostgreSQL is required in production and serverless runtimes; file fallback is disabled.",
      "Set DATABASE_URL and run npm run db:migrate.",
    );
  if (databaseUrl && !isPostgresUrl(databaseUrl))
    issue(
      "database-url.malformed",
      "DATABASE_URL",
      "DATABASE_URL is not a PostgreSQL connection URL.",
      "Configure a valid PostgreSQL URL.",
    );
  const discordClientId = input.DISCORD_CLIENT_ID ?? "";
  const discordClientSecret = input.DISCORD_CLIENT_SECRET ?? "";
  const discordBotToken = input.DISCORD_BOT_TOKEN ?? "";
  if (!demoMode && !(discordClientId && discordClientSecret && discordBotToken)) {
    issue(
      "discord.credentials-missing",
      "DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN",
      "Discord credentials are required. Missing credentials do not enable demo authentication.",
      "Configure Discord credentials, or explicitly set MONARCH_DEMO=1 in development/test.",
    );
  }
  const rawToken = input.INTERNAL_API_TOKEN ?? "";
  const tokenValid =
    rawToken && (!isProduction || secretStrength(rawToken).ok) && !isKnownWeakSecret(rawToken);
  const internalApiToken = tokenValid ? rawToken : null;
  if (!internalApiToken)
    issue(
      "internal-api-token.disabled",
      "INTERNAL_API_TOKEN",
      "Internal API disabled: the token is absent or unusable.",
      "Set the same independently generated random token on dashboard and bot.",
      "warning",
    );
  const rawAppUrl = input.APP_URL || (!isProduction ? "http://localhost:3000" : "");
  const appUrl = parseAppUrl(rawAppUrl) ?? "";
  if (!appUrl || (isProduction && !appUrl.startsWith("https://")))
    issue(
      "app-url.invalid",
      "APP_URL",
      "APP_URL must be an absolute origin; production requires HTTPS.",
      "Set APP_URL to the public dashboard origin, e.g. https://monarch.example.com.",
    );
  return {
    envName,
    isProduction,
    demoMode,
    sessionSecret,
    internalApiToken,
    databaseUrl,
    storageMode: databaseUrl ? "postgres" : "file",
    appUrl,
    discordClientId,
    discordClientSecret,
    discordBotToken,
    isServerless,
    issues,
    errors: issues.filter((i) => i.level === "error"),
    warnings: issues.filter((i) => i.level === "warning"),
  };
}
export class MonarchConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(issues.map((i) => `${i.variable}: ${i.message}`).join(" "));
    this.name = "MonarchConfigError";
  }
}
