/**
 * What a capture does when it has no usable render (pure, unit tested). Shared by the
 * self-hosted worker and the `jobs` Edge Function (T-034).
 *
 * Three kinds of "no usable render":
 * - `render`: the build's own doing (it threw, painted nothing, looped, navigated away), or a
 *   page problem the renderer reported. Retrying gives the same result, so the capture falls
 *   back to the client thumbnail at once (as since T-013).
 * - `budget`: today's Browser Rendering time is spent (free plan: ~9.5 of 10 min a day). It
 *   comes back at 00:00 UTC, usually long after the capture deadline (10 min), so the capture
 *   falls back at once.
 * - `service`: Browser Rendering answered 429 (rate limit) or was unavailable (5xx, network,
 *   no answer, a rejected token). Not the build's fault and often short, so the job is given
 *   back (`fail_job`: 10, 20 s backoff, then the next run) and only the
 *   `SERVICE_FALLBACK_ATTEMPT`th attempt falls back. That keeps an outage within about two
 *   to three minutes of fallback, well inside the capture deadline.
 *
 * "Falls back" needs a client thumbnail. Without one the job is retried with backoff and
 * fails for good on the 5th attempt (`fail_job` in SQL), as before.
 */
import { RenderError } from './renderer';

export type NoRenderKind = 'render' | 'budget' | 'service';

/** The attempt (1-based, `jobs.attempts`) at which a service failure falls back. */
export const SERVICE_FALLBACK_ATTEMPT = 3;

/** Which kind of failure a renderer error is. Aborts are handled by the caller. */
export function classifyRenderFailure(e: unknown): Exclude<NoRenderKind, 'budget'> {
  if (e instanceof RenderError && (e.code === 'rate-limited' || e.code === 'unavailable')) {
    return 'service';
  }
  return 'render';
}

/** After a failure of `kind` on attempt `attempts`: use the fallback now, or retry later. */
export function afterNoRender(kind: NoRenderKind, attempts: number): 'fallback' | 'retry' {
  if (kind === 'service' && attempts < SERVICE_FALLBACK_ATTEMPT) return 'retry';
  return 'fallback';
}
