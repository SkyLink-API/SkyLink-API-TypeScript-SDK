/**
 * Where the SDK reports a failure it deliberately refuses to propagate.
 *
 * Two things can throw without it being the request's fault: a user callback
 * (`onRateLimit`, `onQuotaLow`) and a user-supplied cache store. Neither is allowed
 * to fail a request — an observer that throws must not cost you the METAR you asked
 * for — but neither may vanish either, because a silently swallowed exception in a
 * callback is a bug that takes days to find.
 *
 * So they land on `console.warn`, prefixed with `[skylink-api]`. That is the one
 * channel every JavaScript runtime has, it is greppable, and it is trivially
 * silenced (`console.warn = () => {}`) by anyone who genuinely wants it gone.
 */

/** Report a swallowed failure on `console.warn`, never throwing itself. */
export function warn(context: string, cause: unknown): void {
  try {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const logger = (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console;
    logger?.warn?.(`[skylink-api] ${context}: ${detail}`, cause);
  } catch {
    // A console that throws is not a problem worth having an opinion about.
  }
}
