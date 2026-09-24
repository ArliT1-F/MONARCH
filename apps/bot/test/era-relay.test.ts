import { describe, expect, it, vi } from "vitest";
import { EraPostError } from "../src/era.js";
import {
  clearEraPersonaCache,
  eraWebhookPayload,
  personaFromMember,
  personaFromUser,
  postAsEraPersona,
  sanitizeWebhookUsername,
  type EraPersona,
} from "../src/era-relay.js";

const PERSONA: EraPersona = { username: "Era", avatarURL: "https://cdn.example/a.png" };

describe("era persona relay", () => {
  it("uses the person's name and avatar, and only pings the invoker", () => {
    const line = eraWebhookPayload(PERSONA, {
      content: "hey <@333333333333333333>",
      mentionUserIds: ["333333333333333333"],
    });
    expect(line.username).toBe("Era");
    expect(line.avatarURL).toBe("https://cdn.example/a.png");
    expect(line.content).toBe("hey <@333333333333333333>");
    expect(line.allowedMentions).toEqual({ parse: [], users: ["333333333333333333"] });

    const photo = eraWebhookPayload(PERSONA, {
      files: [
        { name: "shy.png", body: Buffer.from([1, 2]).toString("base64"), encoding: "base64" },
      ],
    });
    expect(photo.content).toBeUndefined();
    expect(photo.username).toBe("Era");
    expect(photo.avatarURL).toBe(PERSONA.avatarURL);
    expect(photo.files).toHaveLength(1);
    expect(photo.allowedMentions).toEqual({ parse: [] });
  });

  it("prefers the server nickname, and won't send a username Discord would reject", () => {
    expect(
      personaFromMember({
        displayName: "Nick",
        displayAvatarURL: () => "https://cdn.example/guild.png",
        user: { username: "global" },
      }),
    ).toEqual({ username: "Nick", avatarURL: "https://cdn.example/guild.png" });

    expect(
      personaFromUser({
        username: "discord_clyde",
        globalName: null,
        displayAvatarURL: () => "https://cdn.example/u.png",
      }).username.toLowerCase(),
    ).not.toContain("discord");
    expect(sanitizeWebhookUsername("discord", "clyde").toLowerCase()).not.toMatch(/discord|clyde/);
  });

  it("refuses to post without Manage Webhooks, and otherwise sends the line before the photo", async () => {
    clearEraPersonaCache();
    const send = vi.fn(
      async (_payload?: {
        content?: string;
        username?: string;
        avatarURL?: string;
        files?: unknown[];
      }) => undefined,
    );
    const hook = { id: "hook", token: "t", owner: { id: "bot" }, name: "Monarch Burg", send };
    const perms = { allow: true };
    const channel = {
      id: "channel",
      isThread: () => false,
      parent: null,
      permissionsFor: () => ({ has: () => perms.allow }),
      fetchWebhooks: vi.fn(async () => ({ find: () => hook })),
      createWebhook: vi.fn(),
    };
    const message = {
      channel,
      guild: { members: { me: { id: "bot" } } },
    };

    await postAsEraPersona(
      message as never,
      [
        { content: "hey <@333333333333333333>", mentionUserIds: ["333333333333333333"] },
        { files: [{ name: "shy.png", body: "YQ==", encoding: "base64" }] },
      ],
      { botUserId: "bot", resolvePersona: async () => PERSONA },
    );
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0];
    const second = send.mock.calls[1]?.[0];
    expect(first?.content).toBe("hey <@333333333333333333>");
    expect(first?.username).toBe("Era");
    expect(first?.avatarURL).toBe(PERSONA.avatarURL);
    expect(second?.files).toHaveLength(1);
    expect(second?.username).toBe("Era");

    perms.allow = false;
    await expect(
      postAsEraPersona(message as never, [{ content: "hey" }], {
        botUserId: "bot",
        resolvePersona: async () => PERSONA,
      }),
    ).rejects.toBeInstanceOf(EraPostError);
  });
});
