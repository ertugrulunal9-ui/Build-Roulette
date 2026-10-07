/**
 * A small seeded random generator (mulberry32), so a run's choices (who ships when, what
 * they vote for, file sizes) can be replayed with `--seed`. Timing still varies with the
 * machine, so two runs with the same seed are similar, not identical.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.between(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Standard normal (Box–Muller). */
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Log-normal with the given median and 90th percentile, clamped to [min, max]. Sizes of
   * user content are long-tailed: most builds are small, a few embed images.
   */
  logNormal(median: number, p90: number, min: number, max: number): number {
    const sigma = Math.log(p90 / median) / 1.2815515655446004;
    const x = median * Math.exp(sigma * this.normal());
    return Math.round(Math.min(max, Math.max(min, x)));
  }

  /** A derived generator (per room, per player), independent of call order elsewhere. */
  fork(salt: number): Rng {
    return new Rng((Math.imul(this.state ^ salt, 0x85ebca6b) + salt) >>> 0);
  }
}
