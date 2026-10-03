/**
 * SandboxRuntime (docs/03 §3.2) and its v1 implementation on esbuild-wasm + ESM CDN +
 * cross-site iframe. Game code depends on the interface only, so a WebContainers
 * implementation can be added later without touching it.
 */
import { PreviewHandle, type PreviewOptions } from './preview/preview-handle';
import type { BuildMode, BuildResult, FileMap, Manifest, WorkspaceSnapshot } from './types';
import { BundlerClient, type BootTimings, type BundlerClientOptions } from './worker/client';
import { normalizePath } from './bundler/resolve';

export interface SandboxRuntime {
  readonly kind: 'esm-browser' | 'webcontainer';
  /** Starts the bundler (esbuild-wasm cold start) and loads the workspace. */
  boot(opts: { files: FileMap; manifest: Manifest }): Promise<BootTimings>;
  /** Updates one file and schedules a debounced rebuild (150 ms). */
  writeFile(path: string, contents: string): void;
  deleteFile(path: string): void;
  /** Replaces the manifest (dependencies, entry) and schedules a rebuild. */
  setManifest(manifest: Manifest): void;
  /** Builds now. Also emitted to `onBuild` listeners. */
  build(mode?: BuildMode): Promise<BuildResult>;
  /** Called with the result of every build (debounced or explicit). */
  onBuild(listener: (result: BuildResult) => void): () => void;
  /** Attaches a preview to an iframe; the caller derives `shellUrl` from the build id. */
  attachPreview(frame: HTMLIFrameElement, opts: PreviewOptions): PreviewHandle;
  exportSnapshot(): Promise<WorkspaceSnapshot>;
  /** Terminates the worker and disposes previews. (IndexedDB workspace wipe lands with persistence.) */
  destroy(): Promise<void>;
}

export interface EsmBrowserRuntimeOptions extends BundlerClientOptions {
  /** Debounce for `writeFile` rebuilds. Default 150 ms (docs/03 §3.4). */
  debounceMs?: number;
}

export class EsmBrowserRuntime implements SandboxRuntime {
  readonly kind = 'esm-browser' as const;
  private readonly bundler: BundlerClient;
  private readonly debounceMs: number;
  private files: FileMap = {};
  private manifest: Manifest = { entry: 'src/main.tsx', dependencies: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly buildListeners = new Set<(r: BuildResult) => void>();
  private readonly previews = new Set<PreviewHandle>();
  private destroyed = false;

  constructor(opts: EsmBrowserRuntimeOptions) {
    this.bundler = new BundlerClient(opts);
    this.debounceMs = opts.debounceMs ?? 150;
  }

  async boot(opts: { files: FileMap; manifest: Manifest }): Promise<BootTimings> {
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
    const result = await this.bundler.build({
      files: { ...this.files },
      manifest: this.manifest,
      mode,
    });
    for (const l of this.buildListeners) l(result);
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

  private scheduleBuild(): void {
    if (this.destroyed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.build();
    }, this.debounceMs);
  }
}
