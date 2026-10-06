import { describe, expect, it } from 'vitest';
import { DEFAULT_READINESS, ReadinessTracker } from '../src/readiness';

describe('ReadinessTracker (signal OR network idle + 2 s, capped at 6 s)', () => {
  it('uses the documented defaults', () => {
    expect(DEFAULT_READINESS).toEqual({ capMs: 6000, idleQuietMs: 500, idleExtraMs: 2000 });
  });

  it('never decides before the page loaded', () => {
    const t = new ReadinessTracker();
    t.readySignal();
    expect(t.decide(10_000)).toBeNull();
  });

  it('a ready signal wins at once (also one sent before load)', () => {
    const t = new ReadinessTracker();
    t.readySignal();
    t.start(1000);
    expect(t.decide(1000)).toEqual({ reason: 'signal', afterMs: 0 });

    const u = new ReadinessTracker();
    u.start(0);
    u.requestStarted('a', 0);
    expect(u.decide(300)).toBeNull();
    u.readySignal();
    expect(u.decide(400)).toEqual({ reason: 'signal', afterMs: 400 });
  });

  it('idle: 500 ms without requests plus 2 s more', () => {
    const t = new ReadinessTracker();
    t.start(0);
    t.requestStarted('bundle', 10);
    t.requestEnded('bundle', 200);
    expect(t.decide(2699)).toBeNull();
    expect(t.decide(2700)).toEqual({ reason: 'idle', afterMs: 2700 });
  });

  it('a request in flight blocks idle; a new request restarts the quiet period', () => {
    const t = new ReadinessTracker();
    t.start(0);
    t.requestStarted('a', 0);
    expect(t.decide(3000)).toBeNull();
    t.requestEnded('a', 3000);
    t.requestStarted('b', 4000);
    t.requestEnded('b', 4100);
    expect(t.decide(5000)).toBeNull();
    // would be idle at 6600, but the cap comes first
    expect(t.decide(6000)).toEqual({ reason: 'cap', afterMs: 6000 });
  });

  it('cap: 6 s after load whatever the build does (a request that never ends)', () => {
    const t = new ReadinessTracker();
    t.start(100);
    t.requestStarted('eventsource', 150);
    expect(t.decide(6099)).toBeNull();
    expect(t.decide(6100)).toEqual({ reason: 'cap', afterMs: 6000 });
  });

  it('counts requests by identity; unknown and repeated ends are ignored', () => {
    const t = new ReadinessTracker();
    const a = {};
    t.start(0);
    t.requestStarted(a, 0);
    t.requestEnded({}, 100);
    expect(t.inflightCount).toBe(1);
    t.requestEnded(a, 100);
    t.requestEnded(a, 5000); // repeated: must not move lastActivity
    expect(t.inflightCount).toBe(0);
    expect(t.decide(2600)).toEqual({ reason: 'idle', afterMs: 2600 });
  });

  it('a page without any request is idle 2.5 s after load', () => {
    const t = new ReadinessTracker();
    t.start(50);
    expect(t.decide(2549)).toBeNull();
    expect(t.decide(2550)?.reason).toBe('idle');
  });

  it('start() only counts once', () => {
    const t = new ReadinessTracker();
    t.start(0);
    t.start(5000);
    expect(t.decide(6000)?.reason).toBe('cap');
  });
});
