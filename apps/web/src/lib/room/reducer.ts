/**
 * Pure reducers for the room and battle Realtime events (docs/04 §4.6–§4.7, §4.10).
 *
 * Every broadcast carries the `version` it produced (exactly one event per version, per
 * topic). The client keeps the snapshot's version and:
 *   - ignores an event with `version <= current` (stale or duplicate);
 *   - applies the event with `version === current + 1`;
 *   - refetches the snapshot on a gap (`version > current + 1`).
 * Applying an event can also ask for a refetch: some changes are not fully described by the
 * small payloads (a new battle, a phase change with new ranks, a finished capture). Two M4
 * events never do: a REVEAL slot step (`phase` reveal → reveal with `reveal_index`) and
 * `vote_progress`, so a reveal or a vote does not make every client refetch at once.
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
 * Is this `phase` event a REVEAL slot step the snapshot can take on its own? Only the
 * spotlight (`reveal_index`) and the slot's times change between two slots, so no refetch is
 * needed, provided the snapshot already knows the reveal (its order) and the index is in it.
 */
function isRevealStep(snap: BattleSnapshot, ev: Extract<BattleEvent, { type: 'phase' }>): boolean {
  const order = snap.battle.reveal_order;
  const index = ev.reveal_index;
  return (
    ev.phase === 'reveal' &&
    snap.battle.phase === 'reveal' &&
    Array.isArray(order) &&
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < order.length
  );
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Applies the battle event that directly follows `snap`. A `phase` event asks for a refetch
 * (docs/04 §4.10: builds, ranks, awards, the reveal order and the ballot rights change in
 * bulk), except a REVEAL slot step, which only moves the spotlight. `vote_progress` carries
 * everything it changes.
 */
export function applyBattleEvent(snap: BattleSnapshot, ev: BattleEvent): Reduced<BattleSnapshot> {
  const battle = { ...snap.battle, version: ev.version };
  switch (ev.type) {
    case 'phase': {
      const step = isRevealStep(snap, ev);
      const phased = {
        ...battle,
        phase: ev.phase,
        phase_started_at: ev.phase_started_at,
        phase_ends_at: ev.phase_ends_at,
      };
      return {
        next: {
          ...snap,
          battle:
            typeof ev.reveal_index === 'number' && ev.phase === 'reveal'
              ? { ...phased, reveal_index: ev.reveal_index }
              : phased,
        },
        refetch: !step,
      };
    }

    case 'vote_progress': {
      // Counts only. A malformed payload is not trusted: refetch the snapshot's counts.
      const ok = isCount(ev.voted_count) && isCount(ev.eligible_count);
      return {
        next: ok
          ? {
              ...snap,
              battle,
              vote_progress: { voted_count: ev.voted_count, eligible_count: ev.eligible_count },
            }
          : { ...snap, battle },
        refetch: !ok,
      };
    }

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
