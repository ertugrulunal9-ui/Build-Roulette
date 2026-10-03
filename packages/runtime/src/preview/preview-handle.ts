/**
 * PreviewHandle: the app-side owner of one sandbox iframe (docs/03 §3.5).
 *
 * - Sets the exact sandbox/allow attributes on the iframe.
 * - Handshake: accepts `hello` only when `event.origin` is the shell origin AND
 *   `event.source` is this iframe's `contentWindow`; then transfers a MessageChannel port
 *   with a random nonce and waits for `connected {nonce}` on that port.
 * - After the handshake it listens to the port only. Every inbound message is validated
 *   with @br/protocol; invalid ones are dropped and counted.
 * - Heartbeat watchdog: no heartbeat for `heartbeatTimeoutMs` (5 s) -> `crash` event and the
 *   iframe is removed from the DOM.
 *
 * Shell messages are display-only (console, errors, liveness). The app never takes an
 * action that matters for the game because of one (threat model §3.9).
 */
import {
  PROTOCOL_VERSION,
  createNonce,
  parseShellToApp,
  type AppToShell,
  type ConsoleMessage,
  type Hello,
  type ImportMap,
  type ParseResult,
  type RunMode,
  type RuntimeErrorMessage,
  type StorageResetMessage,
} from '@br/protocol';

export const PREVIEW_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups';
export const PREVIEW_ALLOW = 'autoplay; fullscreen; gamepad; clipboard-write';

export interface PreviewOptions {
  /** Shell URL, e.g. `https://{build_id}.buildroulette-usercontent.net/v1/`. */
  shellUrl: string;
  /** Expected origin of the shell. Defaults to the origin of `shellUrl`. */
  shellOrigin?: string;
  /** No heartbeat for this long -> crash. Default 5000 ms. */
  heartbeatTimeoutMs?: number;
  /** No completed handshake for this long after attach -> crash. Default 10000 ms. */
  handshakeTimeoutMs?: number;
  /** Watchdog tick. Default 250 ms. */
  watchdogIntervalMs?: number;
}

export interface PreviewBuild {
  js: string;
  css: string;
  importMap: ImportMap;
}

export type CrashReason = 'heartbeat-timeout' | 'handshake-timeout';

export interface PreviewEventMap {
  /** Handshake completed (fires again if the shell reloads and re-handshakes). */
  connected: { handshakes: number };
  ready: { loadId: number };
  console: ConsoleMessage;
  error: RuntimeErrorMessage;
  crash: { reason: CrashReason; silentForMs: number };
}

export type PreviewState = 'connecting' | 'connected' | 'crashed' | 'disposed';

export interface PreviewStats {
  handshakes: number;
  /** Messages dropped by the origin/source guard or by schema validation. */
  rejectedMessages: number;
  lastHeartbeatAt: number;
}

/**
 * The handshake guard, as a pure function: is this window message a `hello` from exactly
 * our iframe's window, from the expected origin, speaking our protocol version?
 */
export function checkHello(
  event: { origin: string; source: unknown; data: unknown },
  frameWindow: unknown,
  expectedOrigin: string,
): ParseResult<Hello> {
  if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) {
    return { ok: false, error: 'source is not the preview iframe' };
  }
  if (event.origin !== expectedOrigin)
    return { ok: false, error: `unexpected origin ${event.origin}` };
  const parsed = parseShellToApp(event.data);
  if (!parsed.ok) return parsed;
  if (parsed.value.type !== 'hello')
    return { ok: false, error: `expected hello, got ${parsed.value.type}` };
  if (parsed.value.protocol !== PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol ${parsed.value.protocol}` };
  }
  return { ok: true, value: parsed.value };
}

type Listener<K extends keyof PreviewEventMap> = (payload: PreviewEventMap[K]) => void;

export class PreviewHandle {
  readonly iframe: HTMLIFrameElement;
  private readonly shellOrigin: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly win: Window;
  private readonly doc: Document;
  private port: MessagePort | null = null;
  private nonce: string | null = null;
  private _state: PreviewState = 'connecting';
  private readonly listeners: { [K in keyof PreviewEventMap]: Set<Listener<K>> } = {
    connected: new Set(),
    ready: new Set(),
    console: new Set(),
    error: new Set(),
    crash: new Set(),
  };
  private readonly _stats: PreviewStats = {
    handshakes: 0,
    rejectedMessages: 0,
    lastHeartbeatAt: 0,
  };
  private readonly attachedAt: number;
  private lastPingAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pendingLoad: AppToShell | null = null;
  private nextLoadId = 1;
  private nextRequestId = 1;
  private readonly storageWaiters = new Map<number, (m: StorageResetMessage) => void>();

  constructor(iframe: HTMLIFrameElement, opts: PreviewOptions) {
    this.iframe = iframe;
    this.shellOrigin = opts.shellOrigin ?? new URL(opts.shellUrl).origin;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 5000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10000;
    const doc = iframe.ownerDocument;
    const win = doc.defaultView;
    if (!win) throw new Error('PreviewHandle: iframe must belong to a document with a window');
    this.doc = doc;
    this.win = win;

    iframe.setAttribute('sandbox', PREVIEW_SANDBOX);
    iframe.setAttribute('allow', PREVIEW_ALLOW);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('loading', 'eager');
    if (!iframe.title) iframe.title = 'User build preview';

    // Listen before navigating so the first `hello` cannot be missed.
    win.addEventListener('message', this.onWindowMessage);
    this.doc.addEventListener('visibilitychange', this.onVisibilityChange);
    this.attachedAt = performance.now();
    this.watchdog = setInterval(this.tick, opts.watchdogIntervalMs ?? 250);
    iframe.src = opts.shellUrl;
  }

  get state(): PreviewState {
    return this._state;
  }

  get stats(): Readonly<PreviewStats> {
    return { ...this._stats };
  }

  on<K extends keyof PreviewEventMap>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners[event] as Set<Listener<K>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Runs a build in a fresh document. Returns the loadId echoed by the `ready` event. */
  load(build: PreviewBuild, mode: RunMode = 'live'): number {
    this.assertUsable();
    const loadId = this.nextLoadId++;
    const msg: AppToShell = {
      type: 'load',
      loadId,
      js: build.js,
      css: build.css,
      importMap: build.importMap,
      mode,
    };
    if (this._state === 'connected') this.send(msg);
    else this.pendingLoad = msg; // only the latest load matters
    return loadId;
  }

  /**
   * Wipes localStorage, sessionStorage, IndexedDB, CacheStorage and cookies of the sandbox
   * origin. The shell also tears down the running build first (open IndexedDB connections
   * would block deletion), so call `load()` afterwards.
   */
  resetStorage(timeoutMs = 5000): Promise<StorageResetMessage> {
    this.assertUsable();
    const requestId = this.nextRequestId++;
    return new Promise<StorageResetMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.storageWaiters.delete(requestId);
        reject(new Error('reset-storage timed out'));
      }, timeoutMs);
      this.storageWaiters.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      const msg: AppToShell = { type: 'reset-storage', requestId };
      if (this._state === 'connected') this.send(msg);
      else {
        // Not connected yet: send right after the handshake (ahead of any pending load).
        const off = this.on('connected', () => {
          off();
          this.send(msg);
        });
      }
    });
  }

  dispose(): void {
    if (this._state === 'disposed') return;
    this.teardown();
    this._state = 'disposed';
    this.iframe.remove();
  }

  // -------------------------------------------------------------------------

  private assertUsable(): void {
    if (this._state === 'crashed' || this._state === 'disposed') {
      throw new Error(`PreviewHandle is ${this._state}; create a new preview`);
    }
  }

  private emit<K extends keyof PreviewEventMap>(event: K, payload: PreviewEventMap[K]): void {
    for (const l of this.listeners[event] as Set<Listener<K>>) {
      try {
        l(payload);
      } catch (e) {
        console.error('PreviewHandle listener threw', e);
      }
    }
  }

  private send(msg: AppToShell): void {
    this.port?.postMessage(msg);
  }

  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (this._state === 'crashed' || this._state === 'disposed') return;
    const hello = checkHello(event, this.iframe.contentWindow, this.shellOrigin);
    if (!hello.ok) {
      // The window channel is shared with anything else on the page; only count messages
      // that look like a sandbox hello (spoof attempts), ignore unrelated traffic.
      const data: unknown = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { type?: unknown }).type === 'hello'
      ) {
        this._stats.rejectedMessages++;
      }
      return;
    }
    this.startHandshake();
  };

  private startHandshake(): void {
    const target = this.iframe.contentWindow;
    if (!target) return;
    this.port?.close();
    const channel = new MessageChannel();
    const nonce = createNonce();
    this.port = channel.port1;
    this.nonce = nonce;
    channel.port1.onmessage = this.onPortMessage;
    target.postMessage({ type: 'connect', protocol: PROTOCOL_VERSION, nonce }, this.shellOrigin, [
      channel.port2,
    ]);
  }

  private readonly onPortMessage = (event: MessageEvent): void => {
    if (this._state === 'crashed' || this._state === 'disposed') return;
    const parsed = parseShellToApp(event.data);
    if (!parsed.ok) {
      this._stats.rejectedMessages++;
      return;
    }
    const msg = parsed.value;
    if (msg.type === 'connected') {
      if (msg.nonce !== this.nonce) {
        this._stats.rejectedMessages++;
        return;
      }
      this.nonce = null; // single use
      this._state = 'connected';
      this._stats.handshakes++;
      this._stats.lastHeartbeatAt = performance.now();
      this.emit('connected', { handshakes: this._stats.handshakes });
      if (this.pendingLoad) {
        this.send(this.pendingLoad);
        this.pendingLoad = null;
      }
      return;
    }
    if (this._state !== 'connected') {
      this._stats.rejectedMessages++;
      return;
    }
    switch (msg.type) {
      case 'heartbeat':
        this._stats.lastHeartbeatAt = performance.now();
        return;
      case 'ready':
        this.emit('ready', { loadId: msg.loadId });
        return;
      case 'console':
        this.emit('console', msg);
        return;
      case 'runtime-error':
        this.emit('error', msg);
        return;
      case 'storage-reset': {
        const id = msg.requestId;
        const waiter = id === undefined ? undefined : this.storageWaiters.get(id);
        if (id !== undefined && waiter) {
          this.storageWaiters.delete(id);
          waiter(msg);
        }
        return;
      }
      case 'hello':
      case 'thumbnail':
        // `hello` only counts on the window channel; thumbnails are not implemented in M1.
        return;
    }
  };

  private readonly onVisibilityChange = (): void => {
    // Hidden tabs throttle timers (down to 1/min after 5 min in Chrome). Give the shell a
    // fresh grace period when we become visible instead of declaring a false crash.
    if (!this.doc.hidden && this._state === 'connected') {
      this._stats.lastHeartbeatAt = performance.now();
      this.send({ type: 'ping', t: Date.now() });
    }
  };

  private readonly tick = (): void => {
    if (this.doc.hidden) return;
    const now = performance.now();
    if (this._state === 'connecting') {
      if (now - this.attachedAt > this.handshakeTimeoutMs)
        this.crash('handshake-timeout', now - this.attachedAt);
      return;
    }
    if (this._state !== 'connected') return;
    const silent = now - this._stats.lastHeartbeatAt;
    if (silent > this.heartbeatTimeoutMs) {
      this.crash('heartbeat-timeout', silent);
      return;
    }
    // Probe early: a shell that is merely slow answers the ping with a heartbeat.
    if (silent > 2000 && now - this.lastPingAt > 1000) {
      this.lastPingAt = now;
      this.send({ type: 'ping', t: Date.now() });
    }
  };

  private crash(reason: CrashReason, silentForMs: number): void {
    this.teardown();
    this._state = 'crashed';
    // Removing the iframe discards its document; with site isolation the frozen renderer
    // process is released by the browser.
    this.iframe.remove();
    this.emit('crash', { reason, silentForMs });
  }

  private teardown(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.win.removeEventListener('message', this.onWindowMessage);
    this.doc.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.port?.close();
    this.port = null;
    for (const [id, waiter] of this.storageWaiters) {
      waiter({ type: 'storage-reset', requestId: id, ok: false, errors: ['preview closed'] });
    }
    this.storageWaiters.clear();
  }
}

/** Creates a preview iframe inside `container` and attaches a PreviewHandle to it. */
export function createPreview(container: HTMLElement, opts: PreviewOptions): PreviewHandle {
  const iframe = container.ownerDocument.createElement('iframe');
  container.appendChild(iframe);
  return new PreviewHandle(iframe, opts);
}
