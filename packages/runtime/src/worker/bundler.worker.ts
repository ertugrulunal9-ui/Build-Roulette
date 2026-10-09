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

/** `init-progress` messages while bytes arrive: at most one per this many ms. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * Downloads and compiles esbuild.wasm, compiling while it downloads (like esbuild-wasm's own
 * `wasmURL` path). We fetch it ourselves for the `init-progress` messages: they let the client
 * tell a slow download (bytes keep coming) from a stalled one (T-039).
 */
async function compileEsbuildWasm(url: string): Promise<WebAssembly.Module> {
  let loaded = 0;
  let sentAt = -Infinity;
  const progress = (stage: 'download' | 'compile', force = false) => {
    const now = performance.now();
    if (!force && now - sentAt < PROGRESS_INTERVAL_MS) return;
    sentAt = now;
    scope.postMessage({ type: 'init-progress', stage, loaded });
  };
  progress('download', true); // the worker runs, the request goes out
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url} (HTTP ${String(res.status)})`);
  }
  progress('download', true); // the response started
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        progress('download');
        controller.enqueue(chunk);
      },
      flush() {
        progress('compile', true);
      },
    }),
  );
  // Our own Response, so the Content-Type is right whatever the server sent.
  const wasm = new Response(counted, { headers: { 'Content-Type': 'application/wasm' } });
  return typeof WebAssembly.compileStreaming === 'function'
    ? WebAssembly.compileStreaming(wasm)
    : WebAssembly.compile(await wasm.arrayBuffer());
}

async function handle(msg: WorkerRequest): Promise<void> {
  if (msg.type === 'init') {
    const started = performance.now();
    try {
      // worker: false because we already are the worker.
      ready ??= compileEsbuildWasm(msg.wasmUrl).then((wasmModule) =>
        esbuild.initialize({ wasmModule, worker: false }),
      );
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
