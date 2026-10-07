/** Percentiles and summaries over raw samples (milliseconds, bytes, counts). */

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile of an ascending array (p in 0..100). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  const i = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[i] ?? Number.NaN;
}

export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    min: n ? (sorted[0] ?? Number.NaN) : Number.NaN,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n ? (sorted[n - 1] ?? Number.NaN) : Number.NaN,
    mean: n ? sum / n : Number.NaN,
  };
}

/** Rounds every number of a summary (for reports). */
export function roundSummary(s: Summary, digits = 1): Summary {
  const f = 10 ** digits;
  const r = (x: number) => (Number.isFinite(x) ? Math.round(x * f) / f : x);
  return {
    n: s.n,
    min: r(s.min),
    p50: r(s.p50),
    p90: r(s.p90),
    p95: r(s.p95),
    p99: r(s.p99),
    max: r(s.max),
    mean: r(s.mean),
  };
}

/** Adds `by` to `counts[key]`. */
export function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/** Sums several count maps. */
export function mergeCounts(maps: readonly Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) bump(out, k, v);
  return out;
}

/** Sorted by key, for stable report output. */
export function sortedEntries<T>(m: Record<string, T>): [string, T][] {
  return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
}
