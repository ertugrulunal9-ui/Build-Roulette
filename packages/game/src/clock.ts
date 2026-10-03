/**
 * One round trip to `server_now()`. All values are epoch milliseconds; the two client
 * timestamps come from the same local clock (`Date.now()`).
 */
export interface ClockSample {
  /** Local time just before the request was sent. */
  clientSentAt: number;
  /** Time reported by the server. */
  serverTime: number;
  /** Local time just after the response arrived. */
  clientReceivedAt: number;
}

/**
 * Estimates `serverClock - localClock` in milliseconds (docs/04-state-machine.md §4.5).
 *
 * Picks the sample with the lowest round-trip time (`clientReceivedAt - clientSentAt`), on
 * the theory that it was delayed the least, and assumes the server answered halfway through
 * it: `offset = serverTime + rtt / 2 - clientReceivedAt`. On a tie, the earliest sample wins.
 *
 * Samples with a non-finite field or a negative RTT (the local clock jumped backwards
 * mid-request) are ignored.
 *
 * @throws {RangeError} if `samples` is empty or contains no usable sample.
 */
export function estimateClockOffset(samples: readonly ClockSample[]): number {
  if (samples.length === 0) {
    throw new RangeError('estimateClockOffset needs at least one sample');
  }

  let best: { sample: ClockSample; rtt: number } | undefined;
  for (const sample of samples) {
    const { clientSentAt, serverTime, clientReceivedAt } = sample;
    if (![clientSentAt, serverTime, clientReceivedAt].every(Number.isFinite)) continue;
    const rtt = clientReceivedAt - clientSentAt;
    if (rtt < 0) continue;
    if (best === undefined || rtt < best.rtt) best = { sample, rtt };
  }

  if (best === undefined) {
    throw new RangeError('estimateClockOffset found no usable sample');
  }
  return best.sample.serverTime + best.rtt / 2 - best.sample.clientReceivedAt;
}

/**
 * Milliseconds left until `phaseEndsAt` (server epoch ms), given the local clock reading
 * `localNow` and the offset from {@link estimateClockOffset}. Never negative: a deadline in
 * the past returns 0.
 */
export function remainingMs(phaseEndsAt: number, localNow: number, offset: number): number {
  return Math.max(0, phaseEndsAt - (localNow + offset));
}
