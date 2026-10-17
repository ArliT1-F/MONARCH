import { describe, expect, it, vi } from "vitest";

// The global-error boundary re-imports globals.css so Tailwind utilities
// still apply at the root document. Stub it for the server-render test.
vi.mock("@/app/globals.css", () => ({ default: "" }));

import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "@/app/global-error";
import { MonarchConfigError } from "@/lib/config";

/**
 * `app/global-error.tsx` is the only boundary that catches failures from
 * the instrumentation hook (it runs *before* the root layout, so a
 * missing production `SESSION_SECRET` would otherwise render as a bare
 * 500). These tests pin the contract: a `MonarchConfigError` produces a
 * friendly, per-variable checklist; any other error falls back to the
 * generic "Something went wrong" page.
 */
describe("global error boundary", () => {
  it("lists every issue from a MonarchConfigError without leaking values", () => {
    const error = new MonarchConfigError([
      {
        level: "error",
        code: "session-secret.known-value",
        variable: "SESSION_SECRET",
        message:
          "SESSION_SECRET must be at least 32 characters, varied, and not a known placeholder.",
        fix: "Generate an independent random secret with openssl rand -hex 32.",
      },
      {
        level: "error",
        code: "app-url.invalid",
        variable: "APP_URL",
        message: "APP_URL must be an absolute origin; production requires HTTPS.",
        fix: "Set APP_URL to the public dashboard origin, e.g. https://monarch.example.com.",
      },
    ]);

    const html = renderToStaticMarkup(
      GlobalError({ error, reset: () => {} }) as unknown as React.ReactElement,
    );

    // HTML-escaped apostrophe: React renders ' as &#x27;.
    expect(html).toContain("Monarch isn&#x27;t configured for this environment");
    expect(html).toContain("SESSION_SECRET");
    expect(html).toContain("APP_URL");
    expect(html).toContain("session-secret.known-value");
    expect(html).toContain("openssl rand -hex 32");
    // Ensure the actual error string (which would never contain secrets,
    // but still) is rendered — confirm value-free rendering.
    expect(html).not.toContain("dev-only-secret-change-me");
  });

  it("falls back to a generic page for unknown errors", () => {
    const html = renderToStaticMarkup(
      GlobalError({ error: new Error("boom"), reset: () => {} }) as unknown as React.ReactElement,
    );
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Issues to fix");
  });
});