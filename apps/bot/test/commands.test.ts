import { describe, expect, it } from "vitest";
import { MUSIC_COMMANDS, MONARCH_COMMANDS } from "@monarch/shared";
import {
  COMMAND_HELP,
  monarchCommandJSON,
  renderHelp,
  renderHelpEmbeds,
} from "../src/commands.js";
import { musicCommandJSON } from "../src/music/commands.js";

describe("monarch command manifest", () => {
  const json = monarchCommandJSON();
  const subcommands = (json.options ?? []).map((o) => o.name);

  it("registers every documented subcommand", () => {
    const documented = COMMAND_HELP.map((c) => c.usage.split(" ")[1]!);
    for (const name of documented) expect(subcommands).toContain(name);
    expect(subcommands).toEqual(
      expect.arrayContaining(["help", "dashboard", "status", "backup", "export", "embed", "test", "jail", "unjail", "jailed"]),
    );
  });

  it("documents every registered subcommand in the shared catalog", () => {
    const documented = new Set(MONARCH_COMMANDS.map((c) => c.usage.split(" ")[1]!));
    for (const name of subcommands) expect(documented.has(name)).toBe(true);
  });

  it("is guild-only", () => {
    expect(json.contexts).toEqual([0]);
  });

  it("renders the plain-text help under Discord's 2000 character limit", () => {
    const help = renderHelp("https://monarch.example");
    expect(help.length).toBeLessThan(2000);
    expect(help).toContain("/monarch jail @user [duration]");
    expect(help).toContain("https://monarch.example");
  });
});

describe("music command manifest", () => {
  const json = musicCommandJSON();
  const subcommands = (json.options ?? []).map((o) => o.name);

  it("registers every documented /music subcommand", () => {
    for (const doc of MUSIC_COMMANDS) {
      expect(doc.name.startsWith("/music ")).toBe(true);
      expect(subcommands).toContain(doc.name.split(" ")[1]);
    }
  });

  it("documents every registered /music subcommand", () => {
    const documented = new Set(MUSIC_COMMANDS.map((c) => c.name.split(" ")[1]));
    for (const name of subcommands) expect(documented.has(name)).toBe(true);
  });

  it("is guild-only", () => {
    expect(json.contexts).toEqual([0]);
  });

  it("gives play a required query option", () => {
    const play = (json.options ?? []).find((o) => o.name === "play") as {
      options?: { name: string; required?: boolean }[];
    };
    expect(play.options?.[0]?.name).toBe("query");
    expect(play.options?.[0]?.required).toBe(true);
  });

  it("has the vote-skip commands documented with the bypass rule", () => {
    const skip = MUSIC_COMMANDS.find((c) => c.name === "/music skip");
    expect(skip?.who).toContain("DJ");
    expect(skip?.notes?.join(" ")).toContain("MUSIC_DJ_ROLE_NAMES");
  });
});

describe("/monarch help embed", () => {
  const embeds = renderHelpEmbeds("https://monarch.example", "1234567890");
  const embed = embeds[0]!;

  it("renders exactly one embed within every Discord limit", () => {
    expect(embeds).toHaveLength(1);
    expect((embed.description ?? "").length).toBeLessThanOrEqual(4096);
    expect(embed.fields!.length).toBeGreaterThan(0);
    for (const field of embed.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    const total =
      (embed.description?.length ?? 0) +
      (embed.title?.length ?? 0) +
      (embed.footer?.text.length ?? 0) +
      (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  it("covers every command from the shared catalog", () => {
    const text = (embed.fields ?? []).map((f) => f.value).join("\n");
    for (const doc of MONARCH_COMMANDS) {
      expect(text).toContain(doc.usage);
    }
    for (const doc of MUSIC_COMMANDS) {
      expect(text).toContain(doc.usage);
    }
  });

  it("links to the dashboard help page for this guild", () => {
    expect(embed.description).toContain("https://monarch.example/s/1234567890/help");
  });
});
