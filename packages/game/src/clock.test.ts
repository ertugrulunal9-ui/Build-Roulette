import { describe, expect, it } from 'vitest';

import { estimateClockOffset, remainingMs } from './clock';
import type { ClockSample } from './clock';

/** Builds a sample for a server that is `offset` ms ahead and answers at the RTT midpoint. */
function sample(sentAt: number, rtt: number, offset: number): ClockSample {
  return {
    clientSentAt: sentAt,
    serverTime: sentAt + rtt / 2 + offset,
    clientReceivedAt: sentAt + rtt,
  };
}

describe('estimateClockOffset', () => {
  it('computes serverTime + rtt/2 - clientReceivedAt for a single sample', () => {
    // rtt = 100, so offset = 5000 + 50 - 1100 = 3950
    expect(
      estimateClockOffset([{ clientSentAt: 1000, serverTime: 5000, clientReceivedAt: 1100 }]),
    ).toBe(3950);
  });

  it('recovers a symmetric offset exactly', () => {
    expect(estimateClockOffset([sample(1_700_000_000_000, 80, 2500)])).toBe(2500);
    expect(estimateClockOffset([sample(1_700_000_000_000, 80, -2500)])).toBe(-2500);
    expect(estimateClockOffset([sample(1_700_000_000_000, 80, 0)])).toBe(0);
  });

  it('uses the sample with the lowest RTT, wherever it is', () => {
    const fast = { clientSentAt: 2000, serverTime: 10_010, clientReceivedAt: 2020 }; // rtt 20
    const slowA = { clientSentAt: 1000, serverTime: 99_999, clientReceivedAt: 1300 }; // rtt 300
    const slowB = { clientSentAt: 3000, serverTime: -5, clientReceivedAt: 3150 }; // rtt 150
    const expected = 10_010 + 10 - 2020;

    expect(estimateClockOffset([fast, slowA, slowB])).toBe(expected);
    expect(estimateClockOffset([slowA, fast, slowB])).toBe(expected);
    expect(estimateClockOffset([slowA, slowB, fast])).toBe(expected);
  });

  it('keeps the earliest sample when RTTs tie', () => {
    const first = { clientSentAt: 0, serverTime: 1000, clientReceivedAt: 50 };
    const second = { clientSentAt: 100, serverTime: 9000, clientReceivedAt: 150 };
    expect(estimateClockOffset([first, second])).toBe(1000 + 25 - 50);
  });

  it('handles a zero RTT', () => {
    expect(estimateClockOffset([{ clientSentAt: 10, serverTime: 15, clientReceivedAt: 10 }])).toBe(
      5,
    );
  });

  it('ignores samples with a negative RTT', () => {
    const backwards = { clientSentAt: 1000, serverTime: 0, clientReceivedAt: 900 }; // rtt -100
    const good = sample(5000, 60, 1234);
    expect(estimateClockOffset([backwards, good])).toBe(1234);
  });

  it('ignores samples with non-finite values', () => {
    const good = sample(5000, 200, 42);
    expect(
      estimateClockOffset([
        { clientSentAt: Number.NaN, serverTime: 0, clientReceivedAt: 1 },
        { clientSentAt: 0, serverTime: Number.POSITIVE_INFINITY, clientReceivedAt: 1 },
        { clientSentAt: 0, serverTime: 0, clientReceivedAt: Number.NaN },
        good,
      ]),
    ).toBe(42);
  });

  it('throws a RangeError on empty input', () => {
    expect(() => estimateClockOffset([])).toThrow(RangeError);
  });

  it('throws a RangeError when no sample is usable', () => {
    expect(() =>
      estimateClockOffset([
        { clientSentAt: 1000, serverTime: 0, clientReceivedAt: 900 },
        { clientSentAt: Number.NaN, serverTime: 0, clientReceivedAt: 1 },
      ]),
    ).toThrow(RangeError);
  });
});

describe('remainingMs', () => {
  const endsAt = 1_700_000_060_000;

  it('is the time to the deadline when clocks agree', () => {
    expect(remainingMs(endsAt, endsAt - 60_000, 0)).toBe(60_000);
  });

  it('applies a positive offset (server ahead of the local clock)', () => {
    // Local clock reads 60 s before the deadline, but the server is 5 s ahead.
    expect(remainingMs(endsAt, endsAt - 60_000, 5000)).toBe(55_000);
  });

  it('applies a negative offset (server behind the local clock)', () => {
    expect(remainingMs(endsAt, endsAt - 60_000, -5000)).toBe(65_000);
  });

  it('is 0 exactly at the deadline', () => {
    expect(remainingMs(endsAt, endsAt, 0)).toBe(0);
    expect(remainingMs(endsAt, endsAt - 1000, 1000)).toBe(0);
  });

  it('clamps at 0 after the deadline', () => {
    expect(remainingMs(endsAt, endsAt + 1, 0)).toBe(0);
    expect(remainingMs(endsAt, endsAt - 1000, 10_000)).toBe(0);
    expect(remainingMs(endsAt, endsAt + 3_600_000, 0)).toBe(0);
  });

  it('keeps sub-millisecond precision from a fractional offset', () => {
    expect(remainingMs(endsAt, endsAt - 1000, 0.5)).toBe(999.5);
  });

  it('works end to end with estimateClockOffset', () => {
    const offset = estimateClockOffset([sample(1_000_000, 120, 7000), sample(1_001_000, 40, 7000)]);
    expect(offset).toBe(7000);
    // The server says the phase ends 30 s after its current time.
    const localNow = 1_002_000;
    expect(remainingMs(localNow + offset + 30_000, localNow, offset)).toBe(30_000);
  });
});
