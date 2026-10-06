/**
 * What the solo game needs from the backend, as an interface so the controller can be unit
 * tested with a fake. `SupabaseSoloApi` implements it with supabase-js: the RPCs from
 * supabase/README.md and the `ephemeral-builds` bucket (paths and content types as in
 * supabase/scripts/e2e-solo.mjs). Every method throws a `GameError`.
 */
import type { BattlePhase } from '@br/game';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EPHEMERAL_BUCKET } from '../supabase/config';
import { toGameError } from './errors';
import type { AdvanceResult, BattleSnapshot, BuildStats, ShipResult } from './types';

/** The files a player may write under `{battle}/{uid}/` (storage RLS allowlist). */
export type BuildFile =
  | 'source.json'
  | 'bundle.js'
  | 'bundle.css'
  | 'thumb.webp'
  | 'autosave/source.json'
  | 'autosave/bundle.js'
  | 'autosave/bundle.css';

export const CONTENT_TYPES: Record<BuildFile, string> = {
  'source.json': 'application/json',
  'bundle.js': 'text/javascript',
  'bundle.css': 'text/css',
  'thumb.webp': 'image/webp',
  'autosave/source.json': 'application/json',
  'autosave/bundle.js': 'text/javascript',
  'autosave/bundle.css': 'text/css',
};

export interface SoloApi {
  /** Signs in anonymously if needed; returns the user id. */
  ensureSession(): Promise<string>;
  /** `server_now()` as epoch ms. */
  serverNow(): Promise<number>;
  startSoloBattle(displayName: string, timeLimitSeconds?: number | null): Promise<string>;
  advanceBattle(battleId: string, expectedVersion: number): Promise<AdvanceResult>;
  shipBuild(battleId: string, name: string, stats: BuildStats): Promise<ShipResult>;
  getSnapshot(battleId: string): Promise<BattleSnapshot>;
  /** Upserts one of the player's files (`{battle}/{uid}/{file}`) with its content type. */
  upload(battleId: string, userId: string, file: BuildFile, body: Blob | string): Promise<void>;
  /** Reads one of the player's own files; null when it does not exist. */
  download(battleId: string, userId: string, file: BuildFile): Promise<string | null>;
  /** The phase of each battle the user may see (`battles` RLS); others are left out. */
  battlePhases(battleIds: string[]): Promise<Record<string, BattlePhase>>;
}

export class SupabaseSoloApi implements SoloApi {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly signIn: (s: SupabaseClient) => Promise<string>,
  ) {}

  ensureSession(): Promise<string> {
    return this.signIn(this.supabase).catch((e: unknown) => {
      throw toGameError(e);
    });
  }

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    let res;
    try {
      res = await this.supabase.rpc(fn, args);
    } catch (e) {
      throw toGameError(e);
    }
    if (res.error) throw toGameError(res.error);
    return res.data as T;
  }

  async serverNow(): Promise<number> {
    const iso = await this.rpc<string>('server_now');
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) throw toGameError(new Error(`server_now returned ${iso}`));
    return t;
  }

  startSoloBattle(displayName: string, timeLimitSeconds: number | null = null): Promise<string> {
    return this.rpc<string>('start_solo_battle', {
      p_display_name: displayName,
      p_time_limit_seconds: timeLimitSeconds,
    });
  }

  advanceBattle(battleId: string, expectedVersion: number): Promise<AdvanceResult> {
    return this.rpc<AdvanceResult>('advance_battle', {
      p_battle_id: battleId,
      p_expected_version: expectedVersion,
    });
  }

  shipBuild(battleId: string, name: string, stats: BuildStats): Promise<ShipResult> {
    return this.rpc<ShipResult>('ship_build', {
      p_battle_id: battleId,
      p_name: name,
      p_stats: stats,
    });
  }

  getSnapshot(battleId: string): Promise<BattleSnapshot> {
    return this.rpc<BattleSnapshot>('get_battle_snapshot', { p_battle_id: battleId });
  }

  async upload(
    battleId: string,
    userId: string,
    file: BuildFile,
    body: Blob | string,
  ): Promise<void> {
    const contentType = CONTENT_TYPES[file];
    const blob = typeof body === 'string' ? new Blob([body], { type: contentType }) : body;
    let res;
    try {
      res = await this.supabase.storage
        .from(EPHEMERAL_BUCKET)
        .upload(`${battleId}/${userId}/${file}`, blob, { contentType, upsert: true });
    } catch (e) {
      throw toGameError(e);
    }
    if (res.error) throw toGameError(res.error);
  }

  async download(battleId: string, userId: string, file: BuildFile): Promise<string | null> {
    let res;
    try {
      res = await this.supabase.storage
        .from(EPHEMERAL_BUCKET)
        .download(`${battleId}/${userId}/${file}`);
    } catch (e) {
      throw toGameError(e);
    }
    if (res.error) {
      // supabase-js reports a missing object as a StorageError with status 400/404.
      const err = res.error as { message: string; statusCode?: string; status?: number };
      const status = String(err.statusCode ?? err.status ?? '');
      if (status === '404' || status === '400' || /not found/i.test(err.message)) return null;
      throw toGameError(res.error);
    }
    return res.data.text();
  }

  async battlePhases(battleIds: string[]): Promise<Record<string, BattlePhase>> {
    if (battleIds.length === 0) return {};
    let res;
    try {
      res = await this.supabase
        .from('battles')
        .select('id, phase')
        .in('id', battleIds)
        .overrideTypes<{ id: string; phase: BattlePhase }[], { merge: false }>();
    } catch (e) {
      throw toGameError(e);
    }
    if (res.error) throw toGameError(res.error);
    return Object.fromEntries(res.data.map((b) => [b.id, b.phase]));
  }
}
