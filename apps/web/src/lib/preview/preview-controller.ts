/**
 * Glue between the app and @br/runtime for a live preview of an imported site (docs/09
 * §9.3, §9.5): owns the preview iframe (PreviewHandle), loads site packs into it, and exposes
 * a snapshot for React (useSyncExternalStore). Used by the BUILD stage and `/try`.
 *
 * Plain TypeScript on purpose: the preview has its own lifecycle (iframe, handshake,
 * watchdog) that should not depend on React renders.
 *
 * - The iframe is attached at once, before anything is imported, so the shell's handshake is
 *   done by the time the first site arrives.
 * - `load(pack)` runs a site pack (the shell serves it from its site worker, in a fresh child
 *   frame per load). Importing again is just another `load`. The latest pack is kept for
 *   `restartPreview()`.
 * - Console output and runtime errors come from the site, so they are untrusted and can
 *   arrive in floods. The PreviewHandle rate-limits them and keeps a size-capped console;
 *   this controller copies that into the snapshot at most once per animation frame, so a
 *   flood costs at most one React render per frame.
 * - Watchdog crashes go to the optional `PreviewHealth` (T-031): one `preview_crash` event per
 *   crash, sent once the user restarted the preview or the controller went away, and the
 *   preview's watchdog stats for the battle's `sync_health`.
 */
import type { RuntimeErrorMessage } from '@br/protocol';
import {
  PreviewHandle,
  type ConsoleEntry,
  type PreviewCrash,
  type PreviewOptions,
} from '@br/runtime';
import type { PreviewHealth } from '../telemetry/sandbox-health';
import type { PreviewConfig } from './config';
import { FrameBatcher, type FrameScheduler } from './frame-batcher';

export type { ConsoleEntry } from '@br/runtime';

/** Runtime errors kept for the Problems list. */
export const MAX_RUNTIME_ERRORS = 20;

/**
 * - `connecting`: waiting for the shell handshake
 * - `idle`: connected, nothing loaded yet
 * - `loading`: a site was sent, waiting for `ready`
 * - `running`: the latest site is running
 * - `crashed`: watchdog fired (a frozen site) or the shell never answered
 */
export type PreviewStatus = 'connecting' | 'idle' | 'loading' | 'running' | 'crashed';

export interface PreviewSnapshot {
  preview: PreviewStatus;
  /**
   * Why the watchdog stopped the preview, whether the latest load had finished (`phase`), and
   * the silence it measured (app-awake time; `stalledMs` more on the wall clock).
   */
  crash: PreviewCrash | null;
  /** Runtime errors since the last load (newest last, at most MAX_RUNTIME_ERRORS). */
  runtimeErrors: readonly RuntimeErrorMessage[];
  /** The preview's retained console (rate-limited and size-capped by the PreviewHandle). */
  console: readonly ConsoleEntry[];
  /** Number of `ready` events so far (one per load that finished). */
  readyCount: number;
}

const INITIAL: PreviewSnapshot = {
  preview: 'connecting',
  crash: null,
  runtimeErrors: [],
  console: [],
  readyCount: 0,
};

/** The part of PreviewHandle the controller uses (tests pass a fake). */
export type PreviewLike = Pick<
  PreviewHandle,
  | 'state'
  | 'stats'
  | 'on'
  | 'load'
  | 'restart'
  | 'dispose'
  | 'consoleEntries'
  | 'clearConsole'
  | 'captureThumbnail'
>;

export interface PreviewControllerDeps {
  /** Defaults to a real PreviewHandle on the iframe. */
  attach?: (iframe: HTMLIFrameElement, opts: PreviewOptions) => PreviewLike;
  /** Defaults to requestAnimationFrame. */
  frames?: FrameScheduler;
  /** Watchdog telemetry (T-031): crashes, restarts and the preview's stall counters. */
  health?: PreviewHealth;
  /** The iframe's title for screen readers, in the page's language (T-050). */
  frameTitle?: string;
}

export class PreviewController {
  private readonly host: HTMLElement;
  private readonly config: PreviewConfig;
  private readonly attach: (iframe: HTMLIFrameElement, opts: PreviewOptions) => PreviewLike;
  private preview: PreviewLike | null = null;
  private previewOff: (() => void)[] = [];
  /** The latest pack loaded (what `restartPreview()` loads again). */
  private site: Uint8Array | null = null;
  private snapshot: PreviewSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  /** Errors received since the last frame flush. */
  private pendingErrors: RuntimeErrorMessage[] = [];
  private readonly batcher: FrameBatcher;
  private readonly health: PreviewHealth | null;
  private frameTitle: string;
  /** The preview's current iframe. */
  private frame: HTMLIFrameElement | null = null;

  constructor(host: HTMLElement, config: PreviewConfig, deps: PreviewControllerDeps = {}) {
    this.host = host;
    this.config = config;
    this.health = deps.health ?? null;
    this.frameTitle = deps.frameTitle ?? 'Preview of your site';
    this.attach = deps.attach ?? ((iframe, opts) => new PreviewHandle(iframe, opts));
    this.batcher = new FrameBatcher(this.flushOutput, deps.frames);
    this.createPreview();
  }

  // --- React store contract -------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): PreviewSnapshot => this.snapshot;

  /** A new title for the iframe (a language switch): the iframe itself stays as it is. */
  setFrameTitle(title: string): void {
    this.frameTitle = title;
    if (this.frame) this.frame.title = title;
  }

  static readonly initialSnapshot = INITIAL;

  // --- intents ----------------------------------------------------------------------------

  /**
   * Runs a site pack (a new import, or the restored one). A crashed preview is replaced by a
   * fresh one first. The pack is kept for `restartPreview()`.
   */
  load(site: Uint8Array): void {
    if (this.disposed) return;
    this.site = site;
    if (this.snapshot.preview === 'crashed' || !this.preview) this.freshPreview();
    this.loadInto(site);
  }

  /** The pack the preview runs (or last ran), or null before the first load. */
  current(): Uint8Array | null {
    return this.site;
  }

  /**
   * Restarts a crashed (or stuck) preview: a new iframe and a new shell, then the latest site
   * is loaded into it again.
   */
  restartPreview(): void {
    if (this.disposed) return;
    this.freshPreview();
    if (this.site) this.loadInto(this.site);
  }

  /**
   * A best-effort WebP thumbnail of what the preview shows (the shell renders it; docs/03
   * §3.7 fallback). Null when the preview is not running or the shell cannot make one.
   */
  async captureThumbnail(size: { width: number; height: number }): Promise<Blob | null> {
    const preview = this.preview;
    if (this.disposed || preview?.state !== 'connected') return null;
    const url = await preview.captureThumbnail(size);
    return url ? dataUrlToBlob(url) : null;
  }

  dismissErrors(): void {
    this.pendingErrors = [];
    this.update({ runtimeErrors: [] });
  }

  clearConsole(): void {
    this.preview?.clearConsole();
    this.update({ console: this.preview?.consoleEntries() ?? [] });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batcher.cancel();
    this.detachPreview();
    this.health?.close();
    this.listeners.clear();
  }

  // --- internals --------------------------------------------------------------------------

  private update(patch: Partial<PreviewSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  /**
   * A new preview document: the same handle restarted (new iframe element, new shell realm),
   * or a new handle if there is none. Errors and console of the old document are dropped.
   */
  private freshPreview(): void {
    const preview = this.preview;
    // A crashed preview brought back by the user (Restart, or a new import replacing it).
    if (this.snapshot.preview === 'crashed') this.health?.restarted();
    if (preview && preview.state !== 'disposed') {
      this.batcher.cancel();
      this.pendingErrors = [];
      preview.restart();
      preview.clearConsole();
      this.update({
        preview: 'connecting',
        crash: null,
        runtimeErrors: [],
        console: preview.consoleEntries(),
      });
    } else {
      this.createPreview();
    }
  }

  private loadInto(site: Uint8Array): void {
    const preview = this.preview;
    if (!preview || preview.state === 'crashed' || preview.state === 'disposed') return;
    try {
      preview.load({ site });
    } catch (e) {
      // A pack over the limit (RangeError): the import refuses those, so only a bug gets here.
      this.update({
        runtimeErrors: [
          {
            type: 'runtime-error',
            kind: 'module-load',
            message: `The site could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
      });
      return;
    }
    preview.clearConsole();
    this.batcher.cancel();
    this.pendingErrors = [];
    this.update({ preview: 'loading', runtimeErrors: [], console: preview.consoleEntries() });
  }

  private detachPreview(): void {
    for (const off of this.previewOff) off();
    this.previewOff = [];
    this.preview?.dispose();
    this.preview = null;
  }

  private createPreview(): void {
    this.detachPreview();
    this.batcher.cancel();
    this.pendingErrors = [];
    const iframe = this.host.ownerDocument.createElement('iframe');
    iframe.title = this.frameTitle;
    this.frame = iframe;
    iframe.dataset['testid'] = 'preview-frame';
    iframe.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    this.host.replaceChildren(iframe);
    const preview = this.attach(iframe, { shellUrl: this.config.shellUrl });
    this.preview = preview;
    this.health?.follow(preview);
    this.update({ preview: 'connecting', crash: null, runtimeErrors: [], console: [] });
    this.previewOff = [
      preview.on('connected', () => {
        if (this.snapshot.preview === 'connecting' && this.site === null) {
          this.update({ preview: 'idle' });
        }
      }),
      preview.on('ready', () => {
        this.update({ preview: 'running', readyCount: this.snapshot.readyCount + 1 });
      }),
      // Console, errors and drop notices: batched, one snapshot update per frame.
      preview.on('console', () => {
        this.batcher.schedule();
      }),
      preview.on('error', (m) => {
        this.pendingErrors.push(m);
        if (this.pendingErrors.length > MAX_RUNTIME_ERRORS) {
          this.pendingErrors = this.pendingErrors.slice(-MAX_RUNTIME_ERRORS);
        }
        this.batcher.schedule();
      }),
      preview.on('dropped', () => {
        this.batcher.schedule();
      }),
      preview.on('crash', (c) => {
        this.update({ preview: 'crashed', crash: c });
        this.health?.crashed(c);
      }),
    ];
  }

  /** Copies the preview's console and the queued errors into the snapshot (one update). */
  private readonly flushOutput = (): void => {
    const preview = this.preview;
    if (this.disposed || !preview) return;
    const console = preview.consoleEntries();
    const errors = this.pendingErrors;
    this.pendingErrors = [];
    if (console === this.snapshot.console && errors.length === 0) return;
    this.update({
      console,
      ...(errors.length > 0
        ? { runtimeErrors: [...this.snapshot.runtimeErrors, ...errors].slice(-MAX_RUNTIME_ERRORS) }
        : {}),
    });
  };
}

/** Decodes a base64 `data:` URL (the shell's WebP thumbnail) into a Blob. */
export function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m?.[1] || m[2] === undefined) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch {
    return null;
  }
}
