/**
 * Build Roulette sandbox shell (runs on the usercontent origin, inside the app's
 * `<iframe sandbox>`). Classic script, no imports at runtime: bundled into one small file.
 *
 * Fresh document per load: every `load` creates a NEW same-origin child iframe
 * (about:blank), then `document.open()` + `document.write()` gives it a standards-mode
 * document, and the shell inserts, in order and synchronously, the import map, the CSS and
 * a `<script type="module" src="blob:...">`. Because no module has started loading in that
 * brand-new realm yet, the import map always applies before user code runs. Removing the
 * previous child iframe destroys the previous build's realm: its timers, rAF loops, audio,
 * workers, module map (React instance included) and DOM go with it.
 *
 * The shell's own realm (this file) survives loads, so the MessagePort from the handshake
 * stays valid and no re-handshake is needed per rebuild. Same-origin frames share one event
 * loop, so an infinite loop in user code also stops the shell's heartbeat interval: the
 * watchdog sees it exactly as if the heartbeat lived in the user's document.
 */
import {
  LIMITS,
  PROTOCOL_VERSION,
  describeThrown,
  parseAppToShell,
  parseConnect,
  serializeConsoleArgs,
  truncate,
  type ConsoleLevel,
  type LoadMessage,
  type ShellToApp,
} from '@br/protocol';

/** Injected at build time: origins allowed to embed and drive this shell. */
declare const __BR_APP_ORIGINS__: readonly string[];

const APP_ORIGINS: readonly string[] = __BR_APP_ORIGINS__;
const FRAME_ALLOW = 'autoplay; fullscreen; gamepad; clipboard-write';
const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

let port: MessagePort | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let helloTimer: ReturnType<typeof setInterval> | null = null;
let frame: HTMLIFrameElement | null = null;
let currentBlobUrl: string | null = null;
const consoleWindow = { start: 0, count: 0, dropped: 0 };

function post(msg: ShellToApp): void {
  port?.postMessage(msg);
}

function forwardConsole(level: ConsoleLevel, args: readonly unknown[]): void {
  const now = Date.now();
  if (now - consoleWindow.start >= 1000) {
    if (consoleWindow.dropped > 0) {
      post({
        type: 'console',
        level: 'warn',
        args: [`[sandbox] ${consoleWindow.dropped} console messages dropped (rate limit)`],
      });
    }
    consoleWindow.start = now;
    consoleWindow.count = 0;
    consoleWindow.dropped = 0;
  }
  if (consoleWindow.count >= LIMITS.consoleMaxPerSecond) {
    consoleWindow.dropped++;
    return;
  }
  consoleWindow.count++;
  post({ type: 'console', level, args: serializeConsoleArgs(args) });
}

function reportError(
  reason: unknown,
  kind: 'error' | 'unhandledrejection' | 'module-load',
  fallbackMessage?: string,
): void {
  const d =
    reason === undefined && fallbackMessage !== undefined
      ? { message: truncate(fallbackMessage, LIMITS.errorMessageMaxChars) }
      : describeThrown(reason);
  post({ type: 'runtime-error', kind, ...d });
}

/** Hooks console + error reporting into a realm. Must run after `document.open()`, which erases listeners. */
function instrument(w: Window & typeof globalThis): void {
  const realmConsole = w.console;
  const c = realmConsole as unknown as Record<ConsoleLevel, (...args: unknown[]) => void>;
  for (const level of CONSOLE_LEVELS) {
    const original = c[level].bind(realmConsole);
    c[level] = (...args: unknown[]) => {
      try {
        original(...args);
      } catch {
        // ignore
      }
      forwardConsole(level, args);
    };
  }
  w.addEventListener('error', (ev: ErrorEvent) => {
    reportError(ev.error, 'error', ev.message || 'Script error');
  });
  w.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    reportError(ev.reason, 'unhandledrejection');
  });
}

function teardownFrame(): void {
  if (frame) {
    frame.remove();
    frame = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

function runLoad(msg: LoadMessage): void {
  teardownFrame();
  const f = document.createElement('iframe');
  f.setAttribute('allow', FRAME_ALLOW);
  f.setAttribute('allowfullscreen', '');
  f.title = 'Build';
  f.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;display:block;background:transparent';
  ((document.body as HTMLElement | null) ?? document.documentElement).appendChild(f);
  frame = f;
  const w = f.contentWindow as (Window & typeof globalThis) | null;
  const d = f.contentDocument;
  if (!w || !d) {
    reportError(undefined, 'module-load', 'Sandbox could not create the build document');
    post({ type: 'ready', loadId: msg.loadId });
    return;
  }

  d.open();
  instrument(w);
  // document.write is deprecated for parser-inserted content in normal pages, but writing
  // into a document we just opened is the one reliable way to get a standards-mode
  // document (an about:blank initial document is in quirks mode).
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  d.write(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
  );
  d.close();

  const importMap = d.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify(msg.importMap);
  d.head.appendChild(importMap);

  if (msg.css) {
    const style = d.createElement('style');
    style.textContent = msg.css;
    d.head.appendChild(style);
  }

  const url = URL.createObjectURL(new Blob([msg.js], { type: 'text/javascript' }));
  currentBlobUrl = url;
  const script = d.createElement('script');
  script.type = 'module';
  script.src = url;
  script.addEventListener('load', () => {
    if (frame === f) post({ type: 'ready', loadId: msg.loadId });
  });
  script.addEventListener('error', () => {
    if (frame !== f) return;
    reportError(
      undefined,
      'module-load',
      'The build or one of its packages failed to load (network or CDN error; see the browser console).',
    );
    post({ type: 'ready', loadId: msg.loadId });
  });
  d.head.appendChild(script);
  // Keyboard games: a click on the outer frame should land in the build.
  w.focus();
}

function deleteDatabase(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(`IndexedDB "${name}" deletion timed out`);
    }, 3000);
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(null);
    };
    req.onerror = () => {
      clearTimeout(timer);
      resolve(`IndexedDB "${name}": ${req.error?.message ?? 'error'}`);
    };
  });
}

async function resetStorage(requestId: number | undefined): Promise<void> {
  // Close the running build first: its open IndexedDB connections would block deletion.
  teardownFrame();
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await attempt('localStorage', () => {
    localStorage.clear();
  });
  await attempt('sessionStorage', () => {
    sessionStorage.clear();
  });
  await attempt('indexedDB', async () => {
    const dbs = await indexedDB.databases();
    const results = await Promise.all(
      dbs.map((db) => (db.name ? deleteDatabase(db.name) : Promise.resolve(null))),
    );
    for (const r of results) if (r) errors.push(r);
  });
  await attempt('caches', async () => {
    if (typeof caches === 'undefined') return;
    for (const key of await caches.keys()) await caches.delete(key);
  });
  await attempt('cookies', () => {
    for (const part of document.cookie.split(';')) {
      const name = part.split('=')[0]?.trim();
      if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  });
  const trimmed = errors
    .slice(0, LIMITS.storageResetMaxErrors)
    .map((e) => truncate(e, LIMITS.errorMessageMaxChars));
  post({
    type: 'storage-reset',
    ok: errors.length === 0,
    ...(requestId === undefined ? {} : { requestId }),
    ...(trimmed.length ? { errors: trimmed } : {}),
  });
}

function onPortMessage(event: MessageEvent): void {
  const parsed = parseAppToShell(event.data);
  if (!parsed.ok) return; // invalid or unknown: dropped
  const msg = parsed.value;
  switch (msg.type) {
    case 'load':
      runLoad(msg);
      return;
    case 'reset-storage':
      void resetStorage(msg.requestId);
      return;
    case 'ping':
      post({ type: 'heartbeat', t: Date.now() });
      return;
    case 'capture-thumbnail':
      // Not implemented in M1 (schema only).
      return;
  }
}

function onWindowMessage(event: MessageEvent): void {
  // Only the embedding app may connect: exact parent window and an allowlisted origin.
  if (event.source !== window.parent || !APP_ORIGINS.includes(event.origin)) return;
  const parsed = parseConnect(event.data);
  if (!parsed.ok || parsed.value.protocol !== PROTOCOL_VERSION) return;
  const p = event.ports[0];
  if (!p) return;
  port?.close();
  port = p;
  port.onmessage = onPortMessage;
  if (helloTimer !== null) clearInterval(helloTimer);
  helloTimer = null;
  post({ type: 'connected', nonce: parsed.value.nonce });
  post({ type: 'heartbeat', t: Date.now() });
  heartbeat ??= setInterval(() => {
    post({ type: 'heartbeat', t: Date.now() });
  }, 1000);
}

function sayHello(): void {
  // postMessage with a non-matching targetOrigin is silently dropped by the browser, so
  // only the real embedding app (one of APP_ORIGINS) receives it.
  for (const origin of APP_ORIGINS)
    window.parent.postMessage({ type: 'hello', protocol: PROTOCOL_VERSION }, origin);
}

function start(): void {
  if (window.parent === window) {
    document.title = 'Build Roulette sandbox';
    return;
  }
  window.addEventListener('message', onWindowMessage);
  window.addEventListener('focus', () => frame?.contentWindow?.focus());
  sayHello();
  // Re-announce for a little while in case the app attached its listener late.
  let tries = 0;
  helloTimer = setInterval(() => {
    if (port || ++tries > 20) {
      if (helloTimer !== null) clearInterval(helloTimer);
      helloTimer = null;
      return;
    }
    sayHello();
  }, 500);
}

start();
