import type { DesignatedChannels, ResolvedTarget, ServerDesign, TargetConfig } from "@monarch/schemas";
import { ok, err, monarchError, type Result, hasPermission, Permission } from "@monarch/shared";
import type { DiscordGateway } from "./gateway.js";

/**
 * Target Resolver — the single path every publishing feature goes through.
 *
 *   Feature → TargetConfig → resolveTarget() → permission check → channel
 *
 * Never assume #general. If no target can be resolved, the feature must
 * ask the user to designate one instead of guessing.
 *
 * Designated channels are Monarch configuration (stored per guild in the
 * MonarchStore) — pass them via `opts.designatedChannels`; the design's own
 * field is only a fallback for already-merged designs.
 */
export async function resolveTarget(
  gateway: DiscordGateway,
  guildId: string,
  target: TargetConfig,
  opts?: { designatedChannels?: DesignatedChannels },
): Promise<Result<ResolvedTarget>> {
  const designResult = await gateway.fetchServerDesign(guildId);
  if (!designResult.ok) return designResult;
  const design = designResult.value;
  const designated = opts?.designatedChannels ?? design.designatedChannels;

  let channelId: string | undefined;
  let threadId: string | undefined;

  if (target.kind === "designated") {
    channelId = designated[target.key];
    if (!channelId) {
      return err(
        monarchError("target.not-designated", `No ${labelFor(target.key)} channel is designated for this server.`, {
          fix: `Set one under Settings → Designated Channels, or pick a channel explicitly.`,
        }),
      );
    }
  } else {
    if (target.guildId !== guildId) {
      return err(
        monarchError("target.wrong-guild", "This target points at a different server.", {
          reason: "Monarch never publishes to a server other than the one you're designing.",
        }),
      );
    }
    channelId = target.channelId;
    threadId = target.threadId;
  }

  const channel = design.channels.find((c) => c.id === channelId);
  if (!channel) {
    return err(
      monarchError("target.channel-missing", "The target channel no longer exists.", {
        fix: "Choose another channel.",
      }),
    );
  }
  if (channel.type === "voice" || channel.type === "stage") {
    return err(
      monarchError("target.channel-kind", `#${channel.name} is a ${channel.type} channel and can't receive messages from Monarch.`, {
        fix: "Choose a text or announcement channel.",
      }),
    );
  }

  const botInfo = await gateway.getBotGuildInfo(guildId);
  if (!botInfo) {
    return err(
      monarchError("target.bot-missing", "Monarch isn't installed in this server.", {
        fix: "Invite the Monarch bot before publishing.",
      }),
    );
  }
  if (
    !hasPermission(botInfo.botPermissions, Permission.ViewChannel) ||
    !hasPermission(botInfo.botPermissions, Permission.SendMessages)
  ) {
    return err(
      monarchError("target.bot-permissions", `Monarch can't send messages to #${channel.name}.`, {
        reason: "The Monarch bot is missing View Channel or Send Messages.",
        fix: "Grant Monarch those permissions in the channel or server settings.",
      }),
    );
  }

  return ok({ guildId, channelId: channel.id, threadId, channelName: channel.name });
}

/** Channels of a design that are valid message targets (for pickers). */
export function messageableChannels(design: ServerDesign) {
  return design.channels.filter(
    (c) => c.type === "text" || c.type === "announcement",
  );
}

function labelFor(key: string): string {
  switch (key) {
    case "welcome":
      return "welcome";
    case "announcements":
      return "announcements";
    case "testing":
      return "testing";
    case "templateTesting":
      return "template-testing";
    default:
      return key;
  }
}
