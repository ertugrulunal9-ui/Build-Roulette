import { describe, expect, it } from 'vitest';
import { CdnError } from '../src/errors';
import { Limiter, SingleFlight } from '../src/limiter';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Limiter', () => {
  it('runs at most maxActive tasks, in FIFO order', async () => {
    const limiter = new Limiter('t', 2, 10);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        await g.promise;
        return i;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.stats()).toMatchObject({ active: 2, queued: 2 });
    gates[1]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    for (const g of gates) g.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(limiter.stats()).toMatchObject({ active: 0, queued: 0, completed: 4 });
  });

  it('sheds load with 503 + Retry-After when the queue is full', async () => {
    const limiter = new Limiter('build', 1, 1, 12);
    const gate = deferred();
    const a = limiter.run(() => gate.promise);
    const b = limiter.run(() => Promise.resolve('b'));
    await expect(limiter.run(() => Promise.resolve('c'))).rejects.toMatchObject({
      status: 503,
      code: 'overloaded',
      retryAfterSeconds: 12,
    });
    gate.resolve();
    await a;
    expect(await b).toBe('b');
    expect(limiter.stats()).toMatchObject({ shed: 1, completed: 2 });
  });

  it('drops a queued task whose signal aborts (it never runs)', async () => {
    const limiter = new Limiter('t', 1, 10);
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const controller = new AbortController();
    let ran = false;
    const queued = limiter.run(() => {
      ran = true;
      return Promise.resolve();
    }, controller.signal);
    await tick();
    expect(limiter.stats().queued).toBe(1);
    controller.abort(new CdnError(504, 'timeout', 'request took too long'));
    await expect(queued).rejects.toMatchObject({ status: 504 });
    expect(limiter.stats()).toMatchObject({ queued: 0, cancelled: 1 });
    gate.resolve();
    await first;
    expect(ran).toBe(false);
    expect(limiter.stats().active).toBe(0);
  });

  it('refuses an already aborted signal and releases the slot after a failure', async () => {
    const limiter = new Limiter('t', 1, 1);
    const aborted = new AbortController();
    aborted.abort(new Error('gone'));
    await expect(limiter.run(() => Promise.resolve(), aborted.signal)).rejects.toThrow('gone');
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(() => Promise.resolve(1))).toBe(1);
  });
});

describe('SingleFlight', () => {
  it('shares one in-flight promise per key and forgets it when settled', async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    const gate = deferred<number>();
    const work = () => {
      calls++;
      return gate.promise;
    };
    const a = flight.run('k', work);
    const b = flight.run('k', work);
    expect(flight.size).toBe(1);
    gate.resolve(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(calls).toBe(1);
    expect(flight.size).toBe(0);
    expect(flight.stats()).toMatchObject({ started: 1, joined: 1 });
  });

  it('does not remember failures', async () => {
    const flight = new SingleFlight<number>();
    await expect(flight.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await flight.run('k', () => Promise.resolve(2))).toBe(2);
  });

  it('cancels the work only when every waiter has aborted', async () => {
    const flight = new SingleFlight<number>();
    let workSignal: AbortSignal | undefined;
    const work = (signal: AbortSignal) => {
      workSignal = signal;
      return new Promise<number>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    };
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = flight.run('k', work, c1.signal);
    const b = flight.run('k', work, c2.signal);
    const c = flight.run('k', work); // no signal: keeps the work alive
    c1.abort(new Error('one'));
    c2.abort(new Error('two'));
    await expect(a).rejects.toThrow('one');
    await expect(b).rejects.toThrow('two');
    expect(workSignal?.aborted).toBe(false);

    const lone = new AbortController();
    const d = flight.run('other', work, lone.signal);
    const otherSignal = workSignal;
    lone.abort(new Error('bye'));
    await expect(d).rejects.toThrow('bye');
    expect(otherSignal?.aborted).toBe(true);
    expect((otherSignal?.reason as CdnError).code).toBe('cancelled');
    expect(flight.has('other')).toBe(false); // the next caller starts fresh
    expect(flight.stats().abandoned).toBe(1);
    void c.catch(() => undefined);
  });
});
