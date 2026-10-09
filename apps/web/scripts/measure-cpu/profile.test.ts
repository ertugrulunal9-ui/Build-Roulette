import { describe, expect, it } from 'vitest';
import { isolateCpu, quantile, stats, type CpuProfile } from './profile';

/** A profile from (node name, gap before the sample in µs) pairs. */
function profile(samples: [string, number][]): CpuProfile {
  const names = [...new Set(samples.map(([n]) => n))];
  return {
    nodes: names.map((functionName, i) => ({ id: i + 1, callFrame: { functionName } })),
    startTime: 0,
    endTime: samples.reduce((t, [, d]) => t + d, 0),
    samples: samples.map(([n]) => names.indexOf(n) + 1),
    timeDeltas: samples.map(([, d]) => d),
  };
}

describe('isolateCpu', () => {
  it('credits each busy sample with the gap before it', () => {
    const p = profile(Array.from({ length: 50 }, () => ['render', 200] as [string, number]));
    expect(isolateCpu(p, 100)).toEqual({
      cpuMs: 10,
      gcMs: 0,
      samples: 50,
      intervalUs: 200,
      gaps: 0,
    });
  });

  it('caps a gap (time the isolate did not run) at twice the real interval', () => {
    // 10 samples, then 300 ms waiting on a fetch, then 10 more.
    const p = profile([
      ...Array.from({ length: 10 }, () => ['a', 200] as [string, number]),
      ['b', 300_000],
      ...Array.from({ length: 9 }, () => ['b', 200] as [string, number]),
    ]);
    const cpu = isolateCpu(p, 100);
    expect(cpu.cpuMs).toBeCloseTo(4.2, 6); // 19 × 0.2 ms + the capped 0.4 ms
    expect(cpu.gaps).toBe(1);
  });

  it('leaves out idle samples and counts the garbage collector', () => {
    const p = profile([
      ['(idle)', 200],
      ['(idle)', 200],
      ['(garbage collector)', 200],
      ['(program)', 200],
      ['fn', 200],
    ]);
    expect(isolateCpu(p, 100)).toMatchObject({ cpuMs: 0.6, gcMs: 0.2, samples: 3 });
  });

  it('falls back to the nominal interval without back-to-back samples', () => {
    const p = profile([['fn', 50_000]]);
    expect(isolateCpu(p, 100)).toMatchObject({ intervalUs: 100, cpuMs: 0.2, gaps: 1 });
    expect(isolateCpu({ nodes: [], startTime: 0, endTime: 0 }, 100).cpuMs).toBe(0);
  });
});

describe('stats', () => {
  it('median and p95 by linear interpolation; non-finite values ignored', () => {
    const values = Array.from({ length: 21 }, (_, i) => i);
    expect(stats([...values, Number.NaN])).toEqual({ n: 21, median: 10, p95: 19, min: 0, max: 20 });
    expect(quantile([1, 2], 0.5)).toBe(1.5);
    expect(stats([]).n).toBe(0);
    expect(Number.isNaN(stats([]).median)).toBe(true);
  });
});
