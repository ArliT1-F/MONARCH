import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickRandomImage, runEra, type EraContext } from "../src/era.js";

function fakeCtx(): EraContext & {
  attach: ReturnType<typeof vi.fn>;
  replyHidden: ReturnType<typeof vi.fn>;
} {
  return {
    commandPrefix: "!",
    attach: vi.fn(async () => undefined),
    replyHidden: vi.fn(async () => undefined),
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

  it("picks nothing out of an empty (or missing) folder", async () => {
    expect(await pickRandomImage(dir)).toBeNull();
    expect(await pickRandomImage(path.join(dir, "nope"))).toBeNull();
  });

  it("ignores non-image files and only picks recognised extensions", async () => {
    await writeFile(path.join(dir, "notes.txt"), "not a picture");
    await writeFile(path.join(dir, "one.png"), "fake-png-bytes");
    const picked = await pickRandomImage(dir);
    expect(picked).toBe("one.png");
  });

  it("!era zhvishu attaches a random image from the folder", async () => {
    await writeFile(path.join(dir, "shy.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const ctx = fakeCtx();

    await runEra(ctx, "zhvishu", dir);

    expect(ctx.attach).toHaveBeenCalledOnce();
    const [, files] = ctx.attach.mock.calls[0]!;
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("shy.jpg");
    expect(files[0].encoding).toBe("base64");
    expect(Buffer.from(files[0].body, "base64")).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(ctx.replyHidden).not.toHaveBeenCalled();
  });

  it("!era zhvishu replies instead of failing when the folder is empty", async () => {
    const ctx = fakeCtx();

    await runEra(ctx, "zhvishu", dir);

    expect(ctx.attach).not.toHaveBeenCalled();
    expect(ctx.replyHidden).toHaveBeenCalledOnce();
    expect(ctx.replyHidden.mock.calls[0]?.[0]).toContain("era_img");
  });

  it("only answers to the zhvishu subcommand", async () => {
    const ctx = fakeCtx();

    await runEra(ctx, "something-else", dir);

    expect(ctx.attach).not.toHaveBeenCalled();
    expect(ctx.replyHidden).toHaveBeenCalledOnce();
    expect(ctx.replyHidden.mock.calls[0]?.[0]).toContain("era zhvishu");
  });
});
