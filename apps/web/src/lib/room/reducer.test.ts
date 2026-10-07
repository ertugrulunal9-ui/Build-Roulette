/**
 * The room state reducer: version rules and every room / battle event of the Realtime
 * contract (supabase/README.md "Realtime").
 */
import { describe, expect, it } from 'vitest';
import {
  applyBattleEvent,
  applyRoomEvent,
  checkVersion,
  parseBattleEvent,
  parseRoomEvent,
} from './reducer';
import { BATTLE_2, BOB, CLEO, ME, battleSnapshot, member, roomSnapshot } from './test-support';
import type { RoomEvent } from './types';

describe('checkVersion', () => {
  it('drops stale and duplicate versions, applies the next one, flags gaps', () => {
    expect(checkVersion(5, 4)).toBe('stale');
    expect(checkVersion(5, 5)).toBe('stale');
    expect(checkVersion(5, 6)).toBe('next');
    expect(checkVersion(5, 7)).toBe('gap');
    expect(checkVersion(0, 1)).toBe('next');
  });
});

describe('parse events', () => {
  it('keeps known events and turns unknown types into sync', () => {
    expect(parseRoomEvent({ type: 'member', version: 3, user_id: BOB })).toMatchObject({
      type: 'member',
      version: 3,
    });
    expect(parseRoomEvent({ type: 'future_thing', version: 4 })).toEqual({
      type: 'sync',
      version: 4,
    });
    expect(
      parseBattleEvent({ type: 'vote_progress', version: 9, voted_count: 1, eligible_count: 3 }),
    ).toEqual({ type: 'vote_progress', version: 9, voted_count: 1, eligible_count: 3 });
    expect(parseBattleEvent({ type: 'something_new', version: 9 })).toEqual({
      type: 'sync',
      version: 9,
    });
    expect(parseBattleEvent({ type: 'phase', phase: 'building', version: 2 })).toMatchObject({
      type: 'phase',
    });
  });

  it('rejects payloads without a numeric version', () => {
    expect(parseRoomEvent(null)).toBeNull();
    expect(parseRoomEvent({ type: 'member' })).toBeNull();
    expect(parseBattleEvent({ type: 'phase', version: '3' })).toBeNull();
    expect(parseBattleEvent('nope')).toBeNull();
  });
});

const memberEvent = (
  userId: string,
  change: Extract<RoomEvent, { type: 'member' }>['change'],
  extra: Partial<Extract<RoomEvent, { type: 'member' }>> = {},
): RoomEvent => ({
  type: 'member',
  version: 2,
  change,
  user_id: userId,
  display_name: 'Bob',
  role: 'player',
  is_ready: false,
  state: 'active',
  ...extra,
});

describe('applyRoomEvent', () => {
  it('member_ready updates the member and the version', () => {
    const snap = roomSnapshot({ version: 1 });
    const { next, refetch } = applyRoomEvent(
      snap,
      memberEvent(BOB, 'member_ready', { is_ready: true }),
    );
    expect(refetch).toBe(false);
    expect(next.room.version).toBe(2);
    expect(next.members.find((m) => m.user_id === BOB)?.is_ready).toBe(true);
    // Immutable: the old snapshot is untouched.
    expect(snap.members.find((m) => m.user_id === BOB)?.is_ready).toBe(false);
    expect(snap.room.version).toBe(1);
  });

  it('my own changes update `me` too', () => {
    const { next } = applyRoomEvent(
      roomSnapshot(),
      memberEvent(ME, 'member_ready', { display_name: 'Ada', is_ready: true }),
    );
    expect(next.me.is_ready).toBe(true);
    const promoted = applyRoomEvent(
      roomSnapshot({ members: [member(ME, 'Ada', { role: 'spectator' })] }),
      memberEvent(ME, 'member_promoted', { display_name: 'Ada', role: 'player' }),
    ).next;
    expect(promoted.me.role).toBe('player');
  });

  it('a newcomer is appended from the payload', () => {
    const snap = roomSnapshot({ members: [member(ME, 'Ada')] });
    const { next, refetch } = applyRoomEvent(
      snap,
      memberEvent(BOB, 'member_joined', { role: 'spectator' }),
    );
    expect(refetch).toBe(false);
    expect(next.members.map((m) => [m.user_id, m.role, m.joined_at])).toEqual([
      [ME, 'player', snap.members[0]?.joined_at],
      [BOB, 'spectator', null],
    ]);
  });

  it('a member who left stays listed as left; a rejoin makes them active again', () => {
    const left = applyRoomEvent(
      roomSnapshot(),
      memberEvent(BOB, 'member_left', { state: 'left' }),
    ).next;
    const bob = left.members.find((m) => m.user_id === BOB);
    expect(bob?.state).toBe('left');
    expect(bob?.left_at).not.toBeNull();
    const back = applyRoomEvent(
      left,
      memberEvent(BOB, 'member_joined', { version: 3, state: 'active' }),
    ).next;
    expect(back.members.find((m) => m.user_id === BOB)).toMatchObject({
      state: 'active',
      left_at: null,
    });
  });

  it('a kicked member disappears; if it is me, me.state says so', () => {
    const { next } = applyRoomEvent(
      roomSnapshot(),
      memberEvent(CLEO, 'member_kicked', { state: 'kicked' }),
    );
    expect(next.members.map((m) => m.user_id)).toEqual([ME, BOB]);
    expect(next.me.state).toBe('active');
    const mine = applyRoomEvent(
      roomSnapshot({ hostId: BOB }),
      memberEvent(ME, 'member_kicked', { state: 'kicked' }),
    ).next;
    expect(mine.me.state).toBe('kicked');
    expect(mine.members.some((m) => m.user_id === ME)).toBe(false);
  });

  it('host_changed moves the crown', () => {
    const snap = roomSnapshot({ hostId: ME });
    const { next, refetch } = applyRoomEvent(snap, {
      type: 'room',
      version: 2,
      change: 'host_changed',
      status: 'open',
      host_id: BOB,
      settings: { max_players: 8 },
      current_battle_id: null,
      reason: 'absent',
    });
    expect(refetch).toBe(false);
    expect(next.room.host_id).toBe(BOB);
    expect(next.me.is_host).toBe(false);
    expect(next.members.filter((m) => m.is_host).map((m) => m.user_id)).toEqual([BOB]);
  });

  it('settings update max_players (clamped)', () => {
    const { next } = applyRoomEvent(roomSnapshot(), {
      type: 'room',
      version: 2,
      change: 'settings',
      status: 'open',
      host_id: ME,
      settings: { max_players: 4 },
      current_battle_id: null,
    });
    expect(next.room.max_players).toBe(4);
    expect(next.room.settings).toEqual({ max_players: 4 });
  });

  it('battle_started and battle_ended ask for a refetch (the battle summary changed)', () => {
    const started = applyRoomEvent(roomSnapshot(), {
      type: 'room',
      version: 2,
      change: 'battle_started',
      status: 'in_battle',
      host_id: ME,
      settings: {},
      current_battle_id: BATTLE_2,
    });
    expect(started.refetch).toBe(true);
    expect(started.next.room).toMatchObject({ status: 'in_battle', current_battle_id: BATTLE_2 });
    const ended = applyRoomEvent(roomSnapshot({ battleId: BATTLE_2 }), {
      type: 'room',
      version: 2,
      change: 'battle_ended',
      status: 'open',
      host_id: ME,
      settings: {},
      current_battle_id: BATTLE_2,
    });
    expect(ended.refetch).toBe(true);
    expect(ended.next.room.status).toBe('open');
  });

  it('sync bumps the version and refetches', () => {
    const { next, refetch } = applyRoomEvent(roomSnapshot(), { type: 'sync', version: 2 });
    expect(refetch).toBe(true);
    expect(next.room.version).toBe(2);
  });
});

describe('applyBattleEvent', () => {
  it('phase applies the new deadline and always refetches', () => {
    const snap = battleSnapshot({ phase: 'spinning', version: 1 });
    const { next, refetch } = applyBattleEvent(snap, {
      type: 'phase',
      version: 2,
      phase: 'building',
      phase_started_at: '2026-10-06T12:00:06.000Z',
      phase_ends_at: '2026-10-06T12:05:06.000Z',
    });
    expect(refetch).toBe(true);
    expect(next.battle).toMatchObject({
      version: 2,
      phase: 'building',
      phase_ends_at: '2026-10-06T12:05:06.000Z',
    });
  });

  it('a REVEAL slot step moves the spotlight without a refetch', () => {
    const snap = battleSnapshot({ phase: 'reveal', version: 10, revealIndex: 0 });
    const { next, refetch } = applyBattleEvent(snap, {
      type: 'phase',
      version: 11,
      phase: 'reveal',
      phase_started_at: '2026-10-07T12:01:00.000Z',
      phase_ends_at: '2026-10-07T12:02:00.000Z',
      reason: 'host_next',
      reveal_index: 1,
    });
    expect(refetch).toBe(false);
    expect(next.battle).toMatchObject({
      version: 11,
      phase: 'reveal',
      reveal_index: 1,
      phase_started_at: '2026-10-07T12:01:00.000Z',
      phase_ends_at: '2026-10-07T12:02:00.000Z',
    });
    expect(next.builds).toBe(snap.builds);
    expect(snap.battle.reveal_index).toBe(0);
  });

  it('entering REVEAL, leaving it, or a step the snapshot cannot place refetches', () => {
    const phase = (p: 'reveal' | 'voting', revealIndex?: number) => ({
      type: 'phase' as const,
      version: 11,
      phase: p,
      phase_started_at: null,
      phase_ends_at: null,
      ...(revealIndex === undefined ? {} : { reveal_index: revealIndex }),
    });
    // SHIPPING → REVEAL: the reveal order comes with the snapshot.
    const shipping = applyBattleEvent(
      battleSnapshot({ phase: 'shipping', version: 10 }),
      phase('reveal', 0),
    );
    expect(shipping.refetch).toBe(true);
    expect(shipping.next.battle).toMatchObject({ phase: 'reveal', reveal_index: 0 });
    const reveal = battleSnapshot({ phase: 'reveal', version: 10 });
    // REVEAL → VOTING: ballot rights and the progress come with the snapshot.
    expect(applyBattleEvent(reveal, phase('voting')).refetch).toBe(true);
    // Out of range, missing or malformed indexes.
    expect(applyBattleEvent(reveal, phase('reveal', 3)).refetch).toBe(true);
    expect(applyBattleEvent(reveal, phase('reveal')).refetch).toBe(true);
    expect(applyBattleEvent(reveal, phase('reveal', 1.5)).refetch).toBe(true);
    expect(applyBattleEvent(reveal, phase('reveal', -1)).refetch).toBe(true);
  });

  it('vote_progress updates the counts without a refetch; a malformed one refetches', () => {
    const snap = battleSnapshot({ phase: 'voting', version: 20 });
    const { next, refetch } = applyBattleEvent(snap, {
      type: 'vote_progress',
      version: 21,
      voted_count: 2,
      eligible_count: 3,
    });
    expect(refetch).toBe(false);
    expect(next.vote_progress).toEqual({ voted_count: 2, eligible_count: 3 });
    expect(next.battle.version).toBe(21);
    const bad = applyBattleEvent(snap, {
      type: 'vote_progress',
      version: 21,
      voted_count: -1,
      eligible_count: 3,
    });
    expect(bad.refetch).toBe(true);
    expect(bad.next.vote_progress).toEqual({ voted_count: 0, eligible_count: 3 });
    expect(bad.next.battle.version).toBe(21);
  });

  it('build marks the builder shipped with the name and completion time', () => {
    const { next, refetch } = applyBattleEvent(battleSnapshot({ version: 2 }), {
      type: 'build',
      version: 3,
      build_id: 'build-bob',
      user_id: BOB,
      status: 'shipped',
      name: 'Snack Overflow',
      completion_ms: 192_000,
    });
    expect(refetch).toBe(false);
    expect(next.builds.find((b) => b.builder_id === BOB)).toMatchObject({
      status: 'shipped',
      name: 'Snack Overflow',
      completion_ms: 192_000,
    });
    expect(next.builds.find((b) => b.builder_id === CLEO)?.status).toBe('draft');
  });

  it('player updates the roster state and a kicked draft becomes disqualified', () => {
    const { next } = applyBattleEvent(battleSnapshot({ version: 2 }), {
      type: 'player',
      version: 3,
      user_id: CLEO,
      status: 'kicked',
      build_status: 'disqualified',
    });
    expect(next.players.find((p) => p.user_id === CLEO)?.state).toBe('kicked');
    expect(next.builds.find((b) => b.builder_id === CLEO)?.status).toBe('disqualified');
    const left = applyBattleEvent(battleSnapshot({ version: 2 }), {
      type: 'player',
      version: 3,
      user_id: BOB,
      status: 'left',
    }).next;
    expect(left.players.find((p) => p.user_id === BOB)?.state).toBe('left');
    expect(left.builds.find((b) => b.builder_id === BOB)?.status).toBe('draft');
  });

  it('host updates host_id and me.is_host', () => {
    const { next } = applyBattleEvent(battleSnapshot({ version: 2, hostId: BOB }), {
      type: 'host',
      version: 3,
      host_id: ME,
    });
    expect(next.battle.host_id).toBe(ME);
    expect(next.me.is_host).toBe(true);
  });

  it('capture updates the status and refetches for the screenshot path', () => {
    const { next, refetch } = applyBattleEvent(battleSnapshot({ version: 5, phase: 'results' }), {
      type: 'capture',
      version: 6,
      build_id: 'build-me',
      capture_status: 'captured',
    });
    expect(refetch).toBe(true);
    expect(next.builds.find((b) => b.id === 'build-me')?.capture_status).toBe('captured');
  });

  it('destroyed and sync refetch', () => {
    const snap = battleSnapshot({ version: 7, phase: 'destroyed' });
    expect(applyBattleEvent(snap, { type: 'destroyed', version: 8 })).toMatchObject({
      refetch: true,
      next: { battle: { version: 8 } },
    });
    expect(applyBattleEvent(snap, { type: 'sync', version: 8 }).refetch).toBe(true);
  });
});
