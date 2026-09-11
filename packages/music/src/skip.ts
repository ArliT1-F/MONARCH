/**
 * Skip elections — the vote-skip rules.
 *
 * A regular listener can skip by collecting votes from a majority of the
 * humans currently listening. DJs, moderators/staff and the current track's
 * requester never need to vote: the bot checks that *before* consulting the
 * election (see `canForceSkip` in roles.ts) and force-skips outright.
 *
 * Pure state machine: the bot feeds it user ids only.
 */

export interface SkipElectionState {
  /** "counted" → vote registered; "passed" → threshold reached, skip now. */
  status: "counted" | "passed" | "already" | "passed-by-this-vote";
  /** Distinct voters so far (user ids). */
  voters: string[];
  /** Votes needed to skip — majority of current listeners. */
  required: number;
  /** Votes still missing. */
  remaining: number;
}

export interface SkipElectionOptions {
  /**
   * User ids of everyone (humans only — bots never vote) currently in the
   * bot's voice channel. Re-supplied on every vote so the threshold tracks
   * people joining/leaving mid-song.
   */
  listeners: string[];
  /** Majority quorum. One listener → their vote skips instantly. */
  majorityOf?: (listenerCount: number) => number;
}

const defaultMajority = (count: number): number => Math.floor(count / 2) + 1;

export class SkipElector {
  private votes = new Map<string, Set<string>>();
  private readonly majorityOf: (count: number) => number;

  constructor(options?: Pick<SkipElectionOptions, "majorityOf">) {
    this.majorityOf = options?.majorityOf ?? defaultMajority;
  }

  /**
   * Cast a vote in `guildId`. Pass the *current* listener list every time —
   * the required count is recomputed against it, so votes never get stuck
   * when the channel empties out.
   */
  vote(guildId: string, userId: string, listeners: string[]): SkipElectionState {
    const unique = [...new Set(listeners)];
    const required = Math.min(this.majorityOf(unique.length), unique.length || 1);
    const voters = this.votes.get(guildId) ?? new Set<string>();

    // Prune votes from people who left the channel first — they shouldn't
    // count, and if everyone left in the channel has already voted the
    // election passes on the spot.
    for (const voter of voters) if (!unique.includes(voter)) voters.delete(voter);
    this.votes.set(guildId, voters);

    const passed = voters.size >= required;
    if (passed) this.votes.delete(guildId);

    if (voters.has(userId)) {
      return { status: passed ? "passed-by-this-vote" : "already", voters: [...voters], required, remaining: Math.max(0, required - voters.size) };
    }
    voters.add(userId);
    this.votes.set(guildId, voters);

    const passedNow = voters.size >= required;
    if (passedNow) this.votes.delete(guildId);
    return {
      status: passedNow ? "passed-by-this-vote" : "counted",
      voters: [...voters],
      required,
      remaining: Math.max(0, required - voters.size),
    };
  }

  /** Current tally without voting. */
  state(guildId: string, listeners: string[]): { voters: string[]; required: number } {
    const voters = this.votes.get(guildId) ?? new Set<string>();
    return { voters: [...voters], required: this.majorityOf(Math.max(listeners.length, 1)) };
  }

  /** Clear an election (track changed, playback stopped, …). */
  reset(guildId: string): void {
    this.votes.delete(guildId);
  }
}
