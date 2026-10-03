/**
 * Bundler Web Worker entry. Hosts esbuild-wasm and answers build requests.
 * Bundle this file as an ES module worker (see test-support/dev-server.ts for an example).
 */
import * as esbuild from 'esbuild-wasm/esm/browser.js';
import { bundle, cachedFetchText, fetchTextFromNetwork } from '../bundler/bundle';
import type { WorkerRequest, WorkerResponse } from './protocol';

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
const fetchText = cachedFetchText(fetchTextFromNetwork);
let ready: Promise<void> | null = null;

async function handle(msg: WorkerRequest): Promise<void> {
  if (msg.type === 'init') {
    const started = performance.now();
    try {
      // worker: false because we already are the worker.
      ready ??= esbuild.initialize({ wasmURL: msg.wasmUrl, worker: false });
      await ready;
      scope.postMessage({ type: 'init-done', wasmInitMs: performance.now() - started });
    } catch (e) {
      ready = null;
      scope.postMessage({
        type: 'init-error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }
  if (!ready) throw new Error('bundler worker: build before init');
  await ready;
  const result = await bundle(esbuild, msg.input, { cdnBaseUrl: msg.cdnBaseUrl, fetchText });
  scope.postMessage({ type: 'build-result', id: msg.id, result });
}

scope.addEventListener('message', (event) => {
  handle(event.data).catch((e: unknown) => {
    if (event.data.type === 'build') {
      scope.postMessage({
        type: 'build-result',
        id: event.data.id,
        result: {
          ok: false,
          js: '',
          css: '',
          importMap: { imports: {} },
          diagnostics: [
            {
              severity: 'error',
              text: `Bundler worker error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          durationMs: 0,
        },
      });
    }
  });
});
