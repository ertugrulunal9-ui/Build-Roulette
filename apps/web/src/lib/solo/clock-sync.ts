/**
 * Server clock offset (docs/04 §4.5): `server_now()` sampled a few times, the lowest-RTT
 * sample wins (`estimateClockOffset`). Shared by the solo controller and the room sync
 * engine.
 */
import { estimateClockOffset, type ClockSample } from '@br/game';

/**
 * Samples `serverNow` `count` times in a row and returns `serverClock − localClock` in ms,
 * or null when every sample failed (the caller keeps its previous offset).
 */
export async function measureClockOffset(
  serverNow: () => Promise<number>,
  now: () => number,
  count = 3,
): Promise<number | null> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < count; i++) {
    const clientSentAt = now();
    try {
      const serverTime = await serverNow();
      samples.push({ clientSentAt, serverTime, clientReceivedAt: now() });
    } catch {
      // A failed sample is skipped.
    }
  }
  return samples.length > 0 ? estimateClockOffset(samples) : null;
}
