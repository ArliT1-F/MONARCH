import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { BuilderApp } from "@/components/content/BuilderApp";

export default async function MessageDesignerPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  return <BuilderApp guildId={guildId} kind="message" />;
}
