/**
 * Build Roulette sandbox shell (runs on the usercontent origin, inside the app's
 * `<iframe sandbox>`). Classic script, no imports at runtime: bundled into one small file.
 *
 * Protocol v2 (docs/09 §9.3): a `load` carries a site pack (an imported, built static site).
 * Per load the shell unpacks it, makes sure the site worker (`/v{N}/sw.js`, `sw.ts`) is
 * registered and active, hands it the files under a fresh random site id, and navigates a
 * NEW same-origin child frame to `/?__br_site=<id>`, which the worker serves like a static
 * host (root-relative URLs, lazy chunks, `fetch('/data.json')`, workers, a client-side
 * router that expects `/`). Removing the previous child frame destroys the previous site's
 * realm: its timers, rAF loops, audio, workers and DOM go with it.
 *
 * Every HTML document of the site starts with the worker's bootstrap, which calls this
 * shell's attach hook (`__brAttach`): console and error forwarding and
 * `window.buildRoulette`, before the site's own scripts run. `ready` is the child frame's
 * first `load` event for the load; a later navigation inside the site sends no second one.
 *
 * The shell's own realm (this file) survives loads, so the MessagePort from the handshake
 * stays valid and no re-handshake is needed per load. Same-origin frames share one event
 * loop, so an infinite loop in the site also stops the shell's main thread: `ping`s are
 * answered with `pong` from a `setTimeout(0)` task, so a frozen site means no pongs and the
 * app's watchdog fires. A heavy site start blocks this thread too, for seconds on a busy
 * CPU: the app allows up to 15 s of silence until this load's `ready` (the load grace,
 * packages/runtime README).
 *
 * `load`, `reset-storage` and `capture-thumbnail` run one at a time, in arrival order
 * (`SerialQueue`): a load that arrives during a reset starts only after the wipe finished
 * (which also unregistered the site worker: the load registers it again), so a site never
 * sees a half-wiped origin and its open IndexedDB connections can't block the wipe.
 *
 * The app treats everything this file sends as untrusted display data (the site can run code
 * in this realm), see packages/runtime/README.md "Trust model".
 */
import { config as zodConfig } from 'zod/mini';
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
  type RunMode,
  type ShellToApp,
} from '@br/protocol';
import {
  createChildFrame,
  defineAttachHook,
  installBuildApi,
  onResourceError,
  type SiteWindow,
} from './build-frame';
import { RESET_ENDPOINT } from './headers';
import { SiteLoadError, startSite } from './site-loader';
import { captureThumbnail } from './thumbnail';
import { SerialQueue, wipeOriginStorage } from './wipe';

/** Injected at build time: origins allowed to embed and drive this shell. */
declare const __BR_APP_ORIGINS__: readonly string[];

// The shell's CSP has no 'unsafe-eval': keep zod from probing `new Function` (which would
// log a CSP violation) for its optional fast path.
zodConfig({ jitless: true });

const APP_ORIGINS: readonly string[] = __BR_APP_ORIGINS__;
/**
 * `allow` of the per-load child frame, by run mode. It can only narrow what the app granted
 * this shell (the app's iframe has no `clipboard-write` in reveal/capture either); setting it
 * here too keeps the child's policy explicit.
 */
const FRAME_ALLOW: Readonly<Record<RunMode, string>> = {
  live: 'autoplay; fullscreen; gamepad; clipboard-write',
  reveal: 'autoplay; fullscreen; gamepad',
  capture: 'autoplay; fullscreen; gamepad',
};
const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
const FRAME_CSS =
  'position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;display:block;background:transparent';

let port: MessagePort | null = null;
let helloTimer: ReturnType<typeof setInterval> | null = null;
let frame: HTMLIFrameElement | null = null;
/** Run mode of the current frame's load. */
let frameMode: RunMode = 'live';
const consoleWindow = { start: 0, count: 0, dropped: 0 };
const queue = new SerialQueue();

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

/** Hooks console + error reporting into a site realm (once per document, see the hook). */
function instrument(w: SiteWindow): void {
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
  // A script or stylesheet of the site that failed to load (a 404 from the site worker).
  onResourceError(w, (url) => {
    reportError(undefined, 'module-load', `Failed to load ${url}`);
  });
  w.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    reportError(ev.reason, 'unhandledrejection');
  });
}

/** The site's documents call this through the bootstrap (`parent.__brAttach(window)`). */
const attach = defineAttachHook(
  window,
  () => frame,
  (w) => {
    instrument(w);
    // `ready()` is a hint for the capture renderer (capture.ts). In the previews it does
    // nothing, so sites can call it unconditionally.
    installBuildApi(w, () => undefined);
    // Keyboard games: someone else's site (reveal, capture) gets the keyboard at once. Not in
    // `live` mode: there every import loads a new frame, and focusing it would pull the
    // keyboard out of the app. A click on the site focuses it, and a click on the shell's
    // own document is forwarded to it (the `focus` listener in start()).
    if (frameMode !== 'live') w.focus();
  },
);

function teardownFrame(): void {
  if (frame) {
    frame.remove();
    frame = null;
  }
}

async function runLoad(msg: LoadMessage): Promise<void> {
  teardownFrame();
  let src: string;
  try {
    src = await startSite(msg.site);
  } catch (e) {
    const text =
      e instanceof SiteLoadError
        ? e.message
        : `The sandbox could not load the site: ${e instanceof Error ? e.message : String(e)}`;
    reportError(undefined, 'module-load', text);
    post({ type: 'ready', loadId: msg.loadId });
    return;
  }
  frameMode = msg.mode;
  const f = createChildFrame(document, FRAME_ALLOW[msg.mode], FRAME_CSS, src);
  frame = f;
  let readySent = false;
  f.addEventListener('load', () => {
    if (frame !== f) return;
    // A document whose bootstrap could not run (a page with its own stricter CSP, a non-HTML
    // entry) is attached now, late.
    try {
      if (f.contentWindow) attach(f.contentWindow);
    } catch {
      // another origin: nothing to attach
    }
    if (readySent) return;
    readySent = true;
    post({ type: 'ready', loadId: msg.loadId });
  });
}

async function resetStorage(requestId: number | undefined): Promise<void> {
  // Close the running site first: its open IndexedDB connections would block deletion.
  teardownFrame();
  const errors = await wipeOriginStorage(new URL(RESET_ENDPOINT, location.href));
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
      void queue.push(() => runLoad(msg));
      return;
    case 'reset-storage': {
      const requestId = msg.requestId;
      void queue.push(() => resetStorage(requestId));
      return;
    }
    case 'ping': {
      // Answer from a separate main-thread task, not from this listener: the pong then shows
      // that the event loop runs timer tasks. Not queued behind a running load or reset.
      const seq = msg.seq;
      setTimeout(() => {
        post({ type: 'pong', seq });
      }, 0);
      return;
    }
    case 'capture-thumbnail': {
      // Best effort (thumbnail.ts): no answer when no image can be made; the app times out.
      const { requestId, width, height } = msg;
      void queue.push(async () => {
        const webp = await captureThumbnail(frame, width, height);
        if (webp)
          post({ type: 'thumbnail', webp, ...(requestId === undefined ? {} : { requestId }) });
      });
      return;
    }
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
