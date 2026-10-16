/**
 * Fakes for the solo controller tests: an in-memory SoloApi whose battle the test drives, the
 * BUILD screen's preview bridge, an in-memory LocalSites, and real site packs. Times use
 * Date.now(), which vitest's fake timers control.
 */
import { contentTypeOf, packSite, type ImportedSite } from '@br/site';
import type { LocalSites, StoredSite } from '../site/local-sites';
import type { BuildFile, SoloApi } from './api';
import type { PreviewBridge } from './controller';
import { GameError } from './errors';
import type { AdvanceResult, BattleSnapshot, BuildStats, ShipResult } from './types';

export const USER = '11111111-1111-4111-8111-111111111111';
export const BATTLE = '22222222-2222-4222-8222-222222222222';
export const BUILD_ID = '33333333-3333-4333-8333-333333333333';

const iso = (t: number) => new Date(t).toISOString();

/** A snapshot of a solo battle in `phase`, with the deadline `endsInMs` from now (server time). */
export function snapshotAt(
  phase: BattleSnapshot['battle']['phase'],
  opts: {
    version?: number;
    endsInMs?: number | null;
    serverOffsetMs?: number;
    status?: BattleSnapshot['builds'][number]['status'];
    capture?: BattleSnapshot['builds'][number]['capture_status'];
    destroyedAt?: string | null;
  } = {},
): BattleSnapshot {
  const now = Date.now() + (opts.serverOffsetMs ?? 0);
  const endsIn = opts.endsInMs === undefined ? 6_000 : opts.endsInMs;
  return {
    server_now: iso(now),
    me: { user_id: USER, is_player: true },
    battle: {
      id: BATTLE,
      room_id: null,
      host_id: USER,
      mode: 'solo',
      phase,
      version: opts.version ?? 1,
      phase_started_at: iso(now),
      phase_ends_at: endsIn === null ? null : iso(now + endsIn),
      building_started_at: phase === 'spinning' ? null : iso(now - 10_000),
      building_ends_at: phase === 'spinning' ? null : iso(now + 290_000),
      shipping_ended_at: null,
      finished_at: null,
      destroyed_at: opts.destroyedAt ?? null,
      is_complete: false,
      created_at: iso(now - 20_000),
    },
    challenge: {
      id: 'c',
      build: { text: 'A pomodoro timer', hint: 'Start, pause, reset' },
      rule: { text: 'Only one button', hint: null },
      style: { text: 'Brutalist', hint: 'Raw borders' },
      time_limit_seconds: 300,
    },
    players: [{ user_id: USER, display_name: 'Otter' }],
    builds: [
      {
        id: BUILD_ID,
        builder_id: USER,
        name: null,
        status: opts.status ?? 'draft',
        shipped_at: null,
        completion_ms: null,
        stats: {},
        capture_status: opts.capture ?? 'pending',
        screenshot_path: null,
        captured_at: null,
        source_destroyed_at: null,
        final_rank: null,
        total_votes: 0,
      },
    ],
    awards: [],
  };
}

type Handler<A extends unknown[], R> = (...args: A) => R | Promise<R>;

export class FakeApi implements SoloApi {
  /** Every call, in order: [method, ...args]. */
  readonly calls: [string, ...unknown[]][] = [];
  readonly files = new Map<string, Blob | Uint8Array<ArrayBuffer>>();
  serverOffsetMs = 0;
  snapshot: BattleSnapshot = snapshotAt('spinning');
  onStart: Handler<[string], string> = () => BATTLE;
  onAdvance: Handler<[number], AdvanceResult> = (v) => ({
    changed: false,
    version: v,
    phase: this.snapshot.battle.phase,
    phase_ends_at: this.snapshot.battle.phase_ends_at,
  });
  onShip: Handler<[string, BuildStats], ShipResult> = (name, stats) => {
    this.snapshot = snapshotAt('results', {
      version: this.snapshot.battle.version + 3,
      endsInMs: 60_000,
      serverOffsetMs: this.serverOffsetMs,
      status: 'shipped',
    });
    return {
      build: {
        id: BUILD_ID,
        status: 'shipped',
        name,
        shipped_at: new Date().toISOString(),
        completion_ms: 1000,
        stats,
      },
      battle: { version: this.snapshot.battle.version, phase: 'results', phase_ends_at: null },
    };
  };
  onUpload: Handler<[BuildFile], void> = () => undefined;

  ensureSession(): Promise<string> {
    this.calls.push(['ensureSession']);
    return Promise.resolve(USER);
  }
  serverNow(): Promise<number> {
    this.calls.push(['serverNow']);
    return Promise.resolve(Date.now() + this.serverOffsetMs);
  }
  async startSoloBattle(name: string): Promise<string> {
    this.calls.push(['startSoloBattle', name]);
    return this.onStart(name);
  }
  async advanceBattle(battleId: string, version: number): Promise<AdvanceResult> {
    this.calls.push(['advanceBattle', battleId, version]);
    return this.onAdvance(version);
  }
  async shipBuild(battleId: string, name: string, stats: BuildStats): Promise<ShipResult> {
    this.calls.push(['shipBuild', battleId, name, stats]);
    return this.onShip(name, stats);
  }
  getSnapshot(battleId: string): Promise<BattleSnapshot> {
    this.calls.push(['getSnapshot', battleId]);
    if (battleId !== this.snapshot.battle.id) {
      return Promise.reject(new GameError('battle_not_found'));
    }
    return Promise.resolve(structuredClone(this.snapshot));
  }
  async upload(
    battleId: string,
    userId: string,
    file: BuildFile,
    body: Blob | Uint8Array<ArrayBuffer>,
  ) {
    this.calls.push(['upload', file]);
    await this.onUpload(file);
    this.files.set(`${battleId}/${userId}/${file}`, body);
  }
  async download(
    battleId: string,
    userId: string,
    file: BuildFile,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    this.calls.push(['download', file]);
    const body = this.files.get(`${battleId}/${userId}/${file}`);
    if (body === undefined) return null;
    return body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
  }

  /** Phases the server reports for `battlePhases` (battles not listed are not visible). */
  phases: Record<string, BattleSnapshot['battle']['phase']> = {};
  battlePhases(ids: string[]): Promise<Record<string, BattleSnapshot['battle']['phase']>> {
    this.calls.push(['battlePhases', ids]);
    const out: Record<string, BattleSnapshot['battle']['phase']> = {};
    for (const id of ids) {
      const phase = this.phases[id];
      if (phase !== undefined) out[id] = phase;
    }
    return Promise.resolve(out);
  }

  count(method: string): number {
    return this.calls.filter((c) => c[0] === method).length;
  }
  uploadsOf(file: BuildFile): number {
    return this.calls.filter((c) => c[0] === 'upload' && c[1] === file).length;
  }
}

/** A real site pack with an `index.html` that says `label` (and `extra` files). */
export function fakeSite(label = 'Site', extra: Record<string, string> = {}): ImportedSite {
  const enc = new TextEncoder();
  const files = Object.entries({
    'index.html': `<!doctype html><title>${label}</title><h1>${label}</h1>`,
    ...extra,
  }).map(([path, text]) => ({ path, type: contentTypeOf(path), bytes: enc.encode(text) }));
  const pack = packSite(files);
  return {
    pack,
    root: 'dist/',
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes.byteLength, 0),
    skipped: 2,
  };
}

/** The BUILD screen's live preview: the ship thumbnail. */
export class FakePreviewBridge implements PreviewBridge {
  thumb: Blob | null = new Blob(['webp'], { type: 'image/webp' });
  thumbnailCalls = 0;

  thumbnail() {
    this.thumbnailCalls++;
    return Promise.resolve(this.thumb);
  }
}

export class FakeLocalSites implements LocalSites {
  readonly deleted: string[] = [];
  readonly puts: string[] = [];
  /** Stored battle sites (key → value and last save). */
  readonly stored = new Map<string, StoredSite>();
  /** When set, every call fails (blocked storage). */
  broken = false;

  get(key: string): Promise<StoredSite | null> {
    if (this.broken) return Promise.reject(new Error('blocked'));
    return Promise.resolve(this.stored.get(key) ?? null);
  }
  put(key: string, value: Omit<StoredSite, 'updatedAt'>): Promise<void> {
    if (this.broken) return Promise.reject(new Error('blocked'));
    this.puts.push(key);
    this.stored.set(key, { ...value, updatedAt: Date.now() });
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.stored.delete(key);
    return Promise.resolve();
  }
  listBattleSites(): Promise<{ id: string; updatedAt: number }[]> {
    return Promise.resolve([...this.stored].map(([id, v]) => ({ id, updatedAt: v.updatedAt })));
  }
  /** A stored entry that only has a last-save time (another battle's, for the cleanup). */
  storeAt(key: string, updatedAt: number): void {
    this.stored.set(key, { ...{ site: fakeSite(key), imports: 1 }, updatedAt });
  }
}
