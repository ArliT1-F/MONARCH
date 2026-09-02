/**
 * A lightweight Result type used across Monarch so services can return
 * human-readable failures instead of throwing raw API errors upward.
 */
export type Result<T, E = MonarchError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface MonarchError {
  /** Stable machine-readable code, e.g. "discord.hierarchy" */
  code: string;
  /** Short human-readable summary ("Monarch couldn't move this role.") */
  message: string;
  /** Why it happened, in plain language. */
  reason?: string;
  /** What the user can do about it. */
  fix?: string;
  /** Technical detail kept for logs — never shown directly in the UI. */
  detail?: unknown;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = (error: MonarchError): Result<never, MonarchError> => ({
  ok: false,
  error,
});

export function monarchError(
  code: string,
  message: string,
  extra?: Partial<Omit<MonarchError, "code" | "message">>,
): MonarchError {
  return { code, message, ...extra };
}
