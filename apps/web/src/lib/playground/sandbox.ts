/**
 * Glue between the playground UI and @br/runtime: owns the bundler worker
 * (EsmBrowserRuntime) and the preview iframe (PreviewHandle), mirrors workspace edits into
 * the runtime, and exposes a snapshot for React (useSyncExternalStore).
 *
 * Plain TypeScript on purpose: the runtime and preview have their own lifecycles (worker,
 * iframe, watchdog) that should not depend on React renders.
 */
import type { ConsoleMessage, RuntimeErrorMessage } from '@br/protocol';
import {
  EsmBrowserRuntime,
  type BuildResult,
  type CrashReason,
  type Diagnostic,
  type PreviewHandle,
} from '@br/runtime';
import type { Workspace } from '@br/workspace';
// Turbopack emits the wasm file as a content-hashed static asset and returns its URL
// (`turbopack.rules['*.wasm']` in next.config.ts).
import wasmUrl from 'esbuild-wasm/esbuild.wasm';
import type { PlaygroundConfig } from './config';

export const MAX_CONSOLE_ENTRIES = 500;

export interface ConsoleEntry {
  id: number;
  level: ConsoleMessage['level'];
  text: string;
}

export interface BuildSummary {
  ok: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
}

/**
 * - `connecting`: waiting for the shell handshake
 * - `loading`: a build was sent, waiting for `ready`
 * - `running`: the latest build is running
 * - `crashed`: watchdog fired (frozen build) or the shell never answered
 */
export type PreviewStatus = 'connecting' | 'loading' | 'running' | 'crashed';

export interface SandboxSnapshot {
  bundler: 'booting' | 'ready' | 'failed';
  bundlerError: string | null;
  /** Edits were sent to the bundler and no build result has come back since. */
  building: boolean;
  lastBuild: BuildSummary | null;
  preview: PreviewStatus;
  crash: { reason: CrashReason; silentForMs: number } | null;
  /** Runtime errors since the last load (newest last). */
  runtimeErrors: RuntimeErrorMessage[];
  console: ConsoleEntry[];
  /** Number of `ready` events so far (one per load that finished). */
  readyCount: number;
}

const INITIAL: SandboxSnapshot = {
  bundler: 'booting',
  bundlerError: null,
  building: true,
  lastBuild: null,
  preview: 'connecting',
  crash: null,
  runtimeErrors: [],
  console: [],
  readyCount: 0,
};

function sameDependencies(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export class SandboxController {
  private readonly runtime: EsmBrowserRuntime;
  private readonly host: HTMLElement;
  private readonly config: PlaygroundConfig;
  private preview: PreviewHandle | null = null;
  private previewOff: (() => void)[] = [];
  private synced: Workspace | null = null;
  private lastOk: BuildResult | null = null;
  private snapshot: SandboxSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly offBuild: () => void;
  private disposed = false;
  private nextConsoleId = 1;

  constructor(host: HTMLElement, config: PlaygroundConfig) {
    this.host = host;
    this.config = config;
    this.runtime = new EsmBrowserRuntime({
      // Unused because createWorker is given; the literal `new Worker(new URL(...))` below is
      // what lets Turbopack find and bundle the worker entry.
      workerUrl: 'bundler.worker',
      wasmUrl,
      cdnBaseUrl: config.cdnBaseUrl,
      createWorker: () =>
        new Worker(new URL('./bundler.worker.ts', import.meta.url), {
          type: 'module',
          name: 'br-bundler',
        }),
    });
    this.offBuild = this.runtime.onBuild(this.onBuild);
  }

  // --- React store contract -------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SandboxSnapshot => this.snapshot;

  static readonly initialSnapshot = INITIAL;

  // --- lifecycle --------------------------------------------------------------------------

  /** Boots esbuild-wasm, attaches the preview and runs the first build. */
  async start(workspace: Workspace): Promise<void> {
    this.synced = workspace;
    this.createPreview();
    try {
      // boot() takes the files synchronously, so sync() calls made while it awaits apply.
      await this.runtime.boot({ files: workspace.files, manifest: workspace.manifest });
    } catch (e) {
      if (!this.disposed) {
        this.update({
          bundler: 'failed',
          building: false,
          bundlerError: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }
    if (this.disposed) return;
    this.update({ bundler: 'ready' });
    await this.rebuild();
  }

  /** Mirrors a new workspace state into the runtime (debounced rebuild). */
  sync(workspace: Workspace): void {
    const prev = this.synced;
    this.synced = workspace;
    if (this.disposed || prev === null || prev === workspace) return;
    // Without a bundler every debounced build would only reject; nothing to update.
    if (this.snapshot.bundler === 'failed') return;
    let changed = false;
    for (const [path, contents] of Object.entries(workspace.files)) {
      if (prev.files[path] !== contents) {
        this.runtime.writeFile(path, contents);
        changed = true;
      }
    }
    for (const path of Object.keys(prev.files)) {
      if (!Object.prototype.hasOwnProperty.call(workspace.files, path)) {
        this.runtime.deleteFile(path);
        changed = true;
      }
    }
    const a = prev.manifest;
    const b = workspace.manifest;
    if (
      a.entry !== b.entry ||
      a.template !== b.template ||
      !sameDependencies(a.dependencies, b.dependencies)
    ) {
      this.runtime.setManifest(b);
      changed = true;
    }
    if (changed && !this.snapshot.building) this.update({ building: true });
  }

  /** Builds now (the result is loaded by `onBuild`). */
  async rebuild(): Promise<void> {
    if (this.disposed || this.snapshot.bundler !== 'ready') return;
    try {
      await this.runtime.build();
    } catch {
      // Only throws after destroy().
    }
  }

  /** Replaces a crashed (or stuck) preview with a fresh iframe and loads the latest good build. */
  restartPreview(): void {
    if (this.disposed) return;
    this.createPreview();
    if (this.lastOk) this.load(this.lastOk);
  }

  dismissErrors(): void {
    this.update({ runtimeErrors: [] });
  }

  clearConsole(): void {
    this.update({ console: [] });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offBuild();
    this.detachPreview();
    void this.runtime.destroy();
    this.listeners.clear();
  }

  // --- internals --------------------------------------------------------------------------

  private update(patch: Partial<SandboxSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private readonly onBuild = (result: BuildResult): void => {
    if (this.disposed) return;
    this.update({
      building: false,
      lastBuild: { ok: result.ok, durationMs: result.durationMs, diagnostics: result.diagnostics },
    });
    if (!result.ok) return; // keep the last good preview running
    this.lastOk = result;
    if (this.snapshot.preview !== 'crashed') this.load(result);
  };

  private load(result: BuildResult): void {
    const preview = this.preview;
    if (!preview || preview.state === 'crashed' || preview.state === 'disposed') return;
    preview.load(result);
    this.update({ preview: 'loading', runtimeErrors: [], console: [] });
  }

  private detachPreview(): void {
    for (const off of this.previewOff) off();
    this.previewOff = [];
    this.preview?.dispose();
    this.preview = null;
  }

  private createPreview(): void {
    this.detachPreview();
    const iframe = this.host.ownerDocument.createElement('iframe');
    iframe.title = 'Preview of your build';
    iframe.dataset['testid'] = 'preview-frame';
    iframe.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    this.host.replaceChildren(iframe);
    const preview = this.runtime.attachPreview(iframe, { shellUrl: this.config.shellUrl });
    this.preview = preview;
    this.update({ preview: 'connecting', crash: null, runtimeErrors: [] });
    this.previewOff = [
      preview.on('ready', () => {
        this.update({ preview: 'running', readyCount: this.snapshot.readyCount + 1 });
      }),
      preview.on('console', (m) => {
        this.pushConsole(m.level, m.args.join(' '));
      }),
      preview.on('error', (m) => {
        const errors = [...this.snapshot.runtimeErrors, m].slice(-20);
        this.update({ runtimeErrors: errors });
        this.pushConsole('error', `Uncaught ${m.message}`);
      }),
      preview.on('crash', (c) => {
        this.update({ preview: 'crashed', crash: c });
      }),
    ];
  }

  private pushConsole(level: ConsoleEntry['level'], text: string): void {
    const entry: ConsoleEntry = { id: this.nextConsoleId++, level, text };
    const next = [...this.snapshot.console, entry];
    this.update({
      console: next.length > MAX_CONSOLE_ENTRIES ? next.slice(-MAX_CONSOLE_ENTRIES) : next,
    });
  }
}
