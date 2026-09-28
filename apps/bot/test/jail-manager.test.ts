import { describe, expect, it, vi } from "vitest";
import { PermissionsBitField, PermissionFlagsBits } from "discord.js";
import { JailConfigRegistry } from "../src/jail-config.js";
import { JailRegistry } from "../src/jail.js";
import { JailManager, isCellMessage, staffRoleIdsFor } from "../src/jail-manager.js";

const GUILD = "800000000000000001";
const CELL = "700000000000000001";
const ROLE = "600000000000000001";
const USER = "500000000000000001";
const MOD = "400000000000000001";
const EVERYONE = GUILD;
const perms = (bits: bigint = 0n) => new PermissionsBitField(bits);
const config = { guildId: GUILD, channelId: CELL, roleId: ROLE, staffRoleIds: [MOD] };

describe("jail live enforcement", () => {
  it("recognizes the cell and its threads, never other channels", () => {
    expect(isCellMessage({ channelId: CELL, channel: { isThread: () => false } }, config)).toBe(true);
    expect(isCellMessage({ channelId: "thread", channel: { isThread: () => true, parentId: CELL } }, config)).toBe(true);
    expect(isCellMessage({ channelId: "other", channel: { isThread: () => false } }, config)).toBe(false);
  });

  it("selects moderation roles and explicit staff without duplicating them", () => {
    const roles = [
      { id: MOD, permissions: perms(PermissionFlagsBits.KickMembers) },
      { id: ROLE, permissions: perms() },
    ] as never;
    expect(staffRoleIdsFor(roles, { extra: MOD, previous: [MOD] })).toEqual([MOD]);
  });

  function harness() {
    const writes = new Map<string, { edit: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }>();
    const channel = (id: string, name: string) => {
      const write = { edit: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
      writes.set(id, write);
      return { id, name, type: 0, isThread: () => false, isTextBased: () => true,
        isVoiceBased: () => false, permissionOverwrites: { cache: new Map(), ...write } };
    };
    const cell = channel(CELL, "jail");
    const general = channel("300000000000000001", "general");
    const role = { id: ROLE, name: "jailed", position: 1, permissions: perms() };
    const mod = { id: MOD, name: "staff", position: 2, permissions: perms(PermissionFlagsBits.KickMembers) };
    const everyone = { id: EVERYONE, name: "@everyone", position: 0, permissions: perms() };
    const userRoles = new Set<string>();
    const user = { id: USER, roles: { cache: { has: (id: string) => userRoles.has(id) },
      add: vi.fn(async (id: string) => { userRoles.add(id); }),
      remove: vi.fn(async (id: string) => { userRoles.delete(id); }), highest: { position: 0 } },
      permissions: perms() };
    const roleCreate = vi.fn(async () => role);
    const guild = { id: GUILD, name: "Test", members: { me: {
      permissions: perms(PermissionFlagsBits.Administrator), roles: { highest: { position: 9 } } },
      fetch: vi.fn(async () => user) }, roles: { everyone,
      cache: new Map([[MOD, mod], [EVERYONE, everyone]]), create: roleCreate },
      channels: { cache: new Map([[CELL, cell], [general.id, general]]), create: vi.fn(), fetch: vi.fn() } };
    const configs = new JailConfigRegistry({ store: { load: async () => null, save: async () => {} } });
    const registry = new JailRegistry();
    const client = { guilds: { cache: new Map([[GUILD, guild]]) }, users: { fetch: vi.fn() },
      user: { id: "bot" } };
    const manager = new JailManager({ client: () => client as never, configs, registry,
      log: { info: vi.fn(), warn: vi.fn() } });
    return { manager, guild, configs, registry, writes, user, userRoles, general, roleCreate, role };
  }

  it("sets @everyone and @jailed overwrites, then confines and releases", async () => {
    const h = harness();
    const result = await h.manager.setup(h.guild as never, { actorId: MOD });
    expect(result).toMatchObject({ ok: true, locked: 1, failed: 0, role: { created: true, id: ROLE } });
    expect(h.roleCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: "jailed", permissions: [], mentionable: false,
    }));
    expect(h.writes.get(CELL)!.edit).toHaveBeenCalledWith(expect.objectContaining({ id: EVERYONE }),
      { ViewChannel: false }, expect.anything());
    expect(h.writes.get(CELL)!.edit).toHaveBeenCalledWith(expect.objectContaining({ id: ROLE }),
      expect.objectContaining({ ViewChannel: true, SendMessages: true }), expect.anything());
    expect(h.writes.get("300000000000000001")!.edit).toHaveBeenCalledWith(expect.objectContaining({ id: ROLE }),
      { ViewChannel: false, SendMessages: false, SendMessagesInThreads: false }, expect.anything());
    expect(h.configs.peek(GUILD)).toMatchObject(config);
    await h.manager.confine(h.guild as never, USER, config);
    expect(h.userRoles.has(ROLE)).toBe(true);
    await h.manager.free(h.guild as never, USER, config);
    expect(h.userRoles.has(ROLE)).toBe(false);
  });

  it("rejects a role that grants server-wide visibility", async () => {
    const h = harness();
    const unsafe = { id: ROLE, name: "jailed", position: 1,
      permissions: perms(PermissionFlagsBits.ViewChannel) };
    h.guild.roles.cache.set(ROLE, unsafe);
    h.configs.remember(GUILD, config);
    const result = await h.manager.setup(h.guild as never, { actorId: MOD });
    expect(result).toMatchObject({ ok: false });
    expect(h.writes.get(CELL)!.edit).not.toHaveBeenCalled();
    expect(h.roleCreate).not.toHaveBeenCalled();
  });

  it("refuses to create the role without Manage Roles, changing nothing else", async () => {
    const h = harness();
    h.guild.members.me.permissions = perms();
    const result = await h.manager.setup(h.guild as never, { actorId: MOD });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("Manage Roles");
    expect(h.roleCreate).not.toHaveBeenCalled();
    expect(h.writes.get(CELL)!.edit).not.toHaveBeenCalled();
    expect(h.configs.peek(GUILD)).toBeNull();
  });

  it("does not adopt a preexisting role just because it is named jailed", async () => {
    const h = harness();
    h.guild.roles.cache.set(ROLE, h.role);
    const result = await h.manager.setup(h.guild as never, { actorId: MOD });
    expect(result).toMatchObject({ ok: true, role: { created: true } });
    expect(h.roleCreate).toHaveBeenCalledTimes(1);
  });
});
