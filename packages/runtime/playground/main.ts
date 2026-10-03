/**
 * Dev playground: textareas per file, a cross-site preview, a console panel.
 * Exposes `window.__playground` so the Playwright tests can drive it.
 */
import type { StorageResetMessage } from '@br/protocol';
import { EsmBrowserRuntime } from '../src/runtime';
import type { PreviewHandle, PreviewStats } from '../src/preview/preview-handle';
import type { BuildResult, Diagnostic, FileMap, Manifest } from '../src/types';
import { SAMPLE_FILES, SAMPLE_MANIFEST } from './sample-project';

declare const __PLAYGROUND_CONFIG__: {
  shellUrl: string;
  cdnBaseUrl: string;
  wasmUrl: string;
  workerUrl: string;
};
const config = __PLAYGROUND_CONFIG__;

export interface PlaygroundEvent {
  type: 'console' | 'error' | 'ready' | 'crash' | 'connected' | 'build';
  t: number;
  data: unknown;
}

export interface BootReport {
  coldStartMs: number;
  wasmInitMs: number;
  firstBuildMs: number;
  firstPreviewMs: number;
}

export interface BuildAndLoadReport {
  ok: boolean;
  /** Bundler time inside the worker. */
  buildMs: number;
  /** runtime.build() call -> `ready` from the preview (bundle + transfer + fresh document + evaluate). */
  totalMs: number;
  diagnostics: Diagnostic[];
}

export interface PlaygroundApi {
  boot: Promise<BootReport>;
  setProject(files: FileMap, manifest: Manifest): Promise<void>;
  writeFile(path: string, contents: string): void;
  buildAndLoad(): Promise<BuildAndLoadReport>;
  waitForReady(loadId: number, timeoutMs?: number): Promise<number>;
  lastLoadId(): number;
  resetStorage(): Promise<StorageResetMessage>;
  restartPreview(): Promise<void>;
  previewState(): string;
  previewStats(): PreviewStats;
  events: PlaygroundEvent[];
}

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

const runtime = new EsmBrowserRuntime({
  workerUrl: config.workerUrl,
  wasmUrl: config.wasmUrl,
  cdnBaseUrl: config.cdnBaseUrl,
});
const events: PlaygroundEvent[] = [];
const readyAt = new Map<number, number>();
const readyWaiters = new Map<number, (t: number) => void>();
let preview: PreviewHandle;
let lastLoadId = 0;
let files: FileMap = { ...SAMPLE_FILES };
let manifest: Manifest = SAMPLE_MANIFEST;

function log(type: PlaygroundEvent['type'], data: unknown): void {
  events.push({ type, t: performance.now(), data });
  if (type === 'console' || type === 'error' || type === 'crash') {
    const line =
      type === 'console'
        ? (data as { level: string; args: string[] }).level +
          ': ' +
          (data as { args: string[] }).args.join(' ')
        : `${type}: ${JSON.stringify(data)}`;
    const el = $('console');
    el.textContent += line + '\n';
    el.scrollTop = el.scrollHeight;
  }
}

function setStatus(s: string): void {
  $('status').textContent = s;
}

function renderFiles(): void {
  const root = $('files');
  root.textContent = '';
  for (const [path, contents] of Object.entries(files)) {
    const wrap = document.createElement('div');
    wrap.className = 'file';
    const label = document.createElement('label');
    label.textContent = path;
    const ta = document.createElement('textarea');
    ta.value = contents;
    ta.dataset['path'] = path;
    ta.spellcheck = false;
    ta.addEventListener('input', () => {
      files[path] = ta.value;
      runtime.writeFile(path, ta.value); // debounced rebuild -> onBuild -> preview.load
    });
    label.htmlFor = ta.id = `file-${path.replace(/[^\w]/g, '_')}`;
    wrap.append(label, ta);
    root.append(wrap);
  }
}

function renderDiagnostics(diags: readonly Diagnostic[]): void {
  $('diagnostics').textContent = diags.length
    ? diags
        .map(
          (d) =>
            `${d.severity}: ${d.file ? `${d.file}:${String(d.line ?? 0)}:${String(d.column ?? 0)} ` : ''}${d.text}`,
        )
        .join('\n')
    : 'none';
}

function createPreviewFrame(): PreviewHandle {
  const container = $('preview-container');
  container.textContent = '';
  const iframe = document.createElement('iframe');
  iframe.id = 'preview';
  container.append(iframe);
  const handle = runtime.attachPreview(iframe, { shellUrl: config.shellUrl });
  handle.on('connected', (d) => {
    log('connected', d);
  });
  handle.on('console', (m) => {
    log('console', { level: m.level, args: m.args });
  });
  handle.on('error', (m) => {
    log('error', m);
  });
  handle.on('ready', ({ loadId }) => {
    const t = performance.now();
    readyAt.set(loadId, t);
    log('ready', { loadId });
    readyWaiters.get(loadId)?.(t);
    readyWaiters.delete(loadId);
  });
  handle.on('crash', (c) => {
    log('crash', c);
    const msg = document.createElement('div');
    msg.id = 'crashed';
    msg.textContent = `Build froze (${c.reason}, silent for ${Math.round(c.silentForMs).toString()} ms). Use "Restart preview".`;
    container.append(msg);
    setStatus('preview crashed');
  });
  return handle;
}

function waitForReady(loadId: number, timeoutMs = 15000): Promise<number> {
  const t = readyAt.get(loadId);
  if (t !== undefined) return Promise.resolve(t);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters.delete(loadId);
      reject(new Error(`preview did not report ready for load ${String(loadId)}`));
    }, timeoutMs);
    readyWaiters.set(loadId, (at) => {
      clearTimeout(timer);
      resolve(at);
    });
  });
}

runtime.onBuild((result: BuildResult) => {
  log('build', {
    ok: result.ok,
    durationMs: result.durationMs,
    diagnostics: result.diagnostics.length,
  });
  renderDiagnostics(result.diagnostics);
  if (result.ok && preview.state !== 'crashed' && preview.state !== 'disposed') {
    lastLoadId = preview.load(result);
  }
  setStatus(`${result.ok ? 'built' : 'build failed'} in ${result.durationMs.toFixed(0)} ms`);
});

async function buildAndLoad(): Promise<BuildAndLoadReport> {
  const started = performance.now();
  const before = lastLoadId;
  const result = await runtime.build();
  if (!result.ok || lastLoadId === before) {
    return {
      ok: false,
      buildMs: result.durationMs,
      totalMs: performance.now() - started,
      diagnostics: result.diagnostics,
    };
  }
  const at = await waitForReady(lastLoadId);
  return {
    ok: true,
    buildMs: result.durationMs,
    totalMs: at - started,
    diagnostics: result.diagnostics,
  };
}

async function restartPreview(): Promise<void> {
  preview.dispose();
  preview = createPreviewFrame();
  await new Promise<void>((resolve) => {
    const off = preview.on('connected', () => {
      off();
      resolve();
    });
  });
}

async function boot(): Promise<BootReport> {
  renderFiles();
  preview = createPreviewFrame();
  const timings = await runtime.boot({ files, manifest });
  setStatus(`esbuild-wasm ready in ${timings.coldStartMs.toFixed(0)} ms`);
  const first = await buildAndLoad();
  if (!first.ok) throw new Error(`first build failed: ${JSON.stringify(first.diagnostics)}`);
  return {
    coldStartMs: timings.coldStartMs,
    wasmInitMs: timings.wasmInitMs,
    firstBuildMs: first.buildMs,
    firstPreviewMs: first.totalMs,
  };
}

$('build').addEventListener('click', () => {
  void buildAndLoad();
});
$('reset').addEventListener('click', () => {
  void preview.resetStorage().then((r) => {
    log('console', { level: 'info', args: [`storage reset: ${JSON.stringify(r)}`] });
  });
});
$('restart').addEventListener('click', () => {
  void restartPreview().then(() => buildAndLoad());
});

const api: PlaygroundApi = {
  boot: boot(),
  async setProject(nextFiles, nextManifest) {
    files = { ...nextFiles };
    manifest = nextManifest;
    renderFiles();
    await runtime.boot({ files, manifest });
  },
  writeFile(path, contents) {
    files[path] = contents;
    const ta = document.querySelector<HTMLTextAreaElement>(
      `textarea[data-path="${CSS.escape(path)}"]`,
    );
    if (ta) ta.value = contents;
    runtime.writeFile(path, contents);
  },
  buildAndLoad,
  waitForReady,
  lastLoadId: () => lastLoadId,
  resetStorage: () => preview.resetStorage(),
  restartPreview,
  previewState: () => preview.state,
  previewStats: () => preview.stats,
  events,
};
(window as unknown as { __playground: PlaygroundApi }).__playground = api;
api.boot.then(
  (r) => {
    setStatus(
      `ready: cold start ${r.coldStartMs.toFixed(0)} ms, first preview ${r.firstPreviewMs.toFixed(0)} ms`,
    );
  },
  (e: unknown) => {
    setStatus(`boot failed: ${e instanceof Error ? e.message : String(e)}`);
  },
);
