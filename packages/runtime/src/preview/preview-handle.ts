/**
 * PreviewHandle: the app-side owner of one sandbox preview slot (docs/03 §3.5).
 *
 * - Sets the sandbox/allow attributes for the run mode on the iframe before it navigates
 *   (`PREVIEW_SANDBOX_BY_MODE`, `PREVIEW_ALLOW_BY_MODE`). Flags only apply on navigation, so
 *   a mode switch, `resetStorage()` and `restart()` replace the iframe element with a new one
 *   (same id/class/style/data attributes) and load the shell into it. A new element also
 *   means a new shell realm: nothing a build left in the old shell's realm survives.
 * - Handshake: accepts `hello` only when `event.origin` is the shell origin AND
 *   `event.source` is the current iframe's `contentWindow`, and only once per navigation that
 *   the handle started itself. Any later `hello` is ignored and counted (`ignoredHellos`), so
 *   the port is never replaced behind the app's back. Then it transfers a MessageChannel port
 *   with a random nonce and waits for `connected {nonce}` on that port.
 * - After the handshake it listens to the port only. Every inbound message is validated with
 *   @br/protocol (invalid ones are dropped and counted) and then budgeted: per-type rate
 *   limits for `console`, `runtime-error` and `ready`, plus a cap on retained console text.
 *   Excess messages are dropped and counted, with at most one "N messages dropped" notice
 *   per second.
 * - Watchdog: pings the shell every second; the shell answers `pong {seq}` from a
 *   main-thread task. No pong for `heartbeatTimeoutMs` (5 s) -> `crash` event and the iframe
 *   is taken out of the DOM.
 *
 * Trust model: everything the shell sends is untrusted display data. `ready`, `pong`,
 * `heartbeat` and `storage-reset` are hints; the app never takes an action that matters for
 * the game because of one (threat model §3.9, README "Trust model").
 */
import {
  PROTOCOL_VERSION,
  createNonce,
  parseShellToApp,
  type AppToShell,
  type ConsoleMessage,
  type Hello,
  type ImportMap,
  type LoadMessage,
  type ParseResult,
  type RunMode,
  type RuntimeErrorMessage,
  type StorageResetMessage,
} from '@br/protocol';
import {
  ConsoleLog,
  DEFAULT_PREVIEW_BUDGETS,
  RateWindow,
  type ConsoleEntry,
  type PreviewBudgets,
} from './budget';

/**
 * iframe `sandbox` per run mode.
 * - `live` (the player's own build while building): popups and modals allowed, so
 *   `window.open`, `target=_blank` links and `alert()` debugging work.
 * - `reveal` / `capture` (someone else's build, or the server renderer): no `allow-popups`,
 *   so a popup can't outlive the build or phish outside the app chrome, and no
 *   `allow-modals`, so `alert`/`confirm`/`prompt`/`print` can't block the viewer's tab or
 *   stall the headless capture renderer (they return immediately, as if dismissed).
 * Never: `allow-top-navigation*`, `allow-popups-to-escape-sandbox`, `allow-downloads`.
 */
export const PREVIEW_SANDBOX_BY_MODE: Readonly<Record<RunMode, string>> = {
  live: 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups',
  reveal: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
  capture: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
};

/** iframe `allow` per run mode: `clipboard-write` only while building your own app. */
export const PREVIEW_ALLOW_BY_MODE: Readonly<Record<RunMode, string>> = {
  live: 'autoplay; fullscreen; gamepad; clipboard-write',
  reveal: 'autoplay; fullscreen; gamepad',
  capture: 'autoplay; fullscreen; gamepad',
};

/** The `live` attributes (the default mode). */
export const PREVIEW_SANDBOX = PREVIEW_SANDBOX_BY_MODE.live;
export const PREVIEW_ALLOW = PREVIEW_ALLOW_BY_MODE.live;

/** Attributes the handle owns on the iframe; everything else is copied to a replacement. */
const OWNED_ATTRIBUTES = new Set([
  'src',
  'srcdoc',
  'name',
  'sandbox',
  'allow',
  'allowfullscreen',
  'referrerpolicy',
  'loading',
]);

/** Sets the mode's `sandbox`/`allow` (plus referrer policy and eager loading) on `iframe`. */
export function applyPreviewAttributes(iframe: HTMLIFrameElement, mode: RunMode): void {
  iframe.setAttribute('sandbox', PREVIEW_SANDBOX_BY_MODE[mode]);
  iframe.setAttribute('allow', PREVIEW_ALLOW_BY_MODE[mode]);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'eager');
}

export interface PreviewOptions {
  /** Shell URL, e.g. `https://{build_id}.buildroulette-usercontent.net/v1/`. */
  shellUrl: string;
  /** Expected origin of the shell. Defaults to the origin of `shellUrl`. */
  shellOrigin?: string;
  /** Run mode of the first iframe. Default `live`. */
  mode?: RunMode;
  /** No `pong` for this long -> crash. Default 5000 ms. */
  heartbeatTimeoutMs?: number;
  /** Ping interval while connected. Default 1000 ms. */
  pingIntervalMs?: number;
  /** No completed handshake for this long after a navigation -> crash. Default 10000 ms. */
  handshakeTimeoutMs?: number;
  /** Watchdog tick. Default 250 ms. */
  watchdogIntervalMs?: number;
  /** Overrides for the app-side message budgets (`DEFAULT_PREVIEW_BUDGETS`). */
  budgets?: Partial<PreviewBudgets>;
  /** Clock in ms (tests). Default `performance.now()`. */
  now?: () => number;
}

export interface PreviewBuild {
  js: string;
  css: string;
  importMap: ImportMap;
}

/** `heartbeat-timeout`: no `pong` within `heartbeatTimeoutMs` (name kept for compatibility). */
export type CrashReason = 'heartbeat-timeout' | 'handshake-timeout';

/** Why the handle replaced its iframe element. */
export type FrameReason = 'mode-change' | 'reset' | 'restart';

/** Message types with an app-side rate budget. */
export type BudgetedType = 'console' | 'error' | 'ready';

export interface PreviewEventMap {
  /** Handshake completed (once per iframe navigation the handle started). */
  connected: { handshakes: number };
  /** The handle replaced its iframe element (new element, new shell realm). */
  frame: { iframe: HTMLIFrameElement; mode: RunMode; reason: FrameReason };
  /** Hint only: the latest load finished evaluating. */
  ready: { loadId: number };
  /** Untrusted display data, within budget. */
  console: ConsoleMessage;
  /** Untrusted display data, within budget. */
  error: RuntimeErrorMessage;
  /** At most once per second: messages dropped by the budgets since the last notice. */
  dropped: { count: number; byType: Record<BudgetedType, number> };
  crash: { reason: CrashReason; silentForMs: number };
}

export type PreviewState = 'connecting' | 'connected' | 'crashed' | 'disposed';

export interface PreviewStats {
  handshakes: number;
  /** Messages dropped by the origin/source guard, by schema validation or as unexpected. */
  rejectedMessages: number;
  /** Valid `hello`s from our iframe that arrived after its one handshake (ignored). */
  ignoredHellos: number;
  /** Messages dropped by the app-side rate budgets, per type. */
  droppedMessages: Record<BudgetedType, number>;
  /** Console entries evicted by the retained-console caps. */
  evictedConsoleEntries: number;
  /** Iframe elements used so far (1 + replacements). */
  frames: number;
  pingsSent: number;
  pongs: number;
  /** Clock time of the last accepted `pong` (or of the handshake). */
  lastPongAt: number;
  /** Round trip of the last accepted ping, in ms. */
  lastRttMs: number | null;
  /** `heartbeat` messages received (informational only). */
  heartbeats: number;
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

interface StorageRequest {
  msg: AppToShell;
  /** Sent to the current shell (re-sent to a replacement shell otherwise). */
  sent: boolean;
  settle: (m: StorageResetMessage) => void;
}

/** Most pings kept waiting for a pong. */
const MAX_OUTSTANDING_PINGS = 16;

export class PreviewHandle {
  private _iframe: HTMLIFrameElement;
  private _mode: RunMode;
  private readonly shellUrl: string;
  private readonly shellOrigin: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly now: () => number;
  private readonly win: Window;
  private readonly doc: Document;
  /** Stands in for the iframe after a crash, so `restart()` knows where to put the new one. */
  private placeholder: Comment | null = null;
  private port: MessagePort | null = null;
  private nonce: string | null = null;
  /** Armed by every navigation the handle starts; the first valid `hello` disarms it. */
  private awaitingHello = false;
  private navigatedAt = 0;
  private _state: PreviewState = 'connecting';
  private readonly listeners: { [K in keyof PreviewEventMap]: Set<Listener<K>> } = {
    connected: new Set(),
    frame: new Set(),
    ready: new Set(),
    console: new Set(),
    error: new Set(),
    dropped: new Set(),
    crash: new Set(),
  };
  private readonly _stats: PreviewStats = {
    handshakes: 0,
    rejectedMessages: 0,
    ignoredHellos: 0,
    droppedMessages: { console: 0, error: 0, ready: 0 },
    evictedConsoleEntries: 0,
    frames: 1,
    pingsSent: 0,
    pongs: 0,
    lastPongAt: 0,
    lastRttMs: null,
    heartbeats: 0,
    lastHeartbeatAt: 0,
  };
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private listening = false;
  private pendingLoad: LoadMessage | null = null;
  private latestLoadId = 0;
  private readyAccepted = false;
  private nextLoadId = 1;
  private nextRequestId = 1;
  private readonly storageRequests = new Map<number, StorageRequest>();
  private nextPingSeq = 1;
  private lastPingAt = 0;
  private readonly outstandingPings = new Map<number, number>();
  private readonly rates: Record<BudgetedType, RateWindow>;
  private readonly consoleLog: ConsoleLog;
  private readonly droppedSinceNotice: Record<BudgetedType, number> = {
    console: 0,
    error: 0,
    ready: 0,
  };
  private dropTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(iframe: HTMLIFrameElement, opts: PreviewOptions) {
    this._iframe = iframe;
    this._mode = opts.mode ?? 'live';
    this.shellUrl = opts.shellUrl;
    this.shellOrigin = opts.shellOrigin ?? new URL(opts.shellUrl).origin;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 5000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 1000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10000;
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? 250;
    this.now = opts.now ?? (() => performance.now());
    const budgets = { ...DEFAULT_PREVIEW_BUDGETS, ...opts.budgets };
    this.rates = {
      console: new RateWindow(budgets.consolePerSecond),
      error: new RateWindow(budgets.errorsPerSecond),
      ready: new RateWindow(budgets.readyPerSecond),
    };
    this.consoleLog = new ConsoleLog(budgets.consoleMaxChars, budgets.consoleMaxEntries);
    const doc = iframe.ownerDocument;
    const win = doc.defaultView;
    if (!win) throw new Error('PreviewHandle: iframe must belong to a document with a window');
    this.doc = doc;
    this.win = win;

    applyPreviewAttributes(iframe, this._mode);
    if (!iframe.title) iframe.title = 'User build preview';

    // Listen before navigating so the first `hello` cannot be missed.
    this.listen();
    this.navigate(iframe);
  }

  get state(): PreviewState {
    return this._state;
  }

  /** The current iframe element (replaced on mode switch, `resetStorage()` and `restart()`). */
  get iframe(): HTMLIFrameElement {
    return this._iframe;
  }

  get mode(): RunMode {
    return this._mode;
  }

  get stats(): Readonly<PreviewStats> {
    return {
      ...this._stats,
      droppedMessages: { ...this._stats.droppedMessages },
      evictedConsoleEntries: this.consoleLog.evicted,
    };
  }

  on<K extends keyof PreviewEventMap>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners[event] as Set<Listener<K>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * The retained console (console messages, runtime errors as `Uncaught …` and drop notices),
   * capped by `budgets.consoleMaxChars` / `consoleMaxEntries`. Same array until it changes.
   */
  consoleEntries(): readonly ConsoleEntry[] {
    return this.consoleLog.list();
  }

  clearConsole(): void {
    this.consoleLog.clear();
  }

  /**
   * Runs a build in a fresh document. Returns the loadId echoed by the `ready` event.
   * A `mode` different from the current one replaces the iframe first (new sandbox flags).
   */
  load(build: PreviewBuild, mode: RunMode = this._mode): number {
    this.assertUsable();
    const loadId = this.nextLoadId++;
    const msg: LoadMessage = {
      type: 'load',
      loadId,
      js: build.js,
      css: build.css,
      importMap: build.importMap,
      mode,
    };
    this.latestLoadId = loadId;
    this.readyAccepted = false;
    if (mode !== this._mode) {
      this.pendingLoad = msg;
      this.replaceFrame(mode, 'mode-change');
    } else if (this._state === 'connected') this.send(msg);
    else this.pendingLoad = msg; // only the latest load matters
    return loadId;
  }

  /**
   * Wipes the sandbox origin's storage in a clean slate: the iframe is replaced first (so
   * nothing the build left running, in its frame or in the shell's realm, survives), then the
   * fresh shell gets `reset-storage` before anything else. Resolves with the shell's ack,
   * which is a hint only (README "Trust model"). The preview is empty afterwards; call
   * `load()` to run a build again.
   */
  resetStorage(timeoutMs = 10000): Promise<StorageResetMessage> {
    this.assertUsable();
    // Replace first (throws if the iframe left the document); the handshake is async, so the
    // request below is registered before the new shell can connect.
    this.replaceFrame(this._mode, 'reset');
    const requestId = this.nextRequestId++;
    return new Promise<StorageResetMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.storageRequests.delete(requestId);
        reject(new Error('reset-storage timed out'));
      }, timeoutMs);
      this.storageRequests.set(requestId, {
        msg: { type: 'reset-storage', requestId },
        sent: false,
        settle: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /**
   * Replaces the iframe with a new one and loads the shell into it (a new realm, a new
   * handshake). Also recovers a crashed handle. Call `load()` afterwards.
   */
  restart(mode: RunMode = this._mode): void {
    if (this._state === 'disposed') throw new Error('PreviewHandle is disposed');
    if (!this.listening) this.listen();
    this.replaceFrame(mode, 'restart');
  }

  dispose(): void {
    if (this._state === 'disposed') return;
    this.teardown();
    this._state = 'disposed';
    this._iframe.remove();
    this.placeholder?.remove();
    this.placeholder = null;
  }

  // -------------------------------------------------------------------------

  private assertUsable(): void {
    if (this._state === 'crashed' || this._state === 'disposed') {
      throw new Error(`PreviewHandle is ${this._state}; call restart() or create a new preview`);
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

  private listen(): void {
    this.win.addEventListener('message', this.onWindowMessage);
    this.doc.addEventListener('visibilitychange', this.onVisibilityChange);
    this.watchdog = setInterval(this.tick, this.watchdogIntervalMs);
    this.listening = true;
  }

  /** Starts a navigation of `frame` to the shell; arms the single expected `hello`. */
  private navigate(frame: HTMLIFrameElement): void {
    this._state = 'connecting';
    this.awaitingHello = true;
    this.nonce = null;
    this.navigatedAt = this.now();
    frame.src = this.shellUrl;
  }

  /** Swaps in a new iframe element with the attributes for `mode` and navigates it. */
  private replaceFrame(mode: RunMode, reason: FrameReason): void {
    this.closePort();
    const old = this._iframe;
    const anchor: ChildNode | null = old.parentNode
      ? old
      : this.placeholder?.parentNode
        ? this.placeholder
        : null;
    if (!anchor) throw new Error('PreviewHandle: the preview iframe is no longer in the document');
    const next = this.doc.createElement('iframe');
    for (const { name, value } of Array.from(old.attributes)) {
      if (!OWNED_ATTRIBUTES.has(name)) next.setAttribute(name, value);
    }
    // Flags apply when the frame navigates: set them before it is inserted and navigated.
    applyPreviewAttributes(next, mode);
    anchor.replaceWith(next);
    old.remove();
    this.placeholder = null;
    this._iframe = next;
    this._mode = mode;
    this._stats.frames++;
    // Storage requests already sent went to the old shell: send them to the new one.
    for (const r of this.storageRequests.values()) r.sent = false;
    this.navigate(next);
    this.emit('frame', { iframe: next, mode, reason });
  }

  private closePort(): void {
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
    }
    this.port = null;
    this.outstandingPings.clear();
  }

  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (!this.listening) return;
    const hello = checkHello(event, this._iframe.contentWindow, this.shellOrigin);
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
    if (!this.awaitingHello) {
      // One handshake per navigation we started. A shell that re-announces itself (its retry
      // timer, a reload the build triggered, or code in the shell's realm) is ignored; the
      // watchdog notices if the real shell went away.
      this._stats.ignoredHellos++;
      return;
    }
    this.awaitingHello = false;
    this.startHandshake();
  };

  private startHandshake(): void {
    const target = this._iframe.contentWindow;
    if (!target) return;
    this.closePort();
    const channel = new MessageChannel();
    const nonce = createNonce();
    const port = channel.port1;
    this.port = port;
    this.nonce = nonce;
    port.onmessage = (event: MessageEvent) => {
      if (port === this.port) this.onPortMessage(event);
    };
    target.postMessage({ type: 'connect', protocol: PROTOCOL_VERSION, nonce }, this.shellOrigin, [
      channel.port2,
    ]);
  }

  private onPortMessage(event: MessageEvent): void {
    if (this._state === 'crashed' || this._state === 'disposed') return;
    const parsed = parseShellToApp(event.data);
    if (!parsed.ok) {
      this._stats.rejectedMessages++;
      return;
    }
    const msg = parsed.value;
    if (msg.type === 'connected') {
      if (this.nonce === null || msg.nonce !== this.nonce) {
        this._stats.rejectedMessages++;
        return;
      }
      this.onConnected();
      return;
    }
    if (this._state !== 'connected') {
      this._stats.rejectedMessages++;
      return;
    }
    const now = this.now();
    switch (msg.type) {
      case 'pong': {
        const sentAt = this.outstandingPings.get(msg.seq);
        if (sentAt === undefined) {
          this._stats.rejectedMessages++;
          return;
        }
        // This pong also settles every older ping.
        for (const seq of this.outstandingPings.keys())
          if (seq <= msg.seq) this.outstandingPings.delete(seq);
        this._stats.pongs++;
        this._stats.lastPongAt = now;
        this._stats.lastRttMs = now - sentAt;
        return;
      }
      case 'heartbeat':
        // Informational only: anything holding the port can send it.
        this._stats.heartbeats++;
        this._stats.lastHeartbeatAt = now;
        return;
      case 'ready':
        if (!this.rates.ready.take(now)) {
          this.drop('ready');
          return;
        }
        if (msg.loadId !== this.latestLoadId || this.readyAccepted) {
          this._stats.rejectedMessages++;
          return;
        }
        this.readyAccepted = true;
        this.emit('ready', { loadId: msg.loadId });
        return;
      case 'console':
        if (!this.rates.console.take(now)) {
          this.drop('console');
          return;
        }
        this.consoleLog.add(msg.level, msg.args.join(' '), 'sandbox');
        this.emit('console', msg);
        return;
      case 'runtime-error':
        if (!this.rates.error.take(now)) {
          this.drop('error');
          return;
        }
        this.consoleLog.add('error', `Uncaught ${msg.message}`, 'sandbox');
        this.emit('error', msg);
        return;
      case 'storage-reset': {
        const id = msg.requestId;
        const request = id === undefined ? undefined : this.storageRequests.get(id);
        if (id === undefined || !request?.sent) {
          this._stats.rejectedMessages++;
          return;
        }
        this.storageRequests.delete(id);
        request.settle(msg);
        return;
      }
      case 'hello':
        // `hello` only counts on the window channel.
        this._stats.rejectedMessages++;
        return;
      case 'thumbnail':
        // Not implemented in M1.
        return;
    }
  }

  private onConnected(): void {
    this.nonce = null; // single use
    this._state = 'connected';
    this._stats.handshakes++;
    this._stats.lastPongAt = this.now();
    // Storage resets first: the shell runs queued messages in order and finishes a reset
    // before it starts the next load.
    for (const r of [...this.storageRequests.values()]) {
      if (!r.sent) {
        r.sent = true;
        this.send(r.msg);
      }
    }
    if (this.pendingLoad) {
      this.send(this.pendingLoad);
      this.pendingLoad = null;
    }
    this.sendPing();
    this.emit('connected', { handshakes: this._stats.handshakes });
  }

  private sendPing(): void {
    const now = this.now();
    const seq = this.nextPingSeq++;
    this.outstandingPings.set(seq, now);
    if (this.outstandingPings.size > MAX_OUTSTANDING_PINGS) {
      const oldest = this.outstandingPings.keys().next().value;
      if (oldest !== undefined) this.outstandingPings.delete(oldest);
    }
    this.lastPingAt = now;
    this._stats.pingsSent++;
    this.send({ type: 'ping', seq, t: Date.now() });
  }

  private drop(type: BudgetedType): void {
    this._stats.droppedMessages[type]++;
    this.droppedSinceNotice[type]++;
    this.dropTimer ??= setTimeout(this.flushDropNotice, 1000);
  }

  private readonly flushDropNotice = (): void => {
    this.dropTimer = null;
    const byType = { ...this.droppedSinceNotice };
    const count = byType.console + byType.error + byType.ready;
    this.droppedSinceNotice.console = 0;
    this.droppedSinceNotice.error = 0;
    this.droppedSinceNotice.ready = 0;
    if (count === 0 || this._state === 'disposed') return;
    this.consoleLog.add(
      'warn',
      `[preview] ${String(count)} message${count === 1 ? '' : 's'} from the build dropped (rate limit)`,
      'preview',
    );
    this.emit('dropped', { count, byType });
  };

  private readonly onVisibilityChange = (): void => {
    if (this.doc.hidden) return;
    // Hidden tabs throttle timers (down to 1/min after 5 min in Chrome). Give the shell a
    // fresh grace period when we become visible instead of declaring a false crash.
    const now = this.now();
    if (this._state === 'connecting') this.navigatedAt = now;
    if (this._state === 'connected') {
      this._stats.lastPongAt = now;
      this.sendPing();
    }
  };

  private readonly tick = (): void => {
    if (this.doc.hidden) return;
    const now = this.now();
    if (this._state === 'connecting') {
      if (now - this.navigatedAt > this.handshakeTimeoutMs)
        this.crash('handshake-timeout', now - this.navigatedAt);
      return;
    }
    if (this._state !== 'connected') return;
    const silent = now - this._stats.lastPongAt;
    if (silent > this.heartbeatTimeoutMs) {
      this.crash('heartbeat-timeout', silent);
      return;
    }
    if (now - this.lastPingAt >= this.pingIntervalMs) this.sendPing();
  };

  private crash(reason: CrashReason, silentForMs: number): void {
    this.teardown();
    this._state = 'crashed';
    // Taking the iframe out of the document discards its documents; with site isolation the
    // frozen renderer process is released by the browser. A comment node keeps its place
    // for `restart()`.
    if (this._iframe.parentNode) {
      const placeholder = this.doc.createComment('crashed preview');
      this._iframe.replaceWith(placeholder);
      this.placeholder = placeholder;
    }
    this.emit('crash', { reason, silentForMs });
  }

  private teardown(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.dropTimer !== null) clearTimeout(this.dropTimer);
    this.dropTimer = null;
    this.win.removeEventListener('message', this.onWindowMessage);
    this.doc.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.listening = false;
    this.awaitingHello = false;
    this.closePort();
    this.pendingLoad = null;
    for (const [id, request] of this.storageRequests) {
      request.settle({
        type: 'storage-reset',
        requestId: id,
        ok: false,
        errors: ['preview closed'],
      });
    }
    this.storageRequests.clear();
  }
}

/** Creates a preview iframe inside `container` and attaches a PreviewHandle to it. */
export function createPreview(container: HTMLElement, opts: PreviewOptions): PreviewHandle {
  const iframe = container.ownerDocument.createElement('iframe');
  container.appendChild(iframe);
  return new PreviewHandle(iframe, opts);
}
