"use client";

/**
 * Global error boundary. Catches everything that escapes the route tree —
 * including failures from the instrumentation hook (which runs *before*
 * the root layout, so the regular `app/error.tsx` is never reached). Without
 * this, a missing production env var (e.g. `SESSION_SECRET`) produces a
 * bare "500 Internal Server Error" page with no actionable guidance.
 *
 * Per Next.js, this file replaces the root `<html><body>` on error, so it
 * must include both. We re-import `globals.css` so Tailwind utilities
 * still apply (Tailwind v4 collects them at build time regardless of
 * where the import is).
 */

import "./globals.css";
import { MonarchConfigError } from "@/lib/config";

interface ConfigIssueLike {
  variable?: string;
  code?: string;
  message?: string;
  fix?: string;
  level?: "error" | "warning";
}

function asIssues(error: unknown): ConfigIssueLike[] {
  if (error instanceof MonarchConfigError && Array.isArray(error.issues)) {
    return error.issues as ConfigIssueLike[];
  }
  // Defensive: a thrown `new MonarchConfigError(...)` always carries the
  // array, but if the boundary is ever reached with a stripped clone we
  // fall back to the message rather than crashing the error page itself.
  if (error instanceof Error && /MonarchConfigError/.test(error.name)) {
    return [
      {
        variable: "configuration",
        message: error.message,
        fix: "Check the deployment environment variables against docs/deploying-vercel.md.",
      },
    ];
  }
  return [];
}

export default function GlobalError({
  error,
  reset,
}: {
  error: unknown;
  reset?: () => void;
}) {
  const issues = asIssues(error);
  const isConfigError = issues.length > 0;
  const headline = isConfigError
    ? "Monarch isn't configured for this environment"
    : "Something went wrong";

  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          background: "var(--color-ink-950)",
          color: "var(--color-ink-100)",
          fontFamily: "var(--font-sans)",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-16">
          <div className="flex items-center gap-3 text-sm font-medium text-royal-400">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-royal-500"
            />
            Monarch
          </div>

          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
            {headline}
          </h1>

          <p className="mt-3 text-base leading-relaxed text-ink-300">
            {isConfigError
              ? "The server refused to start because one or more required environment variables are missing, weak, or set to a known placeholder. The dashboard can't run until they're fixed."
              : "An unexpected error stopped the page from loading. Try again, and if it keeps happening check the server logs."}
          </p>

          {isConfigError ? (
            <section
              aria-label="Configuration issues"
              className="mt-8 rounded-2xl border border-ink-800 bg-ink-900/60 p-5"
            >
              <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
                Issues to fix
              </h2>
              <ol className="mt-4 space-y-4">
                {issues.map((issue, i) => (
                  <li key={`${issue.variable ?? "issue"}-${i}`} className="space-y-1">
                    <p className="font-mono text-sm text-gold-400">
                      {issue.variable}
                      {issue.code ? (
                        <span className="ml-2 text-ink-400">({issue.code})</span>
                      ) : null}
                    </p>
                    {issue.message ? (
                      <p className="text-sm text-ink-200">{issue.message}</p>
                    ) : null}
                    {issue.fix ? (
                      <p className="text-sm text-ink-300">
                        <span className="text-ink-400">Fix:</span> {issue.fix}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <div className="mt-10 flex flex-wrap items-center gap-3">
            {typeof reset === "function" ? (
              <button
                type="button"
                onClick={() => reset()}
                className="rounded-xl bg-royal-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-royal-400"
              >
                Try again
              </button>
            ) : null}
            <a
              href="https://github.com/ArliT1-F/MONARCH/blob/main/docs/deploying-vercel.md"
              className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-ink-200 transition hover:border-ink-600 hover:text-ink-100"
            >
              Deployment guide ↗
            </a>
          </div>

          <p className="mt-12 text-xs text-ink-400">
            Need help? Open an issue on GitHub with the error above — env
            var <em>names</em> are safe to share; values never are.
          </p>
        </main>
      </body>
    </html>
  );
}