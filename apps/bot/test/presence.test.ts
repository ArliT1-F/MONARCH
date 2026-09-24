import { ActivityType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { MONARCH_COMMANDS } from "@monarch/shared";
import { applyHelpStatus, BOT_STATUS_TEXT, helpCommandPresence } from "../src/presence.js";

describe("bot status", () => {
  it("is the help command, taken from the shared catalog", () => {
    const help = MONARCH_COMMANDS.find((command) => command.name === "/monarch help");
    expect(help?.usage).toBe("/monarch help");
    expect(BOT_STATUS_TEXT).toBe("/monarch help");
    expect(BOT_STATUS_TEXT).toBe(help?.usage);
  });

  it("is a custom status, so Discord shows the command with no Playing prefix", () => {
    expect(helpCommandPresence()).toEqual({
      status: "online",
      afk: false,
      activities: [
        {
          type: ActivityType.Custom,
          name: "/monarch help",
          state: "/monarch help",
        },
      ],
    });
  });

  it("applies that presence, and a throwing client does not take the bot down", () => {
    const user = { setPresence: vi.fn() };
    expect(applyHelpStatus(user)).toBe(true);
    expect(user.setPresence).toHaveBeenCalledWith(helpCommandPresence());

    expect(
      applyHelpStatus({
        setPresence: () => {
          throw new Error("gateway closed");
        },
      }),
    ).toBe(false);
  });
});
