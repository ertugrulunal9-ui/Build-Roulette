/**
 * T-041: a bundler start that is slow after its last byte, or whose page did not run for a
 * while, is not a stall; a real stall is still caught.
 *
 * In CI run 63 (chaos shard 3, 8 players on a 4-vCPU runner), a page sat at "Starting
 * bundler…" for 30 s at the battle start. T-039's 15 s timer starts over on every progress
 * message, but after the last byte of esbuild.wasm there are none: V8 finishes the compile,
 * then esbuild's `initialize` instantiates it and runs Go's runtime start, which blocks the
 * worker's thread the whole time (measured). A compile slowed by a starved CPU, or a renderer
 * that got no CPU at all for a while (T-031 saw 5 s), could be killed as a stall, and the retry
 * adds load. Since T-041 the compile stage has its own limit (60 s) and both limits count
 * page-awake time.
 *
 * 1. 8 starts at once on a CPU that busy loops keep saturated (one per core), with esbuild's
 *    initialize held for 17 s in every worker (a synchronous request blocks the worker's thread
 *    the way the real initialize does, without using CPU): the compile stage takes longer than
 *    the 15 s stall limit. Meanwhile one page's first esbuild.wasm request never answers.
 *    Every start is ready on its first worker, and the real stall is still caught after 15 s.
 *    The pre-T-041 client stops every held start after 15 s, twice, and fails (checked).
 * 2. 8 starts, and every renderer is stopped (SIGSTOP) for 17 s while they are in the compile
 *    stage, with the compile limit lowered to 15 s: by the wall clock the stage takes longer
 *    than 15 s, in page-awake time it does not. The pre-T-041 client's timer fires as soon as
 *    the renderers run again, before the worker can finish, and kills them (checked).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import type { BootReport, BundlerLogEntry } from '../playground/main';
import type { InitAttemptReport } from '../src/worker/client';
import { fmt, freezeRenderers, percentile } from './helpers';

const STARTS = 8;
/** Longer than the 15 s stall limit. */
const HOLD_MS = 17_000;
const STALL_MS = 15_000;

/**
 * Runs in a bundler worker: esbuild's initialize (`WebAssembly.instantiate` of the compiled
 * module, then Go's runtime start) first blocks the worker's thread for `ms`, like a starved
 * CPU makes the real one slow.
 */
function holdInitialize(ms: number): void {
  const scope = self as unknown as { __brHolds?: number };
  const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  (
    WebAssembly as unknown as { instantiate: (...args: unknown[]) => Promise<unknown> }
  ).instantiate = (...args: unknown[]) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/__test/hold?ms=${String(ms)}`, false); // synchronous: the thread waits
    xhr.send();
    scope.__brHolds = (scope.__brHolds ?? 0) + 1;
    return instantiate(...args);
  };
}

interface Start {
  page: Page;
  /** The page's boot (the first build and preview after the start). */
  boot: { ok: true; report: BootReport } | { ok: false; error: string };
  attempts: InitAttemptReport[];
  log: BundlerLogEntry[];
}

/** The contexts a test opened: closed after it, so later specs see only their own pages. */
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});

/** Opens `STARTS` playground pages at once, each in its own context (its own HTTP cache). */
async function startAll(
  browser: Browser,
  query: string,
  setup: (page: Page, i: number) => Promise<void>,
): Promise<Page[]> {
  const pages: Page[] = [];
  for (let i = 0; i < STARTS; i++) {
    const context = await browser.newContext();
    opened.push(context);
    const page = await context.newPage();
    await setup(page, i);
    pages.push(page);
  }
  await Promise.all(pages.map((p) => p.goto(`/${query}`, { timeout: 60_000 })));
  return pages;
}

/** Every new bundler worker of `page` gets its initialize held for `ms`. */
function holdEveryWorker(page: Page, ms: number): void {
  page.on('worker', (w: Worker) => {
    // Installed long before the worker gets there: it first downloads 13.6 MB.
    w.evaluate(holdInitialize, ms).catch(() => undefined); // a terminated worker
  });
}

async function finish(page: Page): Promise<Start> {
  const boot = await page.evaluate(() =>
    window.__playground.boot.then(
      (report) => ({ ok: true as const, report }),
      (e: unknown) => ({ ok: false as const, error: String(e) }),
    ),
  );
  const { attempts, log } = await page.evaluate(() => ({
    attempts: window.__playground.initAttempts,
    log: window.__playground.bundlerLog,
  }));
  return { page, boot, attempts, log };
}

/** Per worker: time to its first message, the download, the compile stage, and in total. */
function stages(log: BundlerLogEntry[], worker: number) {
  const own = log.filter((e) => e.worker === worker);
  const at = (pred: (e: BundlerLogEntry) => boolean) => own.find(pred)?.t ?? NaN;
  const created = at((e) => e.type === 'created');
  const first = at((e) => e.type === 'init-progress');
  const lastByte = at((e) => e.type === 'init-progress' && e.stage === 'compile');
  const done = at((e) => e.type === 'init-done');
  return {
    worker: first - created,
    download: lastByte - first,
    compile: done - lastByte,
    total: done - created,
  };
}

function summary(values: number[]): string {
  return `p50 ${fmt(percentile(values, 50))}, max ${fmt(Math.max(...values))}`;
}

/** Each page's worker starts, e.g. `page 0: 1 stalled download 15.3 s → 2 ready 17.2 s`. */
function outcomes(starts: Start[]): string {
  return starts
    .map(
      (s, i) =>
        `page ${String(i)}: ${s.attempts.map((r) => `${String(r.attempt)} ${r.outcome} ${r.stage} ${(r.elapsedMs / 1000).toFixed(1)} s`).join(' → ')}${s.boot.ok ? '' : ` (boot failed: ${s.boot.error})`}`,
    )
    .join('; ');
}

function busyLoops(n: number): ChildProcess[] {
  return Array.from({ length: n }, () =>
    spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }),
  );
}

test('8 starts at once under CPU contention, each compile held 17 s: no false stall; a real stall is still caught', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // One busy loop per core, as the Supabase stack, the services and 8 browsers do in CI.
  const loops = busyLoops(cpus().length);
  try {
    let wasmRequests = 0;
    const pages = await startAll(browser, '', async (page, i) => {
      holdEveryWorker(page, HOLD_MS);
      if (i !== 0) return;
      // Page 0: its first esbuild.wasm request never gets an answer (a stalled download).
      await page.context().route('**/esbuild.wasm', (route) => {
        wasmRequests++;
        if (wasmRequests === 1) return; // never fulfilled
        return route.continue();
      });
    });
    const starts = await Promise.all(pages.map(finish));
    console.log(`[starts] ${outcomes(starts)}`);

    for (const [i, s] of starts.entries()) {
      expect(s.boot, `page ${String(i)}`).toMatchObject({ ok: true });
      const ready = s.attempts.at(-1);
      expect(ready, `page ${String(i)}`).toMatchObject({ outcome: 'ready', stage: 'compile' });
      // The hold ran (installed before esbuild's initialize): the compile stage outlasted the
      // stall limit.
      expect(stages(s.log, ready?.attempt ?? 0).compile, `page ${String(i)}`).toBeGreaterThan(
        HOLD_MS,
      );
    }
    // No false stall: every held start was ready on its first worker.
    for (const s of starts.slice(1)) {
      expect(s.attempts.map((r) => [r.attempt, r.outcome])).toEqual([[1, 'ready']]);
      expect(s.log.filter((e) => e.type === 'terminated')).toEqual([]);
    }
    // The real stall: stopped after 15 s of page-awake time, then the retry was ready.
    const [stalled, retried] = starts[0]?.attempts ?? [];
    expect(starts[0]?.attempts.map((r) => [r.attempt, r.outcome, r.stage])).toEqual([
      [1, 'stalled', 'download'],
      [2, 'ready', 'compile'],
    ]);
    expect(wasmRequests).toBe(2);
    expect(stalled?.awakeMs).toBeGreaterThanOrEqual(STALL_MS);
    expect(stalled?.elapsedMs).toBeLessThan(STALL_MS + 10_000);

    const first = starts.map((s) => stages(s.log, s.attempts.at(-1)?.attempt ?? 1));
    console.log(
      `[metrics] ${String(STARTS)} starts at once next to ${String(loops.length)} busy loops: worker ${summary(first.map((f) => f.worker))}; download ${summary(first.map((f) => f.download))}; compile stage ${summary(first.map((f) => f.compile))} (held ${String(HOLD_MS / 1000)} s; without the hold ${summary(first.map((f) => f.compile - HOLD_MS))}); false stalls 0; the real stall stopped after ${fmt(stalled?.awakeMs ?? NaN)} awake / ${fmt(stalled?.elapsedMs ?? NaN)} wall, retry ready after ${fmt(retried?.elapsedMs ?? NaN)}`,
    );
  } finally {
    for (const l of loops) l.kill('SIGKILL');
  }
});

test('8 starts, every renderer stopped 17 s during their compile stage: the stop is not counted against the compile limit', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const COMPILE_LIMIT_MS = 15_000;
  const FREEZE_MS = 17_000;
  // Long enough that every page is still in its compile stage when the renderers stop.
  const HOLD = 6_000;
  const pages = await startAll(browser, `?initCompileMs=${String(COMPILE_LIMIT_MS)}`, (page) => {
    holdEveryWorker(page, HOLD);
    return Promise.resolve();
  });
  // Wait until every start has its last byte (it is compiling, held), then stop everything.
  for (const page of pages) {
    await page.waitForFunction(
      () =>
        window.__playground.bundlerLog.some(
          (e) => e.type === 'init-progress' && e.stage === 'compile',
        ),
      undefined,
      { polling: 20 },
    );
  }
  const notDone = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => !window.__playground.bundlerLog.some((e) => e.type === 'init-done')),
    ),
  );
  expect(notDone.every(Boolean), 'every start is still compiling when the renderers stop').toBe(
    true,
  );
  await freezeRenderers(browser, FREEZE_MS);
  const starts = await Promise.all(pages.map(finish));
  console.log(`[starts] ${outcomes(starts)}`);

  for (const [i, s] of starts.entries()) {
    expect(s.boot, `page ${String(i)}`).toMatchObject({ ok: true });
    expect(
      s.attempts.map((r) => [r.attempt, r.outcome, r.stage]),
      `page ${String(i)}`,
    ).toEqual([[1, 'ready', 'compile']]);
    const ready = s.attempts[0];
    // By the wall clock the compile stage outlasted its limit; the stop was not counted.
    expect(stages(s.log, 1).compile).toBeGreaterThan(COMPILE_LIMIT_MS);
    expect((ready?.elapsedMs ?? 0) - (ready?.awakeMs ?? 0)).toBeGreaterThan(FREEZE_MS - 2_000);
  }
  const compile = starts.map((s) => stages(s.log, 1).compile);
  const notCounted = starts.map(
    (s) => (s.attempts[0]?.elapsedMs ?? 0) - (s.attempts[0]?.awakeMs ?? 0),
  );
  console.log(
    `[metrics] ${String(STARTS)} starts, renderers stopped ${String(FREEZE_MS / 1000)} s in the compile stage (held ${String(HOLD / 1000)} s, limit ${String(COMPILE_LIMIT_MS / 1000)} s): compile stage ${summary(compile)} wall; not counted ${summary(notCounted)}; false stalls 0`,
  );
});
