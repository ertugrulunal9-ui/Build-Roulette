/**
 * Browser side of the compatibility harness: the real `@br/runtime` (esbuild-wasm bundler
 * worker + PreviewHandle) driving the real sandbox shell, with packages from @br/pkg-cdn.
 * Exposes `window.__compat` for the Playwright runner.
 */
import { EsmBrowserRuntime, type FileMap, type Manifest, type PreviewHandle } from '@br/runtime';

declare const __COMPAT_CONFIG__: {
  shellUrl: string;
  cdnBaseUrl: string;
  wasmUrl: string;
  workerUrl: string;
};
const config = __COMPAT_CONFIG__;

export interface CompatRunReport {
  ok: boolean;
  phase: 'build' | 'connect' | 'ready' | 'done';
  buildMs: number;
  /** runtime.build() -> `ready` from the shell (module evaluated). */
  readyMs: number;
  diagnostics: string[];
}

export interface CompatState {
  runtimeErrors: string[];
  consoleErrors: string[];
  crashed: boolean;
}

export interface CompatApi {
  boot: Promise<{ coldStartMs: number }>;
  run(files: FileMap, manifest: Manifest, timeoutMs: number): Promise<CompatRunReport>;
  state(): CompatState;
}

const runtime = new EsmBrowserRuntime({
  workerUrl: config.workerUrl,
  wasmUrl: config.wasmUrl,
  cdnBaseUrl: config.cdnBaseUrl,
});

let preview: PreviewHandle | null = null;
let state: CompatState = { runtimeErrors: [], consoleErrors: [], crashed: false };

function container(): HTMLElement {
  const el = document.getElementById('preview-container');
  if (!el) throw new Error('#preview-container missing');
  return el;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function run(
  files: FileMap,
  manifest: Manifest,
  timeoutMs: number,
): Promise<CompatRunReport> {
  preview?.dispose();
  state = { runtimeErrors: [], consoleErrors: [], crashed: false };
  const root = container();
  root.textContent = '';
  const iframe = document.createElement('iframe');
  iframe.id = 'preview';
  root.append(iframe);
  const handle = runtime.attachPreview(iframe, { shellUrl: config.shellUrl });
  preview = handle;
  handle.on('error', (m) => {
    state.runtimeErrors.push(`${m.kind ?? 'error'}: ${m.message}`);
  });
  handle.on('console', (m) => {
    if (m.level === 'error') state.consoleErrors.push(m.args.join(' '));
  });
  handle.on('crash', (c) => {
    state.crashed = true;
    state.runtimeErrors.push(`preview crashed: ${c.reason}`);
  });
  const report: CompatRunReport = {
    ok: false,
    phase: 'connect',
    buildMs: 0,
    readyMs: 0,
    diagnostics: [],
  };
  await withTimeout(
    new Promise<void>((resolve) => {
      const off = handle.on('connected', () => {
        off();
        resolve();
      });
    }),
    timeoutMs,
    'shell handshake',
  );

  report.phase = 'build';
  await runtime.boot({ files, manifest });
  const started = performance.now();
  const result = await runtime.build();
  report.buildMs = result.durationMs;
  report.diagnostics = result.diagnostics.map(
    (d) => `${d.severity}: ${d.file ? `${d.file}:${String(d.line ?? 0)} ` : ''}${d.text}`,
  );
  if (!result.ok) return report;

  report.phase = 'ready';
  const loadId = handle.load(result);
  await withTimeout(
    new Promise<void>((resolve) => {
      const off = handle.on('ready', (r) => {
        if (r.loadId === loadId) {
          off();
          resolve();
        }
      });
    }),
    timeoutMs,
    'preview ready',
  );
  report.readyMs = performance.now() - started;
  report.phase = 'done';
  report.ok = true;
  return report;
}

const api: CompatApi = {
  boot: runtime
    .boot({ files: {}, manifest: { entry: 'src/main.tsx', dependencies: {} } })
    .then((t) => ({ coldStartMs: t.coldStartMs })),
  run,
  state: () => state,
};
(window as unknown as { __compat: CompatApi }).__compat = api;
