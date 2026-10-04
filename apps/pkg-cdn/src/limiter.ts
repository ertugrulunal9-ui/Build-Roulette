/**
 * Global back-pressure: concurrency limiters with bounded queues (load shedding) and
 * request coalescing with cancellation.
 *
 * Cancellation model: every request carries an AbortSignal (client disconnect or request
 * timeout). Work that several requests share runs under its own AbortController and is
 * aborted only when *every* request waiting for it has gone away, so shared work is never
 * orphaned (it stops consuming slots, sockets and disk) and never cancelled under a request
 * that still wants it. Nested shared work (bundle -> tree -> package -> tarball) composes:
 * each level is one waiter of the level below.
 */
import { CdnError } from './errors';

/** The rejection reason of an aborted signal, as an Error. */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new CdnError(499, 'cancelled', 'the request was cancelled');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export interface LimiterStats {
  /** Running now. */
  active: number;
  /** Waiting for a slot. */
  queued: number;
  maxActive: number;
  maxQueue: number;
  /** Finished (successfully or not) after getting a slot. */
  completed: number;
  /** Refused with 503 because the queue was full. */
  shed: number;
  /** Left the queue because their request was cancelled or timed out. */
  cancelled: number;
}

interface Waiter {
  grant(): void;
}

/**
 * Runs at most `maxActive` tasks at once; up to `maxQueue` more wait in FIFO order. When the
 * queue is full, `run` fails immediately with CdnError(503, 'overloaded') carrying a
 * Retry-After hint, instead of queueing without bound. A queued task whose signal aborts
 * leaves the queue at once (it never runs).
 */
export class Limiter {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly counters = { completed: 0, shed: 0, cancelled: 0 };

  constructor(
    readonly name: string,
    readonly maxActive: number,
    readonly maxQueue: number,
    readonly retryAfterSeconds = 10,
  ) {
    if (!(maxActive >= 1)) throw new Error(`${name}: maxActive must be >= 1`);
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (this.active < this.maxActive) {
      this.active++;
    } else {
      if (this.queue.length >= this.maxQueue) {
        this.counters.shed++;
        throw new CdnError(
          503,
          'overloaded',
          `the package CDN is busy (${this.name} queue is full); retry in ${this.retryAfterSeconds.toString()} s`,
          this.retryAfterSeconds,
        );
      }
      // A released slot is handed over directly (active stays the same), so a newcomer can
      // never overtake a queued task.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i !== -1) this.queue.splice(i, 1);
          this.counters.cancelled++;
          reject(abortReason(signal));
        };
        const waiter: Waiter = {
          grant: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.queue.push(waiter);
      });
    }
    try {
      throwIfAborted(signal);
      return await fn();
    } finally {
      this.counters.completed++;
      const next = this.queue.shift();
      if (next) next.grant();
      else this.active--;
    }
  }

  stats(): LimiterStats {
    return {
      active: this.active,
      queued: this.queue.length,
      maxActive: this.maxActive,
      maxQueue: this.maxQueue,
      ...this.counters,
    };
  }
}

interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

/**
 * Request coalescing: concurrent calls with the same key share one in-flight promise. The
 * result is not cached: once the work settles (resolved or rejected) the next call starts
 * fresh, so a failure is never remembered. The work gets an AbortSignal that fires when all
 * of its waiters have aborted.
 */
export class SingleFlight<T> {
  private readonly flights = new Map<string, Flight<T>>();
  private readonly counters = { started: 0, joined: 0, abandoned: 0 };

  /** Keys with work in flight. */
  get size(): number {
    return this.flights.size;
  }

  has(key: string): boolean {
    return this.flights.has(key);
  }

  run(key: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let flight = this.flights.get(key);
    if (flight) {
      this.counters.joined++;
    } else {
      this.counters.started++;
      const controller = new AbortController();
      const promise = (async () => work(controller.signal))();
      const created: Flight<T> = { promise, controller, waiters: 0 };
      flight = created;
      this.flights.set(key, created);
      const forget = () => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      };
      promise.then(forget, forget);
    }
    const f = flight;
    f.waiters++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        f.waiters--;
        if (f.waiters === 0) {
          // Nobody wants the result any more: stop the work and let the next caller restart.
          this.counters.abandoned++;
          if (this.flights.get(key) === f) this.flights.delete(key);
          f.controller.abort(
            new CdnError(499, 'cancelled', 'every request waiting for this work went away'),
          );
        }
        reject(abortReason(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      f.promise.then(
        (value) => {
          if (done) return;
          done = true;
          f.waiters--;
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (e: unknown) => {
          if (done) return;
          done = true;
          f.waiters--;
          signal?.removeEventListener('abort', onAbort);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  stats() {
    return { inflight: this.flights.size, ...this.counters };
  }
}
