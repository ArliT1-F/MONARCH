/**
 * The owner-only debug switch (`/monarch debug on|off`).
 *
 * Music failures are reported to users as one line of human-readable text —
 * `explainYtdlpFailure()` turns yt-dlp's stderr into something a server member
 * can act on. That is the right default, but it is useless when *you* are the
 * one debugging: the interesting part is the raw error (the downloader's own
 * words, the exit code, the search that came back empty).
 *
 * So the bot keeps one switch, owned by whoever holds the Monarch application
 * (`MONARCH_OWNER_USER_ID`). With it **off** — the default, and the only state
 * a non-owner can ever see — nothing changes: failures stay one tidy sentence.
 * With it **on**, the raw failure detail is also posted to the guild's music
 * channel, fenced as a code block, for the owner to read or copy into a report.
 *
 * It is deliberately in-memory: a restart returns to the quiet default, so a
 * forgotten switch can't leave raw stack traces in a server forever.
 */

/** Owner-only switches, shared by the command that flips them and the code they affect. */
export class DebugFlags {
  private on = false;

  get enabled(): boolean {
    return this.on;
  }

  /** Flip the switch. Returns the new state. */
  set(enabled: boolean): boolean {
    this.on = enabled;
    return this.on;
  }

  toggle(): boolean {
    return this.set(!this.on);
  }
}

/**
 * Where raw diagnostics go. The music layer asks {@link enabled} before it
 * builds anything, and calls {@link post} with the raw text — never the other
 * way round, so a failure path can't leak internals by accident.
 */
export interface DebugReporter {
  enabled: () => boolean;
  /** Post raw diagnostic text for a guild. Only called while enabled. */
  post: (guildId: string, text: string) => void;
}

/** Trim raw text to something Discord accepts, keeping the tail (the newest lines). */
export function clampDebugText(text: string, max = 1800): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `…\n${clean.slice(clean.length - max)}`;
}
