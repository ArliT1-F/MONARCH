import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock("@/lib/prisma-store", () => ({
  PrismaStore: class {
    constructor() {
      mocks.construct();
    }
  },
}));
let dir: string;
let store: typeof import("@/lib/store");
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "monarch-security-"));
  vi.stubEnv("MONARCH_DATA_DIR", dir);
  store = await import("@/lib/store");
});
afterEach(() => {
  vi.unstubAllEnvs();
  store.resetStoreCache();
  vi.clearAllMocks();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
function localStore() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
  return store.getStore();
}
describe("storage configuration and failures", () => {
  it("uses cryptographic IDs, independent of Math.random", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("not CSPRNG");
    });
    try {
      const ids = Array.from({ length: 100 }, () => store.newId("sess"));
      expect(new Set(ids).size).toBe(100);
      expect(ids.every((id) => /^sess_[a-f0-9]{32}$/.test(id))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("refuses production file storage", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => store.getStore()).toThrow("DATABASE_URL");
  });
  it("does not fall back to files if PostgreSQL initialization fails", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/monarch");
    mocks.construct.mockImplementationOnce(() => {
      throw new Error("connection failed");
    });
    expect(() => store.getStore()).toThrow("connection failed");
  });
  it("rejects expired legacy sessions in the real file adapter", async () => {
    const file = localStore();
    await file.putSession({
      id: "legacy",
      userId: "1",
      username: "test",
      avatarUrl: null,
      createdAt: new Date(0).toISOString(),
    });
    expect(await file.getSession("legacy")).toBeNull();
  });
  it("does not treat corrupt files as empty or overwrite their contents", async () => {
    const file = localStore();
    const target = path.join(dir, "sessions.json");
    await writeFile(target, "{broken json");
    await expect(
      file.putSession({
        id: "new",
        userId: "1",
        username: "test",
        avatarUrl: null,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("{broken json");
  });
});
