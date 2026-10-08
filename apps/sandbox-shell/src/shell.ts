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
 * loop, so an infinite loop in user code also stops the shell's main thread: `ping`s are
 * answered with `pong` from a `setTimeout(0)` task, so a frozen build means no pongs and the
 * app's watchdog fires. A `load` blocks this thread too (frame swap, then the new module
 * graph compiles and evaluates in one task), for seconds on a busy CPU: the app allows up to
 * 15 s of silence until this load's `ready` (the load grace, packages/runtime README).
 *
 * Packages (T-032, `packages.ts`): after a build ran, its import map's URLs are fetched once
 * into the browser's HTTP cache (the build frame's partition), so the template's packages
 * keep working while the package CDN is down. When the module graph fails, or still waits
 * after 8 s, the shell checks the build's package URLs the same way and names the one that
 * is missing ("Package server unreachable: zustand@5.0.15").
 *
 * `load` and `reset-storage` run one at a time, in arrival order (`SerialQueue`): a load
 * that arrives during a reset starts only after the wipe finished, so a build never sees a
 * half-wiped origin and its open IndexedDB connections can't block the wipe.
 *
 * The app treats everything this file sends as untrusted display data (the build can run
 * code in this realm), see packages/runtime/README.md "Trust model".
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
  type RunMode,
  type ShellToApp,
} from '@br/protocol';
import { createChildFrame, injectBuild, installBuildApi, openBuildDocument } from './build-frame';
import { RESET_ENDPOINT } from './headers';
import {
  STALL_MS,
  WARM_DELAY_MS,
  explainLoadFailure,
  explainStall,
  packageCandidates,
  warmPackages,
} from './packages';
import { captureThumbnail } from './thumbnail';
import { SerialQueue, wipeOriginStorage } from './wipe';

/** Injected at build time: origins allowed to embed and drive this shell. */
declare const __BR_APP_ORIGINS__: readonly string[];

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

let port: MessagePort | null = null;
let helloTimer: ReturnType<typeof setInterval> | null = null;
let frame: HTMLIFrameElement | null = null;
let currentBlobUrl: string | null = null;
/** The current load's "still waiting for packages" check (T-032). */
let stallTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The shell's own `fetch`, taken before any build runs: a build can replace `parent.fetch`,
 * which would only garble its own package messages, but never this reference.
 */
const shellFetch: typeof fetch = window.fetch.bind(window);
/** Import map URLs this shell realm already fetched into the HTTP cache (T-032 warm-up). */
const warmed = new Set<string>();
const MODULE_LOAD_FAILED =
  'The build or one of its packages failed to load (network or CDN error; see the browser console).';
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
  if (stallTimer !== null) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
  if (frame) {
    frame.remove();
    frame = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

const FRAME_CSS =
  'position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;display:block;background:transparent';

function runLoad(msg: LoadMessage): void {
  teardownFrame();
  const f = createChildFrame(document, FRAME_ALLOW[msg.mode], FRAME_CSS);
  frame = f;
  const opened = openBuildDocument(f, (w) => {
    instrument(w);
    // `ready()` is a hint for the capture renderer (capture.ts). In the previews it does
    // nothing, so templates can call it unconditionally.
    installBuildApi(w, () => undefined);
  });
  if (!opened) {
    reportError(undefined, 'module-load', 'Sandbox could not create the build document');
    post({ type: 'ready', loadId: msg.loadId });
    return;
  }
  // T-032: the URLs to check when the module graph fails or stalls (the error event does not
  // say which one failed), and to warm up after it ran.
  const candidates = packageCandidates(msg.importMap, msg.packages);
  let finished = false;
  const settled = () => {
    finished = true;
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = null;
  };
  currentBlobUrl = injectBuild(opened.document, msg, {
    onLoad: () => {
      if (frame !== f) return;
      settled();
      post({ type: 'ready', loadId: msg.loadId });
      if (msg.mode !== 'capture') {
        const urls = Object.values(msg.importMap.imports);
        setTimeout(() => {
          void warmPackages(urls, shellFetch, warmed).catch(() => undefined);
        }, WARM_DELAY_MS);
      }
    },
    onError: () => {
      if (frame !== f) return;
      settled();
      // Name the package that did not load: cached ones answer at once, the others fail fast
      // (or time out), so this adds well under a second when the CDN is down.
      void explainLoadFailure(candidates, shellFetch)
        .catch(() => null)
        .then((text) => {
          if (frame !== f) return;
          reportError(undefined, 'module-load', text ?? MODULE_LOAD_FAILED);
          post({ type: 'ready', loadId: msg.loadId });
        });
    },
  });
  // A module graph can also wait forever (a CDN that accepts connections and never answers).
  // The watchdog does not see that (the shell keeps answering pings), so say what it waits
  // for. No `ready`: the build may still start.
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (frame !== f) return;
    void explainStall(candidates, STALL_MS, shellFetch)
      .catch(() => null)
      .then((text) => {
        // Not after the load ended meanwhile (its own outcome was reported).
        if (frame === f && !finished && text !== null) reportError(undefined, 'module-load', text);
      });
  }, STALL_MS);
  // Keyboard games: someone else's build (reveal, capture) gets the keyboard at once. Not in
  // `live` mode: there every rebuild loads a new frame, and focusing it would pull the
  // keyboard out of the app's editor mid-typing. A click on the build focuses it, and a
  // click on the shell's own document is forwarded to it (the `focus` listener in start()).
  if (msg.mode !== 'live') opened.window.focus();
}

async function resetStorage(requestId: number | undefined): Promise<void> {
  // Close the running build first: its open IndexedDB connections would block deletion.
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
      void queue.push(() => {
        runLoad(msg);
      });
      return;
    case 'reset-storage': {
      const requestId = msg.requestId;
      void queue.push(() => resetStorage(requestId));
      return;
    }
    case 'ping': {
      // Answer from a separate main-thread task, not from this listener: the pong then shows
      // that the event loop runs timer tasks. Not queued behind a running reset.
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
