import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { isDemoMode } from "@/lib/env";
import { MonarchMark } from "@/components/ui/MonarchMark";

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/select");
  const { error } = await searchParams;
  const demo = isDemoMode();

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(600px 400px at 50% -10%, rgba(124,92,255,0.18), transparent), radial-gradient(500px 300px at 85% 110%, rgba(232,182,76,0.07), transparent)",
        }}
      />
      <div className="animate-fade-up relative z-10 flex w-full max-w-md flex-col items-center text-center">
        <MonarchMark className="mb-6 h-12 w-12" />
        <p className="mb-2 text-xs font-semibold tracking-[0.3em] text-ink-300 uppercase">
          Monarch
        </p>
        <h1 className="mb-3 text-4xl font-semibold tracking-tight text-ink-100">
          Design your Discord.
        </h1>
        <p className="mb-10 text-sm leading-relaxed text-ink-300">
          A visual studio for Discord servers — design structure, preview every
          change, and deploy with confidence. Nothing touches your server until
          you approve the diff.
        </p>

        {error && (
          <div className="mb-6 w-full rounded-lg border border-danger-400/30 bg-danger-400/10 px-4 py-3 text-sm text-danger-400">
            {error}
          </div>
        )}

        <a
          href="/api/auth/login"
          className="group flex w-full items-center justify-center gap-2 rounded-xl bg-royal-500 px-5 py-3 text-sm font-medium text-white shadow-lg shadow-royal-500/20 transition hover:bg-royal-400"
        >
          {demo ? (
            <>Enter the demo studio</>
          ) : (
            <>
              <DiscordIcon className="h-4 w-4" />
              Continue with Discord
            </>
          )}
        </a>

        {demo && (
          <p className="mt-4 text-xs text-ink-400">
            Demo mode — no Discord app configured. Monarch runs against mock
            servers so you can try the full design&nbsp;→&nbsp;diff&nbsp;→&nbsp;apply flow.
          </p>
        )}

        <div className="mt-14 grid w-full grid-cols-3 gap-3 text-left">
          {[
            ["Design", "Structure, channels & categories in a visual canvas"],
            ["Preview", "Validation and a full diff before anything changes"],
            ["Deploy", "Apply to Discord with snapshots and version history"],
          ].map(([title, desc]) => (
            <div key={title} className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
              <p className="mb-1 text-xs font-semibold text-ink-100">{title}</p>
              <p className="text-[11px] leading-relaxed text-ink-400">{desc}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 text-[11px] text-ink-400">
          Already exploring?{" "}
          <Link href="/select" className="text-royal-400 hover:underline">
            Go to your servers
          </Link>
        </p>
      </div>
    </main>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}
