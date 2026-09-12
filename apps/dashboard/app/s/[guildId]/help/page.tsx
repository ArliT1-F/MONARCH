import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { env } from "@/lib/env";
import { HelpPanel } from "@/components/help/HelpPanel";

export const metadata = { title: "Help & Commands · Monarch" };

/**
 * Help & Commands — the full manual for Monarch's commands (slash *and*
 * prefix), rendered from the shared catalog in @monarch/shared — the same
 * data `/monarch help` and `!help` show in Discord.
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
        Everything Monarch can do in Discord — the design studio, the jail and burg gags, and the music player — with every
        option, who can run it and what it needs. Every command works two ways: as a slash command (
        <code className="rounded bg-ink-900 px-1.5 py-0.5 text-xs text-gold-400">/monarch help</code>) or as a plain
        message with your server&apos;s prefix (
        <code className="rounded bg-ink-900 px-1.5 py-0.5 text-xs text-gold-400">!help</code>, changeable with{" "}
        <code className="rounded bg-ink-900 px-1.5 py-0.5 text-xs text-gold-400">!prefix set ?</code>). Type either one
        in Discord for the short version of this page.
      </p>
      <HelpPanel appUrl={env.appUrl} />
    </main>
  );
}