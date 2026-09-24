import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_CATALOG } from "@monarch/shared";
import { renderHelp } from "../src/commands.js";
import {
  canUseEra,
  chunkText,
  ERA_MESSAGE_MAX_LENGTH,
  ERA_PERSONA_USER_ID,
  EraMessages,
  eraAddText,
  eraMessagesPath,
  formatEraLine,
  listImages,
  pickRandomImage,
  runEra,
  type EraContext,
  type EraOutgoing,
} from "../src/era.js";

const OWNER = "111111111111111111";
const BOT_OWNER = "222222222222222222";
const MEMBER = "333333333333333333";
const GUILD = "800000000000000001";

function fakeCtx(overrides: Partial<Omit<EraContext, "replyPrivate" | "postAsPersona">> = {}) {
  const replies: string[] = [];
  const replyPrivate = vi.fn(async (content: string) => {
    replies.push(content);
  });
  const postAsPersona = vi.fn(async (_posts: EraOutgoing[]) => undefined);
  return {
    commandPrefix: "!",
    userId: OWNER,
    guildId: GUILD,
    guildOwnerId: OWNER,
    botOwnerId: BOT_OWNER,
    rawContent: "",
    args: [] as string[],
    ...overrides,
    replyPrivate,
    postAsPersona,
    privateText: () => replies.join("\n"),
  };
}

describe("era easter egg", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "era-img-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function options() {
    return { imgDir: dir, messagesFile: eraMessagesPath(dir), random: () => 0 };
  }

  it("is not on the help list", () => {
    const help = `${JSON.stringify(COMMAND_CATALOG)}\n${renderHelp("https://monarch.example")}`;
    expect(help).not.toContain("zhvishu");
    expect(help).not.toContain("!era");
    expect(help).not.toContain("era add");
    expect(help).not.toContain("era photos");
    expect(help).not.toContain(ERA_PERSONA_USER_ID);
  });

  it("only the server owner and the bot owner may use it", () => {
    expect(canUseEra({ userId: OWNER, guildOwnerId: OWNER, botOwnerId: null })).toBe(true);
    expect(canUseEra({ userId: BOT_OWNER, guildOwnerId: OWNER, botOwnerId: BOT_OWNER })).toBe(true);
    expect(canUseEra({ userId: MEMBER, guildOwnerId: OWNER, botOwnerId: BOT_OWNER })).toBe(false);
    expect(canUseEra({ userId: MEMBER, guildOwnerId: OWNER, botOwnerId: "  " })).toBe(false);
  });

  it("stays silent for everyone else — no hint, no photo", async () => {
    await writeFile(path.join(dir, "shy.jpg"), Buffer.from([0xff, 0xd8]));
    const ctx = fakeCtx({ userId: MEMBER });

    await runEra(ctx, "zhvishu", options());
    await runEra(ctx, "messages", options());
    await runEra(ctx, "add", { ...options() });

    expect(ctx.postAsPersona).not.toHaveBeenCalled();
    expect(ctx.replyPrivate).not.toHaveBeenCalled();
    expect(ctx.privateText()).not.toContain("zhvishu");
  });

  it("picks nothing out of an empty (or missing) folder", async () => {
    expect(await pickRandomImage(dir)).toBeNull();
    expect(await pickRandomImage(path.join(dir, "nope"))).toBeNull();
    expect(await listImages(dir)).toEqual([]);
  });

  it("ignores non-image files and lists photos in a stable order", async () => {
    await writeFile(path.join(dir, "notes.txt"), "not a picture");
    await writeFile(path.join(dir, "messages.json"), "{}");
    await writeFile(path.join(dir, "b.png"), "b");
    await writeFile(path.join(dir, "a.JPG"), "a");
    expect(await listImages(dir)).toEqual(["a.JPG", "b.png"]);
  });

  it("!era photos lists the images privately", async () => {
    await writeFile(path.join(dir, "one.png"), "x");
    await writeFile(path.join(dir, "two.gif"), "y");
    const ctx = fakeCtx();

    await runEra(ctx, "photos", options());

    expect(ctx.privateText()).toContain("one.png");
    expect(ctx.privateText()).toContain("two.gif");
    expect(ctx.privateText()).not.toContain("messages.json");
    expect(ctx.postAsPersona).not.toHaveBeenCalled();
  });

  it("saves a line as typed, including a mention the tokenizer would have flattened", async () => {
    expect(eraAddText('era add "look at this"')).toBe("look at this");
    expect(eraAddText("era ADD hello <@444444444444444444>")).toBe("hello <@444444444444444444>");
    expect(eraAddText("era add")).toBe("");

    const ctx = fakeCtx({ rawContent: "era add hello there" });
    await runEra(ctx, "add", options());
    expect(ctx.privateText()).toContain("Saved");

    const again = fakeCtx();
    await runEra(again, "messages", options());
    expect(again.privateText()).toContain("1. hello there");

    const stored = JSON.parse(await readFile(eraMessagesPath(dir), "utf8")) as {
      guilds: Record<string, string[]>;
    };
    expect(stored.guilds[GUILD]).toEqual(["hello there"]);
  });

  it("refuses an empty, duplicate, or oversized line", async () => {
    const empty = fakeCtx({ rawContent: "era add" });
    await runEra(empty, "add", options());
    expect(empty.privateText()).toContain("era add");

    const first = fakeCtx({ rawContent: "era add hey" });
    await runEra(first, "add", options());
    const dup = fakeCtx({ rawContent: "era add hey" });
    await runEra(dup, "add", options());
    expect(dup.privateText()).toContain("already saved");

    const huge = fakeCtx({ rawContent: `era add ${"a".repeat(ERA_MESSAGE_MAX_LENGTH + 1)}` });
    await runEra(huge, "add", options());
    expect(huge.privateText()).toContain(String(ERA_MESSAGE_MAX_LENGTH));
  });

  it("removes a line by the number !era messages shows", async () => {
    const store = new EraMessages(eraMessagesPath(dir));
    await store.add(GUILD, "one");
    await store.add(GUILD, "two");

    const ctx = fakeCtx({ args: ["1"] });
    await runEra(ctx, "remove", options());
    expect(ctx.privateText()).toContain("Removed 1");
    expect(await store.list(GUILD)).toEqual(["two"]);

    const missing = fakeCtx({ args: ["9"] });
    await runEra(missing, "remove", options());
    expect(missing.privateText()).toContain("no line 9");
  });

  it("!era zhvishu posts a random saved line, then a random photo, as the persona", async () => {
    await writeFile(path.join(dir, "first.png"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(dir, "second.png"), Buffer.from([4]));
    const store = new EraMessages(eraMessagesPath(dir));
    await store.add(GUILD, "hey");
    await store.add(GUILD, "look");
    const ctx = fakeCtx({ userId: MEMBER, botOwnerId: MEMBER, guildOwnerId: OWNER });

    await runEra(ctx, "zhvishu", options());

    expect(ctx.replyPrivate).not.toHaveBeenCalled();
    expect(ctx.postAsPersona).toHaveBeenCalledOnce();
    const posts = ctx.postAsPersona.mock.calls[0]![0] as EraOutgoing[];
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({
      content: formatEraLine("hey", MEMBER),
      mentionUserIds: [MEMBER],
    });
    expect(posts[0]!.content).toBe(`hey <@${MEMBER}>`);
    expect(posts[0]!.content).not.toContain(ERA_PERSONA_USER_ID);
    expect(posts[1]!.files).toHaveLength(1);
    expect(posts[1]!.files![0]!.name).toBe("first.png");
    expect(posts[1]!.files![0]!.encoding).toBe("base64");
    expect(Buffer.from(posts[1]!.files![0]!.body, "base64")).toEqual(Buffer.from([1, 2, 3]));
  });

  it("still posts the photo when no lines have been saved", async () => {
    await writeFile(path.join(dir, "only.jpg"), Buffer.from([9]));
    const ctx = fakeCtx();

    await runEra(ctx, "zhvishu", options());

    const posts = ctx.postAsPersona.mock.calls[0]![0] as EraOutgoing[];
    expect(posts).toHaveLength(1);
    expect(posts[0]!.files?.[0]?.name).toBe("only.jpg");
    expect(posts[0]!.content).toBeUndefined();
  });

  it("tells the owner, privately, when the folder is empty", async () => {
    const ctx = fakeCtx();
    await runEra(ctx, "zhvishu", options());
    expect(ctx.postAsPersona).not.toHaveBeenCalled();
    expect(ctx.privateText()).toContain("era_img");
  });

  it("tells the owner the hidden commands without announcing them to the channel helper", async () => {
    const ctx = fakeCtx();
    await runEra(ctx, "nope", options());
    expect(ctx.privateText()).toContain("!era zhvishu");
    expect(ctx.privateText()).toContain("!era add");
    expect(ctx.privateText()).toContain("!era messages");
    expect(ctx.privateText()).toContain("!era photos");
    expect(ctx.postAsPersona).not.toHaveBeenCalled();
  });

  it("keeps a long list inside Discord's message limit", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `${i}. ${"word ".repeat(20)}`);
    const chunks = chunkText(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1800)).toBe(true);
  });
});
