/**
 * Confessions — the one rule both sides of the internal API must agree on.
 *
 * The confession *channels* are per guild (`GuildSettings.confession*ChannelId`,
 * set with `/monarch confession setup`). The confession *cooldown* is per
 * Discord user and **global**: a single window that covers every server, so
 * confessing in server A is what makes you wait in server B too.
 *
 * The window length lives here so the dashboard (which stamps `nextAllowedAt`
 * when it hands a window out) and the bot (which words "you can confess again
 * <t:…:R>") can never drift apart — same reason the prefix rules live in
 * ./prefix.ts.
 */

/**
 * How long one confession locks that person out: 6 hours. They may confess
 * again the moment it expires, i.e. they are blocked for 5h59m and change.
 */
export const CONFESSION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
