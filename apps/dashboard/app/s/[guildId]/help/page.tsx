import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { env } from "@/lib/env";
import { HelpPanel } from "@/components/help/HelpPanel";

export const metadata = { title: "Help & Commands · Monarch" };

/**
 * Help & Commands — the full manual for Monarch's slash commands, rendered
 * from the shared catalog in @monarch/shared (same data as `/monarch help`
 * in Discord).
 */
export default async function HelpPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  await params; // guildId only personalizes the copy below

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Help</p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Commands &amp; how to use them</h1>
      <p className="mb-8 max-w-2xl text-sm leading-relaxed text-ink-300 sm:mb-6">
        Everything Monarch can do in Discord — the design studio, the jail gag and the music player — with every
        option, who can run it and what it needs. Type <code className="rounded bg-ink-900 px-1.5 py-0.5 text-xs text-gold-400">/monarch help</code>{" "}
        in Discord for the short version of this page.
      </p>
      <HelpPanel appUrl={env.appUrl} />
    </main>
  );
}
