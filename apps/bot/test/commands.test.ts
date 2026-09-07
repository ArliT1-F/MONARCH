import { describe, expect, it } from "vitest";
import { COMMAND_HELP, monarchCommandJSON, renderHelp } from "../src/commands.js";

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

  it("documents every registered subcommand in /monarch help", () => {
    const documented = new Set(COMMAND_HELP.map((c) => c.usage.split(" ")[1]!));
    for (const name of subcommands) expect(documented.has(name)).toBe(true);
  });

  it("is guild-only", () => {
    expect(json.contexts).toEqual([0]);
  });

  it("renders help under Discord's 2000 character limit", () => {
    const help = renderHelp("https://monarch.example");
    expect(help.length).toBeLessThan(2000);
    expect(help).toContain("/monarch jail @user [duration]");
    expect(help).toContain("https://monarch.example");
  });
});
