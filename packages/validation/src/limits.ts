/**
 * Discord resource limits, centralized.
 *
 * Every Monarch feature must consume limits from here — never hardcode
 * them at call sites. When Discord changes a limit, update this file only.
 * Values reflect Discord API v10 documented constraints.
 */
export const DiscordLimits = {
  channel: {
    nameMin: 1,
    nameMax: 100,
    topicMax: 1024,
    forumTopicMax: 4096,
    slowmodeMax: 21600,
  },
  guild: {
    maxChannels: 500,
    maxChannelsPerCategory: 50,
    maxRoles: 250,
  },
  role: {
    nameMin: 1,
    nameMax: 100,
  },
  embed: {
    titleMax: 256,
    descriptionMax: 4096,
    fieldsMax: 25,
    fieldNameMax: 256,
    fieldValueMax: 1024,
    footerMax: 2048,
    authorNameMax: 256,
    totalMax: 6000,
    perMessageMax: 10,
  },
  message: {
    contentMax: 2000,
    actionRowsMax: 5,
    buttonsPerRowMax: 5,
  },
} as const;
