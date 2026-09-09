import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getGuildSummary } from "@/lib/discord";
import { RoleDesigner } from "@/components/designer/RoleDesigner";

export default async function RolesPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const guild = await getGuildSummary(session, guildId);
  if (!guild) redirect("/select");
  if (!guild.userCanDesign) redirect(`/s/${guildId}`);
  if (!guild.botInstalled) redirect(`/s/${guildId}`);

  return <RoleDesigner guildId={guildId} />;
}
