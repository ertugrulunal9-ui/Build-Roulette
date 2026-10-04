/**
 * Creates the playground's EsmBrowserRuntime. Kept apart from SandboxController so the
 * controller can be unit tested with a fake runtime (the wasm asset import and the worker URL
 * only work inside the Next.js build).
 */
import { EsmBrowserRuntime } from '@br/runtime';
// Turbopack emits the wasm file as a content-hashed static asset and returns its URL
// (`turbopack.rules['*.wasm']` in next.config.ts).
import wasmUrl from 'esbuild-wasm/esbuild.wasm';
import type { PlaygroundConfig } from './config';

export function createPlaygroundRuntime(config: PlaygroundConfig): EsmBrowserRuntime {
  return new EsmBrowserRuntime({
    wasmUrl,
    cdnBaseUrl: config.cdnBaseUrl,
    // The literal `new Worker(new URL(...))` is what lets Turbopack find and bundle the
    // worker entry, so the worker is created here rather than from a `workerUrl`.
    createWorker: () =>
      new Worker(new URL('./bundler.worker.ts', import.meta.url), {
        type: 'module',
        name: 'br-bundler',
      }),
  });
}
