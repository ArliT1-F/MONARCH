/**
 * Environment access — the only place process.env is read.
 * Bot credentials are server-only and must never reach the client bundle.
 */
export const env = {
  discordClientId: process.env.DISCORD_CLIENT_ID ?? "",
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET ?? "",
  discordBotToken: process.env.DISCORD_BOT_TOKEN ?? "",
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-secret-change-me",
  databaseUrl: process.env.DATABASE_URL ?? "",
  forceDemo: process.env.MONARCH_DEMO === "1",
};

/**
 * Demo mode: active when explicitly forced, or when Discord credentials are
 * absent. In demo mode Monarch uses the MockDiscordGateway with seeded
 * guilds so the entire design → diff → apply loop works without a Discord
 * application. The UI labels it clearly.
 */
export function isDemoMode(): boolean {
  if (env.forceDemo) return true;
  return !(env.discordClientId && env.discordClientSecret && env.discordBotToken);
}
