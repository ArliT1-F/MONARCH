import { createHmac } from "node:crypto";
import { env } from "./env";

/**
 * Discord OAuth2 helpers (authorization-code flow).
 * Demo mode bypasses this entirely (see /api/auth/login).
 */

const OAUTH_SCOPES = ["identify", "guilds"];

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.discordClientId,
    redirect_uri: `${env.appUrl}/api/auth/callback`,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state,
    prompt: "none",
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export function signState(value: string): string {
  return `${value}.${createHmac("sha256", env.sessionSecret).update(value).digest("base64url")}`;
}

export function verifyState(signed: string): boolean {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return false;
  const value = signed.slice(0, dot);
  return signState(value) === signed;
}

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function exchangeCode(code: string): Promise<DiscordTokenResponse | null> {
  const res = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.discordClientId,
      client_secret: env.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.appUrl}/api/auth/callback`,
    }),
  });
  if (!res.ok) return null;
  return (await res.json()) as DiscordTokenResponse;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser | null> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as DiscordUser;
}

export function avatarUrl(user: DiscordUser): string | null {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : null;
}
