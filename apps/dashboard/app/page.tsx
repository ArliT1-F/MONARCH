import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { isDemoMode } from "@/lib/env";
import { isInviteAvailable } from "@/lib/invite";
import { MonarchMark } from "@/components/ui/MonarchMark";
import { DiscordIcon } from "@/components/ui/DiscordIcon";
import { InviteBotButton } from "@/components/ui/InviteBotButton";

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/select");
  const { error } = await searchParams;
  const demo = isDemoMode();
  // Inviting the bot from the landing page only makes sense with a real
  // Discord application; in demo mode the install is simulated after sign-in.
  const canInvite = !demo && isInviteAvailable();

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

        {canInvite && (
          <>
            <InviteBotButton variant="secondary" className="mt-3 w-full" />
            <p className="mt-3 text-[11px] text-ink-400">
              Adding the bot doesn&apos;t change anything on its own — Monarch only
              writes to your server after you approve a diff.
            </p>
          </>
        )}

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
