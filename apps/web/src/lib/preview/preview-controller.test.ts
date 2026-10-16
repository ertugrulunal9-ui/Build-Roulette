/**
 * PreviewController with a fake preview: loading site packs (each import is one load; a
 * crashed preview is replaced first), restart, the thumbnail, and a flood of console/error
 * messages from a site costing a bounded number of store updates. Every store notification
 * is one React render of the preview (it reads the store with useSyncExternalStore), so
 * counting notifications counts renders.
 */
import type { ConsoleMessage, RuntimeErrorMessage } from '@br/protocol';
import { ConsoleLog, type PreviewEventMap, type PreviewHandle } from '@br/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSite } from '../solo/test-support';
import type { AnalyticsEvents } from '../telemetry/analytics';
import { PreviewHealth, SandboxHealthTally } from '../telemetry/sandbox-health';
import type { FrameScheduler } from './frame-batcher';
import { PreviewController, dataUrlToBlob, type PreviewLike } from './preview-controller';

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
  readonly loads: { site: Uint8Array | ArrayBuffer }[] = [];
  restarts = 0;
  thumbnail: string | null = null;
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
  load(build: { site: Uint8Array | ArrayBuffer }): number {
    this.loads.push(build);
    return this.loads.length;
  }
  consoleEntries() {
    return this.log.list();
  }
  clearConsole(): void {
    this.log.clear();
  }
  captureThumbnail(): Promise<string | null> {
    return Promise.resolve(this.thumbnail);
  }
  restart(): void {
    this.restarts++;
    this.state = 'connecting';
  }
  dispose(): void {
    this.state = 'disposed';
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

function setup(health?: PreviewHealth) {
  const previews: FakePreview[] = [];
  const frames = new Frames();
  const controller = new PreviewController(
    fakeHost(),
    { shellUrl: 'https://b1.usercontent.example/v2/' },
    {
      attach: () => {
        const p = new FakePreview();
        previews.push(p);
        return p as unknown as PreviewLike;
      },
      frames,
      ...(health ? { health } : {}),
    },
  );
  const preview = previews[0];
  if (!preview) throw new Error('no preview attached');
  let renders = 0;
  controller.subscribe(() => {
    renders++;
  });
  return { controller, previews, preview, frames, renders: () => renders };
}

const A = fakeSite('A').pack;
const B = fakeSite('B').pack;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PreviewController loads', () => {
  it('attaches the preview at once; idle until the first import, then loading and running', () => {
    const { controller, preview } = setup();
    expect(controller.getSnapshot().preview).toBe('connecting');
    preview.state = 'connected';
    preview.emit('connected', { handshakes: 1 });
    expect(controller.getSnapshot().preview).toBe('idle');
    controller.load(A);
    expect(preview.loads).toEqual([{ site: A }]);
    expect(controller.current()).toBe(A);
    expect(controller.getSnapshot().preview).toBe('loading');
    preview.emit('ready', { loadId: 1 });
    expect(controller.getSnapshot()).toMatchObject({ preview: 'running', readyCount: 1 });
  });

  it('importing again loads the new pack into the same preview, clearing errors and console', () => {
    const { controller, previews, preview, frames } = setup();
    controller.load(A);
    preview.console({ type: 'console', level: 'log', args: ['old'] });
    preview.error({ type: 'runtime-error', message: 'old error' });
    frames.run();
    expect(controller.getSnapshot().runtimeErrors).toHaveLength(1);
    controller.load(B);
    expect(preview.loads.map((l) => l.site)).toEqual([A, B]);
    expect(previews).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({ runtimeErrors: [], console: [] });
    expect(frames.pending).toBe(0);
  });

  it('a crashed preview is replaced before the next import loads', () => {
    const { controller, preview } = setup();
    controller.load(A);
    preview.state = 'crashed';
    preview.emit('crash', CRASH);
    expect(controller.getSnapshot()).toMatchObject({ preview: 'crashed', crash: CRASH });
    preview.state = 'crashed';
    controller.load(B);
    expect(preview.restarts).toBe(1);
    expect(controller.getSnapshot().crash).toBeNull();
    // The restarted handle is connecting again; the load waits in it (PreviewHandle queues it).
    expect(preview.loads.map((l) => l.site)).toEqual([A, B]);
  });

  it('restartPreview restarts the same handle and loads the latest pack again', () => {
    const { controller, previews, preview } = setup();
    controller.restartPreview(); // nothing imported: just a fresh shell
    expect(preview.loads).toEqual([]);
    controller.load(A);
    controller.load(B);
    preview.state = 'crashed';
    preview.emit('crash', CRASH);
    preview.state = 'crashed';
    controller.restartPreview();
    expect(preview.restarts).toBe(2);
    expect(previews).toHaveLength(1);
    expect(preview.loads.map((l) => l.site)).toEqual([A, B, B]);
  });

  it('the ship thumbnail only while connected, as a WebP blob', async () => {
    const { controller, preview } = setup();
    expect(await controller.captureThumbnail({ width: 64, height: 40 })).toBeNull();
    preview.state = 'connected';
    preview.thumbnail = `data:image/webp;base64,${btoa('webp')}`;
    const blob = await controller.captureThumbnail({ width: 64, height: 40 });
    expect(blob?.type).toBe('image/webp');
    expect(await blob?.text()).toBe('webp');
    expect(dataUrlToBlob('not a data url')).toBeNull();
  });

  it('dispose disposes the preview; later loads do nothing', () => {
    const { controller, preview } = setup();
    controller.dispose();
    expect(preview.state).toBe('disposed');
    controller.load(A);
    expect(preview.loads).toEqual([]);
  });
});

describe('PreviewController frame title (T-050)', () => {
  it('a language switch renames the same iframe; a new iframe gets the new title', () => {
    const frames: { title: string }[] = [];
    const host = {
      ownerDocument: {
        createElement: () => {
          const f = { title: '', dataset: {}, style: { cssText: '' } };
          frames.push(f);
          return f;
        },
      },
      replaceChildren: () => undefined,
    } as unknown as HTMLElement;
    const previews: FakePreview[] = [];
    const controller = new PreviewController(
      host,
      { shellUrl: 'https://b1.usercontent.example/v2/' },
      {
        attach: () => {
          const p = new FakePreview();
          previews.push(p);
          return p as unknown as PreviewLike;
        },
        frames: new Frames(),
        frameTitle: 'Sitenin önizlemesi',
      },
    );
    expect(frames.map((f) => f.title)).toEqual(['Sitenin önizlemesi']);
    controller.load(A);
    controller.setFrameTitle('Preview of your site');
    // Renamed in place: no new iframe, nothing reloaded.
    expect(frames.map((f) => f.title)).toEqual(['Preview of your site']);
    expect(previews[0]?.loads).toHaveLength(1);
    // A crash replaces the iframe: the new one has the current title.
    previews[0]?.emit('crash', CRASH);
    controller.restartPreview();
    expect(frames.at(-1)?.title).toBe('Preview of your site');
    controller.dispose();
  });
});

describe('PreviewController output batching', () => {
  it('10,000 console messages in one frame cause one store update', () => {
    const { controller, preview, frames, renders } = setup();
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

  it('a sustained flood costs at most one update per frame', () => {
    const { preview, frames, renders } = setup();
    for (let frame = 0; frame < 60; frame++) {
      for (let i = 0; i < 200; i++)
        preview.console({ type: 'console', level: 'warn', args: ['x'] });
      for (let i = 0; i < 50; i++) preview.error({ type: 'runtime-error', message: 'boom' });
      frames.run();
    }
    expect(renders()).toBe(60);
  });

  it('errors are batched too, and the Problems list keeps the latest 20', () => {
    const { controller, preview, frames, renders } = setup();
    for (let i = 0; i < 1000; i++)
      preview.error({ type: 'runtime-error', message: `e${String(i)}` });
    frames.run();
    expect(renders()).toBe(1);
    const errors = controller.getSnapshot().runtimeErrors;
    expect(errors).toHaveLength(20);
    expect(errors.at(-1)?.message).toBe('e999');
    controller.dismissErrors();
    expect(controller.getSnapshot().runtimeErrors).toEqual([]);
  });

  it('no output, no update', () => {
    const { frames, renders } = setup();
    frames.run();
    expect(renders()).toBe(0);
  });
});

describe('PreviewController watchdog telemetry (T-031)', () => {
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

  it('a crash, then Restart preview: one preview_crash, restarted', () => {
    const { sent, tally, health } = telemetry();
    const { controller, preview } = setup(health);
    controller.load(A);
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

  it('a new import replacing a crashed preview counts as a restart', () => {
    const { sent, health } = telemetry();
    const { controller, preview } = setup(health);
    controller.load(A);
    preview.state = 'crashed';
    preview.emit('crash', CRASH);
    controller.load(B);
    expect(sent.map((e) => e.restarted)).toEqual([true]);
  });

  it('a crash nobody restarted is sent when the BUILD screen goes', () => {
    const { sent, health } = telemetry();
    const { controller, preview } = setup(health);
    controller.load(A);
    preview.state = 'crashed';
    preview.emit('crash', { ...CRASH, phase: 'loading', silentForMs: 15_100 });
    controller.dispose();
    expect(sent).toEqual([expect.objectContaining({ phase: 'loading', restarted: false })]);
  });

  it('a restart of a preview that did not crash reports nothing', () => {
    const { sent, health } = telemetry();
    const { controller } = setup(health);
    controller.restartPreview();
    controller.dispose();
    expect(sent).toEqual([]);
  });
});
