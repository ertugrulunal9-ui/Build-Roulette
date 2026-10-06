/**
 * Shapes returned by the solo RPCs (supabase/migrations/20261004120300_solo_battle.sql and
 * 20261006120000_autosave_css_and_public_battle.sql). Timestamps are ISO strings.
 */
import type { BattlePhase } from '@br/game';

export type BuildStatus = 'draft' | 'shipped' | 'auto_shipped' | 'dnf' | 'disqualified';
export type CaptureStatus = 'pending' | 'captured' | 'fallback' | 'failed';
export type AwardKind = 'clutch_ship' | 'speedrun' | 'fastest_ship' | (string & {});

export interface ChallengeCard {
  text: string;
  hint: string | null;
}

export interface Challenge {
  build: ChallengeCard;
  rule: ChallengeCard;
  style: ChallengeCard;
  time_limit_seconds: number;
}

export interface BuildStats {
  files?: number;
  lines?: number;
  deps?: string[];
  bundle_bytes?: number;
  rebuilds?: number;
  pastes?: number;
}

export interface Award {
  build_id: string;
  award: AwardKind;
  source: string;
  votes: number | null;
}

/** `get_battle_snapshot` (members, or anyone signed in once RESULTS/DESTROYED). */
export interface BattleSnapshot {
  server_now: string;
  me: { user_id: string; is_player: boolean };
  battle: {
    id: string;
    room_id: string | null;
    host_id: string;
    mode: string;
    phase: BattlePhase;
    version: number;
    phase_started_at: string | null;
    phase_ends_at: string | null;
    building_started_at: string | null;
    building_ends_at: string | null;
    shipping_ended_at: string | null;
    finished_at: string | null;
    destroyed_at: string | null;
    is_complete: boolean;
    created_at: string;
  };
  challenge: Challenge & { id: string };
  players: { user_id: string; display_name: string }[];
  builds: SnapshotBuild[];
  awards: Award[];
}

export interface SnapshotBuild {
  id: string;
  builder_id: string;
  name: string | null;
  status: BuildStatus;
  shipped_at: string | null;
  completion_ms: number | null;
  stats: BuildStats;
  capture_status: CaptureStatus;
  screenshot_path: string | null;
  captured_at: string | null;
  source_destroyed_at: string | null;
  final_rank: number | null;
  total_votes: number;
}

/** `advance_battle` */
export interface AdvanceResult {
  changed: boolean;
  version: number;
  phase: BattlePhase;
  phase_ends_at: string | null;
}

/** `ship_build` */
export interface ShipResult {
  build: {
    id: string;
    status: BuildStatus;
    name: string;
    shipped_at: string;
    completion_ms: number;
    stats: BuildStats;
  };
  battle: { version: number; phase: BattlePhase; phase_ends_at: string | null };
}

/** `get_public_battle` (anyone, RESULTS/DESTROYED only): permanent data, no user ids. */
export interface PublicBattle {
  battle: {
    id: string;
    mode: string;
    phase: 'results' | 'destroyed';
    is_complete: boolean;
    building_started_at: string | null;
    building_ends_at: string | null;
    finished_at: string | null;
    destroyed_at: string | null;
    created_at: string;
  };
  challenge: Challenge;
  players: string[];
  builds: PublicBuild[];
  awards: Award[];
}

export interface PublicBuild {
  id: string;
  builder_name: string;
  name: string | null;
  status: BuildStatus;
  shipped_at: string | null;
  completion_ms: number | null;
  final_rank: number | null;
  total_votes: number;
  stats: BuildStats;
  capture_status: CaptureStatus;
  screenshot_path: string | null;
}
