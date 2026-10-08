/**
 * Server clock offset (docs/04 §4.5), shared by the solo controller and the room sync
 * engine.
 *
 * - **Measure** (on open, and when the page comes back: visible, online): `server_now()`
 *   sampled 3 times, the lowest-RTT sample wins (`estimateClockOffset`).
 * - **Resync** (every 60 s while the page stays open, T-029): ONE sample. It only keeps
 *   the clock from drifting, so a sample is used only when its round trip is about as good
 *   as the one behind the current offset (at most twice it, or 100 ms more); a slower one is
 *   ignored instead of moving the offset by up to half its RTT. After 3 ignored samples in a
 *   row (the network got slower for good) the next resync measures again with 3 samples.
 */
import { estimateClockOffset, type ClockSample } from '@br/game';

/** The current estimate: `serverClock − localClock` and the RTT of the sample behind it. */
export interface ClockEstimate {
  offsetMs: number;
  rttMs: number;
}

/**
 * Samples `serverNow` `count` times in a row and returns the lowest-RTT estimate, or null
 * when every sample failed (the caller keeps its previous offset).
 */
export async function measureClock(
  serverNow: () => Promise<number>,
  now: () => number,
  count = 3,
): Promise<ClockEstimate | null> {
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
  const usable = samples.filter(
    (s) =>
      [s.clientSentAt, s.serverTime, s.clientReceivedAt].every(Number.isFinite) &&
      s.clientReceivedAt >= s.clientSentAt,
  );
  if (usable.length === 0) return null;
  const offsetMs = estimateClockOffset(usable);
  const rttMs = Math.min(...usable.map((s) => s.clientReceivedAt - s.clientSentAt));
  return { offsetMs, rttMs };
}

/** A resync sample is used when its RTT is at most max(2 × reference, reference + this). */
export const RESYNC_RTT_SLACK_MS = 100;
/** Ignored resync samples in a row after which the next resync measures with 3 samples. */
export const RESYNC_MAX_IGNORED = 3;

/** Whether a single resync sample with `rttMs` may replace an estimate with `referenceRttMs`. */
export function acceptsResyncSample(rttMs: number, referenceRttMs: number): boolean {
  return rttMs <= Math.max(referenceRttMs * 2, referenceRttMs + RESYNC_RTT_SLACK_MS);
}

/** The offset of one page: measured (3 samples), then resynced with single samples. */
export class ServerClock {
  private estimate: ClockEstimate | null = null;
  private ignored = 0;

  constructor(
    private readonly serverNow: () => Promise<number>,
    private readonly now: () => number,
  ) {}

  /** The current offset, or null before the first successful measurement. */
  get offsetMs(): number | null {
    return this.estimate?.offsetMs ?? null;
  }

  /** 3 samples, lowest RTT wins; returns the new offset (null: all failed, nothing changes). */
  async measure(): Promise<number | null> {
    const next = await measureClock(this.serverNow, this.now, 3);
    if (next === null) return null;
    this.estimate = next;
    this.ignored = 0;
    return next.offsetMs;
  }

  /**
   * One sample; returns the new offset, or null when the sample failed or was too slow to
   * trust (the offset stays). Without an estimate yet, or after {@link RESYNC_MAX_IGNORED}
   * ignored samples in a row, it measures with 3 samples instead.
   */
  async resync(): Promise<number | null> {
    const current = this.estimate;
    if (current === null || this.ignored >= RESYNC_MAX_IGNORED) return this.measure();
    const sample = await measureClock(this.serverNow, this.now, 1);
    if (sample === null) return null;
    if (this.estimate !== current) return null; // a measurement landed meanwhile
    if (!acceptsResyncSample(sample.rttMs, current.rttMs)) {
      this.ignored++;
      return null;
    }
    this.ignored = 0;
    // The reference RTT only gets better: a slightly slower sample does not lower the bar.
    this.estimate = { offsetMs: sample.offsetMs, rttMs: Math.min(current.rttMs, sample.rttMs) };
    return sample.offsetMs;
  }
}
