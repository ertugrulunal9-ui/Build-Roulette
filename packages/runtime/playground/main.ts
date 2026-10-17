/**
 * Dev playground: import a built site (a folder or a .zip) and run it in a cross-site
 * preview, with a console panel. Exposes `window.__playground` so the Playwright tests can
 * drive it with site packs made from text files (`SiteSpec`).
 */
import type { RunMode, StorageResetMessage } from '@br/protocol';
import { contentTypeOf, packSite } from '@br/site';
import { importFiles } from '@br/site/browser';
import { PreviewHandle, type PreviewStats } from '../src/preview/preview-handle';

declare const __PLAYGROUND_CONFIG__: { shellUrl: string };
const config = __PLAYGROUND_CONFIG__;

/** A site as text files: path inside the site (`index.html`, `assets/app.js`) -> contents. */
export type SiteSpec = Record<string, string>;

export interface PlaygroundEvent {
  type: 'console' | 'error' | 'ready' | 'crash' | 'connected' | 'load';
  t: number;
  data: unknown;
}

export interface BootReport {
  /** Page start -> first handshake. */
  connectMs: number;
  /** load() of the sample site -> its `ready`. */
  firstPreviewMs: number;
}

export interface LoadReport {
  loadId: number;
  /** `load()` -> `ready` (pack copy, transfer, unpack, worker upload, fresh frame, site start). */
  totalMs: number;
}

export interface PlaygroundApi {
  boot: Promise<BootReport>;
  /** Packs `files`, loads them and waits for `ready`. */
  loadSite(files: SiteSpec, mode?: RunMode): Promise<LoadReport>;
  /** Packs `files` and sends the load; does not wait. Returns the loadId. */
  sendSite(files: SiteSpec, mode?: RunMode): number;
  /** Sends raw bytes as the pack (for broken packs). Returns the loadId. */
  sendPack(bytes: number[], mode?: RunMode): number;
  /** Packs `files` and stores them on the test file server as `name` (capture e2e). */
  uploadPack(name: string, files: SiteSpec): Promise<void>;
  waitForReady(loadId: number, timeoutMs?: number): Promise<number>;
  lastLoadId(): number;
  resetStorage(): Promise<StorageResetMessage>;
  /** Best-effort WebP thumbnail of the running site (data URL), or null. */
  captureThumbnail(width: number, height: number): Promise<string | null>;
  restartPreview(): Promise<void>;
  /** Run mode for the following loads; a different mode replaces the preview iframe. */
  setMode(mode: RunMode): void;
  previewMode(): RunMode;
  previewState(): string;
  previewStats(): PreviewStats;
  events: PlaygroundEvent[];
}

/** The sample site: a Vite-like build (module entry, CSS, a lazy chunk, a JSON file). */
export const SAMPLE_SITE: SiteSpec = {
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sample</title>
    <script type="module" crossorigin src="/assets/index-s4mpl3.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-s4mpl3.css" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
  'assets/index-s4mpl3.css': `body { font: 16px system-ui, sans-serif; margin: 24px; }
.title { color: rgb(255, 0, 128); }
`,
  'assets/index-s4mpl3.js': `const root = document.getElementById('root');
root.innerHTML = '<h1 class="title" data-testid="title">Hello Build Roulette</h1><button data-testid="inc">count is 0</button><p data-testid="data"></p>';
let count = 0;
root.querySelector('[data-testid="inc"]').addEventListener('click', (e) => {
  count++;
  e.currentTarget.textContent = 'count is ' + count;
});
fetch('/data.json').then((r) => r.json()).then((d) => {
  root.querySelector('[data-testid="data"]').textContent = d.message;
});
import('./chunk-l4zy.js').then((m) => m.mark(root));
`,
  'assets/chunk-l4zy.js': `export function mark(root) { root.dataset.lazy = 'loaded'; }
`,
  'data.json': `{ "message": "data from /data.json" }
`,
};

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

const started = performance.now();
const events: PlaygroundEvent[] = [];
const readyAt = new Map<number, number>();
const readyWaiters = new Map<number, (t: number) => void>();
let preview: PreviewHandle;
let lastLoadId = 0;
let mode: RunMode = 'live';

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

/** A pack of text files, each with the content type of its extension. */
function pack(files: SiteSpec): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  return packSite(
    Object.entries(files).map(([path, text]) => ({
      path,
      type: contentTypeOf(path),
      bytes: enc.encode(text),
    })),
  );
}

function createPreviewFrame(): PreviewHandle {
  const container = $('preview-container');
  container.textContent = '';
  const iframe = document.createElement('iframe');
  iframe.id = 'preview';
  container.append(iframe);
  const handle = new PreviewHandle(iframe, { shellUrl: config.shellUrl });
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
    msg.textContent = `Build froze (${c.reason} while ${c.phase}, silent for ${Math.round(c.silentForMs).toString()} ms). Use "Restart preview".`;
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

function sendBytes(site: Uint8Array, m: RunMode = mode): number {
  lastLoadId = preview.load({ site }, m);
  log('load', { loadId: lastLoadId, bytes: site.byteLength, mode: m });
  return lastLoadId;
}

async function loadSite(files: SiteSpec, m: RunMode = mode): Promise<LoadReport> {
  const t0 = performance.now();
  const loadId = sendBytes(pack(files), m);
  const at = await waitForReady(loadId);
  return { loadId, totalMs: at - t0 };
}

function connected(): Promise<void> {
  if (preview.state === 'connected') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const off = preview.on('connected', () => {
      off();
      resolve();
    });
  });
}

/** Restarts the preview in place: a new iframe and a new handshake (also after a crash). */
async function restartPreview(): Promise<void> {
  document.getElementById('crashed')?.remove();
  const done = new Promise<void>((resolve) => {
    const off = preview.on('connected', () => {
      off();
      resolve();
    });
  });
  preview.restart(mode);
  setStatus('restarting preview');
  await done;
}

async function boot(): Promise<BootReport> {
  preview = createPreviewFrame();
  await connected();
  const connectMs = performance.now() - started;
  const first = await loadSite(SAMPLE_SITE);
  return { connectMs, firstPreviewMs: first.totalMs };
}

$('folder').addEventListener('change', (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  void importFiles(files).then((r) => {
    if (!r.ok) {
      setStatus(`import failed: ${r.error.code}${r.error.detail ? ` (${r.error.detail})` : ''}`);
      return;
    }
    sendBytes(r.site.pack);
    setStatus(`imported ${r.site.root || '.'}: ${String(r.site.files)} files`);
  });
});
$('reset').addEventListener('click', () => {
  void preview.resetStorage().then((r) => {
    log('console', { level: 'info', args: [`storage reset: ${JSON.stringify(r)}`] });
  });
});
$('restart').addEventListener('click', () => {
  void restartPreview().then(() => loadSite(SAMPLE_SITE));
});

const api: PlaygroundApi = {
  boot: boot(),
  loadSite,
  sendSite: (files, m) => sendBytes(pack(files), m),
  sendPack: (bytes, m) => sendBytes(new Uint8Array(bytes), m),
  async uploadPack(name, files) {
    const res = await fetch(`/__test/site?name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: pack(files),
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${String(res.status)}`);
  },
  waitForReady,
  lastLoadId: () => lastLoadId,
  resetStorage: () => preview.resetStorage(),
  captureThumbnail: (width, height) => preview.captureThumbnail({ width, height }),
  restartPreview,
  setMode(next) {
    mode = next;
  },
  previewMode: () => preview.mode,
  previewState: () => preview.state,
  previewStats: () => preview.stats,
  events,
};
(window as unknown as { __playground: PlaygroundApi }).__playground = api;
api.boot.then(
  (r) => {
    setStatus(
      `ready: connected in ${r.connectMs.toFixed(0)} ms, first preview ${r.firstPreviewMs.toFixed(0)} ms`,
    );
  },
  (e: unknown) => {
    setStatus(`boot failed: ${e instanceof Error ? e.message : String(e)}`);
  },
);
