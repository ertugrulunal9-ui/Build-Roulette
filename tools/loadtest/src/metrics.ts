/**
 * What one generator process measures. Everything is kept raw (latency samples, receipt
 * times) so the coordinator can merge processes and compute exact percentiles.
 */
import { bump } from './stats';

/** One broadcast received by one client: [topic key ("b:<id>" | "r:<id>"), version, ms]. */
export type Receipt = [string, number, number];

export interface HttpClassStats {
  /** Latency samples (ms), one per request. */
  lat: number[];
  /** Responses by HTTP status ("200", "429", "timeout", "network"). */
  status: Record<string, number>;
  bytesUp: number;
  bytesDown: number;
}

export interface BattleRecord {
  battleId: string;
  roomId: string;
  players: number;
  /** Plans drawn for the roster: ship / auto / dnf. */
  plans: Record<string, number>;
  /** The build time limit start_battle drew (s), before compression. */
  drawnBuildS: number | null;
  startedAt: number;
  /** When the host's client saw DESTROYED (or the generator gave up). */
  endedAt: number | null;
  outcome: 'destroyed' | 'abandoned' | 'timeout' | 'error';
  /** Final builds (shipped + auto-shipped) seen in REVEAL. */
  finalBuilds: number;
}

export interface RawMetrics {
  proc: number;
  startedAt: number;
  endedAt: number;
  /** Keyed by request class, e.g. "rpc:heartbeat", "storage:upload", "rest:battles". */
  http: Record<string, HttpClassStats>;
  /** RPC failures by "fn:code" (code = the stable snake_case message, or the HTTP class). */
  rpcErrors: Record<string, number>;
  /** Every failure (RPC, storage, auth) by code. */
  errors: Record<string, number>;
  /** Storage bytes by "up|down:<file class>" and by battle. */
  storageBytes: Record<string, number>;
  storageCount: Record<string, number>;
  storageByBattle: Record<string, { up: number; down: number; upCount: number; downCount: number }>;
  ws: {
    opened: number;
    closed: number;
    peakOpen: number;
    framesIn: Record<string, number>;
    framesOut: Record<string, number>;
    bytesIn: number;
    bytesOut: number;
    /** Inbound broadcast/presence frames per epoch second (the "messages per second" quota). */
    billableInPerSec: Record<string, number>;
  };
  /** Channel status callbacks by status ("SUBSCRIBED", "CHANNEL_ERROR", …). */
  channel: Record<string, number>;
  presence: { sent: number; deferred: number; failed: number };
  /** Client-side counters: snapshot refetches, gaps, duplicates, nudges, version-check misses… */
  sim: Record<string, number>;
  receipts: Receipt[];
  battles: BattleRecord[];
  clients: { created: number; peak: number; clientMs: number };
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  /** Client clock minus server clock (best of 3 `server_now` samples), one per sync. */
  clockOffsetMs: number[];
  timeseries: { t: number; ws: number; inflight: number; reqs: number; clients: number }[];
}

/**
 * Frames that Supabase counts as Realtime messages (ASSUMED billing rule: every broadcast
 * and presence message delivered to a client, plus presence sent by a client; joins,
 * replies and heartbeats are protocol overhead).
 */
export function isBillable(event: string): boolean {
  return (
    event === 'broadcast' ||
    event === 'presence' ||
    event === 'presence_state' ||
    event === 'presence_diff' ||
    event.startsWith('binary:')
  );
}

export class Metrics {
  readonly raw: RawMetrics;
  private openWs = 0;
  private inflight = 0;
  private reqsSinceTick = 0;
  private liveClients = 0;
  private clientStarts = new Map<string, number>();

  constructor(proc: number) {
    this.raw = {
      proc,
      startedAt: Date.now(),
      endedAt: 0,
      http: {},
      rpcErrors: {},
      errors: {},
      storageBytes: {},
      storageCount: {},
      storageByBattle: {},
      ws: {
        opened: 0,
        closed: 0,
        peakOpen: 0,
        framesIn: {},
        framesOut: {},
        bytesIn: 0,
        bytesOut: 0,
        billableInPerSec: {},
      },
      channel: {},
      presence: { sent: 0, deferred: 0, failed: 0 },
      sim: {},
      receipts: [],
      battles: [],
      clients: { created: 0, peak: 0, clientMs: 0 },
      eventLoopDelayMs: { p50: 0, p99: 0, max: 0 },
      clockOffsetMs: [],
      timeseries: [],
    };
  }

  private cls(key: string): HttpClassStats {
    let c = this.raw.http[key];
    if (!c) {
      c = { lat: [], status: {}, bytesUp: 0, bytesDown: 0 };
      this.raw.http[key] = c;
    }
    return c;
  }

  requestStarted(): void {
    this.inflight++;
    this.reqsSinceTick++;
  }

  requestEnded(key: string, ms: number, status: string, up: number, down: number): void {
    this.inflight--;
    const c = this.cls(key);
    c.lat.push(Math.round(ms * 10) / 10);
    bump(c.status, status);
    c.bytesUp += up;
    c.bytesDown += down;
  }

  /** A latency sample that is not an HTTP request (e.g. a channel join). */
  observe(key: string, ms: number, status = 'ok'): void {
    const c = this.cls(key);
    c.lat.push(Math.round(ms * 10) / 10);
    bump(c.status, status);
  }

  storage(dir: 'up' | 'down', file: string, battleId: string | null, bytes: number): void {
    bump(this.raw.storageBytes, `${dir}:${file}`, bytes);
    bump(this.raw.storageCount, `${dir}:${file}`);
    if (!battleId) return;
    let b = this.raw.storageByBattle[battleId];
    if (!b) {
      b = { up: 0, down: 0, upCount: 0, downCount: 0 };
      this.raw.storageByBattle[battleId] = b;
    }
    if (dir === 'up') {
      b.up += bytes;
      b.upCount++;
    } else {
      b.down += bytes;
      b.downCount++;
    }
  }

  rpcError(fn: string, code: string): void {
    bump(this.raw.rpcErrors, `${fn}:${code}`);
    bump(this.raw.errors, code);
  }

  error(code: string): void {
    bump(this.raw.errors, code);
  }

  count(name: string, by = 1): void {
    bump(this.raw.sim, name, by);
  }

  wsOpened(): void {
    this.raw.ws.opened++;
    this.openWs++;
    this.raw.ws.peakOpen = Math.max(this.raw.ws.peakOpen, this.openWs);
  }

  wsClosed(): void {
    this.raw.ws.closed++;
    this.openWs--;
  }

  wsFrame(dir: 'in' | 'out', event: string, bytes: number): void {
    if (dir === 'in') {
      bump(this.raw.ws.framesIn, event);
      this.raw.ws.bytesIn += bytes;
      if (isBillable(event))
        bump(this.raw.ws.billableInPerSec, String(Math.floor(Date.now() / 1000)));
    } else {
      bump(this.raw.ws.framesOut, event);
      this.raw.ws.bytesOut += bytes;
    }
  }

  channelStatus(status: string): void {
    bump(this.raw.channel, status);
  }

  receipt(topicKey: string, version: number, at: number): void {
    this.raw.receipts.push([topicKey, version, Math.round(at * 10) / 10]);
  }

  clientStarted(id: string): void {
    this.raw.clients.created++;
    this.liveClients++;
    this.raw.clients.peak = Math.max(this.raw.clients.peak, this.liveClients);
    this.clientStarts.set(id, Date.now());
  }

  clientStopped(id: string): void {
    const t = this.clientStarts.get(id);
    if (t === undefined) return;
    this.clientStarts.delete(id);
    this.liveClients--;
    this.raw.clients.clientMs += Date.now() - t;
  }

  tick(): void {
    this.raw.timeseries.push({
      t: Date.now(),
      ws: this.openWs,
      inflight: this.inflight,
      reqs: this.reqsSinceTick,
      clients: this.liveClients,
    });
    this.reqsSinceTick = 0;
  }

  finish(): RawMetrics {
    for (const id of [...this.clientStarts.keys()]) this.clientStopped(id);
    this.raw.endedAt = Date.now();
    return this.raw;
  }
}
