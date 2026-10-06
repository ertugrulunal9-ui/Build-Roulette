/**
 * Pure reducers for the room and battle Realtime events (docs/04 §4.6–§4.7, §4.10).
 *
 * Every broadcast carries the `version` it produced (exactly one event per version, per
 * topic). The client keeps the snapshot's version and:
 *   - ignores an event with `version <= current` (stale or duplicate);
 *   - applies the event with `version === current + 1`;
 *   - refetches the snapshot on a gap (`version > current + 1`).
 * Applying an event can also ask for a refetch: some changes are not fully described by the
 * small payloads (a new battle, a phase change with new ranks, a finished capture).
 *
 * No I/O, no clock: the sync engine (sync.ts) owns ordering, buffering and fetching.
 */
import { BATTLE_EVENT_TYPES, ROOM_EVENT_TYPES, roomMaxPlayers } from '@br/game';
import type { BattleSnapshot, SnapshotBuild } from '../solo/types';
import type { BattleEvent, RoomEvent, RoomMember, RoomSnapshot } from './types';

export type VersionCheck = 'stale' | 'next' | 'gap';

/** Where an incoming event's version stands relative to the snapshot's. */
export function checkVersion(current: number, incoming: number): VersionCheck {
  if (incoming <= current) return 'stale';
  return incoming === current + 1 ? 'next' : 'gap';
}

export interface Reduced<T> {
  next: T;
  /** The payload could not describe the whole change: fetch a fresh snapshot. */
  refetch: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * A broadcast payload as a room event, or null if it is not one (no numeric version). An
 * unknown `type` becomes `sync`, which makes the client refetch: the server only ever adds
 * event types, and a refetch is always correct.
 */
export function parseRoomEvent(payload: unknown): RoomEvent | null {
  if (!isRecord(payload) || typeof payload['version'] !== 'number') return null;
  const type = payload['type'];
  if (!(ROOM_EVENT_TYPES as readonly unknown[]).includes(type)) {
    return { type: 'sync', version: payload['version'] };
  }
  return payload as unknown as RoomEvent;
}

/** Same as {@link parseRoomEvent} for the battle topic. */
export function parseBattleEvent(payload: unknown): BattleEvent | null {
  if (!isRecord(payload) || typeof payload['version'] !== 'number') return null;
  const type = payload['type'];
  if (!(BATTLE_EVENT_TYPES as readonly unknown[]).includes(type)) {
    return { type: 'sync', version: payload['version'] };
  }
  return payload as unknown as BattleEvent;
}

// ─── Room ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies the room event that directly follows `snap` (the caller checked the version).
 */
export function applyRoomEvent(snap: RoomSnapshot, ev: RoomEvent): Reduced<RoomSnapshot> {
  const room = { ...snap.room, version: ev.version };
  switch (ev.type) {
    case 'sync':
      return { next: { ...snap, room }, refetch: true };

    case 'member': {
      let members: RoomMember[];
      const known = snap.members.some((m) => m.user_id === ev.user_id);
      if (ev.state === 'kicked') {
        // Kicked members are not listed (get_room_snapshot leaves them out).
        members = snap.members.filter((m) => m.user_id !== ev.user_id);
      } else if (known) {
        members = snap.members.map((m) =>
          m.user_id === ev.user_id
            ? {
                ...m,
                display_name: ev.display_name ?? m.display_name,
                role: ev.role ?? m.role,
                is_ready: ev.is_ready ?? m.is_ready,
                state: ev.state,
                left_at: ev.state === 'left' ? (m.left_at ?? snap.server_now) : null,
              }
            : m,
        );
      } else {
        // A newcomer: what the payload knows; joined_at and last_seen_at come with the next
        // snapshot (online status comes from Presence anyway).
        members = [
          ...snap.members,
          {
            user_id: ev.user_id,
            display_name: ev.display_name ?? 'Player',
            role: ev.role ?? 'spectator',
            state: ev.state,
            is_ready: ev.is_ready ?? false,
            is_host: ev.user_id === snap.room.host_id,
            joined_at: null,
            last_seen_at: null,
            left_at: null,
          },
        ];
      }
      const me =
        ev.user_id === snap.me.user_id
          ? {
              ...snap.me,
              role: ev.role ?? snap.me.role,
              is_ready: ev.is_ready ?? snap.me.is_ready,
              state: ev.state,
            }
          : snap.me;
      return { next: { ...snap, room, me, members }, refetch: false };
    }

    case 'room': {
      const nextRoom = {
        ...room,
        status: ev.status,
        host_id: ev.host_id,
        settings: ev.settings,
        max_players: roomMaxPlayers(ev.settings),
        current_battle_id: ev.current_battle_id,
      };
      const members = snap.members.map((m) =>
        m.is_host === (m.user_id === ev.host_id) ? m : { ...m, is_host: m.user_id === ev.host_id },
      );
      const me = { ...snap.me, is_host: snap.me.user_id === ev.host_id };
      // The battle summary (phase, roster) is not in the payload: refetch when it changed.
      const battleChanged =
        ev.current_battle_id !== snap.room.current_battle_id ||
        ev.change === 'battle_started' ||
        ev.change === 'battle_ended';
      return {
        next: { ...snap, room: nextRoom, me, members },
        refetch: battleChanged,
      };
    }
  }
}

// ─── Battle ───────────────────────────────────────────────────────────────────────────

function mapBuilds(
  snap: BattleSnapshot,
  match: (b: SnapshotBuild) => boolean,
  update: (b: SnapshotBuild) => SnapshotBuild,
): SnapshotBuild[] {
  return snap.builds.map((b) => (match(b) ? update(b) : b));
}

/**
 * Applies the battle event that directly follows `snap`. `phase` events always ask for a
 * refetch (docs/04 §4.10: builds, ranks and awards change in bulk at RESULTS).
 */
export function applyBattleEvent(snap: BattleSnapshot, ev: BattleEvent): Reduced<BattleSnapshot> {
  const battle = { ...snap.battle, version: ev.version };
  switch (ev.type) {
    case 'phase':
      return {
        next: {
          ...snap,
          battle: {
            ...battle,
            phase: ev.phase,
            phase_started_at: ev.phase_started_at,
            phase_ends_at: ev.phase_ends_at,
          },
        },
        refetch: true,
      };

    case 'build':
      return {
        next: {
          ...snap,
          battle,
          builds: mapBuilds(
            snap,
            (b) => b.id === ev.build_id || b.builder_id === ev.user_id,
            (b) => ({
              ...b,
              status: 'shipped',
              name: ev.name,
              completion_ms: ev.completion_ms,
            }),
          ),
        },
        refetch: false,
      };

    case 'player': {
      const players = snap.players.map((p) =>
        p.user_id === ev.user_id ? { ...p, state: ev.status } : p,
      );
      const buildStatus = ev.build_status;
      const builds = buildStatus
        ? mapBuilds(
            snap,
            (b) => b.builder_id === ev.user_id,
            (b) => ({ ...b, status: buildStatus }),
          )
        : snap.builds;
      return { next: { ...snap, battle, players, builds }, refetch: false };
    }

    case 'host':
      return {
        next: {
          ...snap,
          battle: { ...battle, host_id: ev.host_id },
          me: { ...snap.me, is_host: ev.host_id === snap.me.user_id },
        },
        refetch: false,
      };

    case 'capture':
      // The screenshot path is not in the payload.
      return {
        next: {
          ...snap,
          battle,
          builds: mapBuilds(
            snap,
            (b) => b.id === ev.build_id,
            (b) => ({ ...b, capture_status: ev.capture_status }),
          ),
        },
        refetch: true,
      };

    case 'destroyed':
    case 'sync':
      return { next: { ...snap, battle }, refetch: true };
  }
}
