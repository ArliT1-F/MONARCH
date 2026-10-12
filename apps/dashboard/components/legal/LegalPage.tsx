import Link from "next/link";
import { MonarchMark } from "@/components/ui/MonarchMark";

/**
 * Shared shell for the public legal pages (Privacy Policy, Terms of Service).
 *
 * These routes are intentionally public — no session required — because the
 * Discord developer portal fetches them server-side during app submission.
 */
export function LegalPage({
  title,
  updatedAt,
  children,
}: {
  title: string;
  updatedAt: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative min-h-screen overflow-hidden px-6 pb-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(600px 400px at 50% -10%, rgba(124,92,255,0.14), transparent)",
        }}
      />

      <header className="relative z-10 mx-auto flex w-full max-w-2xl items-center justify-between pt-8">
        <Link href="/" className="flex items-center gap-2.5 text-ink-300 hover:text-ink-100">
          <MonarchMark className="h-7 w-7" />
          <span className="text-xs font-semibold tracking-[0.3em] uppercase">Monarch</span>
        </Link>
        <Link href="/" className="text-xs text-ink-400 transition hover:text-ink-200">
          ← Back to home
        </Link>
      </header>

      <article className="animate-fade-up relative z-10 mx-auto mt-10 w-full max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-100">{title}</h1>
        <p className="mt-2 text-xs text-ink-400">Last updated: {updatedAt}</p>

        <div className="prose-monarch mt-8 space-y-7 text-sm leading-relaxed text-ink-200">
          {children}
        </div>

        <nav className="mt-12 flex items-center justify-between border-t border-ink-700 pt-6 text-xs text-ink-400">
          <Link href="/privacy" className="transition hover:text-ink-200">
            Privacy Policy
          </Link>
          <Link href="/terms" className="transition hover:text-ink-200">
            Terms of Service
          </Link>
        </nav>
      </article>
    </main>
  );
}

/** Section heading inside a legal page. */
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-ink-100">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
