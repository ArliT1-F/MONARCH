import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type Role,
  type Webhook,
  type WebhookMessageCreateOptions,
} from "discord.js";
import type { JailConfig, JailConfigRegistry } from "./jail-config.js";
import {
  JAIL_CHANNEL_NAME,
  JAIL_ROLE_NAME,
  toJailSpeak,
  type JailEntry,
  type JailRegistry,
} from "./jail.js";

/**
 * The live half of the jail: building the cell, keeping the @jailed role
 * locked out of every other channel, confining and releasing members, and the
 * cute relay itself.
 *
 * It lives outside index.ts because it is a lot of behaviour and it deserves
 * a unit test; it needs the gateway objects, so unlike the registry it is a
 * class holding a client getter (the worker may reconnect with fewer intents).
 *
 * The rules, in one place:
 *
 * - **The cell.** `#jail` is hidden from @everyone; the managed @jailed role
 *   may see *only* it (every other channel gets a deny for that role, and new
 *   channels get one as they are created). Roles that already hold moderation
 *   powers are let in, so staff can watch.
 * - **Confinement.** A jailed member's messages outside the cell are deleted
 *   and they get a DM pointing at #jail. Their messages *inside* the cell are
 *   deleted and re-posted through a webhook under their own name and avatar —
 *   in the chosen cute style, which is the joke.
 * - **Nothing is irreversible.** Release removes the role; `/monarch jail
 *   disable` releases everyone, strips the overwrites and forgets the cell.
 *   Without a cell the whole thing is just the old relay gag.
 *
 * The manager never throws at its callers: everything the gateway might
 * refuse (a missing permission, a role above Monarch's, a rate limit) comes
 * back as a user-presentable message.
 */

// ── structural views of the gateway objects ──────────────────────────
// Narrow interfaces rather than the full discord.js types: the manager only
// touches a handful of members, and the tests hand it plain objects.

interface PermissionLike {
  has(bit: bigint): boolean;
  bitfield: bigint;
}

interface RoleLike {
  id: string;
  name: string;
  position: number;
  managed?: boolean;
  permissions: PermissionLike;
}

interface OverwriteLike {
  allow: PermissionLike;
  deny: PermissionLike;
}

interface ChannelLike {
  id: string;
  name: string;
  type: number;
  parentId?: string | null;
  isThread(): boolean;
  isTextBased(): boolean;
  isVoiceBased(): boolean;
  permissionOverwrites: {
    cache: { get(id: string): OverwriteLike | undefined };
    edit(
      target: unknown,
      options: Record<string, boolean>,
      opts?: { reason?: string },
    ): Promise<unknown>;
    delete(target: unknown, reason?: string): Promise<unknown>;
  };
}

interface MemberLike {
  id: string;
  permissions: PermissionLike;
  roles: {
    highest: { position: number };
    cache: { has(id: string): boolean };
    add(role: unknown, reason?: string): Promise<unknown>;
    remove(role: unknown, reason?: string): Promise<unknown>;
  };
}

interface GuildLike {
  id: string;
  name: string;
  members: {
    me: MemberLike | null;
    fetch(id: string): Promise<MemberLike>;
  };
  roles: {
    everyone: RoleLike;
    cache: Map<string, RoleLike>;
    create(options: {
      name: string;
      permissions: bigint[];
      color: number;
      mentionable: boolean;
      hoist: boolean;
      reason?: string;
    }): Promise<RoleLike>;
  };
  channels: {
    cache: Map<string, ChannelLike>;
    create(options: {
      name: string;
      type: ChannelType;
      permissionOverwrites?: { id: string; deny: bigint }[];
      reason?: string;
    }): Promise<ChannelLike>;
    fetch(id: string): Promise<ChannelLike | null>;
  };
}

export type JailSetupResult =
  | {
      ok: true;
      channel: { id: string; name: string; created: boolean };
      role: { id: string; name: string; created: boolean };
      staffRoleIds: string[];
      locked: number;
      skipped: number;
      failed: number;
    }
  | { ok: false; message: string };

export type JailDisableResult =
  | { ok: true; released: number; cleaned: number; failed: number }
  | { ok: false; message: string };

export interface JailStatus {
  config: JailConfig | null;
  jailed: JailEntry[];
  channelExists: boolean;
  roleExists: boolean;
}

export interface JailManagerDeps {
  client: () => Client;
  configs: JailConfigRegistry;
  registry: JailRegistry;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** How many channel overwrites to edit at once while locking the cell down. */
const OVERWRITE_CHUNK = 8;

/** One "you're in jail" DM per member per this window (a delete storm is noisy). */
const NOTICE_COOLDOWN_MS = 5 * 60_000;

/** Roles that already hold moderation powers are staff: they get to watch. */
const STAFF_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
];

/**
 * Which roles may see #jail: every role holding a moderation permission, plus
 * an explicitly named one, plus whatever the previous setup recorded (in case
 * a role that used to grant access was renamed or lost its permissions).
 */
export function staffRoleIdsFor(
  roles: readonly RoleLike[],
  options: { extra?: string | null; previous?: readonly string[] } = {},
): string[] {
  const ids = new Set<string>();
  for (const role of roles) {
    if (role.managed) continue;
    if (STAFF_PERMISSIONS.some((bit) => role.permissions.has(bit))) ids.add(role.id);
  }
  if (options.extra) ids.add(options.extra);
  for (const id of options.previous ?? []) ids.add(id);
  return [...ids];
}

/**
 * Is this message inside the cell? Threads count as their parent channel, so
 * a cell thread (or a forum post in it) behaves like #jail itself.
 */
export function isCellMessage(
  message: { channelId: string; channel: { isThread(): boolean; parentId?: string | null } },
  config: JailConfig,
): boolean {
  if (message.channelId === config.channelId) return true;
  return message.channel.isThread() && message.channel.parentId === config.channelId;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class JailManager {
  private readonly client: () => Client;
  private readonly configs: JailConfigRegistry;
  private readonly registry: JailRegistry;
  private readonly log: JailManagerDeps["log"];

  /** One webhook per channel, created lazily and reused (Discord caps them at 15/channel). */
  private readonly webhookCache = new Map<string, Webhook>();
  /** Relay sends for one channel run in order: without this, two quick messages race. */
  private readonly relayChains = new Map<string, Promise<void>>();
  /** userId → epoch ms of the last "you're jailed" DM. */
  private readonly lastNotice = new Map<string, number>();

  constructor(deps: JailManagerDeps) {
    this.client = deps.client;
    this.configs = deps.configs;
    this.registry = deps.registry;
    this.log = deps.log;
  }

  // ── the cell ───────────────────────────────────────────────────────

  /**
   * Build (or rebuild) the cell. Re-running is the supported way to refresh
   * staff access, point the cell at a different channel/role, or heal a
   * channel somebody made public again.
   */
  async setup(
    guild: Guild,
    options: {
      channel?: GuildBasedChannel | null;
      staffRole?: Role | null;
      actorId: string;
    },
  ): Promise<JailSetupResult> {
    const g = guild as unknown as GuildLike;
    const me = g.members.me;
    if (!me) {
      return { ok: false, message: "❌ I can't read my own membership here — try again in a moment." };
    }
    const highest = me.roles.highest.position;
    const previous = (await this.configs.get(guild.id)) ?? null;

    // 1) Own the role ourselves. Never silently adopt an unrelated role
    // (even one named "jailed"): it may already belong to another workflow.
    // Only the role ID previously saved by this setup can be reused.
    let role: RoleLike | null = previous?.roleId
      ? g.roles.cache.get(previous.roleId) ?? null
      : null;
    let createdRole = false;
    if (!role) {
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return {
          ok: false,
          message:
            "❌ I need **Manage Roles** to create the `@jailed` role. " +
            "Grant it and run setup again.",
        };
      }
      role = await g.roles.create({
        name: JAIL_ROLE_NAME,
        permissions: [],
        color: 0x99aab5,
        mentionable: false,
        hoist: false,
        reason: "Monarch jail — permissions are granted only in #jail",
      });
      createdRole = true;
    }
    // A modified role with global grants would defeat channel isolation.
    if (role.permissions.bitfield !== 0n) {
      return {
        ok: false,
        message: "❌ @jailed must have no server-wide permissions. Remove its role permissions and run setup again.",
      };
    }
    if (role.position >= highest) {
      return {
        ok: false,
        message:
          `❌ The **${role.name}** role sits at or above Monarch's own role, so I can't hand it out. ` +
          `Drag Monarch's role above **${role.name}** in Server Settings → Roles, then run setup again.`,
      };
    }

    // 2) The cell channel.
    let channel: ChannelLike | null = (options.channel as unknown as ChannelLike | null) ?? null;
    if (!channel && previous?.channelId) {
      channel =
        g.channels.cache.get(previous.channelId) ??
        (await g.channels.fetch(previous.channelId).catch(() => null));
    }
    if (!channel) {
      channel =
        [...g.channels.cache.values()].find(
          (candidate) => candidate.isTextBased() && !candidate.isThread() && candidate.name === JAIL_CHANNEL_NAME,
        ) ?? null;
    }
    let createdChannel = false;
    if (!channel) {
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return {
          ok: false,
          message:
            "❌ I need the **Manage Channels** permission to create `#jail`. " +
            "Grant it in Server Settings → Roles (or re-invite me), then run setup again.",
        };
      }
      channel = await g.channels.create({
        name: JAIL_CHANNEL_NAME,
        type: ChannelType.GuildText,
        // Hidden from the moment it exists — never a public #jail, even briefly.
        permissionOverwrites: [{ id: g.roles.everyone.id, deny: PermissionFlagsBits.ViewChannel }],
        reason: "Monarch jail — where jailed members are confined",
      });
      createdChannel = true;
    } else if (!channel.isTextBased() || channel.isThread()) {
      return {
        ok: false,
        message: "❌ The cell must be a normal text channel (not a thread, voice or forum channel).",
      };
    }

    if (channel.name !== JAIL_CHANNEL_NAME) {
      return {
        ok: false,
        message: "❌ The cell channel must be named #jail. Rename it or let me create #jail.",
      };
    }

    // 3) Staff access + the overwrites that make the cell a cell.
    const staffRoleIds = staffRoleIdsFor(
      [...g.roles.cache.values()].filter(
        (candidate) => candidate.id !== g.roles.everyone.id && candidate.id !== role.id,
      ),
      {
        extra:
          options.staffRole?.id === role.id || options.staffRole?.id === g.roles.everyone.id
            ? null
            : options.staffRole?.id ?? null,
        previous: (previous?.staffRoleIds ?? []).filter(
          (id) => id !== role.id && id !== g.roles.everyone.id,
        ),
      },
    );
    try {
      await this.applyCellOverwrites(g, channel, role, staffRoleIds);
    } catch (error) {
      this.log.warn("couldn't secure the jail cell", { guildId: guild.id, error: String(error) });
      return { ok: false, message: "❌ Couldn't secure #jail. Check Manage Channels and try setup again." };
    }
    const { locked, skipped, failed } = await this.lockEveryChannel(g, role, channel.id);

    if (failed > 0) {
      return {
        ok: false,
        message: `❌ Could not lock ${failed} channel(s). Setup was not saved; check Manage Channels and re-run setup.`,
      };
    }

    const config: JailConfig = {
      guildId: guild.id,
      channelId: channel.id,
      roleId: role.id,
      staffRoleIds,
    };
    const saved = await this.configs.set(guild.id, config);
    if (!saved.ok) return { ok: false, message: saved.message };

    // On a rerun after role deletion, reapply the newly created role to
    // everyone still serving a jail term.
    await this.registry.hydrate(guild.id);
    for (const entry of this.registry.list(guild.id)) {
      await this.confine(guild, entry.userId, config);
    }

    this.log.info("jail cell set up", {
      guildId: guild.id,
      by: options.actorId,
      channelId: channel.id,
      createdChannel,
      roleId: role.id,
      createdRole,
      staffRoles: staffRoleIds.length,
      locked,
      skipped,
      failed,
    });

    return {
      ok: true,
      channel: { id: channel.id, name: channel.name, created: createdChannel },
      role: { id: role.id, name: role.name, created: createdRole },
      staffRoleIds,
      locked,
      skipped,
      failed,
    };
  }

  /** Release everyone, strip the overwrites, forget the cell. */
  async disable(guild: Guild, actorId: string): Promise<JailDisableResult> {
    const g = guild as unknown as GuildLike;
    const config = await this.configs.get(guild.id);
    if (!config) {
      return { ok: false, message: "🔒 This server doesn't have a jail cell set up." };
    }

    // Pick up stored entries first: a restart may have emptied memory, and
    // everybody has to lose the role before the cell is forgotten.
    await this.registry.hydrate(guild.id);
    const released = this.registry.releaseGuild(guild.id);
    let freed = 0;
    for (const entry of released) {
      if (await this.free(guild, entry.userId, config)) freed += 1;
    }

    // Strip the role's overwrites everywhere (the channel keeps its own
    // @everyone deny, so #jail stays private rather than becoming public).
    let cleaned = 0;
    let failed = 0;
    const role = g.roles.cache.get(config.roleId) ?? null;
    for (const channel of g.channels.cache.values()) {
      if (channel.isThread()) continue;
      if (!channel.permissionOverwrites.cache.get(config.roleId)) continue;
      try {
        // Deleting an overwrite that a role no longer has is a no-op 404 online;
        // `role` may be gone entirely, which is the same outcome.
        await channel.permissionOverwrites.delete(role ?? config.roleId, "Monarch jail disabled");
        cleaned += 1;
      } catch {
        failed += 1;
      }
    }

    const saved = await this.configs.set(guild.id, null);
    if (!saved.ok) return { ok: false, message: saved.message };
    this.registry.forgetHydration(guild.id);

    this.log.info("jail disabled", {
      guildId: guild.id,
      by: actorId,
      released: released.length,
      freed,
      cleaned,
      failed,
    });
    return { ok: true, released: released.length, cleaned, failed };
  }

  /** What the cell looks like right now (for `!jail status`). */
  async status(guild: Guild): Promise<JailStatus> {
    const g = guild as unknown as GuildLike;
    const config = await this.configs.get(guild.id);
    await this.registry.hydrate(guild.id);
    return {
      config,
      jailed: this.registry.list(guild.id),
      channelExists: config ? g.channels.cache.has(config.channelId) : false,
      roleExists: config ? g.roles.cache.has(config.roleId) : false,
    };
  }

  /**
   * After READY: pull stored jails in, re-arm their timers, hand the role to
   * anyone missing it, free anyone whose window ran out while the bot was
   * down, and repair any channel that lost its deny (a channel created while
   * the bot was offline, for instance).
   */
  async startup(): Promise<void> {
    for (const guild of this.client().guilds.cache.values()) {
      try {
        const config = await this.configs.get(guild.id);
        if (!config) continue;
        const g = guild as unknown as GuildLike;
        const role = g.roles.cache.get(config.roleId) ?? null;
        if (!role) {
          this.log.warn("jail role is gone — confinement is off until setup runs again", {
            guildId: guild.id,
            roleId: config.roleId,
          });
          continue;
        }
        const { expired } = await this.registry.hydrate(guild.id);
        for (const row of expired) {
          await this.free(guild, row.userId, config);
          this.registry.release(guild.id, row.userId);
        }
        for (const entry of this.registry.list(guild.id)) {
          await this.confine(guild, entry.userId, config);
        }
        const { locked, failed } = await this.lockEveryChannel(g, role, config.channelId);
        if (locked > 0 || failed > 0) {
          this.log.info("jail overwrites repaired on startup", {
            guildId: guild.id,
            locked,
            failed,
          });
        }
      } catch (e) {
        this.log.warn("jail startup check failed for a guild", {
          guildId: guild.id,
          error: String(e),
        });
      }
    }
  }

  /** A channel was created: make sure the @jailed role can't see it. */
  async onChannelCreate(channel: GuildBasedChannel): Promise<void> {
    const guild = channel.guild as Guild | undefined;
    if (!guild) return;
    const config = await this.configs.get(guild.id);
    if (!config || channel.id === config.channelId) return;
    const c = channel as unknown as ChannelLike;
    if (c.isThread()) return;
    const g = guild as unknown as GuildLike;
    const role = g.roles.cache.get(config.roleId);
    if (!role) return;
    try {
      await this.denyRole(c, role);
    } catch (e) {
      this.log.warn("couldn't hide a new channel from jailed members", {
        guildId: guild.id,
        channelId: channel.id,
        error: String(e),
      });
    }
  }

  // ── confinement ────────────────────────────────────────────────────

  /** Give a member the @jailed role. Returns a user-presentable error if not. */
  async confine(
    guild: Guild,
    userId: string,
    config: JailConfig | null,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!config) return { ok: true }; // relay-only mode: nothing to hand out
    const g = guild as unknown as GuildLike;
    const me = g.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return {
        ok: false,
        message:
          "❌ I need the **Manage Roles** permission to confine members to #jail. " +
          "Grant it (or re-invite me), then try again — the relay still works meanwhile.",
      };
    }
    try {
      const member = await g.members.fetch(userId);
      if (!member.roles.cache.has(config.roleId)) {
        await member.roles.add(config.roleId, "Monarch jail");
      }
      return { ok: true };
    } catch (e) {
      this.log.warn("couldn't confine a member (role add failed)", {
        guildId: guild.id,
        userId,
        error: String(e),
      });
      return {
        ok: false,
        message:
          "❌ I couldn't give them the `@jailed` role — check that my role is above it and that " +
          "**Manage Roles** is still granted. The relay works either way.",
      };
    }
  }

  /** Take the @jailed role away. Best-effort: returns whether anything changed. */
  async free(guild: Guild, userId: string, config: JailConfig | null): Promise<boolean> {
    if (!config) return false;
    const g = guild as unknown as GuildLike;
    try {
      const member = await g.members.fetch(userId);
      if (!member.roles.cache.has(config.roleId)) return false;
      await member.roles.remove(config.roleId, "Monarch jail released");
      return true;
    } catch (e) {
      // The member left, or the role is gone: either way there is nothing
      // left to take away.
      this.log.warn("couldn't remove the jail role", {
        guildId: guild.id,
        userId,
        error: String(e),
      });
      return false;
    }
  }

  /** A timed cell ran out. */
  async releaseExpired(entry: JailEntry): Promise<void> {
    const guild = this.client().guilds.cache.get(entry.guildId);
    if (!guild) return;
    const config = await this.configs.get(guild.id);
    await this.free(guild, entry.userId, config);
    void this.notify(
      guild,
      entry.userId,
      `🔓 Your cell in **${guild.name}** just opened by itself — you can talk normally again.`,
    );
    this.log.info("jail expired", { guildId: entry.guildId, userId: entry.userId });
  }

  // ── messages ───────────────────────────────────────────────────────

  /**
   * A message arrived. Returns true when it was the jail's business: either
   * re-posted cutely (inside the cell, or anywhere in relay-only mode) or
   * deleted for trying to talk outside the cell.
   */
  async handleMessage(message: Message<true>): Promise<boolean> {
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system) {
      return false;
    }
    const entry = this.registry.get(message.guildId, message.author.id);
    if (!entry) return false;

    const config = this.configs.peek(message.guildId) ?? (await this.configs.get(message.guildId));
    const inCell = config ? isCellMessage(message, config) : true;

    if (config && !inCell) {
      await this.confineOutside(message, config);
      return true;
    }
    await this.relay(message, entry.style);
    return true;
  }

  /** They tried to talk to the outside world: delete it, tell them where to go. */
  private async confineOutside(message: Message<true>, config: JailConfig): Promise<void> {
    const me = message.guild.members.me;
    const perms = me ? message.channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.ManageMessages)) {
      this.log.warn("jailed member's message left alone — missing Manage Messages", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }
    await message
      .delete()
      .catch((e) => this.log.warn("couldn't delete a jailed member's message", { error: String(e) }));

    const last = this.lastNotice.get(message.author.id) ?? 0;
    if (Date.now() - last < NOTICE_COOLDOWN_MS) return;
    this.lastNotice.set(message.author.id, Date.now());
    void this.notify(
      message.guild,
      message.author.id,
      [
        `🔒 You're in jail in **${message.guild.name}** — right now you can only talk in <#${config.channelId}>.`,
        "Anything you type elsewhere is removed before anyone sees it. Play nice and staff will let you out.",
      ].join("\n"),
    );
  }

  /** DM somebody, tolerating closed DMs. */
  private async notify(guild: Guild, userId: string, text: string): Promise<void> {
    try {
      const user = await this.client().users.fetch(userId);
      await user.send(text);
    } catch (e) {
      this.log.warn("couldn't DM a jailed member (DMs closed?)", {
        guildId: guild.id,
        userId,
        error: String(e),
      });
    }
  }

  // ── overwrites ─────────────────────────────────────────────────────

  /** @everyone can't see the cell; @jailed may only use it; staff may watch. */
  private async applyCellOverwrites(
    g: GuildLike,
    channel: ChannelLike,
    role: RoleLike,
    staffRoleIds: readonly string[],
  ): Promise<void> {
    const reason = "Monarch jail cell";
    await channel.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: false }, { reason });
    await channel.permissionOverwrites.edit(
      role,
      {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AddReactions: true,
        // No side rooms in the cell: a private thread would be a place to
        // hide from the mods watching it.
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
      },
      { reason },
    );
    for (const staffId of staffRoleIds) {
      const staffRole = g.roles.cache.get(staffId);
      if (!staffRole) continue;
      await channel.permissionOverwrites.edit(
        staffRole,
        {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          ManageMessages: true,
        },
        { reason },
      );
    }
  }

  /**
   * Deny the @jailed role on every channel except the cell. Channels that
   * already carry the deny are skipped without an API call, so re-running
   * this (setup, startup, channel creation) is cheap on a healthy server.
   */
  private async lockEveryChannel(
    g: GuildLike,
    role: RoleLike,
    cellChannelId: string,
  ): Promise<{ locked: number; skipped: number; failed: number }> {
    const targets = [...g.channels.cache.values()].filter(
      (channel) =>
        channel.id !== cellChannelId &&
        !channel.isThread() &&
        !(role.id === g.roles.everyone.id) &&
        !isAlreadyDenied(channel, role.id),
    );
    let locked = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += OVERWRITE_CHUNK) {
      const chunk = targets.slice(i, i + OVERWRITE_CHUNK);
      const results = await Promise.allSettled(chunk.map((channel) => this.denyRole(channel, role)));
      for (const result of results) {
        if (result.status === "fulfilled") locked += 1;
        else {
          failed += 1;
          this.log.warn("couldn't hide a channel from jailed members", {
            error: String(result.reason),
          });
        }
      }
    }
    return {
      locked,
      skipped: g.channels.cache.size - targets.length,
      failed,
    };
  }

  /** Deny @jailed read/write on other channels (and voice Connect). */
  private async denyRole(channel: ChannelLike, role: RoleLike): Promise<void> {
    const options: Record<string, boolean> = {
      ViewChannel: false,
      SendMessages: false,
      SendMessagesInThreads: false,
    };
    if (channel.isVoiceBased()) options.Connect = false;
    await channel.permissionOverwrites.edit(role, options, { reason: "Monarch jail" });
  }

  // ── the relay ──────────────────────────────────────────────────────

  /** One webhook per channel, created lazily and reused (Discord caps them at 15/channel). */
  private async relayWebhook(message: Message<true>): Promise<Webhook | null> {
    const channel = message.channel;
    // Threads post through their parent's webhook with `threadId`.
    const host = channel.isThread() ? channel.parent : channel;
    if (!host || !("fetchWebhooks" in host)) return null;
    const cached = this.webhookCache.get(host.id);
    if (cached) return cached;
    const me = message.guild.members.me;
    if (!me || !host.permissionsFor(me).has(PermissionFlagsBits.ManageWebhooks)) return null;
    const hooks = await host.fetchWebhooks();
    let hook = hooks.find(
      (candidate) =>
        candidate.owner?.id === this.client().user?.id &&
        candidate.name === JAIL_WEBHOOK_NAME &&
        candidate.token,
    );
    if (!hook) {
      hook = await host.createWebhook({ name: JAIL_WEBHOOK_NAME, reason: "Monarch jail relay" });
    }
    this.webhookCache.set(host.id, hook);
    return hook;
  }

  /** Drop a cached webhook so the next relay re-fetches (or recreates) it. */
  private evictWebhookCache(hook: Webhook): void {
    for (const [channelId, cached] of this.webhookCache) {
      if (cached.id === hook.id) this.webhookCache.delete(channelId);
    }
  }

  private serializeRelay(channelId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.relayChains.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const stored = current.catch(() => {});
    this.relayChains.set(channelId, stored);
    const cleanup = () => {
      if (this.relayChains.get(channelId) === stored) this.relayChains.delete(channelId);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  /**
   * Delete a jailed message and re-post it cutely under the member's own name
   * and avatar. Attachments are re-uploaded from the original's CDN URLs, so
   * the relay goes first and the delete happens even if it failed — the gag
   * has to hold either way.
   */
  private async relay(message: Message<true>, style: JailEntry["style"]): Promise<void> {
    // Polls can't be re-posted faithfully (recreating one would lose every
    // vote), so they're left alone rather than deleted.
    if (message.poll) {
      this.log.info("jail relay skipped — message contains a poll", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }

    const me = message.guild.members.me;
    const channelPerms = me ? message.channel.permissionsFor(me) : null;
    if (!channelPerms?.has(PermissionFlagsBits.ManageMessages)) {
      this.log.warn("jailed message left alone — missing Manage Messages", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }
    if (!channelPerms.has(PermissionFlagsBits.SendMessages)) {
      // Deleting a message the bot couldn't re-post would just destroy it.
      this.log.warn("jailed message left alone — missing Send Messages", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }

    const content = toJailedText(message.content ?? "", style);
    const files = message.attachments.map((a) => a.url);
    const stickers = message.stickers.map((s) => s.name);
    const stickerText =
      stickers.length > 0 ? toJailedText(`*(sticker: ${stickers.join(", ")})*`, style) : "";
    const body = [content, stickerText].filter(Boolean).join("\n");
    if (!body && files.length === 0) {
      await message.delete().catch(() => {});
      return;
    }

    const member = message.member;
    const displayName = member?.displayName ?? message.author.displayName ?? message.author.username;
    const avatarURL =
      member?.displayAvatarURL({ size: 256 }) ?? message.author.displayAvatarURL({ size: 256 });
    const username = sanitizeRelayUsername(displayName, message.author.username);
    const sendPayload = (): WebhookMessageCreateOptions => ({
      content: truncate(body, 2000) || undefined,
      files: files.slice(0, 10),
      username,
      avatarURL,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
      allowedMentions: { parse: [] },
    });

    await this.serializeRelay(message.channelId, async () => {
      try {
        const hook = await this.relayWebhook(message);
        if (hook) {
          try {
            await hook.send(sendPayload());
          } catch (error) {
            // A webhook deleted from Server Settings leaves a stale cache
            // entry: evict it and try once more with a fresh one.
            if (!isUnknownWebhook(error)) throw error;
            this.log.info("jail webhook was deleted — recreating", {
              guildId: message.guildId,
              channelId: message.channelId,
            });
            this.evictWebhookCache(hook);
            const fresh = await this.relayWebhook(message);
            if (!fresh) throw error;
            await fresh.send(sendPayload());
          }
        } else {
          await message.channel.send({
            content: truncate(`**${displayName}**: ${body}`, 2000),
            files: files.slice(0, 10),
            allowedMentions: { parse: [] },
          });
        }
      } catch (e) {
        this.log.warn("jail relay failed — original still deleted", { error: String(e) });
      }
      await message
        .delete()
        .catch((e) => this.log.warn("couldn't delete a jailed message", { error: String(e) }));
    });
  }
}

const JAIL_WEBHOOK_NAME = "Monarch Jail";

function isAlreadyDenied(channel: ChannelLike, roleId: string): boolean {
  const overwrite = channel.permissionOverwrites.cache.get(roleId);
  if (!overwrite) return false;
  if (!overwrite.deny.has(PermissionFlagsBits.ViewChannel)) return false;
  if (!overwrite.deny.has(PermissionFlagsBits.SendMessages)) return false;
  if (!overwrite.deny.has(PermissionFlagsBits.SendMessagesInThreads)) return false;
  if (channel.isVoiceBased() && !overwrite.deny.has(PermissionFlagsBits.Connect)) return false;
  // An allow for View Channel on the same overwrite would win in Discord's
  // calculation — only a clean deny counts as done.
  return !overwrite.allow.has(PermissionFlagsBits.ViewChannel) &&
    !overwrite.allow.has(PermissionFlagsBits.SendMessages) &&
    !overwrite.allow.has(PermissionFlagsBits.SendMessagesInThreads);
}

/**
 * Webhook display names may not contain "discord" (Discord rejects the send,
 * which would delete the original with nothing re-posted), so swap one
 * character for a lookalike instead of failing the whole relay.
 */
function sanitizeRelayUsername(displayName: string, fallback: string): string {
  const cleaned = displayName
    .replace(/discord/gi, "d\u0456scord")
    .replace(/clyde/gi, "\u0441lyde")
    .trim();
  const name = cleaned.length > 0 ? cleaned : fallback;
  // Truncate by code point so a trailing emoji isn't sliced in half (Discord
  // caps webhook usernames at 80 characters).
  return Array.from(name).slice(0, 80).join("");
}

function isUnknownWebhook(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 10015;
}

/** One place decides how a jailed message is spelled (./jail.ts owns the styles). */
function toJailedText(text: string, style: JailEntry["style"]): string {
  return toJailSpeak(text, style);
}
