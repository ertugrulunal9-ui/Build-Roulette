/**
 * SandboxController with a fake runtime and preview: a flood of console/error messages from a
 * build must cost a bounded number of store updates. Every store notification is one React
 * render of the playground (it reads the store with useSyncExternalStore), so counting
 * notifications counts renders.
 */
import type { ConsoleMessage, RuntimeErrorMessage } from '@br/protocol';
import {
  ConsoleLog,
  type BuildResult,
  type PreviewEventMap,
  type PreviewHandle,
} from '@br/runtime';
import { BundlerInitTimeoutError } from '@br/runtime';
import { createWorkspace } from '@br/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsEvents } from '../telemetry/analytics';
import { PreviewHealth, SandboxHealthTally } from '../telemetry/sandbox-health';
import type { FrameScheduler } from './frame-batcher';
import type { PlaygroundRuntimeHooks } from './runtime-factory';
import { SandboxController, type PlaygroundRuntime } from './sandbox';

// The real factory imports the esbuild wasm asset, which only Next.js can resolve. Tests pass
// a fake runtime; one that needs the factory's hooks sets `factory.next` and reads `hooks`.
const factory = vi.hoisted(() => ({
  next: null as PlaygroundRuntime | null,
  hooks: null as PlaygroundRuntimeHooks | null,
}));
vi.mock('./runtime-factory', () => ({
  createPlaygroundRuntime: (_config: unknown, hooks: PlaygroundRuntimeHooks) => {
    factory.hooks = hooks;
    if (!factory.next) throw new Error('tests pass a fake runtime');
    return factory.next;
  },
}));

type Listener = (payload: unknown) => void;

const CRASH: PreviewEventMap['crash'] = {
  reason: 'heartbeat-timeout',
  silentForMs: 5100,
  phase: 'running',
  wallSilentForMs: 5100,
  stalledMs: 0,
  longestStallMs: 0,
};

/** Enough of PreviewHandle for the controller: events, load, the retained console. */
class FakePreview {
  state: PreviewHandle['state'] = 'connecting';
  readonly log = new ConsoleLog(200_000, 500);
  readonly loads: unknown[] = [];
  restarts = 0;
  /** The watchdog counters PreviewHealth follows (T-031). */
  stats = { stalls: 0, stallMs: 0, sparedSilences: 0 };
  private readonly listeners = new Map<string, Set<Listener>>();

  on<K extends keyof PreviewEventMap>(event: K, l: (p: PreviewEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(l as Listener);
    return () => set.delete(l as Listener);
  }
  emit<K extends keyof PreviewEventMap>(event: K, payload: PreviewEventMap[K]): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
  /** What PreviewHandle does for an accepted console message. */
  console(m: ConsoleMessage): void {
    this.log.add(m.level, m.args.join(' '), 'sandbox');
    this.emit('console', m);
  }
  error(m: RuntimeErrorMessage): void {
    this.log.add('error', `Uncaught ${m.message}`, 'sandbox');
    this.emit('error', m);
  }
  load(build: unknown): number {
    this.loads.push(build);
    return this.loads.length;
  }
  consoleEntries() {
    return this.log.list();
  }
  clearConsole(): void {
    this.log.clear();
  }
  restart(): void {
    this.restarts++;
    this.state = 'connecting';
  }
  dispose(): void {
    this.state = 'disposed';
  }
}

class FakeRuntime implements PlaygroundRuntime {
  readonly previews: FakePreview[] = [];
  /** `build()` calls so far. */
  builds = 0;
  /** writeFile/deleteFile/setManifest calls so far (each one schedules a debounced build). */
  edits = 0;
  /** When true, `build()` waits for `finishBuilds()`. */
  manual = false;
  /** When set, builds report that the bundler could not start, with this text. */
  startFailure: string | null = null;
  private readonly running: (() => void)[] = [];
  private buildListener: ((r: BuildResult) => void) | null = null;
  boot: PlaygroundRuntime['boot'] = () =>
    Promise.resolve({ coldStartMs: 1, wasmInitMs: 1, attempts: 1 });
  writeFile = () => {
    this.edits++;
  };
  deleteFile = () => {
    this.edits++;
  };
  setManifest = () => {
    this.edits++;
  };
  /** Like EsmBrowserRuntime: the result also goes to onBuild listeners. */
  build = () => {
    this.builds++;
    const r = this.result(`build ${String(this.builds)}`);
    if (!this.manual) {
      this.buildListener?.(r);
      return Promise.resolve(r);
    }
    return new Promise<BuildResult>((resolve) => {
      this.running.push(() => {
        this.buildListener?.(r);
        resolve(r);
      });
    });
  };
  finishBuilds(): void {
    for (const finish of this.running.splice(0)) finish();
  }
  onBuild = (l: (r: BuildResult) => void) => {
    this.buildListener = l;
    return () => {
      this.buildListener = null;
    };
  };
  attachPreview = () => {
    const p = new FakePreview();
    this.previews.push(p);
    return p as unknown as PreviewHandle;
  };
  destroy = () => Promise.resolve();
  /** A build result the controller did not ask for (a debounced build, or an older one). */
  emitBuild(js = ''): void {
    this.buildListener?.(this.result(js));
  }
  private result(js: string): BuildResult {
    if (this.startFailure !== null) {
      // What EsmBrowserRuntime.build() resolves with when the bundler cannot start.
      return {
        ok: false,
        js: '',
        css: '',
        importMap: { imports: {} },
        diagnostics: [{ severity: 'error', code: 'bundler-init-failed', text: this.startFailure }],
        durationMs: 0,
      };
    }
    return {
      ok: true,
      js,
      css: '',
      importMap: { imports: {} },
      diagnostics: [],
      durationMs: 1,
    };
  }
}

/** A manual animation-frame scheduler. */
class Frames implements FrameScheduler {
  private queue = new Map<number, () => void>();
  private next = 1;
  request(cb: () => void): number {
    const id = this.next++;
    this.queue.set(id, cb);
    return id;
  }
  cancel(id: number): void {
    this.queue.delete(id);
  }
  get pending(): number {
    return this.queue.size;
  }
  run(): void {
    const cbs = [...this.queue.values()];
    this.queue.clear();
    for (const cb of cbs) cb();
  }
}

function fakeHost(): HTMLElement {
  const doc = {
    createElement: () => ({ title: '', dataset: {}, style: { cssText: '' } }),
  };
  return { ownerDocument: doc, replaceChildren: () => undefined } as unknown as HTMLElement;
}

async function setup(health?: PreviewHealth, configure?: (runtime: FakeRuntime) => void) {
  const runtime = new FakeRuntime();
  configure?.(runtime);
  const frames = new Frames();
  const controller = new SandboxController(
    fakeHost(),
    { shellUrl: 'https://b1.usercontent.example/v1/', cdnBaseUrl: 'https://pkg.example' },
    { runtime, frames, ...(health ? { health } : {}) },
  );
  await controller.start(createWorkspace('react-ts'));
  const preview = runtime.previews[0];
  if (!preview) throw new Error('no preview attached');
  let renders = 0;
  controller.subscribe(() => {
    renders++;
  });
  return { controller, runtime, preview, frames, renders: () => renders };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SandboxController output batching', () => {
  it('10,000 console messages in one frame cause one store update', async () => {
    const { controller, preview, frames, renders } = await setup();
    for (let i = 0; i < 10_000; i++)
      preview.console({ type: 'console', level: 'log', args: [`line ${String(i)}`] });
    expect(renders()).toBe(0);
    expect(frames.pending).toBe(1);
    frames.run();
    expect(renders()).toBe(1);
    const shown = controller.getSnapshot().console;
    expect(shown.length).toBeLessThanOrEqual(500);
    expect(shown.at(-1)?.text).toBe('line 9999');
  });

  it('a sustained flood costs at most one update per frame', async () => {
    const { preview, frames, renders } = await setup();
    for (let frame = 0; frame < 60; frame++) {
      for (let i = 0; i < 200; i++)
        preview.console({ type: 'console', level: 'warn', args: ['x'] });
      for (let i = 0; i < 50; i++) preview.error({ type: 'runtime-error', message: 'boom' });
      frames.run();
    }
    expect(renders()).toBe(60);
  });

  it('errors are batched too, and the overlay keeps the latest 20', async () => {
    const { controller, preview, frames, renders } = await setup();
    for (let i = 0; i < 1000; i++)
      preview.error({ type: 'runtime-error', message: `e${String(i)}` });
    frames.run();
    expect(renders()).toBe(1);
    const errors = controller.getSnapshot().runtimeErrors;
    expect(errors).toHaveLength(20);
    expect(errors.at(-1)?.message).toBe('e999');
  });

  it('no output, no update', async () => {
    const { frames, renders } = await setup();
    frames.run();
    expect(renders()).toBe(0);
  });

  it('a "still waiting for the package server" note goes once the build runs (T-032)', async () => {
    const { controller, preview, frames } = await setup();
    const stall: RuntimeErrorMessage = {
      type: 'runtime-error',
      kind: 'module-load',
      message: 'Still waiting for the package server after 8 s: zustand@5.0.15',
    };
    const failure: RuntimeErrorMessage = {
      type: 'runtime-error',
      kind: 'module-load',
      message: 'Package server unreachable: zustand@5.0.15',
    };
    preview.error(stall);
    frames.run();
    expect(controller.getSnapshot().runtimeErrors).toEqual([stall]);
    preview.emit('ready', { loadId: 1 });
    expect(controller.getSnapshot().runtimeErrors).toEqual([]);
    // A real failure stays: the shell reports `ready` right after it.
    preview.error(stall); // still pending in the frame batcher when `ready` comes
    preview.error(failure);
    preview.emit('ready', { loadId: 2 });
    frames.run();
    expect(controller.getSnapshot().runtimeErrors).toEqual([failure]);
  });

  it('a new load clears the console and drops a pending flush', async () => {
    const { controller, runtime, preview, frames } = await setup();
    preview.console({ type: 'console', level: 'log', args: ['old'] });
    runtime.emitBuild();
    expect(controller.getSnapshot().console).toEqual([]);
    expect(frames.pending).toBe(0);
  });

  it('restartPreview restarts the same handle and loads the last good build', async () => {
    const { controller, runtime, preview } = await setup();
    preview.state = 'crashed';
    preview.emit('crash', CRASH);
    expect(controller.getSnapshot().preview).toBe('crashed');
    preview.state = 'crashed';
    controller.restartPreview();
    expect(preview.restarts).toBe(1);
    expect(runtime.previews).toHaveLength(1);
    expect(controller.getSnapshot().crash).toBeNull();
    expect(preview.loads).toHaveLength(2); // the first build, then the reload after restart
  });
});

describe('SandboxController watchdog telemetry (T-031)', () => {
  const BATTLE = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';
  const telemetry = () => {
    const sent: AnalyticsEvents['preview_crash'][] = [];
    const tally = new SandboxHealthTally();
    const health = new PreviewHealth({
      mode: 'live',
      battleId: BATTLE,
      tally,
      win: null,
      track: (name, props) => {
        if (name === 'preview_crash') sent.push(props as AnalyticsEvents['preview_crash']);
      },
    });
    return { sent, tally, health };
  };

  it('a crash, then Restart preview: one preview_crash, restarted', async () => {
    const { sent, tally, health } = telemetry();
    const { controller, preview } = await setup(health);
    preview.state = 'crashed';
    preview.emit('crash', { ...CRASH, stalledMs: 300, wallSilentForMs: 5400 });
    expect(sent).toEqual([]);
    controller.restartPreview();
    expect(sent).toEqual([
      {
        battle_id: BATTLE,
        mode: 'live',
        reason: 'heartbeat_timeout',
        phase: 'running',
        silent_ms: 5100,
        wall_silent_ms: 5400,
        stalled_ms: 300,
        longest_stall_ms: 0,
        restarted: true,
      },
    ]);
    // The preview's own watchdog counters count for the battle while it runs.
    preview.stats = { stalls: 2, stallMs: 7000, sparedSilences: 1 };
    expect(tally.take(BATTLE)).toEqual({
      crashes: 1,
      restarts: 1,
      stalls: 2,
      stallMs: 7000,
      spared: 1,
    });
  });

  it('a new project replacing a crashed preview counts as a restart', async () => {
    const { sent, health } = telemetry();
    const { controller, preview } = await setup(health);
    preview.state = 'crashed';
    preview.emit('crash', CRASH);
    controller.replace(createWorkspace('vanilla-ts'));
    expect(sent.map((e) => e.restarted)).toEqual([true]);
  });

  it('a crash nobody restarted is sent when the BUILD screen goes', async () => {
    const { sent, health } = telemetry();
    const { controller, preview } = await setup(health);
    preview.state = 'crashed';
    preview.emit('crash', { ...CRASH, phase: 'loading', silentForMs: 15_100 });
    controller.dispose();
    expect(sent).toEqual([expect.objectContaining({ phase: 'loading', restarted: false })]);
  });

  it('a restart of a preview that did not crash reports nothing', async () => {
    const { sent, health } = telemetry();
    const { controller } = await setup(health);
    controller.restartPreview();
    controller.dispose();
    expect(sent).toEqual([]);
  });
});

/** The js of every build the preview was asked to run, in order. */
const loaded = (p: FakePreview) => p.loads.map((b) => (b as BuildResult).js);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SandboxController.replace (reset to a template, paste-import in replace mode)', () => {
  it('drops the old preview at once, then builds and loads the new project exactly once', async () => {
    const { controller, runtime, preview } = await setup();
    runtime.manual = true;
    expect(loaded(preview)).toEqual(['build 1']);
    const next = createWorkspace('vanilla-ts');
    controller.replace(next);
    // The old project's document is gone before the new build exists, so nothing in it can
    // take a click that the next load would throw away.
    expect(preview.restarts).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ preview: 'connecting', building: true });
    // Built right away (no 150 ms debounce), once.
    expect(runtime.builds).toBe(2);
    runtime.finishBuilds();
    await settle();
    expect(loaded(preview)).toEqual(['build 1', 'build 2']);
    expect(controller.getSnapshot().building).toBe(false);
    // The session's sync effect then sees the same workspace: nothing more to build.
    const edits = runtime.edits;
    controller.sync(next);
    expect(runtime.edits).toBe(edits);
    await settle();
    expect(runtime.builds).toBe(2);
    expect(loaded(preview)).toEqual(['build 1', 'build 2']);
  });

  it('does not load a build of the old files that finishes during the replace', async () => {
    const { controller, runtime, preview } = await setup();
    runtime.manual = true;
    controller.replace(createWorkspace('vanilla-ts'));
    runtime.emitBuild('old files'); // a build that was already running for the old project
    expect(loaded(preview)).toEqual(['build 1']);
    expect(controller.getSnapshot().building).toBe(true);
    runtime.finishBuilds();
    await settle();
    expect(loaded(preview)).toEqual(['build 1', 'build 2']);
  });

  it('loads an edit that lands right after the replace instead of the replace build', async () => {
    const { controller, runtime, preview } = await setup();
    runtime.manual = true;
    controller.replace(createWorkspace('vanilla-ts'));
    runtime.finishBuilds();
    runtime.emitBuild('edit after the replace');
    await settle();
    expect(loaded(preview)).toEqual(['build 1', 'edit after the replace']);
  });

  it('restartPreview during a replace waits for the new project instead of reloading the old one', async () => {
    const { controller, runtime, preview } = await setup();
    runtime.manual = true;
    controller.replace(createWorkspace('vanilla-ts'));
    controller.restartPreview();
    expect(loaded(preview)).toEqual(['build 1']);
    runtime.finishBuilds();
    await settle();
    expect(loaded(preview)).toEqual(['build 1', 'build 2']);
  });

  it('a newer replace wins over an older one still building', async () => {
    const { controller, runtime, preview } = await setup();
    runtime.manual = true;
    controller.replace(createWorkspace('vanilla-ts'));
    controller.replace(createWorkspace('react-ts'));
    expect(preview.restarts).toBe(2);
    runtime.finishBuilds();
    await settle();
    expect(loaded(preview)).toEqual(['build 1', 'build 3']);
  });
});

describe('SandboxController bundler start failures (T-039)', () => {
  const STALLED =
    "Couldn't start the bundler: the download stalled (no progress for 15 s, 2 attempts)";
  const stalledBoot = (runtime: FakeRuntime) => {
    runtime.boot = () => Promise.reject(new BundlerInitTimeoutError('download', 15_000, 2));
  };

  afterEach(() => {
    factory.next = null;
    factory.hooks = null;
  });

  it('a start that stalled: the failed state says so, and nothing was built or loaded', async () => {
    const { controller, runtime, preview } = await setup(undefined, stalledBoot);
    expect(controller.getSnapshot()).toMatchObject({
      bundler: 'failed',
      bundlerError: STALLED,
      building: false,
      lastBuild: null,
    });
    expect(runtime.builds).toBe(0);
    expect(preview.loads).toEqual([]);
  });

  it('Retry starts the bundler again and builds the current files into the preview', async () => {
    const { controller, runtime, preview } = await setup(undefined, stalledBoot);
    runtime.manual = true;
    const edits = runtime.edits;
    controller.retryBundler();
    expect(controller.getSnapshot()).toMatchObject({
      bundler: 'booting',
      bundlerError: null,
      building: true,
    });
    expect(runtime.builds).toBe(1);
    runtime.finishBuilds();
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      bundler: 'ready',
      bundlerError: null,
      building: false,
      lastBuild: { ok: true },
    });
    expect(loaded(preview)).toEqual(['build 1']);
    // Only the bundler restarted: no file was written, deleted or replaced.
    expect(runtime.edits).toBe(edits);
  });

  it('a Retry that fails again is back in the failed state, with the new reason', async () => {
    const { controller, runtime, preview } = await setup(undefined, (rt) => {
      rt.boot = () => Promise.reject(new Error('esbuild-wasm failed to initialize: wasm 404'));
    });
    expect(controller.getSnapshot().bundlerError).toBe(
      "Couldn't start the bundler: esbuild-wasm failed to initialize: wasm 404",
    );
    runtime.startFailure = STALLED;
    controller.retryBundler();
    await settle();
    expect(controller.getSnapshot()).toMatchObject({
      bundler: 'failed',
      bundlerError: STALLED,
      building: false,
    });
    expect(preview.loads).toEqual([]);
    // And the next Retry works.
    runtime.startFailure = null;
    controller.retryBundler();
    await settle();
    expect(controller.getSnapshot().bundler).toBe('ready');
    expect(preview.loads).toHaveLength(1);
  });

  it('Retry does nothing while the bundler runs, or after dispose', async () => {
    const { controller, runtime } = await setup();
    expect(runtime.builds).toBe(1);
    controller.retryBundler();
    expect(runtime.builds).toBe(1);
    expect(controller.getSnapshot().bundler).toBe('ready');

    const failed = await setup(undefined, stalledBoot);
    failed.controller.dispose();
    failed.controller.retryBundler();
    expect(failed.runtime.builds).toBe(0);
  });

  it('bundler starts that stalled or failed become bundler_start events', () => {
    const BATTLE = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';
    const sent: AnalyticsEvents['bundler_start'][] = [];
    const health = new PreviewHealth({
      mode: 'live',
      battleId: BATTLE,
      tally: new SandboxHealthTally(),
      win: null,
      track: (name, props) => {
        if (name === 'bundler_start') sent.push(props as AnalyticsEvents['bundler_start']);
      },
    });
    factory.next = new FakeRuntime();
    const controller = new SandboxController(
      fakeHost(),
      { shellUrl: 'https://b1.usercontent.example/v1/', cdnBaseUrl: 'https://pkg.example' },
      { frames: new Frames(), health },
    );
    const report = factory.hooks?.onInitAttempt;
    if (!report) throw new Error('the controller passed no onInitAttempt hook');
    report({ attempt: 1, outcome: 'ready', stage: 'compile', elapsedMs: 210, loadedBytes: 1 });
    expect(sent).toEqual([]); // a clean start is not news
    report({
      attempt: 1,
      outcome: 'stalled',
      stage: 'download',
      elapsedMs: 15_000.4,
      loadedBytes: 4_200_000,
    });
    report({ attempt: 2, outcome: 'ready', stage: 'compile', elapsedMs: 300, loadedBytes: 1e7 });
    report({ attempt: 1, outcome: 'error', stage: 'worker', elapsedMs: 12, loadedBytes: 0 });
    expect(sent).toEqual([
      {
        battle_id: BATTLE,
        outcome: 'stalled',
        stage: 'download',
        attempt: 1,
        elapsed_ms: 15_000,
        loaded_bytes: 4_200_000,
      },
      {
        battle_id: BATTLE,
        outcome: 'ready',
        stage: 'compile',
        attempt: 2,
        elapsed_ms: 300,
        loaded_bytes: 1e7,
      },
      {
        battle_id: BATTLE,
        outcome: 'error',
        stage: 'worker',
        attempt: 1,
        elapsed_ms: 12,
        loaded_bytes: 0,
      },
    ]);
    controller.dispose();
    report({ attempt: 1, outcome: 'stalled', stage: 'worker', elapsedMs: 1, loadedBytes: 0 });
    expect(sent).toHaveLength(3);
  });
});
