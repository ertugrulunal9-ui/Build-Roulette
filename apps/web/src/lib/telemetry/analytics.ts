/**
 * Product analytics (T-030): a small typed event module that posts to PostHog's capture API
 * (`POST {host}/batch/`). Off unless `NEXT_PUBLIC_POSTHOG_KEY` is set, and off for a visitor
 * who sends Do Not Track or Global Privacy Control.
 *
 * Why not posthog-js: it is a large bundle whose defaults (autocapture of clicks and inputs,
 * session replay, the toolbar, surveys, a persistent cookie or localStorage id, `$current_url`
 * with its query string, the referrer) would all have to be turned off. The capture API is a
 * documented public endpoint, so this sends exactly the events below and nothing else:
 *
 * - **No autocapture, no replay, no inputs:** only `track()` calls, with typed properties
 *   (ids are random UUIDs, everything else enums and numbers), checked again at runtime.
 * - **Pseudonymous:** `distinct_id` is the hashed anonymous user id (context.ts);
 *   `$process_person_profile: false` (no person profiles), `$geoip_disable: true`; no
 *   cookies, nothing stored in the browser. The page is sent as a route template
 *   (`/r/[code]`), never as a URL.
 * - Events wait in memory until the user id is known, then go out in batches: 2 s after the
 *   first one, and at once when the page is hidden or unloaded (`keepalive`).
 */
import type { ReportReason } from '@br/game';
import { routeTemplate } from '@br/telemetry/scrub';
import { telemetryConfig, type TelemetryConfig } from './config';
import { currentUserHash, userHashReady } from './context';
import { privacySignal } from './privacy';

export type BattleMode = 'solo' | 'multiplayer';

/** Why a battle's sync-health report was sent. */
export type SyncHealthEnd = 'destroyed' | 'abandoned' | 'left' | 'switched' | 'closed';

/**
 * This tab's preview watchdog over one battle (T-031, sandbox-health.ts), summed over the
 * battle's previews (BUILD, the REVEAL spotlights, the last look).
 */
export interface PreviewHealthProps {
  /** Watchdog crashes (each one is also a `preview_crash` event). */
  preview_crashes: number;
  /** Crashed previews the user restarted. */
  preview_restarts: number;
  /** App-side stalls of 1 s or more the watchdog saw: this tab itself got no CPU. */
  preview_stalls: number;
  /** Their total length. */
  preview_stall_ms: number;
  /**
   * Silences the pre-T-031 watchdog (wall-clock time) would have reported as a crash, and
   * which then ended with a pong: false crashes avoided.
   */
  preview_spared: number;
}

/** The sync engine's counters over one battle, from this client (sync.ts). */
export interface SyncHealthProps extends PreviewHealthProps {
  battle_id: string;
  room_id: string;
  ended: SyncHealthEnd;
  /** How long this client followed the battle. */
  duration_s: number;
  /** Heartbeats that found the battle ahead of the snapshot: broadcasts that never came. */
  missed: number;
  /** Snapshot fetches (room and battle). */
  refetches: number;
  /** Events that arrived after a gap in the versions. */
  gaps: number;
  /** Time the connection read "degraded" (room topic down or offline). */
  degraded_ms: number;
  /** Re-subscribes after a topic was closed by the server. */
  rejoins: number;
  /** Topics closed by the server (CLOSED: e.g. a Realtime rate limit). */
  server_closed: number;
  /** CHANNEL_ERROR and TIMED_OUT statuses (supabase-js retries those itself). */
  channel_errors: number;
}

/**
 * One preview watchdog crash (T-031, sandbox-health.ts), sent once its outcome is known.
 * Silences are in app-awake time (the watchdog's own measure); `stalled_ms` is the time the
 * tab's own timers did not run during the silence (starvation evidence, not counted).
 */
export interface PreviewCrashProps {
  /** The battle the preview belongs to; null outside a battle (the playground). */
  battle_id: string | null;
  /** `live`: the player's own build while building; `reveal`: a REVEAL spotlight or the last look. */
  mode: 'live' | 'reveal';
  reason: 'heartbeat_timeout' | 'handshake_timeout';
  /** What the preview was doing (`loading`: its latest build had not finished starting). */
  phase: 'connecting' | 'loading' | 'running';
  /** App-awake silence when the watchdog fired. */
  silent_ms: number;
  /** Wall-clock silence: `silent_ms + stalled_ms`. */
  wall_silent_ms: number;
  stalled_ms: number;
  /** The longest single app-side stall within the silence. */
  longest_stall_ms: number;
  /** The user restarted the preview afterwards. */
  restarted: boolean;
}

/**
 * A bundler worker start that stalled or failed, or that worked only on the automatic retry
 * after a stall (T-039, sandbox-health.ts). One per worker start; a clean first start sends
 * nothing.
 */
export interface BundlerStartProps {
  /** The battle being built; null outside a battle (the playground). */
  battle_id: string | null;
  /** `stalled`: no progress for 15 s (retried once); `error`: a load or init error. */
  outcome: 'ready' | 'stalled' | 'error';
  /** How far it got: the worker script never ran, esbuild.wasm was downloading, or compiling. */
  stage: 'worker' | 'download' | 'compile';
  /** 1, or 2 for the automatic retry after a stall. */
  attempt: number;
  /** From this worker's start to the outcome. */
  elapsed_ms: number;
  /** Bytes of esbuild.wasm received. */
  loaded_bytes: number;
}

export interface AnalyticsEvents {
  room_created: { room_id: string };
  room_joined: { room_id: string; role: 'player' | 'spectator' };
  battle_started: {
    battle_id: string;
    mode: BattleMode;
    room_id: string | null;
    rematch: boolean;
  };
  rematch: { room_id: string; battle_id: string; previous_battle_id: string };
  build_shipped: {
    battle_id: string;
    mode: BattleMode;
    how: 'manual' | 'auto';
    completion_ms: number | null;
  };
  vote_cast: { battle_id: string; category: string; revote: boolean };
  battle_completed: {
    battle_id: string;
    mode: BattleMode;
    role: 'player' | 'spectator' | 'viewer';
    /** RESULTS reached, or the battle was abandoned. */
    outcome: 'results' | 'abandoned';
    /** This client's own build. */
    build: 'manual' | 'auto' | 'dnf' | 'disqualified' | 'none';
    rank: number | null;
    builds: number;
  };
  report_filed: { reason: ReportReason; surface: 'results' | 'reveal' };
  sync_health: SyncHealthProps;
  preview_crash: PreviewCrashProps;
  bundler_start: BundlerStartProps;
}

export type AnalyticsEventName = keyof AnalyticsEvents;

type PropValue = string | number | boolean | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An enum value: short, lowercase words. */
const TOKEN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The properties as they may be sent: ids must be UUIDs (`*_id`), other strings short enum
 * tokens, numbers finite. Anything else is dropped (a guard behind the types).
 */
export function sanitizeProps(props: object): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(props) as [string, unknown][]) {
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = Math.round(value * 1000) / 1000;
    } else if (typeof value === 'string') {
      if (key.endsWith('_id') ? UUID.test(value) : TOKEN.test(value)) out[key] = value;
    }
  }
  return out;
}

interface Queued {
  event: AnalyticsEventName;
  properties: Record<string, PropValue>;
  timestamp: string;
}

export interface AnalyticsDeps {
  config?: TelemetryConfig;
  fetch?: typeof fetch;
  /** Default: Do Not Track / Global Privacy Control of this browser. */
  privacy?: () => boolean;
  /** The hashed user id now, and when it becomes known. */
  user?: { current(): string | null; ready(timeoutMs: number): Promise<string | null> };
  /** The page's path (default `location.pathname`). */
  path?: () => string;
  flushDelayMs?: number;
  now?: () => number;
}

/** Most events kept while the user id is unknown. */
export const MAX_QUEUE = 100;

export class AnalyticsClient {
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;
  private hiding = false;
  private readonly config: TelemetryConfig;

  constructor(private readonly deps: AnalyticsDeps = {}) {
    this.config = deps.config ?? telemetryConfig;
  }

  /** True when events would be sent from this page. */
  enabled(): boolean {
    if (this.config.posthogKey === null) return false;
    return !(this.deps.privacy ?? privacySignal)();
  }

  track<N extends AnalyticsEventName>(name: N, props: AnalyticsEvents[N]): void {
    if (!this.enabled()) return;
    const path = (this.deps.path ?? (() => window.location.pathname))();
    this.queue.push({
      event: name,
      properties: { ...sanitizeProps(props), path: routeTemplate(path) },
      timestamp: new Date((this.deps.now ?? Date.now)()).toISOString(),
    });
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.listen();
    if (this.hiding) void this.flush({ keepalive: true });
    else this.schedule();
  }

  /** Sends what is queued (once the user id is known). */
  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0 || this.config.posthogKey === null) return;
    const user = this.deps.user ?? { current: currentUserHash, ready: userHashReady };
    // Leaving the page: no time to wait for the hash.
    const id = opts.keepalive ? user.current() : (user.current() ?? (await user.ready(10_000)));
    if (id === null) return; // kept until the id is known (or the page goes)
    const batch = this.queue.splice(0).map((q) => ({
      event: q.event,
      distinct_id: id,
      timestamp: q.timestamp,
      properties: {
        ...q.properties,
        distinct_id: id,
        $process_person_profile: false,
        $geoip_disable: true,
        $lib: 'build-roulette-web',
        $lib_version: this.config.release,
        release: this.config.release,
      },
    }));
    const doFetch = this.deps.fetch ?? fetch.bind(globalThis);
    try {
      await doFetch(`${this.config.posthogHost}/batch/`, {
        method: 'POST',
        // text/plain keeps it a "simple" request (no CORS preflight), which `keepalive`
        // needs; the capture API parses the JSON body either way.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ api_key: this.config.posthogKey, batch }),
        keepalive: opts.keepalive === true,
        credentials: 'omit',
      });
    } catch {
      // Analytics never breaks the game; a lost batch is lost.
    }
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.flushDelayMs ?? 2_000);
  }

  /** Flush when the page is hidden or unloaded (installed with the first event only). */
  private listen(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    const leave = () => {
      this.hiding = true;
      void this.flush({ keepalive: true });
    };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') leave();
      else this.hiding = false;
    });
  }
}

const client = new AnalyticsClient();

/** The signature of `track` (controllers take it as a dependency, tests pass a spy). */
export type Track = <N extends AnalyticsEventName>(name: N, props: AnalyticsEvents[N]) => void;

/** Records a product event (a no-op without `NEXT_PUBLIC_POSTHOG_KEY` or with DNT/GPC). */
export const track: Track = (name, props) => {
  client.track(name, props);
};

/**
 * Sends what is queued now, with `keepalive`: for an event recorded while the page is going
 * away (`pagehide`) before anything else installed the client's own unload flush.
 */
export function flushAnalytics(): void {
  void client.flush({ keepalive: true });
}
