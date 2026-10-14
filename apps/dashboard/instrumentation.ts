/** Next.js runtime initialization; builds do not need production credentials. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertConfigUsable } = await import("./lib/env");
    assertConfigUsable();
  }
}
