import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatUploadManager } from "../src/cat-upload.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function directMessage(options: {
  content?: string;
  authorId?: string;
  attachment?: { name: string; url: string; size: number; contentType: string };
}) {
  const attachment = options.attachment;
  return {
    author: { id: options.authorId ?? "owner-id" },
    content: options.content ?? "",
    attachments: {
      size: attachment ? 1 : 0,
      first: () => attachment ?? null,
    },
    reply: vi.fn(async () => undefined),
  } as unknown as Message;
}

async function tempDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "monarch-cat-upload-"));
  tempDirs.push(root);
  return root;
}

describe("CatUploadManager", () => {
  it("is owner-only and waits for an image in a DM", async () => {
    const root = await tempDirectory();
    const manager = new CatUploadManager("owner-id", root);
    const intruder = directMessage({ content: "!cat add mythic", authorId: "someone-else" });
    await manager.handleDirectMessage(intruder);
    expect(intruder.reply).toHaveBeenCalledWith("🔒 Cat uploads are reserved for the bot owner.");

    const owner = directMessage({ content: "!cat add mythic" });
    await manager.handleDirectMessage(owner);
    expect(owner.reply).toHaveBeenCalledWith(expect.stringContaining("Ready for a **Mythic** cat"));
  });

  it("downloads an owner attachment into the selected rarity folder", async () => {
    const root = await tempDirectory();
    const manager = new CatUploadManager("owner-id", root);
    await manager.handleDirectMessage(directMessage({ content: "!cat add mythic" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => Buffer.from("cat-image") })),
    );

    const upload = directMessage({
      attachment: {
        name: "My Cute Cat.png",
        url: "https://cdn.discordapp.com/attachments/channel/file/cat.png",
        size: 9,
        contentType: "image/png",
      },
    });
    await manager.handleDirectMessage(upload);

    const saved = await readFile(path.join(root, "mythic-0.01", "My_Cute_Cat.png"), "utf8");
    expect(saved).toBe("cat-image");
    expect(upload.reply).toHaveBeenCalledWith(expect.stringContaining("My_Cute_Cat"));
    expect(upload.reply).toHaveBeenCalledWith(expect.stringContaining("0.01%"));
  });

  it("uses an optional command name for the saved cat filename", async () => {
    const root = await tempDirectory();
    const manager = new CatUploadManager("owner-id", root);
    const command = directMessage({ content: "!cat add mythic Midnight Paws" });
    await manager.handleDirectMessage(command);
    expect(command.reply).toHaveBeenCalledWith(expect.stringContaining("named **Midnight_Paws**"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => Buffer.from("named-cat") })),
    );

    const upload = directMessage({
      attachment: {
        name: "original-file.png",
        url: "https://cdn.discordapp.com/attachments/channel/file/cat.png",
        size: 9,
        contentType: "image/png",
      },
    });
    await manager.handleDirectMessage(upload);

    const saved = await readFile(path.join(root, "mythic-0.01", "Midnight_Paws.png"), "utf8");
    expect(saved).toBe("named-cat");
    expect(upload.reply).toHaveBeenCalledWith(expect.stringContaining("Midnight_Paws"));
  });

  it("rejects non-image formats without leaving the pending flow", async () => {
    const root = await tempDirectory();
    const manager = new CatUploadManager("owner-id", root);
    await manager.handleDirectMessage(directMessage({ content: "!cat add rare" }));
    const upload = directMessage({
      attachment: {
        name: "cat.txt",
        url: "https://cdn.discordapp.com/attachments/channel/file/cat.txt",
        size: 9,
        contentType: "text/plain",
      },
    });
    await manager.handleDirectMessage(upload);
    expect(upload.reply).toHaveBeenCalledWith(expect.stringContaining("file type isn't supported"));
  });
});
