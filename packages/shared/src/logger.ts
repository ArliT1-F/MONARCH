/**
 * Structured logger. Intentionally dependency-free; emits JSON lines so a
 * real transport (pino, Datadog, …) can be swapped in without changing
 * call sites. Secrets must never be passed in `data` — see redactKeys.
 */
type Level = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = /token|secret|authorization|password|cookie/i;

function redact(data: Record<string, unknown> | undefined) {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = REDACT_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

function emit(level: Level, scope: string, msg: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...redact(data),
  });
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => emit("debug", scope, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => emit("info", scope, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", scope, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", scope, msg, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
