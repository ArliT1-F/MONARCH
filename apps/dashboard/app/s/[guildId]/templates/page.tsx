import { redirect } from "next/navigation";

/** Templates live on the Import / Export page — one place for portable designs. */
export default async function TemplatesPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  redirect(`/s/${guildId}/import-export`);
}
