import { describe, expect, it } from "vitest";
import {
  COMMAND_CATALOG,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
  MUSIC_COMMANDS,
  MONARCH_COMMANDS,
} from "@monarch/shared";
import {
  COMMAND_HELP,
  burgCommandJSON,
  monarchCommandJSON,
  prefixHelpLine,
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
      expect.arrayContaining([
        "help",
        "dashboard",
        "invite",
        "status",
        "prefix",
        "backup",
        "export",
        "embed",
        "test",
        "burged",
      ]),
    );
  });

  it("registers invite with no options — it is a link, not a form", () => {
    const invite = (json.options ?? []).find((o) => o.name === "invite") as { options?: unknown[] };
    expect(invite).toBeTruthy();
    expect(invite.options ?? []).toHaveLength(0);
  });

  it("gives the prefix subcommand a bounded prefix option", () => {
    const prefix = (json.options ?? []).find((o) => o.name === "prefix") as {
      options?: { name: string; max_length?: number }[];
    };
    expect(prefix.options?.[0]?.name).toBe("prefix");
    expect(prefix.options?.[0]?.max_length).toBe(MAX_COMMAND_PREFIX_LENGTH);
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
    expect(help).toContain("/monarch burged");
    expect(help).toContain("https://monarch.example");
  });
});

describe("/burg command manifest", () => {
  const json = burgCommandJSON();

  it("is a guild-only top-level command with a required user", () => {
    expect(json.name).toBe("burg");
    expect(json.contexts).toEqual([0]);
    const options = json.options as { name: string; required?: boolean; choices?: { value: string }[] }[];
    expect(options.find((option) => option.name === "user")?.required).toBe(true);
    expect(options.map((option) => option.name)).toEqual(["user", "duration", "style", "reason"]);
  });

  it("offers cute style variations", () => {
    const style = (json.options as { name: string; choices?: { value: string }[] }[]).find(
      (option) => option.name === "style",
    );
    expect(style?.choices?.map((choice) => choice.value)).toEqual(["random", "soft", "cat", "chaotic"]);
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

  it("advertises the prefix surface with the guild's own prefix", () => {
    expect(embed.description).toContain(`${DEFAULT_COMMAND_PREFIX}help`);
    expect(embed.description).toContain(`${DEFAULT_COMMAND_PREFIX}prefix set <new>`);

    const custom = renderHelpEmbeds("https://monarch.example", "1234567890", "m!")[0]!;
    expect(custom.description).toContain("m!help");
    expect(custom.description).toContain("the default `!` still works");
  });

  it("lists the short prefix aliases next to the commands that have them", () => {
    const text = (embed.fields ?? []).map((f) => f.value).join("\n");
    expect(text).toContain("`!play`");
    expect(text).toContain("`!burg`");
    expect(text).toContain("`!burged`");
    expect(text).toContain("`!np`");
  });

  it("keeps every cataloged command's prefix form in sync with the docs", () => {
    for (const doc of COMMAND_CATALOG) {
      expect(doc.prefixUsage, doc.name).toBeTruthy();
      expect(doc.prefixUsage!.startsWith(DEFAULT_COMMAND_PREFIX), doc.name).toBe(true);
    }
  });
});

describe("prefix help line", () => {
  it("names the default prefix, the mention escape hatch and the way to change it", () => {
    const line = prefixHelpLine();
    expect(line).toContain(`${DEFAULT_COMMAND_PREFIX}help`);
    expect(line).toContain("@Monarch");
    expect(line).toContain(`${DEFAULT_COMMAND_PREFIX}prefix set <new>`);
    expect(line.length).toBeLessThanOrEqual(1024);
  });

  it("reminds you the default still works once a server has its own prefix", () => {
    const line = prefixHelpLine("?");
    expect(line).toContain("?play");
    expect(line).toContain("`!`");
  });
});
