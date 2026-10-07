/**
 * Rooms and multiplayer constants shared by the web app and checked against the SQL
 * migrations (schema-drift.test.ts). The server decides everything; these are read-side
 * metadata for the UI and the client sync rules (docs/04 §4.10, supabase/README.md "Rooms
 * and multiplayer" and "Realtime").
 */

/** `private.room_limits()`: room sizes, presence and housekeeping windows (seconds). */
export const ROOM_LIMITS = {
  max_players: 8,
  min_players: 2,
  max_spectators: 20,
  /** A member is present when active and seen within this many seconds. */
  present_s: 30,
  /** The server writes at most one heartbeat per member per this many seconds. */
  heartbeat_min_interval_s: 5,
  abandon_s: 300,
  idle_close_s: 7200,
  purge_closed_s: 604800,
  max_hosted_rooms: 3,
} as const;

export type RoomLimits = typeof ROOM_LIMITS;

/**
 * How often a client calls `heartbeat(room_id)` while the room page is open (docs/04
 * §4.10: about every 10 s, well inside the 30 s presence window that drives host migration).
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Presence updates (activity during BUILD) are sent at most this often (docs/04 §4.7). */
export const PRESENCE_THROTTLE_MS = 2_000;

/**
 * Supabase Realtime limits presence messages per client and channel: by default 5 per
 * 30 s (`CLIENT_PRESENCE_MAX_CALLS`, `CLIENT_PRESENCE_WINDOW_MS`; Realtime 2.140), and a
 * client that goes over has its channel CLOSED by the server ("Client presence rate limit
 * exceeded"). Clients stay one below it: at most this many tracks per window.
 */
export const PRESENCE_MAX_PER_WINDOW = 4;
export const PRESENCE_WINDOW_MS = 30_000;

/** Enum `public.room_status`. */
export const ROOM_STATUSES = ['open', 'in_battle', 'closed'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** Enum `public.member_role`. */
export const MEMBER_ROLES = ['player', 'spectator'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** A member's state in snapshots and `member` events (derived from left_at / kicked_at). */
export const MEMBER_STATES = ['active', 'left', 'kicked'] as const;
export type MemberState = (typeof MEMBER_STATES)[number];

/** `me.role` in a multiplayer battle snapshot. */
export const BATTLE_ROLES = ['player', 'spectator', 'viewer'] as const;
export type BattleRole = (typeof BATTLE_ROLES)[number];

/** Enum `public.build_status`. */
export const BUILD_STATUSES = ['draft', 'shipped', 'auto_shipped', 'dnf', 'disqualified'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

/** Enum `public.capture_status`. */
export const CAPTURE_STATUSES = ['pending', 'captured', 'fallback', 'failed'] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** The automatic awards (M3 has no votes yet): `private.finalize_results`. */
export const AUTO_AWARDS = ['clutch_ship', 'speedrun', 'fastest_ship'] as const;
export type AutoAward = (typeof AUTO_AWARDS)[number];

// ─── Realtime (private topics `room:{id}` and `battle:{id}`) ──────────────────────────

/**
 * Broadcast event names on `battle:{id}` (`private.battle_broadcast`; the drift test checks
 * both lists are the same). `vote_progress` (M4) is `{version, voted_count, eligible_count}`
 * during VOTING, sent when a voter completes their ballot.
 */
export const BATTLE_EVENT_TYPES = [
  'phase',
  'build',
  'player',
  'host',
  'capture',
  'vote_progress',
  'destroyed',
  'sync',
] as const;
export type BattleEventType = (typeof BATTLE_EVENT_TYPES)[number];

/** Broadcast event names on `room:{id}` (`private.room_broadcast`). */
export const ROOM_EVENT_TYPES = ['room', 'member', 'sync'] as const;
export type RoomEventType = (typeof ROOM_EVENT_TYPES)[number];

/** `change` of a `member` event. */
export const MEMBER_CHANGES = [
  'member_joined',
  'member_left',
  'member_ready',
  'member_kicked',
  'member_promoted',
  'member_updated',
] as const;
export type MemberChange = (typeof MEMBER_CHANGES)[number];

/** `change` of a `room` event. */
export const ROOM_CHANGES = [
  'created',
  'settings',
  'host_changed',
  'battle_started',
  'battle_ended',
  'closed',
] as const;
export type RoomChange = (typeof ROOM_CHANGES)[number];

export function roomTopic(roomId: string): string {
  return `room:${roomId}`;
}

export function battleTopic(battleId: string): string {
  return `battle:${battleId}`;
}

// ─── Room codes ───────────────────────────────────────────────────────────────────────

/** The 32 characters of a room code (no I, O, 0, 1): `private.new_room_code()`. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{5}$/;

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE.test(value);
}

/**
 * A room code from what a player typed or pasted: any case, surrounding spaces, or a whole
 * invite link (`https://…/r/k7qxm`). Returns the canonical upper-case code, or null.
 */
export function normalizeRoomCode(input: string): string | null {
  let text = input.trim();
  const fromLink = /\/r\/([^/?#\s]+)/i.exec(text);
  if (fromLink?.[1]) text = fromLink[1];
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  return isRoomCode(code) ? code : null;
}

/** `max_players` of a room's settings, clamped like `private.room_max_players`. */
export function roomMaxPlayers(settings: { max_players?: unknown } | null | undefined): number {
  const raw = settings?.max_players;
  const n =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : ROOM_LIMITS.max_players;
  return Math.min(Math.max(n, ROOM_LIMITS.min_players), ROOM_LIMITS.max_players);
}
