/**
 * App-side budgets for messages from the sandbox (docs/03 §3.9, "App-side flood through the
 * bridge"). They do not rely on the shell's own rate limit: a build can run code in the
 * shell's realm and post straight to the port, so `PreviewHandle` enforces its own limits.
 */
import type { ConsoleLevel } from '@br/protocol';

export interface PreviewBudgets {
  /** Max `console` messages accepted per second. */
  consolePerSecond: number;
  /** Max `runtime-error` messages accepted per second. */
  errorsPerSecond: number;
  /** Max `ready` messages accepted per second. */
  readyPerSecond: number;
  /** Max characters of console text the handle keeps (oldest entries are evicted first). */
  consoleMaxChars: number;
  /** Max console entries the handle keeps. */
  consoleMaxEntries: number;
}

export const DEFAULT_PREVIEW_BUDGETS: Readonly<PreviewBudgets> = {
  // Same as the shell's own limit (LIMITS.consoleMaxPerSecond), so honest shells never hit it.
  consolePerSecond: 100,
  errorsPerSecond: 20,
  // One `ready` per load; loads are debounced (150 ms), so 10/s is generous.
  readyPerSecond: 10,
  // ~200 K chars is ~400 KB of UTF-16, comfortably renderable in the console panel.
  consoleMaxChars: 200_000,
  consoleMaxEntries: 500,
};

/** Fixed one-second window counter. */
export class RateWindow {
  private start = Number.NEGATIVE_INFINITY;
  private count = 0;

  constructor(private readonly perSecond: number) {}

  /** Counts one message at `now` (ms); false when the budget for the window is used up. */
  take(now: number): boolean {
    if (now - this.start >= 1000) {
      this.start = now;
      this.count = 0;
    }
    if (this.count >= this.perSecond) return false;
    this.count++;
    return true;
  }
}

export interface ConsoleEntry {
  /** Increasing id, stable for React keys. */
  id: number;
  level: ConsoleLevel;
  text: string;
  /** `sandbox`: sent by the build (untrusted display data). `preview`: written by the app. */
  source: 'sandbox' | 'preview';
}

/**
 * The retained console: bounded by entry count and total characters. Adding past either cap
 * evicts the oldest entries; a single entry longer than the character cap is truncated.
 */
export class ConsoleLog {
  private entries: ConsoleEntry[] = [];
  private chars = 0;
  private nextId = 1;
  private _evicted = 0;
  private _version = 0;

  constructor(
    private readonly maxChars: number,
    private readonly maxEntries: number,
  ) {}

  add(level: ConsoleLevel, text: string, source: ConsoleEntry['source']): ConsoleEntry {
    const capped =
      text.length > this.maxChars ? `${text.slice(0, Math.max(0, this.maxChars - 1))}…` : text;
    const entry: ConsoleEntry = { id: this.nextId++, level, text: capped, source };
    this.entries.push(entry);
    this.chars += capped.length;
    let drop = 0;
    let chars = this.chars;
    while (
      drop < this.entries.length - 1 &&
      (chars > this.maxChars || this.entries.length - drop > this.maxEntries)
    ) {
      chars -= this.entries[drop]?.text.length ?? 0;
      drop++;
    }
    if (drop > 0) {
      this.entries = this.entries.slice(drop);
      this.chars = chars;
      this._evicted += drop;
    }
    this._version++;
    return entry;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.chars = 0;
    this._version++;
  }

  /**
   * An immutable snapshot. The same array is returned until the log changes, so it can be
   * used directly as React state.
   */
  list(): readonly ConsoleEntry[] {
    if (this.snapshot?.version !== this._version) {
      this.snapshot = { version: this._version, entries: Object.freeze(this.entries.slice()) };
    }
    return this.snapshot.entries;
  }

  private snapshot: { version: number; entries: readonly ConsoleEntry[] } | null = null;

  get totalChars(): number {
    return this.chars;
  }

  /** Entries evicted so far because of the caps. */
  get evicted(): number {
    return this._evicted;
  }

  /** Increments on every change; cheap change detection for UI batching. */
  get version(): number {
    return this._version;
  }
}
