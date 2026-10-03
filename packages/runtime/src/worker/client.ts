/**
 * Main-thread side of the bundler worker: spawns it, initializes esbuild-wasm, and turns
 * build requests into promises. Results of superseded builds are still delivered (callers
 * decide whether to use them); `latestId` lets them check.
 */
import type { BuildResult, BundleInput } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface BundlerClientOptions {
  /** URL of the bundled `bundler.worker` module. */
  workerUrl: string | URL;
  /** URL of `esbuild.wasm` (served by the app origin, ideally preloaded during the lobby). */
  wasmUrl: string;
  /** Base URL of the esm.sh-compatible package CDN. */
  cdnBaseUrl: string;
  /** Override worker creation (tests, bundler-specific `new Worker(new URL(...))`). */
  createWorker?: () => Worker;
}

export interface BootTimings {
  /** `new Worker()` -> esbuild-wasm ready, measured on the main thread. */
  coldStartMs: number;
  /** Time spent inside the worker compiling/instantiating the wasm module. */
  wasmInitMs: number;
}

export class BundlerClient {
  private readonly opts: BundlerClientOptions;
  private worker: Worker | null = null;
  private initPromise: Promise<BootTimings> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (r: BuildResult) => void>();
  latestId = 0;

  constructor(opts: BundlerClientOptions) {
    this.opts = opts;
  }

  init(): Promise<BootTimings> {
    this.initPromise ??= new Promise<BootTimings>((resolve, reject) => {
      const started = performance.now();
      const worker = this.opts.createWorker
        ? this.opts.createWorker()
        : new Worker(this.opts.workerUrl, { type: 'module' });
      this.worker = worker;
      worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'init-done':
            resolve({ coldStartMs: performance.now() - started, wasmInitMs: msg.wasmInitMs });
            break;
          case 'init-error':
            reject(new Error(`esbuild-wasm failed to initialize: ${msg.message}`));
            break;
          case 'build-result': {
            const cb = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            cb?.(msg.result);
            break;
          }
        }
      });
      worker.addEventListener('error', (e) => {
        reject(new Error(`bundler worker failed: ${e.message}`));
      });
      this.post({ type: 'init', wasmUrl: this.opts.wasmUrl });
    });
    return this.initPromise;
  }

  async build(input: BundleInput): Promise<BuildResult> {
    await this.init();
    const id = this.nextId++;
    this.latestId = id;
    return new Promise<BuildResult>((resolve) => {
      this.pending.set(id, resolve);
      this.post({ type: 'build', id, input, cdnBaseUrl: this.opts.cdnBaseUrl });
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    for (const cb of this.pending.values()) {
      cb({
        ok: false,
        js: '',
        css: '',
        importMap: { imports: {} },
        diagnostics: [{ severity: 'error', text: 'Bundler terminated.' }],
        durationMs: 0,
      });
    }
    this.pending.clear();
  }

  private post(msg: WorkerRequest): void {
    if (!this.worker) throw new Error('bundler worker is not running');
    this.worker.postMessage(msg);
  }
}
