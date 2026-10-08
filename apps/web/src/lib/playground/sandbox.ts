/**
 * Glue between the playground UI and @br/runtime: owns the bundler worker
 * (EsmBrowserRuntime) and the preview iframe (PreviewHandle), mirrors workspace edits into
 * the runtime, and exposes a snapshot for React (useSyncExternalStore).
 *
 * Plain TypeScript on purpose: the runtime and preview have their own lifecycles (worker,
 * iframe, watchdog) that should not depend on React renders.
 *
 * Console output and runtime errors come from the build, so they are untrusted and can
 * arrive in floods. The PreviewHandle rate-limits them and keeps a size-capped console; this
 * controller copies that into the snapshot at most once per animation frame, so a flood costs
 * at most one React render per frame.
 *
 * Watchdog crashes go to the optional `PreviewHealth` (T-031): one `preview_crash` event per
 * crash, sent once the user restarted the preview or the controller went away, and the
 * preview's watchdog stats for the battle's `sync_health`.
 */
import { isPackageStall, type RuntimeErrorMessage } from '@br/protocol';
import type {
  BuildResult,
  ConsoleEntry,
  Diagnostic,
  PreviewCrash,
  PreviewHandle,
  SandboxRuntime,
} from '@br/runtime';
import type { Workspace } from '@br/workspace';
import type { PreviewHealth } from '../telemetry/sandbox-health';
import type { PlaygroundConfig } from './config';
import { FrameBatcher, type FrameScheduler } from './frame-batcher';
import { createPlaygroundRuntime } from './runtime-factory';

export type { ConsoleEntry } from '@br/runtime';

/** Runtime errors kept for the overlay. */
export const MAX_RUNTIME_ERRORS = 20;

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
  /**
   * Why the watchdog stopped the preview, whether the latest load had finished (`phase`), and
   * the silence it measured (app-awake time; `stalledMs` more on the wall clock).
   */
  crash: PreviewCrash | null;
  /** Runtime errors since the last load (newest last, at most MAX_RUNTIME_ERRORS). */
  runtimeErrors: readonly RuntimeErrorMessage[];
  /** The preview's retained console (rate-limited and size-capped by the PreviewHandle). */
  console: readonly ConsoleEntry[];
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

/** The part of SandboxRuntime the controller uses. */
export type PlaygroundRuntime = Pick<
  SandboxRuntime,
  | 'boot'
  | 'writeFile'
  | 'deleteFile'
  | 'setManifest'
  | 'build'
  | 'onBuild'
  | 'attachPreview'
  | 'destroy'
>;

export interface SandboxControllerDeps {
  /** Defaults to the real esbuild-wasm runtime. */
  runtime?: PlaygroundRuntime;
  /** Defaults to requestAnimationFrame. */
  frames?: FrameScheduler;
  /** Watchdog telemetry (T-031): crashes, restarts and the preview's stall counters. */
  health?: PreviewHealth;
}

function sameDependencies(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export class SandboxController {
  private readonly runtime: PlaygroundRuntime;
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
  /** Errors received since the last frame flush. */
  private pendingErrors: RuntimeErrorMessage[] = [];
  private readonly batcher: FrameBatcher;
  private readonly health: PreviewHealth | null;
  /** Build results received so far (the `rebuilds` stat). */
  private builds = 0;
  /**
   * Set while the build of a `replace()` runs: results are held (newest wins) instead of
   * loaded, so a build of the old project that finishes meanwhile never reaches the preview.
   */
  private replacing: { latest: BuildResult | null } | null = null;

  constructor(host: HTMLElement, config: PlaygroundConfig, deps: SandboxControllerDeps = {}) {
    this.host = host;
    this.config = config;
    this.runtime = deps.runtime ?? createPlaygroundRuntime(config);
    this.batcher = new FrameBatcher(this.flushOutput, deps.frames);
    this.health = deps.health ?? null;
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
    // If the bundler failed to start, the debounced build retries starting it and reports
    // the outcome through onBuild like any other build.
    if (this.mirror(prev, workspace) && !this.snapshot.building) this.update({ building: true });
  }

  /**
   * Replaces the whole project (reset to a template, paste-import in replace mode). An edit
   * keeps the running preview until its debounced rebuild loads, but here that preview is a
   * different project: anything the user does in it is thrown away by the next load. So the
   * preview frame is replaced at once (no document of the old project is left to click) and
   * the new files build right away, as one build and one load. Results of builds that were
   * still running for the old files are not loaded.
   */
  replace(workspace: Workspace): void {
    const prev = this.synced;
    this.synced = workspace;
    if (this.disposed || prev === null) return;
    if (prev !== workspace) this.mirror(prev, workspace);
    if (this.snapshot.bundler !== 'ready') {
      // Booting: start() builds the mirrored files. Failed: like an edit, the debounced
      // build retries starting the bundler.
      if (prev !== workspace && !this.snapshot.building) this.update({ building: true });
      return;
    }
    const replacing: { latest: BuildResult | null } = { latest: null };
    this.replacing = replacing;
    this.freshPreview();
    this.update({ building: true });
    // build() cancels the debounced build the mirrored edits scheduled.
    this.runtime.build().then(
      (own) => {
        if (this.disposed || this.replacing !== replacing) return; // a newer replace() runs
        this.replacing = null;
        // The runtime delivers results in order, so a held result is this build's or newer.
        this.applyBuild(replacing.latest ?? own);
      },
      () => undefined, // only after dispose()
    );
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

  /**
   * Restarts a crashed (or stuck) preview: a new iframe and a new shell, then the latest good
   * build is loaded into it.
   */
  restartPreview(): void {
    if (this.disposed) return;
    this.freshPreview();
    // During a replace() the last good build is the old project: its own build loads next.
    if (this.lastOk && !this.replacing) this.load(this.lastOk);
  }

  /** The latest successful build (what the preview runs), or null before the first one. */
  lastGoodBuild(): BuildResult | null {
    return this.lastOk;
  }

  /** Number of build results so far (debounced rebuilds and explicit builds). */
  get buildCount(): number {
    return this.builds;
  }

  /**
   * A production build (minified, `NODE_ENV=production`) of the current files. Like every
   * build it goes to `onBuild`, so a successful one also becomes the preview and the last
   * good build. Rejects only after dispose().
   */
  productionBuild(): Promise<BuildResult> {
    if (this.disposed) return Promise.reject(new Error('sandbox disposed'));
    return this.runtime.build('production');
  }

  /**
   * A best-effort WebP thumbnail of what the preview shows (the shell renders it; docs/03
   * §3.7 fallback). Null when the preview is not running or the shell cannot make one.
   */
  async captureThumbnail(size: { width: number; height: number }): Promise<Blob | null> {
    const preview = this.preview;
    if (this.disposed || preview?.state !== 'connected') return null;
    const url = await preview.captureThumbnail(size);
    return url ? dataUrlToBlob(url) : null;
  }

  dismissErrors(): void {
    this.pendingErrors = [];
    this.update({ runtimeErrors: [] });
  }

  clearConsole(): void {
    this.preview?.clearConsole();
    this.update({ console: this.preview?.consoleEntries() ?? [] });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batcher.cancel();
    this.offBuild();
    this.detachPreview();
    this.health?.close();
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
    this.builds++;
    if (this.replacing) {
      this.replacing.latest = result;
      return;
    }
    this.applyBuild(result);
  };

  /** Shows a build result: status, Problems, and (when it is good) the preview. */
  private applyBuild(result: BuildResult): void {
    const initFailure = result.diagnostics.find((d) => d.code === 'bundler-init-failed');
    this.update({
      // A build after a failed start retried starting the bundler: reflect the outcome.
      ...(initFailure
        ? { bundler: 'failed' as const, bundlerError: initFailure.text }
        : { bundler: 'ready' as const, bundlerError: null }),
      building: false,
      lastBuild: { ok: result.ok, durationMs: result.durationMs, diagnostics: result.diagnostics },
    });
    if (!result.ok) return; // keep the last good preview running
    this.lastOk = result;
    if (this.snapshot.preview !== 'crashed') this.load(result);
  }

  /**
   * Writes the difference between two workspace states into the runtime (each write
   * schedules the debounced rebuild). Files and manifest go in together, before any build
   * can start. Returns whether anything changed.
   */
  private mirror(prev: Workspace, workspace: Workspace): boolean {
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
    return changed;
  }

  /**
   * A new preview document: the same handle restarted (new iframe element, new shell realm),
   * or a new handle if there is none. Errors and console of the old document are dropped.
   */
  private freshPreview(): void {
    const preview = this.preview;
    // A crashed preview brought back by the user (Restart, or a new project replacing it).
    if (this.snapshot.preview === 'crashed') this.health?.restarted();
    if (preview && preview.state !== 'disposed') {
      this.batcher.cancel();
      this.pendingErrors = [];
      preview.restart();
      preview.clearConsole();
      this.update({
        preview: 'connecting',
        crash: null,
        runtimeErrors: [],
        console: preview.consoleEntries(),
      });
    } else {
      this.createPreview();
    }
  }

  private load(result: BuildResult): void {
    const preview = this.preview;
    if (!preview || preview.state === 'crashed' || preview.state === 'disposed') return;
    preview.load(result);
    preview.clearConsole();
    this.batcher.cancel();
    this.pendingErrors = [];
    this.update({ preview: 'loading', runtimeErrors: [], console: preview.consoleEntries() });
  }

  private detachPreview(): void {
    for (const off of this.previewOff) off();
    this.previewOff = [];
    this.preview?.dispose();
    this.preview = null;
  }

  private createPreview(): void {
    this.detachPreview();
    this.batcher.cancel();
    this.pendingErrors = [];
    const iframe = this.host.ownerDocument.createElement('iframe');
    iframe.title = 'Preview of your build';
    iframe.dataset['testid'] = 'preview-frame';
    iframe.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    this.host.replaceChildren(iframe);
    const preview = this.runtime.attachPreview(iframe, { shellUrl: this.config.shellUrl });
    this.preview = preview;
    this.health?.follow(preview);
    this.update({ preview: 'connecting', crash: null, runtimeErrors: [], console: [] });
    this.previewOff = [
      preview.on('ready', () => {
        // A "still waiting for the package server" note (T-032) is moot once the build runs.
        const waiting = (e: RuntimeErrorMessage) =>
          e.kind === 'module-load' && isPackageStall(e.message);
        this.pendingErrors = this.pendingErrors.filter((e) => !waiting(e));
        const runtimeErrors = this.snapshot.runtimeErrors.some(waiting)
          ? this.snapshot.runtimeErrors.filter((e) => !waiting(e))
          : this.snapshot.runtimeErrors;
        this.update({
          preview: 'running',
          readyCount: this.snapshot.readyCount + 1,
          runtimeErrors,
        });
      }),
      // Console, errors and drop notices: batched, one snapshot update per frame.
      preview.on('console', () => {
        this.batcher.schedule();
      }),
      preview.on('error', (m) => {
        this.pendingErrors.push(m);
        if (this.pendingErrors.length > MAX_RUNTIME_ERRORS) {
          this.pendingErrors = this.pendingErrors.slice(-MAX_RUNTIME_ERRORS);
        }
        this.batcher.schedule();
      }),
      preview.on('dropped', () => {
        this.batcher.schedule();
      }),
      preview.on('crash', (c) => {
        this.update({ preview: 'crashed', crash: c });
        this.health?.crashed(c);
      }),
    ];
  }

  /** Copies the preview's console and the queued errors into the snapshot (one update). */
  private readonly flushOutput = (): void => {
    const preview = this.preview;
    if (this.disposed || !preview) return;
    const console = preview.consoleEntries();
    const errors = this.pendingErrors;
    this.pendingErrors = [];
    if (console === this.snapshot.console && errors.length === 0) return;
    this.update({
      console,
      ...(errors.length > 0
        ? { runtimeErrors: [...this.snapshot.runtimeErrors, ...errors].slice(-MAX_RUNTIME_ERRORS) }
        : {}),
    });
  };
}

/** Decodes a base64 `data:` URL (the shell's WebP thumbnail) into a Blob. */
export function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m?.[1] || m[2] === undefined) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch {
    return null;
  }
}
