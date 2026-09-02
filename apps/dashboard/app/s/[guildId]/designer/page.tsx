import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { DesignerApp } from "@/components/designer/DesignerApp";

export default async function ServerDesignerPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  return <DesignerApp guildId={guildId} />;
}
