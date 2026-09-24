import {
  AttachmentBuilder,
  PermissionFlagsBits,
  type Message,
  type Webhook,
  type WebhookMessageCreateOptions,
} from "discord.js";
import { ERA_PERSONA_USER_ID, EraPostError, type EraOutgoing } from "./era.js";

/**
 * Posts `!era zhvishu` as {@link ERA_PERSONA_USER_ID}: a webhook message uses
 * that account's display name and avatar instead of the bot's. The webhook
 * name matches the burg relay (`Monarch Burg`) so the two features share one
 * webhook per channel instead of adding a second integration.
 */
export const ERA_WEBHOOK_NAME = "Monarch Burg";

const PERSONA_TTL_MS = 10 * 60 * 1000;
const eraWebhookCache = new Map<string, Webhook>();
let personaCache: { at: number; persona: EraPersona } | null = null;

export interface EraPersona {
  username: string;
  avatarURL: string | null;
}

/**
 * Webhook display names may not contain "discord" (Discord rejects the send).
 * Same substitution the burg relay uses, kept here so a persona named Discord
 * still posts.
 */
export function sanitizeWebhookUsername(displayName: string, fallback: string): string {
  const clean = (value: string) =>
    value
      .replace(/discord/gi, "d\u0456scord")
      .replace(/clyde/gi, "\u0441lyde")
      .replace(/[@#:`]/g, "")
      .trim();
  const name = clean(displayName) || clean(fallback) || "Monarch";
  return Array.from(name).slice(0, 80).join("").trim() || "Monarch";
}

export function personaFromUser(user: {
  username: string;
  displayName?: string | null;
  globalName?: string | null;
  displayAvatarURL(options?: { size?: number }): string;
}): EraPersona {
  return {
    username: sanitizeWebhookUsername(
      user.displayName || user.globalName || user.username,
      user.username,
    ),
    avatarURL: user.displayAvatarURL({ size: 256 }) || null,
  };
}

export function personaFromMember(member: {
  displayName: string;
  displayAvatarURL(options?: { size?: number }): string;
  user: { username: string };
}): EraPersona {
  return {
    username: sanitizeWebhookUsername(member.displayName, member.user.username),
    avatarURL: member.displayAvatarURL({ size: 256 }) || null,
  };
}

/** Prefer the server nickname and guild avatar; fall back to the global profile. */
export async function resolveEraPersona(
  guild: { members: { fetch(id: string): Promise<Parameters<typeof personaFromMember>[0]> } },
  fetchUser: (id: string) => Promise<Parameters<typeof personaFromUser>[0]>,
): Promise<EraPersona> {
  if (personaCache && Date.now() - personaCache.at < PERSONA_TTL_MS) return personaCache.persona;
  try {
    const member = await guild.members.fetch(ERA_PERSONA_USER_ID);
    const persona = personaFromMember(member);
    personaCache = { at: Date.now(), persona };
    return persona;
  } catch {
    // Not in this server — the global user still has a name and avatar.
  }
  try {
    const user = await fetchUser(ERA_PERSONA_USER_ID);
    const persona = personaFromUser(user);
    personaCache = { at: Date.now(), persona };
    return persona;
  } catch {
    throw new EraPostError(
      "persona",
      `I couldn't load the profile these posts use (\`${ERA_PERSONA_USER_ID}\`), so nothing was sent.`,
    );
  }
}

/** Test hook — the caches would otherwise leak across cases. */
export function clearEraPersonaCache(): void {
  personaCache = null;
  eraWebhookCache.clear();
}

export function eraWebhookPayload(
  persona: EraPersona,
  post: EraOutgoing,
  threadId?: string,
): WebhookMessageCreateOptions {
  const content = post.content?.trim();
  const files = post.files?.map(
    (file) =>
      new AttachmentBuilder(Buffer.from(file.body, file.encoding ?? "utf8"), { name: file.name }),
  );
  return {
    content: content || undefined,
    username: persona.username,
    avatarURL: persona.avatarURL ?? undefined,
    files: files && files.length > 0 ? files : undefined,
    allowedMentions: post.mentionUserIds?.length
      ? { parse: [], users: [...post.mentionUserIds] }
      : { parse: [] },
    threadId,
  };
}

function isUnknownWebhook(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 10015;
}

function evictWebhook(hook: Webhook): void {
  for (const [channelId, cached] of eraWebhookCache) {
    if (cached.id === hook.id) eraWebhookCache.delete(channelId);
  }
}

type WebhookHost = {
  id: string;
  permissionsFor(member: unknown): { has(bit: bigint): boolean } | null;
  fetchWebhooks(): Promise<{
    find(fn: (hook: Webhook) => boolean): Webhook | undefined;
  }>;
  createWebhook(options: { name: string; reason?: string }): Promise<Webhook>;
};

async function eraWebhook(message: Message<true>, botUserId: string | null): Promise<Webhook> {
  const channel = message.channel;
  const host = (channel.isThread() ? channel.parent : channel) as WebhookHost | null;
  if (
    !host ||
    typeof host.fetchWebhooks !== "function" ||
    typeof host.createWebhook !== "function"
  ) {
    throw new EraPostError("webhook", "I can only post that in a normal text channel.");
  }
  const me = message.guild.members.me;
  if (!me || !host.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
    throw new EraPostError(
      "webhook",
      "I need **Manage Webhooks** in this channel to post with that name and picture.",
    );
  }
  const cached = eraWebhookCache.get(host.id);
  if (cached) return cached;
  const hooks = await host.fetchWebhooks();
  let hook = hooks.find(
    (candidate) =>
      candidate.owner?.id === botUserId &&
      candidate.name === ERA_WEBHOOK_NAME &&
      Boolean(candidate.token),
  );
  if (!hook) {
    hook = await host.createWebhook({ name: ERA_WEBHOOK_NAME, reason: "Monarch relay" });
  }
  eraWebhookCache.set(host.id, hook);
  return hook;
}

/**
 * Send each post in order, all as the persona. The line goes out before the
 * photo because the caller puts them in that order and we await each send.
 */
export async function postAsEraPersona(
  message: Message<true>,
  posts: EraOutgoing[],
  deps: {
    botUserId: string | null;
    resolvePersona: () => Promise<EraPersona>;
  },
): Promise<void> {
  if (posts.length === 0) return;
  const persona = await deps.resolvePersona();
  const threadId = message.channel.isThread() ? message.channel.id : undefined;
  for (const post of posts) {
    const payload = eraWebhookPayload(persona, post, threadId);
    try {
      const hook = await eraWebhook(message, deps.botUserId);
      try {
        await hook.send(payload);
      } catch (error) {
        if (!isUnknownWebhook(error)) throw error;
        evictWebhook(hook);
        const fresh = await eraWebhook(message, deps.botUserId);
        await fresh.send(payload);
      }
    } catch (e) {
      if (e instanceof EraPostError) throw e;
      throw new EraPostError("send", `The post didn't go through — ${String(e)}`);
    }
  }
}
