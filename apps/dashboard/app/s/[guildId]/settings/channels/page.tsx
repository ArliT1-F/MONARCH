import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { fetchCurrentDesign } from "@/lib/discord";
import { getStore } from "@/lib/store";
import { DesignatedChannelsForm } from "@/components/settings/DesignatedChannelsForm";

export default async function DesignatedChannelsPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const [design, settings] = await Promise.all([
    fetchCurrentDesign(guildId),
    getStore().getGuildSettings(guildId),
  ]);

  const channels =
    design?.channels
      .filter((c) => c.type === "text" || c.type === "announcement")
      .map((c) => ({ id: c.id, name: c.name })) ?? [];

  return (
    <main className="mx-auto max-w-2xl px-8 py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Settings</p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Designated channels</h1>
      <p className="mb-8 text-sm leading-relaxed text-ink-300">
        Every Monarch feature that publishes content resolves its destination through these
        defaults (or a per-feature override). Monarch never guesses a channel.
      </p>
      <DesignatedChannelsForm
        guildId={guildId}
        channels={channels}
        initial={settings.designatedChannels}
      />
    </main>
  );
}
