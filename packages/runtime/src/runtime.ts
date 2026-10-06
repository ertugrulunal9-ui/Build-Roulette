/**
 * SandboxRuntime (docs/03 §3.2) and its v1 implementation on esbuild-wasm + ESM CDN +
 * cross-site iframe. Game code depends on the interface only, so a WebContainers
 * implementation can be added later without touching it.
 */
import { PreviewHandle, type PreviewOptions } from './preview/preview-handle';
import type { BuildMode, BuildResult, FileMap, Manifest, WorkspaceSnapshot } from './types';
import {
  BundlerClient,
  isAbortError,
  type BootTimings,
  type BundlerClientOptions,
} from './worker/client';
import { buildImportMap, normalizePath } from './bundler/resolve';

export interface SandboxRuntime {
  readonly kind: 'esm-browser' | 'webcontainer';
  /**
   * Starts the bundler (esbuild-wasm cold start) and loads the workspace. Rejects when the
   * bundler fails to start (later builds retry) or with an `AbortError` when `destroy()`
   * runs first.
   */
  boot(opts: { files: FileMap; manifest: Manifest }): Promise<BootTimings>;
  /** Updates one file and schedules a debounced rebuild (150 ms). */
  writeFile(path: string, contents: string): void;
  deleteFile(path: string): void;
  /** Replaces the manifest (dependencies, entry) and schedules a rebuild. */
  setManifest(manifest: Manifest): void;
  /**
   * Builds now. Also emitted to `onBuild` listeners. If the bundler cannot start, resolves
   * with `ok: false` and a `bundler-init-failed` diagnostic. Rejects only after `destroy()`.
   */
  build(mode?: BuildMode): Promise<BuildResult>;
  /**
   * Called with the result of every build (debounced or explicit), in the order the builds
   * were started: builds can run concurrently, and a result that arrives after the result of
   * a newer build is not delivered (`build()` still returns it), so a listener never
   * replaces a newer result with an older one.
   */
  onBuild(listener: (result: BuildResult) => void): () => void;
  /** Attaches a preview to an iframe; the caller derives `shellUrl` from the build id. */
  attachPreview(frame: HTMLIFrameElement, opts: PreviewOptions): PreviewHandle;
  exportSnapshot(): Promise<WorkspaceSnapshot>;
  /** Terminates the worker and disposes previews. (IndexedDB workspace wipe lands with persistence.) */
  destroy(): Promise<void>;
}

export type EsmBrowserRuntimeOptions = BundlerClientOptions & {
  /** Debounce for `writeFile` rebuilds. Default 150 ms (docs/03 §3.4). */
  debounceMs?: number;
};

export class EsmBrowserRuntime implements SandboxRuntime {
  readonly kind = 'esm-browser' as const;
  private readonly bundler: BundlerClient;
  private readonly debounceMs: number;
  private readonly cdnBaseUrl: string;
  private files: FileMap = {};
  private manifest: Manifest = { entry: 'src/main.tsx', dependencies: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly buildListeners = new Set<(r: BuildResult) => void>();
  private readonly previews = new Set<PreviewHandle>();
  private destroyed = false;
  /** Builds started so far, and the latest of them whose result went to listeners. */
  private started = 0;
  private delivered = 0;

  constructor(opts: EsmBrowserRuntimeOptions) {
    this.bundler = new BundlerClient(opts);
    this.debounceMs = opts.debounceMs ?? 150;
    this.cdnBaseUrl = opts.cdnBaseUrl;
  }

  async boot(opts: { files: FileMap; manifest: Manifest }): Promise<BootTimings> {
    if (this.destroyed) throw new Error('runtime destroyed');
    this.files = {};
    for (const [p, c] of Object.entries(opts.files)) this.files[normalizePath(p)] = c;
    this.manifest = structuredClone(opts.manifest);
    return this.bundler.init();
  }

  writeFile(path: string, contents: string): void {
    this.files[normalizePath(path)] = contents;
    this.scheduleBuild();
  }

  deleteFile(path: string): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- file maps are keyed by path
    delete this.files[normalizePath(path)];
    this.scheduleBuild();
  }

  setManifest(manifest: Manifest): void {
    this.manifest = structuredClone(manifest);
    this.scheduleBuild();
  }

  async build(mode: BuildMode = 'dev'): Promise<BuildResult> {
    if (this.destroyed) throw new Error('runtime destroyed');
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const seq = ++this.started;
    const manifest = this.manifest;
    let result: BuildResult;
    try {
      result = await this.bundler.build({ files: { ...this.files }, manifest, mode });
    } catch (e) {
      // AbortError: destroy() terminated the bundler while this build waited or ran.
      if (this.isDestroyed() || isAbortError(e)) throw e;
      // Anything else is the bundler failing to start (the client does not cache a failed
      // init, so the next build tries again). Report it like any other failed build.
      result = {
        ok: false,
        js: '',
        css: '',
        importMap: buildImportMap(manifest.dependencies, this.cdnBaseUrl),
        diagnostics: [
          {
            severity: 'error',
            code: 'bundler-init-failed',
            text: `The bundler could not start: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        durationMs: 0,
      };
    }
    // A build that finished just as destroy() ran is returned but not broadcast, and so is
    // one that a newer build overtook (the worker runs builds concurrently, so a slow build
    // of older files can finish last).
    if (!this.isDestroyed() && seq > this.delivered) {
      this.delivered = seq;
      for (const l of this.buildListeners) l(result);
    }
    return result;
  }

  onBuild(listener: (result: BuildResult) => void): () => void {
    this.buildListeners.add(listener);
    return () => this.buildListeners.delete(listener);
  }

  attachPreview(frame: HTMLIFrameElement, opts: PreviewOptions): PreviewHandle {
    const handle = new PreviewHandle(frame, opts);
    this.previews.add(handle);
    return handle;
  }

  exportSnapshot(): Promise<WorkspaceSnapshot> {
    return Promise.resolve({ files: { ...this.files }, manifest: structuredClone(this.manifest) });
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.bundler.terminate();
    for (const p of this.previews) p.dispose();
    this.previews.clear();
    this.files = {};
    return Promise.resolve();
  }

  /** A method, so TypeScript does not narrow the flag across awaits. */
  private isDestroyed(): boolean {
    return this.destroyed;
  }

  private scheduleBuild(): void {
    if (this.destroyed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // Failures reach onBuild listeners as results; the only rejection left is the
      // AbortError / "destroyed" of a build cut short by destroy(), which nobody waits for.
      this.build().catch(() => undefined);
    }, this.debounceMs);
  }
}
