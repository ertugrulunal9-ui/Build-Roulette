/**
 * The room sync engine with a fake API, a fake Realtime, a fake environment and vitest's
 * fake timers: subscription order, event ordering, duplicates, stale events, gaps,
 * buffering during fetches, battle switching, heartbeat, recovery, reconnects, presence
 * throttling and teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameError } from '../solo/errors';
import { RoomSync, normalizePresence, type SyncNotice } from './sync';
import {
  BATTLE_1,
  BATTLE_2,
  BOB,
  CLEO,
  FakeEnvironment,
  FakeRealtime,
  FakeRoomApi,
  ME,
  ROOM,
  battleSnapshot,
  roomSnapshot,
} from './test-support';

let api: FakeRoomApi;
let rt: FakeRealtime;
let env: FakeEnvironment;
let notices: SyncNotice[];

const ROOM_TOPIC = `room:${ROOM}`;
const B1_TOPIC = `battle:${BATTLE_1}`;
const B2_TOPIC = `battle:${BATTLE_2}`;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function engine(): RoomSync {
  const s = new RoomSync({ api, realtime: rt, env, userId: ME });
  s.onNotice((n) => notices.push(n));
  return s;
}

/** Starts an engine and lets the room topic subscribe. */
async function started(): Promise<RoomSync> {
  const s = engine();
  await s.start(ROOM);
  rt.open(ROOM_TOPIC).status('SUBSCRIBED');
  await flush();
  return s;
}

const member = (version: number, userId: string, extra: Record<string, unknown> = {}) => ({
  type: 'member',
  version,
  change: 'member_ready',
  user_id: userId,
  display_name: 'Bob',
  role: 'player',
  is_ready: true,
  state: 'active',
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-06T12:00:00Z') });
  api = new FakeRoomApi();
  rt = new FakeRealtime();
  env = new FakeEnvironment();
  notices = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('start', () => {
  it('sets the Realtime auth before subscribing to the private room topic, then fetches', async () => {
    const order: string[] = [];
    rt.setAuth = () => {
      order.push('setAuth');
      return Promise.resolve();
    };
    const subscribe = rt.subscribe.bind(rt);
    rt.subscribe = (topic, opts, handlers) => {
      order.push(`subscribe ${topic}`);
      return subscribe(topic, opts, handlers);
    };
    const s = engine();
    expect(s.getSnapshot().connection).toBe('idle');
    await s.start(ROOM);
    expect(order).toEqual(['setAuth', `subscribe ${ROOM_TOPIC}`]);
    expect(rt.open(ROOM_TOPIC).presenceKey).toBe(ME);
    await flush();
    expect(s.getSnapshot()).toMatchObject({ roomId: ROOM, connection: 'connecting' });
    expect(s.getSnapshot().room?.room.code).toBe('K7QXM');
    // SUBSCRIBED refetches (anything may have happened in between).
    const before = api.count('getRoomSnapshot');
    rt.open(ROOM_TOPIC).status('SUBSCRIBED');
    await flush();
    expect(api.count('getRoomSnapshot')).toBe(before + 1);
    expect(s.getSnapshot().connection).toBe('live');
    s.stop();
  });

  it('subscribes to the current battle and fetches its snapshot', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 4 }));
    const s = await started();
    expect(rt.isOpen(B1_TOPIC)).toBe(true);
    expect(rt.open(B1_TOPIC).presenceKey).toBeNull(); // Presence lives on the room topic
    expect(s.getSnapshot().battle?.battle.version).toBe(4);
    s.stop();
  });

  it('measures the clock offset with server_now (lowest RTT)', async () => {
    api.serverOffsetMs = 42_000;
    const s = await started();
    expect(api.count('serverNow')).toBe(3);
    expect(s.getSnapshot().clockOffsetMs).toBe(42_000);
    // Again every 60 s.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count('serverNow')).toBe(6);
    s.stop();
  });
});

describe('room events', () => {
  it('applies events in order and ignores duplicate and stale versions', async () => {
    api.room = roomSnapshot({ version: 1 });
    const s = await started();
    const topic = rt.open(ROOM_TOPIC);
    api.clearCalls();
    topic.send(member(2, BOB));
    topic.send(member(3, CLEO, { display_name: 'Cleo' }));
    topic.send(member(3, CLEO, { display_name: 'Cleo', is_ready: false })); // duplicate
    topic.send(member(1, BOB, { is_ready: false })); // stale
    const room = s.getSnapshot().room;
    expect(room?.room.version).toBe(3);
    expect(room?.members.filter((m) => m.is_ready).map((m) => m.user_id)).toEqual([BOB, CLEO]);
    expect(s.stats).toMatchObject({ applied: 2, stale: 2, gaps: 0 });
    expect(api.count('getRoomSnapshot')).toBe(0);
    expect(notices.map((n) => n.event.version)).toEqual([2, 3]);
    s.stop();
  });

  it('a gap refetches the snapshot; the missed event is not applied twice', async () => {
    api.room = roomSnapshot({ version: 1 });
    const s = await started();
    const topic = rt.open(ROOM_TOPIC);
    // Versions 2..4 happened; this client only sees 4.
    const server = roomSnapshot({ version: 4 });
    server.members = server.members.map((m) => ({ ...m, is_ready: true }));
    api.room = server;
    api.clearCalls();
    topic.send(member(4, BOB));
    await flush();
    expect(api.count('getRoomSnapshot')).toBe(1);
    expect(s.stats.gaps).toBe(1);
    expect(s.getSnapshot().room?.room.version).toBe(4);
    expect(s.getSnapshot().room?.members.every((m) => m.is_ready)).toBe(true);
    // Version 5 follows normally.
    topic.send(member(5, BOB, { is_ready: false }));
    expect(s.getSnapshot().room?.room.version).toBe(5);
    s.stop();
  });

  it('buffers events that arrive while a snapshot is in flight and replays the newer ones', async () => {
    api.room = roomSnapshot({ version: 1 });
    const s = await started();
    const topic = rt.open(ROOM_TOPIC);
    let release: (() => void) | undefined;
    const slow = roomSnapshot({ version: 3 });
    api.onRoom = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(structuredClone(slow));
        };
      });
    void s.refetchRoom();
    topic.send(member(3, BOB)); // already in the snapshot being fetched
    topic.send(member(4, CLEO, { display_name: 'Cleo' }));
    expect(s.getSnapshot().room?.room.version).toBe(1);
    release?.();
    await flush();
    const room = s.getSnapshot().room;
    expect(room?.room.version).toBe(4);
    expect(room?.members.find((m) => m.user_id === CLEO)?.is_ready).toBe(true);
    expect(room?.members.find((m) => m.user_id === BOB)?.is_ready).toBe(false);
    expect(s.stats.stale).toBe(1);
    s.stop();
  });

  it('a host change is applied and notified', async () => {
    const s = await started();
    rt.open(ROOM_TOPIC).send({
      type: 'room',
      version: 2,
      change: 'host_changed',
      status: 'open',
      host_id: BOB,
      settings: { max_players: 8 },
      current_battle_id: null,
    });
    expect(s.getSnapshot().room?.room.host_id).toBe(BOB);
    expect(notices.at(-1)).toMatchObject({ topic: 'room', event: { change: 'host_changed' } });
    s.stop();
  });

  it('an unknown event type is a sync: the snapshot is refetched', async () => {
    const s = await started();
    api.room = roomSnapshot({ version: 2 });
    api.clearCalls();
    rt.open(ROOM_TOPIC).send({ type: 'brand_new', version: 2 });
    await flush();
    expect(api.count('getRoomSnapshot')).toBe(1);
    s.stop();
  });
});

describe('battle events', () => {
  async function inBattle() {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 2, phase: 'building' }));
    const s = await started();
    api.clearCalls();
    return { s, topic: rt.open(B1_TOPIC) };
  }

  it('a ship is applied without a refetch and notified', async () => {
    const { s, topic } = await inBattle();
    topic.send({
      type: 'build',
      version: 3,
      build_id: 'build-bob',
      user_id: BOB,
      status: 'shipped',
      name: 'Snack Overflow',
      completion_ms: 192_000,
    });
    expect(s.getSnapshot().battle?.builds.find((b) => b.builder_id === BOB)?.name).toBe(
      'Snack Overflow',
    );
    expect(api.count('getBattleSnapshot')).toBe(0);
    expect(notices.at(-1)).toMatchObject({ topic: 'battle', event: { type: 'build' } });
    s.stop();
  });

  it('every phase event refetches the battle snapshot', async () => {
    const { s, topic } = await inBattle();
    api.battles.set(BATTLE_1, battleSnapshot({ version: 3, phase: 'shipping' }));
    topic.send({
      type: 'phase',
      version: 3,
      phase: 'shipping',
      phase_started_at: new Date().toISOString(),
      phase_ends_at: new Date(Date.now() + 15_000).toISOString(),
    });
    expect(s.getSnapshot().battle?.battle.phase).toBe('shipping'); // at once, from the payload
    await flush();
    expect(api.count('getBattleSnapshot', BATTLE_1)).toBe(1);
    s.stop();
  });

  it('a gap on the battle topic refetches; duplicates are ignored', async () => {
    const { s, topic } = await inBattle();
    api.battles.set(BATTLE_1, battleSnapshot({ version: 6, phase: 'results' }));
    topic.send({ type: 'capture', version: 6, build_id: 'build-me', capture_status: 'captured' });
    await flush();
    expect(api.count('getBattleSnapshot')).toBe(1);
    expect(s.getSnapshot().battle?.battle).toMatchObject({ version: 6, phase: 'results' });
    // The gap event itself was replayed on the fetched snapshot (already version 6): stale.
    expect(s.stats.stale).toBe(1);
    topic.send({ type: 'capture', version: 6, build_id: 'build-me', capture_status: 'captured' });
    expect(s.stats.stale).toBe(2);
    expect(api.count('getBattleSnapshot')).toBe(1);
    s.stop();
  });

  it('switches the battle topic when a new battle starts (rematch)', async () => {
    const { s } = await inBattle();
    const room = rt.open(ROOM_TOPIC);
    api.room = roomSnapshot({ battleId: BATTLE_2, version: 5 });
    api.battles.set(BATTLE_2, battleSnapshot({ id: BATTLE_2, version: 1, phase: 'spinning' }));
    room.send({
      type: 'room',
      version: 4,
      change: 'battle_started',
      status: 'in_battle',
      host_id: ME,
      settings: {},
      current_battle_id: BATTLE_2,
    });
    // The old topic closes at once and the old snapshot is dropped.
    expect(rt.isOpen(B1_TOPIC)).toBe(false);
    expect(rt.isOpen(B2_TOPIC)).toBe(true);
    await flush();
    expect(s.getSnapshot().battle?.battle.id).toBe(BATTLE_2);
    // Late events of the old battle are not applied to the new one.
    const oldTopic = rt.topics.find((t) => t.topic === B1_TOPIC);
    oldTopic?.send({ type: 'destroyed', version: 99 });
    expect(s.getSnapshot().battle?.battle.version).toBe(1);
    s.stop();
  });
});

describe('heartbeat', () => {
  it('beats every 10 s and refetches when the room moved on', async () => {
    const s = await started();
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.count('heartbeat', ROOM)).toBe(1);
    expect(api.count('getRoomSnapshot')).toBe(0);
    api.room = roomSnapshot({ version: 7, hostId: BOB });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.count('heartbeat')).toBe(2);
    expect(api.count('getRoomSnapshot')).toBe(1);
    expect(s.getSnapshot().room?.room.host_id).toBe(BOB);
    s.stop();
  });

  it.each([
    ['kicked', 'kicked'],
    ['room_closed', 'closed'],
    ['not_a_member', 'left'],
    ['room_not_found', 'gone'],
  ] as const)('a %s heartbeat ends the session (%s)', async (code, reason) => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot());
    const s = await started();
    api.onHeartbeat = () => {
      throw new GameError(code);
    };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.getSnapshot()).toMatchObject({ ended: reason, connection: 'stopped' });
    expect(rt.isOpen(ROOM_TOPIC)).toBe(false);
    expect(rt.isOpen(B1_TOPIC)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a network failure is retried by the next beat', async () => {
    const s = await started();
    api.onHeartbeat = () => {
      throw new GameError('network');
    };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.count('heartbeat')).toBe(2);
    expect(s.getSnapshot().ended).toBeNull();
    s.stop();
  });
});

describe('kicked through an event', () => {
  it('a member event that kicks me ends the session', async () => {
    api.room = roomSnapshot({ hostId: BOB });
    const s = await started();
    rt.open(ROOM_TOPIC).send(
      member(2, ME, { change: 'member_kicked', state: 'kicked', display_name: 'Ada' }),
    );
    expect(s.getSnapshot().ended).toBe('kicked');
    expect(rt.isOpen(ROOM_TOPIC)).toBe(false);
  });

  it('a refetch that finds no room asks the heartbeat whether I was kicked', async () => {
    const s = await started();
    api.onRoom = () => {
      throw new GameError('room_not_found');
    };
    api.onHeartbeat = () => {
      throw new GameError('kicked');
    };
    await s.refetchRoom();
    await flush();
    expect(s.getSnapshot().ended).toBe('kicked');
  });
});

describe('recovery', () => {
  it('visible and online resync the clock and both snapshots', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot());
    const s = await started();
    for (const reason of ['visible', 'online'] as const) {
      api.clearCalls();
      env.fire(reason);
      await flush();
      expect(api.count('serverNow')).toBe(3);
      expect(api.count('getRoomSnapshot')).toBe(1);
      expect(api.count('getBattleSnapshot')).toBe(1);
      expect(api.count('heartbeat')).toBe(1);
    }
    s.stop();
  });

  it('a dropped channel polls until Realtime rejoins, then refetches and tracks again', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot());
    const s = await started();
    s.setPresence('Ada');
    const topic = rt.open(ROOM_TOPIC);
    expect(topic.tracked).toHaveLength(1);
    topic.status('CHANNEL_ERROR', 'socket closed');
    expect(s.getSnapshot().connection).toBe('degraded');
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.count('getRoomSnapshot')).toBe(1);
    expect(api.count('getBattleSnapshot')).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.count('getRoomSnapshot')).toBe(2);
    // supabase-js rejoins: SUBSCRIBED again.
    vi.advanceTimersByTime(2_000);
    topic.status('SUBSCRIBED');
    await flush();
    expect(s.getSnapshot().connection).toBe('live');
    expect(api.count('getRoomSnapshot')).toBe(3);
    expect(topic.tracked).toHaveLength(2); // presence is claimed again
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.count('getRoomSnapshot')).toBe(0); // no more polling
    s.stop();
  });
});

describe('presence', () => {
  it('tracks {user_id, display_name, device, activity} once subscribed, at most every 2 s', async () => {
    const s = engine();
    await s.start(ROOM);
    s.setPresence('Ada');
    const topic = rt.open(ROOM_TOPIC);
    expect(topic.tracked).toHaveLength(0); // not subscribed yet
    topic.status('SUBSCRIBED');
    await flush();
    expect(topic.tracked).toEqual([
      {
        user_id: ME,
        display_name: 'Ada',
        device: 'desktop',
        activity: { lines: 0, last_build: 'ok', typing: false },
      },
    ]);
    for (let lines = 1; lines <= 10; lines++) {
      s.setActivity({ lines, last_build: 'ok', typing: true });
      vi.advanceTimersByTime(150);
    }
    expect(topic.tracked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(topic.tracked).toHaveLength(2);
    expect(topic.tracked[1]).toMatchObject({ activity: { lines: 10, typing: true } });
    // Unchanged activity is not sent again.
    s.setActivity({ lines: 10, last_build: 'ok', typing: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(topic.tracked).toHaveLength(2);
    s.stop();
  });

  it('exposes the presence state by user', async () => {
    const s = await started();
    rt.open(ROOM_TOPIC).presence({
      [BOB]: [
        {
          user_id: BOB,
          display_name: 'Bob',
          device: 'mobile',
          activity: { lines: 12, last_build: 'error', typing: false },
          presence_ref: 'x',
        },
      ],
    });
    expect(s.getSnapshot().presence[BOB]).toEqual({
      user_id: BOB,
      display_name: 'Bob',
      device: 'mobile',
      activity: { lines: 12, last_build: 'error', typing: false },
    });
    s.stop();
  });

  it('normalizePresence merges tabs of one user and drops junk', () => {
    expect(
      normalizePresence({
        [BOB]: [
          { user_id: BOB, display_name: 'Bob', activity: { lines: 3, typing: false } },
          { user_id: BOB, display_name: 'Bob', activity: { lines: 9, typing: true } },
        ],
        junk: [{ nope: true }],
      }),
    ).toEqual({
      [BOB]: {
        user_id: BOB,
        display_name: 'Bob',
        device: 'desktop',
        activity: { lines: 9, last_build: 'ok', typing: true },
      },
    });
  });
});

describe('stop', () => {
  it('closes both topics, stops every timer and removes the listeners', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot());
    const s = await started();
    expect(env.size).toBe(1);
    s.stop();
    expect(rt.topics.every((t) => t.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(env.size).toBe(0);
    expect(s.getSnapshot().connection).toBe('stopped');
    // Late events and fetches are ignored.
    api.clearCalls();
    rt.topics[0]?.send(member(9, BOB));
    env.fire('visible');
    await flush();
    expect(api.calls).toEqual([]);
  });
});
