import { ActivityType, type PresenceData } from "discord.js";
import { MONARCH_COMMANDS } from "@monarch/shared";

/**
 * The bot's Discord status *is* the help command.
 *
 * `/monarch help` is the catalog name (and what the slash picker shows).
 * Kept to that one command on purpose: a member-list status truncates, and
 * a chopped command is worse than one people can type. `!help` is the same
 * command — the default prefix keeps working in every server — and the help
 * embed says so.
 */
export const BOT_STATUS_TEXT =
  MONARCH_COMMANDS.find((command) => command.name === "/monarch help")?.usage ?? "/monarch help";

/**
 * Gateway presence sent with identify, and again once the client is ready.
 *
 * Custom (activity type 4) rather than Playing/Watching so Discord shows the
 * command itself, with no "Playing" prefix. `name` is required by the API
 * and is not what current clients display for this activity type — the
 * visible text is `state`. `name` repeats the command anyway, so a client
 * that renders `name` still shows something you can type.
 */
export function helpCommandPresence(): PresenceData {
  return {
    status: "online",
    afk: false,
    activities: [
      {
        type: ActivityType.Custom,
        name: BOT_STATUS_TEXT,
        state: BOT_STATUS_TEXT,
      },
    ],
  };
}

/** Apply {@link helpCommandPresence} to a connected user. Never throws. */
export function applyHelpStatus(user: { setPresence(presence: PresenceData): unknown }): boolean {
  try {
    user.setPresence(helpCommandPresence());
    return true;
  } catch {
    return false;
  }
}
