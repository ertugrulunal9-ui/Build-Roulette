/** Shapes of the admin RPCs (supabase/migrations/20261008120400_reports_and_admin.sql). */
import type { BattlePhase, ReportReason } from '@br/game';
import type { BuildStatus, CaptureStatus } from '../solo/types';

export interface QueueReport {
  id: string;
  reason: ReportReason;
  details: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
  resolved_at: string | null;
}

/** One build of `admin_report_queue`. */
export interface QueueItem {
  build_id: string;
  battle_id: string;
  battle_phase: BattlePhase;
  battle_mode: string;
  finished_at: string | null;
  /** The build's name, or the archived original once taken down. */
  name: string | null;
  builder_id: string;
  builder_name: string | null;
  status: BuildStatus;
  final_rank: number | null;
  capture_status: CaptureStatus;
  screenshot_path: string | null;
  taken_down_at: string | null;
  takedown: {
    requested_at: string;
    storage_deleted_at: string | null;
    original_screenshot_path: string | null;
    note: string | null;
    job_status: 'queued' | 'running' | 'done' | 'failed' | null;
    job_error: string | null;
  } | null;
  open_count: number;
  report_count: number;
  reasons: Partial<Record<ReportReason, number>>;
  first_reported_at: string;
  last_reported_at: string;
  reports: QueueReport[];
}

export interface LogEvent {
  id: number;
  version: number;
  type: string;
  actor_id: string | null;
  actor_name: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface BattleLog {
  battle: {
    id: string;
    room_id: string | null;
    phase: BattlePhase;
    version: number;
    settings: Record<string, unknown>;
    created_at: string;
    finished_at: string | null;
    destroyed_at: string | null;
    is_complete: boolean;
    reveal_order: string[];
    reveal_index: number;
    host_id: string;
  };
  challenge: { build: string; rule: string; style: string; time_limit_seconds: number } | null;
  room: { id: string; code: string; status: string } | null;
  players: {
    user_id: string;
    display_name: string;
    is_voter: boolean;
    state: 'active' | 'left' | 'kicked' | null;
  }[];
  builds: {
    id: string;
    builder_id: string;
    builder_name: string | null;
    name: string | null;
    status: BuildStatus;
    shipped_at: string | null;
    completion_ms: number | null;
    capture_status: CaptureStatus;
    screenshot_path: string | null;
    final_rank: number | null;
    total_votes: number;
    taken_down_at: string | null;
    reports: number;
    open_reports: number;
  }[];
  events: LogEvent[];
  jobs: {
    id: number;
    kind: 'capture' | 'destroy' | 'takedown';
    ref_id: string;
    status: string;
    attempts: number;
    last_error: string | null;
    updated_at: string;
  }[];
}

export interface RoomLog {
  room: {
    id: string;
    code: string;
    status: string;
    host_id: string;
    host_name: string | null;
    version: number;
    settings: Record<string, unknown>;
    created_at: string;
    closed_at: string | null;
    current_battle_id: string | null;
  };
  members: {
    user_id: string;
    display_name: string | null;
    role: 'player' | 'spectator';
    is_ready: boolean;
    joined_at: string;
    last_seen_at: string;
    left_at: string | null;
    kicked_at: string | null;
  }[];
  battles: {
    id: string;
    phase: BattlePhase;
    created_at: string;
    finished_at: string | null;
    is_complete: boolean;
  }[];
  events: LogEvent[];
}

export interface AdminAction {
  id: number;
  admin_id: string | null;
  admin_email: string | null;
  action: 'dismiss_reports' | 'take_down_build' | 'retry_takedown' | 'view_battle' | 'view_room';
  build_id: string | null;
  battle_id: string | null;
  room_id: string | null;
  note: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/** `admin_ops_health` (supabase/migrations/20261008150000_ops_health.sql, T-030). */
export interface OpsHealth {
  generated_at: string;
  battles: {
    grace_s: number;
    /** Battles that are not over, by phase. */
    running: Partial<Record<BattlePhase, number>>;
    overdue_total: number;
    stuck_total: number;
    overdue: {
      phase: BattlePhase;
      count: number;
      stuck: number;
      waiting_for_captures: number;
      oldest_overdue_s: number;
      oldest_battle_id: string;
    }[];
    destroy_pending: { count: number; oldest_s: number | null; oldest_battle_id: string | null };
  };
  jobs: {
    kind: 'capture' | 'destroy' | 'takedown';
    queued: number;
    running: number;
    ready: number;
    lease_expired: number;
    oldest_pending_s: number | null;
    oldest_pending_ref: string | null;
    done_last_hour: number;
    failed_last_hour: number;
    failed_last_day: number;
    last_failure: { at: string; ref_id: string; error: string | null } | null;
  }[];
  captures_last_day: { captured: number; fallback: number; failed: number };
  cron: {
    available: boolean;
    error?: string;
    jobs: {
      name: string;
      schedule: string;
      active: boolean;
      last_run: { start: string; status: string; duration_ms: number | null } | null;
      runs_last_hour: number;
      failed_last_hour: number;
      last_failure: { at: string; message: string | null } | null;
    }[];
  };
  ttl: {
    battles_past_ttl: number;
    oldest_battle_past_ttl_id: string | null;
    ephemeral_objects: number;
    ephemeral_objects_past_ttl: number;
    oldest_ephemeral_object_s: number | null;
    ephemeral_objects_of_destroyed: number;
  };
}
