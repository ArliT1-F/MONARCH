/**
 * top.gg vote gate — the "thank you for voting" wall in front of a few perks.
 *
 * What is behind it is deliberately cosmetic or convenience-only: extra jail
 * styles, music radio mode and the on-demand analyzer report. Nothing that
 * keeps a server safe, and nothing a moderated member's fate depends on.
 *
 * The rules:
 *
 * - **Nothing is locked without `TOPGG_TOKEN`.** Self-hosted Monarch (and the
 *   dev sandbox) can't check votes at all, so every perk is simply unlocked —
 *   a missing token must not punish people for running their own bot.
 * - **Votes are cached per user**, a little while when the answer is "voted"
 *   (so a burst of commands doesn't hammer top.gg) and a shorter while when it
 *   is "not voted" (so the link they just clicked starts working quickly).
 * - **Network trouble fails open.** If top.gg is down, voters keep their
 *   perks; the alternative — locking everything behind a third party's uptime
 *   — is worse than a few freeloaders during an outage. The failure is
 *   logged, and `TOPGG_REQUIRED=1` flips the policy to fail *closed* for
 *   instances that would rather enforce it strictly.
 */

/** How top.gg's bot-check endpoint is reached. Injectable for tests. */
export type VoteFetch = (botId: string, userId: string, token: string) => Promise<boolean>;

export interface VoteGateOptions {
  /** top.gg API token (`TOPGG_TOKEN`); null disables the gate entirely. */
  token?: string | null;
  /** The application id to check votes for. */
  botId?: () => string | null;
  /** Overrides the HTTP call (tests). */
  fetchVote?: VoteFetch;
  /** `TOPGG_REQUIRED=1` → a broken check denies instead of allowing. */
  required?: boolean;
  /** How long a "voted" answer is trusted. */
  votedTtlMs?: number;
  /** How long a "not voted" answer is trusted. */
  unvotedTtlMs?: number;
  now?: () => number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_VOTED_TTL_MS = 5 * 60_000;
const DEFAULT_UNVOTED_TTL_MS = 60_000;

/** top.gg counts a vote for twelve hours; the vote page says so. */
export const VOTE_WINDOW_MS = 12 * 60 * 60_000;

interface CacheEntry {
  voted: boolean;
  expiresAt: number;
}

export class VoteGate {
  private readonly token: string | null;
  private readonly botId: () => string | null;
  private readonly fetchVote: VoteFetch;
  private readonly required: boolean;
  private readonly votedTtlMs: number;
  private readonly unvotedTtlMs: number;
  private readonly now: () => number;
  private readonly log: VoteGateOptions["log"];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: VoteGateOptions = {}) {
    this.token = options.token?.trim() || null;
    this.botId = options.botId ?? (() => null);
    this.fetchVote = options.fetchVote ?? topGgCheck;
    this.required = options.required ?? false;
    this.votedTtlMs = options.votedTtlMs ?? DEFAULT_VOTED_TTL_MS;
    this.unvotedTtlMs = options.unvotedTtlMs ?? DEFAULT_UNVOTED_TTL_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Can votes be checked at all? False = every perk is unlocked. */
  get enabled(): boolean {
    return this.token !== null && this.botId() !== null;
  }

  /** True when a failed check denies access instead of allowing it. */
  get strict(): boolean {
    return this.required;
  }

  /** The page to send people to. Null when there is no application id yet. */
  voteUrl(): string | null {
    const id = this.botId();
    return id ? `https://top.gg/bot/${id}/vote` : null;
  }

  /**
   * Does this person hold a counted vote right now?
   *
   * Fail-open by design (see the module comment): when the gate is disabled,
   * or top.gg can't be reached and `required` is not set, the answer is yes.
   */
  async hasVoted(userId: string): Promise<boolean> {
    if (!this.enabled) return true;

    const hit = this.cache.get(userId);
    if (hit && hit.expiresAt > this.now()) return hit.voted;

    const botId = this.botId()!;
    try {
      const voted = await this.fetchVote(botId, userId, this.token!);
      this.cache.set(userId, {
        voted,
        expiresAt: this.now() + (voted ? this.votedTtlMs : this.unvotedTtlMs),
      });
      return voted;
    } catch (e) {
      if (this.required) {
        this.log?.warn("top.gg vote check failed — denying (TOPGG_REQUIRED)", {
          userId,
          error: String(e),
        });
        return false;
      }
      this.log?.warn("top.gg vote check failed — allowing the perk for now", {
        userId,
        error: String(e),
      });
      // Cache the optimistic answer so an outage doesn't produce one failing
      // HTTP call per command use.
      this.cache.set(userId, { voted: true, expiresAt: this.now() + this.unvotedTtlMs });
      return true;
    }
  }

  /** Forget a cached answer (tests, and the `/vote` command's "check again"). */
  forget(userId: string): void {
    this.cache.delete(userId);
  }
}

/**
 * `GET https://top.gg/api/bots/:id/check?userId=:id` with the raw API token in
 * the `Authorization` header. `voted` comes back as 1 or 0.
 */
export const topGgCheck: VoteFetch = async (botId, userId, token) => {
  const res = await fetch(
    `https://top.gg/api/bots/${botId}/check?userId=${encodeURIComponent(userId)}`,
    { headers: { Authorization: token } },
  );
  if (!res.ok) throw new Error(`top.gg responded ${res.status}`);
  const data = (await res.json()) as { voted?: number | boolean };
  return data.voted === 1 || data.voted === true;
};

/**
 * The shared words for a locked perk. One wording everywhere, so somebody who
 * hits the wall twice gets the same instruction twice.
 */
export function voteRequiredMessage(perk: string, url: string | null): string {
  return [
    `🗳️ **${perk} is a voter perk.**`,
    url
      ? `Vote for Monarch on top.gg and it unlocks for 12 hours: ${url}`
      : "Vote for Monarch on top.gg and it unlocks for 12 hours — the link is in `/monarch vote`.",
    "It takes ten seconds, and it is the whole subscription model. Thank you! 💛",
  ].join("\n");
}
