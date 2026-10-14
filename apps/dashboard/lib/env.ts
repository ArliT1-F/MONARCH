import { MonarchConfigError, resolveConfig } from "./config";

/** Server-only. Resolve at use time so configuration cannot be captured before loading. */
export function getConfig() {
  return resolveConfig(process.env);
}
export const env = {
  get discordClientId() {
    return getConfig().discordClientId;
  },
  get discordClientSecret() {
    return getConfig().discordClientSecret;
  },
  get discordBotToken() {
    return getConfig().discordBotToken;
  },
  get appUrl() {
    return getConfig().appUrl;
  },
  get sessionSecret() {
    return requireSessionSecret();
  },
  get databaseUrl() {
    return getConfig().databaseUrl;
  },
  get forceDemo() {
    return getConfig().demoMode;
  },
};
export function isDemoMode(): boolean {
  return getConfig().demoMode;
}
export function assertConfigUsable() {
  const config = getConfig();
  if (config.errors.length) throw new MonarchConfigError(config.errors);
  return config;
}
export function requireSessionSecret(): string {
  const config = getConfig();
  const errors = config.errors.filter((i) => i.variable === "SESSION_SECRET");
  if (errors.length) throw new MonarchConfigError(errors);
  return config.sessionSecret;
}
export function internalApiToken(): string | null {
  return getConfig().internalApiToken;
}
