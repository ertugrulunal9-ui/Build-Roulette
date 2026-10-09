/**
 * Pure helpers of the CPU measurement (T-033, docs/08-free-tier.md): the CPU time an isolate
 * spent, estimated from a V8 CPU profile (Chrome DevTools Protocol `Profiler.stop`), and the
 * summary statistics of the samples. Unit-tested in profile.test.ts.
 */

/** The parts of a DevTools `Profiler.Profile` this needs. */
export interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string } }[];
  startTime: number;
  endTime: number;
  samples?: number[];
  /** Microseconds between a sample and the one before it (the first: since `startTime`). */
  timeDeltas?: number[];
}

export interface IsolateCpu {
  /** Estimated CPU time of the isolate, milliseconds. */
  cpuMs: number;
  /** Of which the garbage collector. */
  gcMs: number;
  /** Non-idle samples. */
  samples: number;
  /** The sampler's real interval (median gap between back-to-back samples), microseconds. */
  intervalUs: number;
  /** Samples whose gap was capped (the isolate was not running in between: I/O, other isolates). */
  gaps: number;
}

/** A gap shorter than this counts as "back to back" when finding the sampler's real interval. */
const RUN_GAP_US = 1_000;

/**
 * The CPU time an isolate spent between `Profiler.start` and `Profiler.stop`.
 *
 * V8 records a sample only while the isolate is entered (workerd enters it only while it runs
 * JavaScript for it), so time spent waiting on I/O or running other isolates leaves no
 * samples, only a longer gap before the next one. Each non-idle sample is credited with the
 * gap before it (like `wrangler check startup`), capped at twice the sampler's real interval:
 * a long gap is time the isolate was not running. The cap is the method's error per gap
 * (at most `2 × intervalUs` per resumption, in either direction).
 */
export function isolateCpu(profile: CpuProfile, nominalIntervalUs: number): IsolateCpu {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const names = new Map(profile.nodes.map((n) => [n.id, n.callFrame.functionName]));
  const inRun = deltas.filter((d) => d > 0 && d < RUN_GAP_US).sort((a, b) => a - b);
  const intervalUs = inRun.length > 0 ? quantile(inRun, 0.5) : nominalIntervalUs;
  const cap = 2 * intervalUs;
  let cpuUs = 0;
  let gcUs = 0;
  let counted = 0;
  let gaps = 0;
  for (let i = 0; i < samples.length; i++) {
    const name = names.get(samples[i] ?? -1);
    if (name === '(idle)') continue;
    const delta = Math.max(0, deltas[i] ?? 0);
    const credited = Math.min(delta, cap);
    if (delta > cap) gaps++;
    cpuUs += credited;
    if (name === '(garbage collector)') gcUs += credited;
    counted++;
  }
  return { cpuMs: cpuUs / 1000, gcMs: gcUs / 1000, samples: counted, intervalUs, gaps };
}

/** The q-quantile of sorted values (linear interpolation between ranks). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (pos - lo);
}

export interface Stats {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export function stats(values: readonly number[]): Stats {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
  };
}

/** A number for a table cell: one decimal, `–` when missing. */
export function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '–';
}
