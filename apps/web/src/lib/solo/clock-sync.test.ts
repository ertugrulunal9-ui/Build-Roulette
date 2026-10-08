/**
 * The server clock offset: best-of-3 measurements and single-sample resyncs that ignore a
 * slow round trip (T-029), with a scripted network (each call's RTT and the server's clock).
 */
import { describe, expect, it } from 'vitest';
import { RESYNC_MAX_IGNORED, ServerClock, acceptsResyncSample, measureClock } from './clock-sync';

/** A fake network: `samples` are [rtt, true offset] per call; the server answers halfway. */
function network(samples: [number, number][]) {
  let t = 1_000_000;
  let calls = 0;
  return {
    now: () => t,
    get calls() {
      return calls;
    },
    serverNow: (): Promise<number> => {
      const next = samples[calls++];
      if (!next) return Promise.reject(new Error('offline'));
      const [rtt, offset] = next;
      t += rtt / 2;
      const server = t + offset;
      t += rtt / 2;
      return Promise.resolve(server);
    },
  };
}

describe('measureClock', () => {
  it('keeps the lowest-RTT sample of 3 and reports its RTT', async () => {
    const n = network([
      [400, 900],
      [20, 1_000],
      [100, 1_100],
    ]);
    expect(await measureClock(n.serverNow, n.now)).toEqual({ offsetMs: 1_000, rttMs: 20 });
    expect(n.calls).toBe(3);
  });

  it('null when every sample failed', async () => {
    const n = network([]);
    expect(await measureClock(n.serverNow, n.now)).toBeNull();
  });
});

describe('acceptsResyncSample', () => {
  it('up to twice the reference RTT, or the reference + 100 ms on a fast link', () => {
    expect(acceptsResyncSample(10, 5)).toBe(true);
    expect(acceptsResyncSample(105, 5)).toBe(true);
    expect(acceptsResyncSample(106, 5)).toBe(false);
    expect(acceptsResyncSample(600, 300)).toBe(true);
    expect(acceptsResyncSample(601, 300)).toBe(false);
  });
});

describe('ServerClock', () => {
  it('measures with 3 samples, then resyncs with 1', async () => {
    const n = network([
      [30, 500],
      [20, 500],
      [40, 500],
      [25, 520],
    ]);
    const c = new ServerClock(n.serverNow, n.now);
    expect(await c.measure()).toBe(500);
    expect(n.calls).toBe(3);
    expect(await c.resync()).toBe(520);
    expect(n.calls).toBe(4);
    expect(c.offsetMs).toBe(520);
  });

  it('ignores a resync sample with a slow round trip instead of moving the offset', async () => {
    const n = network([
      [20, 500],
      [20, 500],
      [20, 500],
      [900, 2_000], // slow and far off: could be wrong by 450 ms
    ]);
    const c = new ServerClock(n.serverNow, n.now);
    await c.measure();
    expect(await c.resync()).toBeNull();
    expect(c.offsetMs).toBe(500);
  });

  it(`after ${String(RESYNC_MAX_IGNORED)} ignored samples in a row, measures with 3 again (the link got slower for good)`, async () => {
    const n = network([
      [20, 500],
      [20, 500],
      [20, 500],
      [800, 700],
      [800, 700],
      [800, 700],
      [800, 700],
      [790, 700],
      [810, 700],
    ]);
    const c = new ServerClock(n.serverNow, n.now);
    await c.measure();
    for (let i = 0; i < RESYNC_MAX_IGNORED; i++) expect(await c.resync()).toBeNull();
    expect(n.calls).toBe(3 + RESYNC_MAX_IGNORED);
    expect(await c.resync()).toBe(700);
    expect(n.calls).toBe(3 + RESYNC_MAX_IGNORED + 3);
  });

  it('a failed resync sample keeps the offset; without an estimate a resync measures', async () => {
    const n = network([
      [20, 500],
      [20, 500],
      [20, 500],
    ]);
    const c = new ServerClock(n.serverNow, n.now);
    expect(await c.resync()).toBe(500); // measured (3 samples)
    expect(n.calls).toBe(3);
    expect(await c.resync()).toBeNull(); // offline
    expect(c.offsetMs).toBe(500);
  });
});
