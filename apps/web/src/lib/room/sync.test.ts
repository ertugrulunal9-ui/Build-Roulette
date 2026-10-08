/**
 * The room sync engine with a fake API, a fake Realtime, a fake environment and vitest's
 * fake timers: subscription order, event ordering, duplicates, stale events, gaps,
 * buffering during fetches, battle switching, heartbeat, recovery, reconnects, presence
 * throttling and teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realClock } from '../solo/controller';
import { GameError } from '../solo/errors';
import { RoomSync, normalizePresence, type SyncNotice, type SyncTimings } from './sync';
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
/** What the engine's clock.random() returns (join stagger, rejoin jitter). */
let random: number;

const ROOM_TOPIC = `room:${ROOM}`;
const B1_TOPIC = `battle:${BATTLE_1}`;
const B2_TOPIC = `battle:${BATTLE_2}`;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function engine(timings?: Partial<SyncTimings>): RoomSync {
  const s = new RoomSync({
    api,
    realtime: rt,
    env,
    userId: ME,
    clock: { ...realClock, random: () => random },
    timings,
  });
  s.onNotice((n) => notices.push(n));
  return s;
}

/** Starts an engine and lets the room topic subscribe. */
async function started(timings?: Partial<SyncTimings>): Promise<RoomSync> {
  const s = engine(timings);
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
  random = 0;
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

  it('joins the battle topic a random 0–500 ms later (no join burst at battle start); the snapshot is fetched at once and again on SUBSCRIBED', async () => {
    random = 0.5; // 250 ms
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 4 }));
    const s = await started();
    expect(rt.isOpen(B1_TOPIC)).toBe(false);
    expect(s.getSnapshot().battle?.battle.version).toBe(4); // shown at once
    await vi.advanceTimersByTimeAsync(249);
    expect(rt.isOpen(B1_TOPIC)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rt.isOpen(B1_TOPIC)).toBe(true);
    // An event sent before the join is not lost: the SUBSCRIBED refetch has it.
    api.battles.set(BATTLE_1, battleSnapshot({ version: 5, phase: 'shipping' }));
    api.clearCalls();
    rt.open(B1_TOPIC).status('SUBSCRIBED');
    await flush();
    expect(api.count('getBattleSnapshot', BATTLE_1)).toBe(1);
    expect(s.getSnapshot().battle?.battle).toMatchObject({ version: 5, phase: 'shipping' });
    s.stop();

    // Stopped (or switched) before the join: no subscription, no timer left.
    random = 0.999;
    const t = await started();
    t.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rt.topics.filter((x) => x.topic === B1_TOPIC)).toHaveLength(1); // the first engine's
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures the clock offset with 3 server_now samples, then resyncs with 1 every 60 s', async () => {
    api.serverOffsetMs = 42_000;
    const s = await started();
    expect(api.count('serverNow')).toBe(3);
    expect(s.getSnapshot().clockOffsetMs).toBe(42_000);
    // One sample every 60 s (T-029: was 3), and it moves the offset.
    api.serverOffsetMs = 43_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count('serverNow')).toBe(4);
    expect(s.getSnapshot().clockOffsetMs).toBe(43_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.count('serverNow')).toBe(6);
    s.stop();
  });

  it('a resync sample with a slow round trip is ignored; recovery measures with 3 again', async () => {
    api.serverOffsetMs = 42_000;
    const s = await started();
    expect(s.getSnapshot().clockOffsetMs).toBe(42_000);
    // The next sample takes 2 s and claims a different clock: not trusted.
    const serverNow = api.serverNow.bind(api);
    api.serverNow = async () => {
      await new Promise((r) => setTimeout(r, 2_000));
      return Date.now() - 1_000 + 50_000;
    };
    await vi.advanceTimersByTimeAsync(62_000);
    expect(s.getSnapshot().clockOffsetMs).toBe(42_000);
    // The page comes back: a full measurement (3 samples) is taken whatever their RTT.
    api.serverNow = serverNow;
    api.serverOffsetMs = 44_000;
    api.clearCalls();
    env.fire('visible');
    await flush();
    expect(api.count('serverNow')).toBe(3);
    expect(s.getSnapshot().clockOffsetMs).toBe(44_000);
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

  it('REVEAL slot steps and vote progress apply without a refetch; a gap still refetches', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 10, phase: 'reveal', revealIndex: 0 }));
    const s = await started();
    api.clearCalls();
    const topic = rt.open(B1_TOPIC);
    const step = (version: number, revealIndex: number) => ({
      type: 'phase',
      version,
      phase: 'reveal',
      phase_started_at: new Date().toISOString(),
      phase_ends_at: new Date(Date.now() + 60_000).toISOString(),
      reason: 'host_next',
      reveal_index: revealIndex,
    });
    topic.send(step(11, 1));
    await flush();
    expect(s.getSnapshot().battle?.battle).toMatchObject({ version: 11, reveal_index: 1 });
    expect(api.count('getBattleSnapshot')).toBe(0);

    // VOTING comes with a refetch (ballot rights, progress)…
    api.battles.set(BATTLE_1, battleSnapshot({ version: 12, phase: 'voting' }));
    topic.send({ ...step(12, 0), phase: 'voting', reveal_index: undefined });
    await flush();
    expect(api.count('getBattleSnapshot')).toBe(1);
    // …then every completed ballot is a counter, not a refetch storm.
    for (const [v, n] of [
      [13, 1],
      [14, 2],
    ] as const) {
      topic.send({ type: 'vote_progress', version: v, voted_count: n, eligible_count: 3 });
    }
    await flush();
    expect(s.getSnapshot().battle?.vote_progress).toEqual({ voted_count: 2, eligible_count: 3 });
    expect(api.count('getBattleSnapshot')).toBe(1);

    // A missed vote_progress (16 after 14) is a gap: refetch.
    api.battles.set(
      BATTLE_1,
      battleSnapshot({
        version: 16,
        phase: 'voting',
        voteProgress: { voted_count: 3, eligible_count: 3 },
      }),
    );
    topic.send({ type: 'vote_progress', version: 16, voted_count: 3, eligible_count: 3 });
    await flush();
    expect(api.count('getBattleSnapshot')).toBe(2);
    expect(s.getSnapshot().battle?.vote_progress).toEqual({ voted_count: 3, eligible_count: 3 });
    s.stop();
  });

  it('every other phase event refetches the battle snapshot', async () => {
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

  // A host change: applied from its payload alone (no refetch of its own).
  const hostEvent = (version: number) => ({ type: 'host', version, host_id: BOB });

  it('separate holes in a row are each refetched (a lossy link never freezes the battle)', async () => {
    const { s, topic } = await inBattle();
    // Every other event is lost: 3, 5, 7, 9 arrive; the server is always one ahead.
    for (const v of [4, 6, 8, 10]) {
      api.battles.set(BATTLE_1, battleSnapshot({ version: v, phase: 'building' }));
      topic.send(hostEvent(v));
      await flush();
      expect(s.getSnapshot().battle?.battle.version).toBe(v);
    }
    expect(api.count('getBattleSnapshot')).toBe(4);
    expect(s.stats.gaps).toBe(4);
    // And the next event in line applies as usual.
    topic.send(hostEvent(11));
    expect(s.getSnapshot().battle?.battle.version).toBe(11);
    s.stop();
  });

  it('a hole the refetch does not close is retried with backoff; the event is kept', async () => {
    const { s, topic } = await inBattle();
    // The snapshot lags behind the event (still version 2) for a while.
    topic.send(hostEvent(5));
    await flush();
    expect(api.count('getBattleSnapshot')).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.count('getBattleSnapshot')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count('getBattleSnapshot')).toBe(2); // +1 s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.count('getBattleSnapshot')).toBe(3); // +2 s
    // The server catches up (version 4): event 5 is the next one and is applied.
    api.battles.set(BATTLE_1, battleSnapshot({ version: 4, phase: 'building' }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(api.count('getBattleSnapshot')).toBe(4); // +4 s
    expect(s.getSnapshot().battle?.battle.version).toBe(5);
    // Settled: no more retries, and the next hole is fetched at once again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count('getBattleSnapshot')).toBe(4);
    api.battles.set(BATTLE_1, battleSnapshot({ version: 7, phase: 'building' }));
    topic.send(hostEvent(7));
    await flush();
    expect(api.count('getBattleSnapshot')).toBe(5);
    expect(s.getSnapshot().battle?.battle.version).toBe(7);
    s.stop();
  });

  it('a failed refetch is retried with backoff (at most every 30 s) until it succeeds', async () => {
    const { s, topic } = await inBattle();
    const fresh = api.onBattle;
    api.onBattle = () => {
      throw new GameError('network');
    };
    topic.send({
      type: 'phase',
      version: 3,
      phase: 'shipping',
      phase_started_at: new Date().toISOString(),
      phase_ends_at: new Date(Date.now() + 15_000).toISOString(),
    });
    await flush();
    expect(api.count('getBattleSnapshot')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000);
    expect(api.count('getBattleSnapshot')).toBe(6);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.count('getBattleSnapshot')).toBe(7); // capped at 30 s
    api.battles.set(BATTLE_1, battleSnapshot({ version: 3, phase: 'shipping' }));
    api.onBattle = fresh;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.count('getBattleSnapshot')).toBe(8);
    expect(s.getSnapshot().battle?.battle).toMatchObject({ version: 3, phase: 'shipping' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.count('getBattleSnapshot')).toBe(8);
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

  it('a battle event Realtime never delivered is caught by the next beat (the version in its answer)', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 10, phase: 'reveal', revealIndex: 0 }));
    const s = await started();
    rt.open(B1_TOPIC).status('SUBSCRIBED');
    await flush();
    api.clearCalls();
    // Up to date: one request per beat (T-029: the heartbeat answers the version), no fetch.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.calls).toEqual([['heartbeat', ROOM]]);
    // The host moves to the next build; the broadcast is lost (the channel stays subscribed).
    api.battles.set(BATTLE_1, battleSnapshot({ version: 11, phase: 'reveal', revealIndex: 1 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.count('getBattleSnapshot', BATTLE_1)).toBe(1);
    expect(s.getSnapshot().battle?.battle).toMatchObject({ version: 11, reveal_index: 1 });
    expect(s.stats.missed).toBe(1);
    // A late copy of the event is then stale, not applied twice.
    rt.open(B1_TOPIC).send({
      type: 'phase',
      version: 11,
      phase: 'reveal',
      reveal_index: 1,
      phase_started_at: new Date().toISOString(),
      phase_ends_at: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(s.stats.stale).toBe(1);
    s.stop();
  });

  it('a heartbeat ahead of a battle that is over, of another battle, or without the fields (an older server) refetches nothing', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 20, phase: 'destroyed' }));
    const s = await started();
    api.onBattleVersion = () => 25;
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.calls).toEqual([['heartbeat', ROOM]]);
    s.stop();

    api.battles.set(BATTLE_1, battleSnapshot({ version: 5, phase: 'building' }));
    const t = await started();
    const heartbeat = api.onHeartbeat;
    // Another battle id (e.g. the answer of a rematch the room snapshot has not seen yet).
    api.onHeartbeat = async () => ({ ...(await heartbeat()), battle_id: BATTLE_2 });
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.count('getBattleSnapshot')).toBe(0);
    // An older server: no battle fields at all.
    api.onHeartbeat = async () => {
      const { server_now, room_version, host_id, status } = await heartbeat();
      return { server_now, room_version, host_id, status };
    };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.count('heartbeat')).toBe(2);
    expect(api.count('getBattleSnapshot')).toBe(0);
    expect(t.stats.missed).toBe(0);
    expect(t.getSnapshot().ended).toBeNull();
    t.stop();
  });

  it('a RESULTS battle whose DESTROYED never arrived is caught within one beat', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 30, phase: 'results' }));
    const s = await started();
    rt.open(B1_TOPIC).status('SUBSCRIBED');
    await flush();
    api.battles.set(BATTLE_1, battleSnapshot({ version: 31, phase: 'destroyed' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.getSnapshot().battle?.battle).toMatchObject({ version: 31, phase: 'destroyed' });
    expect(s.stats.missed).toBe(1);
    s.stop();
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

  it('offline: degraded at once and polling (the socket may look open); online: live and resynced', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot());
    const s = await started();
    expect(s.getSnapshot().connection).toBe('live');
    env.fire('offline');
    expect(s.getSnapshot().connection).toBe('degraded');
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.count('getRoomSnapshot')).toBe(1);
    expect(api.count('getBattleSnapshot')).toBe(1);
    env.fire('online');
    expect(s.getSnapshot().connection).toBe('live');
    await flush();
    expect(api.count('getRoomSnapshot')).toBe(2); // the resync
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.count('getRoomSnapshot')).toBe(0); // no more polling
    s.stop();
  });

  it('a channel the server closes is subscribed again after 5 s, 10 s, 20 s, 30 s (supabase-js does not); SUBSCRIBED alone does not reset that', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot());
    const s = await started();
    s.setPresence('Ada');
    const first = rt.open(ROOM_TOPIC);
    first.status('CLOSED'); // e.g. "Too many presence messages per second"
    expect(s.getSnapshot().connection).toBe('degraded');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rt.open(ROOM_TOPIC)).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    const second = rt.open(ROOM_TOPIC);
    expect(second).not.toBe(first);
    expect(second.presenceKey).toBe(ME);
    // Closed again before it could join: the next try waits 10 s.
    second.status('CLOSED');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(rt.open(ROOM_TOPIC)).toBe(second);
    await vi.advanceTimersByTimeAsync(1);
    const third = rt.open(ROOM_TOPIC);
    // A late status of an old subscription changes nothing.
    first.status('SUBSCRIBED');
    expect(s.getSnapshot().connection).toBe('degraded');
    third.status('SUBSCRIBED');
    await flush();
    expect(s.getSnapshot().connection).toBe('live');
    expect(third.tracked).toHaveLength(1); // presence is claimed again
    // The rate limit closes it again 3 s later: 20 s, not back to 5 s (no rejoin storm).
    await vi.advanceTimersByTimeAsync(3_000);
    third.status('CLOSED');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rt.open(ROOM_TOPIC)).toBe(third);
    await vi.advanceTimersByTimeAsync(1);
    const fourth = rt.open(ROOM_TOPIC);
    fourth.status('CLOSED');
    await vi.advanceTimersByTimeAsync(29_999); // capped at 30 s
    expect(rt.open(ROOM_TOPIC)).toBe(fourth);
    await vi.advanceTimersByTimeAsync(1);
    const fifth = rt.open(ROOM_TOPIC);
    fifth.status('SUBSCRIBED');
    await flush();
    // Up for 2 minutes: two levels down (4 closes: level 4 → 2), so the next wait is 20 s.
    await vi.advanceTimersByTimeAsync(120_000);
    fifth.status('CLOSED');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rt.open(ROOM_TOPIC)).toBe(fifth);
    await vi.advanceTimersByTimeAsync(1);
    expect(rt.open(ROOM_TOPIC)).not.toBe(fifth);
    // The battle topic has its own level: 5 s.
    const battle = rt.open(B1_TOPIC);
    battle.status('CLOSED');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rt.open(B1_TOPIC)).toBe(battle);
    await vi.advanceTimersByTimeAsync(1);
    expect(rt.open(B1_TOPIC)).not.toBe(battle);
    api.clearCalls();
    rt.open(B1_TOPIC).status('SUBSCRIBED');
    await flush();
    expect(api.count('getBattleSnapshot')).toBe(1);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejoin delays get up to half again as random jitter', async () => {
    random = 0.999;
    const s = await started();
    const first = rt.open(ROOM_TOPIC);
    first.status('CLOSED');
    await vi.advanceTimersByTimeAsync(7_400);
    expect(rt.open(ROOM_TOPIC)).toBe(first);
    await vi.advanceTimersByTimeAsync(100); // 5 s × 1.4995
    expect(rt.open(ROOM_TOPIC)).not.toBe(first);
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
  const building = () => {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 2, phase: 'building' }));
  };
  const act = (lines: number, typing = true, last_build: 'ok' | 'error' = 'ok') => ({
    lines,
    last_build,
    typing,
  });

  it('claims {user_id, display_name, device, activity} once subscribed, in any phase', async () => {
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
    s.stop();
  });

  it('BUILD activity goes out at most once per 15 s, only when it matters, the latest winning', async () => {
    building();
    const s = await started();
    s.setPresence('Ada');
    const topic = rt.open(ROOM_TOPIC);
    await flush();
    expect(topic.tracked).toHaveLength(1); // the claim
    // Starts typing: matters, but 15 s after the claim at the earliest; more lines meanwhile.
    s.setActivity(act(5));
    await vi.advanceTimersByTimeAsync(5_000);
    s.setActivity(act(12));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(topic.tracked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(topic.tracked).toHaveLength(2);
    expect(topic.tracked[1]).toMatchObject({ activity: act(12) });
    // Small line changes do not matter on their own: nothing for a minute.
    for (let lines = 13; lines <= 31; lines++) {
      s.setActivity(act(lines));
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(topic.tracked).toHaveLength(2);
    // 20 lines more than the others saw: sent (the gap is long over).
    s.setActivity(act(32));
    expect(topic.tracked).toHaveLength(3);
    // The build breaks 1 s later (and stays broken past 10 s): out when the 15 s gap is over.
    await vi.advanceTimersByTimeAsync(1_000);
    s.setActivity(act(33, true, 'error'));
    await vi.advanceTimersByTimeAsync(13_999);
    expect(topic.tracked).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(topic.tracked.at(-1)).toMatchObject({ activity: act(33, true, 'error') });
    // A change that stops mattering before its turn is not sent: fixed again within 15 s.
    s.setActivity(act(33, true, 'ok'));
    await vi.advanceTimersByTimeAsync(5_000);
    s.setActivity(act(34, true, 'error'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(topic.tracked).toHaveLength(4);
    s.stop();
  });

  it('a build that fails for a moment is not news; one that fails for 10 s is, and so is its fix', async () => {
    building();
    const s = await started();
    s.setPresence('Ada');
    const topic = rt.open(ROOM_TOPIC);
    s.setActivity(act(10));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(topic.tracked).toHaveLength(2); // the claim, then active
    // A half-typed line breaks the build for 2 s, again and again: nothing is sent.
    for (let i = 0; i < 10; i++) {
      s.setActivity(act(10, true, 'error'));
      await vi.advanceTimersByTimeAsync(2_000);
      s.setActivity(act(10, true, 'ok'));
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(topic.tracked).toHaveLength(2);
    // Now it stays broken: reported once it has failed for 10 s.
    s.setActivity(act(11, true, 'error'));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(topic.tracked).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(topic.tracked.at(-1)).toMatchObject({ activity: act(11, true, 'error') });
    // Fixed: that matters at once (well, after the 15 s gap).
    s.setActivity(act(12, true, 'ok'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(topic.tracked).toHaveLength(4);
    expect(topic.tracked.at(-1)).toMatchObject({ activity: act(12, true, 'ok') });
    s.stop();
  });

  it('no activity updates outside BUILDING (none in SPINNING, SHIPPING, REVEAL, VOTING, RESULTS or after)', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 1, phase: 'spinning' }));
    const s = await started();
    s.setPresence('Ada');
    const topic = rt.open(ROOM_TOPIC);
    const battle = rt.open(B1_TOPIC);
    await flush();
    expect(topic.tracked).toHaveLength(1);
    const phase = (
      version: number,
      to: 'building' | 'shipping' | 'reveal' | 'voting' | 'results' | 'destroyed',
    ) => {
      api.battles.set(BATTLE_1, battleSnapshot({ version, phase: to }));
      battle.send({
        type: 'phase',
        version,
        phase: to,
        phase_started_at: new Date().toISOString(),
        phase_ends_at: new Date(Date.now() + 600_000).toISOString(),
      });
    };
    s.setActivity(act(40));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(topic.tracked).toHaveLength(1); // SPINNING: held back
    // BUILDING starts: the held-back activity goes out.
    phase(2, 'building');
    await flush();
    expect(topic.tracked).toHaveLength(2);
    expect(topic.tracked[1]).toMatchObject({ activity: act(40) });
    for (const [v, to] of [
      [3, 'shipping'],
      [4, 'reveal'],
      [5, 'voting'],
      [6, 'results'],
      [7, 'destroyed'],
    ] as const) {
      phase(v, to);
      await flush();
      s.setActivity(act(40 + v * 30, v % 2 === 0, v % 2 === 0 ? 'ok' : 'error'));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(topic.tracked).toHaveLength(2);
    // A (re)subscribe still claims presence, with the latest activity.
    topic.status('CHANNEL_ERROR', 'socket closed');
    topic.status('SUBSCRIBED');
    await flush();
    expect(topic.tracked).toHaveLength(3);
    s.stop();
  });

  it('someone typing for two minutes: one update per 15 s at most (Realtime closes channels above 5 per 30 s), and the final count once they stop', async () => {
    building();
    const s = await started();
    s.setPresence('Ada');
    const topic = rt.open(ROOM_TOPIC);
    const times: number[] = [];
    const track = topic.track.bind(topic);
    topic.track = (p) => {
      times.push(Date.now());
      return track(p);
    };
    // A new line every 500 ms.
    for (let i = 1; i <= 240; i++) {
      s.setActivity(act(i));
      await vi.advanceTimersByTimeAsync(500);
    }
    for (const [i, t] of times.entries()) {
      if (i > 0) expect(t - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(15_000);
    }
    expect(times.length).toBeGreaterThanOrEqual(6);
    expect(times.length).toBeLessThanOrEqual(9); // was 16 with 4 per 30 s
    // They stop: no longer active, so the latest count goes out.
    s.setActivity(act(240, false));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(topic.tracked.at(-1)).toMatchObject({ activity: act(240, false) });
    s.stop();
  });

  it('holds presence back while offline and sends one update when back online', async () => {
    building();
    const s = await started();
    s.setPresence('Ada');
    const topic = rt.open(ROOM_TOPIC);
    await vi.advanceTimersByTimeAsync(20_000);
    const before = topic.tracked.length;
    env.fire('offline');
    for (let i = 1; i <= 10; i++) {
      s.setActivity(act(i * 30));
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(topic.tracked).toHaveLength(before);
    env.fire('online');
    expect(topic.tracked).toHaveLength(before + 1);
    expect(topic.tracked.at(-1)).toMatchObject({ activity: { lines: 300 } });
    s.stop();
  });

  it('a refused track is claimed again at the next chance', async () => {
    building();
    const s = await started();
    const topic = rt.open(ROOM_TOPIC);
    topic.trackResult = false;
    s.setPresence('Ada');
    await flush();
    expect(topic.tracked).toHaveLength(1);
    topic.trackResult = true;
    // Unchanged activity, but the claim is owed: it goes out after the 2 s gap.
    s.setActivity({ lines: 0, last_build: 'ok', typing: false });
    await vi.advanceTimersByTimeAsync(2_000);
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
    expect(env.size).toBe(2); // resume + offline
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
