/**
 * Shapes of the room RPCs and Realtime payloads (supabase/migrations/20261006130000_rooms.sql
 * and 20261006130300_realtime.sql; contract in supabase/README.md "Rooms and multiplayer").
 * Timestamps are ISO strings.
 */
import type {
  BattlePhase,
  BuildStatus,
  CaptureStatus,
  MemberChange,
  MemberRole,
  MemberState,
  RoomChange,
  RoomStatus,
} from '@br/game';

export interface RoomSettings {
  max_players?: number;
  reveal_slot_s?: number;
  voting_s?: number;
  /** M4: REVEAL and VOTING after SHIPPING (default true). */
  reveal_vote?: boolean;
}

/**
 * A change to the room settings (`update_room_settings` merges it): a key with `null`
 * goes back to the server default (e.g. `reveal_slot_s: null` = by the number of builds).
 */
export type RoomSettingsPatch = { [K in keyof RoomSettings]?: RoomSettings[K] | null };

/** A member in `get_room_snapshot.members` (kicked members are not listed). */
export interface RoomMember {
  user_id: string;
  display_name: string;
  avatar_seed?: string | null;
  role: MemberRole;
  /** `active` or `left` in snapshots; `kicked` only transiently from an event. */
  state: MemberState;
  is_ready: boolean;
  is_host: boolean;
  /** Null for a member only known from an event so far (the next refetch fills it). */
  joined_at: string | null;
  last_seen_at: string | null;
  left_at: string | null;
}

/** The current (or last) battle of a room, as summarized by `get_room_snapshot`. */
export interface RoomBattleSummary {
  id: string;
  phase: BattlePhase;
  version: number;
  host_id: string;
  phase_started_at: string | null;
  phase_ends_at: string | null;
  building_started_at: string | null;
  building_ends_at: string | null;
  finished_at: string | null;
  is_complete: boolean;
  created_at: string;
  roster: { user_id: string; display_name: string }[];
}

/** `get_room_snapshot(p_room_id)`. */
export interface RoomSnapshot {
  server_now: string;
  me: {
    user_id: string;
    role: MemberRole;
    state: MemberState;
    is_ready: boolean;
    is_host: boolean;
  };
  room: {
    id: string;
    code: string;
    host_id: string;
    status: RoomStatus;
    version: number;
    settings: RoomSettings;
    max_players: number;
    max_spectators: number;
    current_battle_id: string | null;
    created_at: string;
    last_activity_at: string;
    closed_at: string | null;
  };
  members: RoomMember[];
  battle: RoomBattleSummary | null;
}

/** `join_room` / `create_room`. */
export interface JoinResult {
  room_id: string;
  code: string;
  role?: MemberRole;
}

/** `heartbeat(p_room_id)`. */
export interface HeartbeatResult {
  server_now: string;
  room_version: number;
  host_id: string;
  status: RoomStatus;
}

// ─── Realtime payloads (`payload.type` is the event name) ─────────────────────────────

interface Versioned {
  version: number;
}

export type RoomEvent =
  | (Versioned & {
      type: 'member';
      change: MemberChange;
      user_id: string;
      display_name: string | null;
      role: MemberRole | null;
      is_ready: boolean | null;
      state: MemberState;
    })
  | (Versioned & {
      type: 'room';
      change: RoomChange;
      status: RoomStatus;
      host_id: string;
      settings: RoomSettings;
      current_battle_id: string | null;
      reason?: string;
    })
  | (Versioned & { type: 'sync' });

export type BattleEvent =
  | (Versioned & {
      type: 'phase';
      phase: BattlePhase;
      phase_started_at: string | null;
      phase_ends_at: string | null;
      reason?: string;
      /** Only when `phase` is `reveal`: the spotlighted position (M4). */
      reveal_index?: number;
    })
  | (Versioned & {
      type: 'build';
      build_id: string;
      user_id: string;
      status: Extract<BuildStatus, 'shipped'>;
      name: string;
      completion_ms: number;
    })
  | (Versioned & {
      type: 'player';
      user_id: string;
      status: MemberState;
      build_status?: BuildStatus | null;
    })
  | (Versioned & { type: 'host'; host_id: string })
  | (Versioned & { type: 'capture'; build_id: string; capture_status: CaptureStatus })
  /** M4: a voter completed their ballot (counts only, never who or what). */
  | (Versioned & { type: 'vote_progress'; voted_count: number; eligible_count: number })
  | (Versioned & { type: 'destroyed' })
  | (Versioned & { type: 'sync' });

// ─── Presence (client-claimed, never read by the server) ──────────────────────────────

export interface Activity {
  /** Lines of code in the workspace. */
  lines: number;
  last_build: 'ok' | 'error';
  typing: boolean;
}

/** What each client tracks on `room:{id}` (docs/04 §4.7). */
export interface PresencePayload {
  user_id: string;
  display_name: string;
  device: 'desktop' | 'mobile';
  activity: Activity;
}

/** The presence state the client derives, by user id. */
export type PresenceMap = Record<string, PresencePayload>;
