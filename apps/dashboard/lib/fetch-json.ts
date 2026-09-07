/**
 * Safe JSON helpers for client-side API calls.
 *
 * Route handlers (or proxies/gateways in front of them) can answer with an
 * empty body or an HTML error page on 5xx. Calling `res.json()` on those
 * throws `JSON.parse: unexpected end of data…` / `Unexpected end of JSON
 * input`, which used to surface as a raw crash string in the UI. These
 * helpers turn that into human-readable errors instead.
 *
 * Client-safe: no Node imports, no secrets — safe to bundle for the browser.
 */

export interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    fix?: string;
  };
}

/**
 * Parse a fetch Response as JSON without ever throwing.
 * Returns null for empty or non-JSON bodies (5xx HTML pages, empty 500s).
 */
export async function readJsonSafe<T = unknown>(res: Response): Promise<T | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Best-effort human-readable message for a failed API call. Never throws. */
export function apiErrorMessage(data: unknown, res: Response, fallback: string): string {
  try {
    const err = (data as ApiErrorShape | null)?.error;
    if (err && typeof err.message === "string" && err.message) {
      const extra = [err.reason, err.fix].filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      return extra.length > 0 ? `${err.message} ${extra.join(" ")}` : err.message;
    }
  } catch {
    // fall through to status-based messages
  }
  if (res.status === 401) return "Your session expired — refresh the page and sign in again.";
  if (res.status === 403) return "You don't have permission for that in this server.";
  if (res.status === 404) return "Monarch couldn't find that. It may have been deleted.";
  if (res.status >= 500) return "Monarch hit an unexpected error. Try again in a moment.";
  return fallback;
}

/** Friendly message for a fetch that never got a response (offline, DNS, CORS). */
export function networkErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return "Couldn't reach Monarch — check your connection, then try again.";
  }
  return error instanceof Error && error.message ? error.message : "Couldn't reach Monarch.";
}
