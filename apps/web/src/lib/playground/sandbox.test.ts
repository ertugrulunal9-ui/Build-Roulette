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
import { createWorkspace } from '@br/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameScheduler } from './frame-batcher';
import { SandboxController, type PlaygroundRuntime } from './sandbox';

// The real factory imports the esbuild wasm asset, which only Next.js can resolve.
vi.mock('./runtime-factory', () => ({
  createPlaygroundRuntime: () => {
    throw new Error('tests pass a fake runtime');
  },
}));

type Listener = (payload: unknown) => void;

/** Enough of PreviewHandle for the controller: events, load, the retained console. */
class FakePreview {
  state: PreviewHandle['state'] = 'connecting';
  readonly log = new ConsoleLog(200_000, 500);
  readonly loads: unknown[] = [];
  restarts = 0;
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
  private readonly running: (() => void)[] = [];
  private buildListener: ((r: BuildResult) => void) | null = null;
  boot = () => Promise.resolve({ coldStartMs: 1, wasmInitMs: 1 });
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

async function setup() {
  const runtime = new FakeRuntime();
  const frames = new Frames();
  const controller = new SandboxController(
    fakeHost(),
    { shellUrl: 'https://b1.usercontent.example/v1/', cdnBaseUrl: 'https://pkg.example' },
    { runtime, frames },
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
    preview.emit('crash', { reason: 'heartbeat-timeout', silentForMs: 5100, phase: 'running' });
    expect(controller.getSnapshot().preview).toBe('crashed');
    preview.state = 'crashed';
    controller.restartPreview();
    expect(preview.restarts).toBe(1);
    expect(runtime.previews).toHaveLength(1);
    expect(controller.getSnapshot().crash).toBeNull();
    expect(preview.loads).toHaveLength(2); // the first build, then the reload after restart
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
