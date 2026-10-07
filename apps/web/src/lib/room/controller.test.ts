/**
 * RoomController with fakes: the join flow and its error screens, the lobby intents, the
 * battle controller per battle (rematch), toasts, leaving and being kicked, and roomView.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { battleWorkspaceId } from '../solo/controller';
import { GameError } from '../solo/errors';
import { FakeApi, FakeLocalWorkspaces } from '../solo/test-support';
import { RoomController, playerCount, readyCount, roomView, type NameStore } from './controller';
import {
  BATTLE_1,
  BATTLE_2,
  BOB,
  FakeEnvironment,
  FakeRealtime,
  FakeRoomApi,
  ME,
  ROOM,
  battleSnapshot,
  member,
  roomSnapshot,
  storeRevealObjects,
} from './test-support';

let api: FakeRoomApi;
let rt: FakeRealtime;
let local: FakeLocalWorkspaces;
let saved: string | null;
const names: NameStore = {
  get: () => saved,
  set: (n) => {
    saved = n;
  },
};

const ROOM_TOPIC = `room:${ROOM}`;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function controller(code = 'k7qxm'): RoomController {
  return new RoomController(code, {
    api,
    soloApi: new FakeApi(),
    realtime: rt,
    cdnBaseUrl: 'https://pkg.test',
    localWorkspaces: local,
    nameStore: names,
    env: new FakeEnvironment(),
  });
}

/** A controller that joined and whose room topic is subscribed. */
async function joined(): Promise<RoomController> {
  const c = controller();
  await c.init();
  rt.open(ROOM_TOPIC).status('SUBSCRIBED');
  await flush();
  return c;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-06T12:00:00Z') });
  api = new FakeRoomApi();
  rt = new FakeRealtime();
  local = new FakeLocalWorkspaces();
  saved = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('joining', () => {
  it('with a profile name: joins at once with the canonical code and opens the room', async () => {
    const c = controller('  k7qxm ');
    await c.init();
    expect(api.calls.slice(0, 3)).toEqual([
      ['ensureSession'],
      ['profileName', ME],
      ['joinRoom', 'K7QXM', 'Ada'],
    ]);
    await flush();
    const s = c.getSnapshot();
    expect(s.stage).toBe('room');
    expect(s.sync.room?.room.code).toBe('K7QXM');
    expect(saved).toBe('Ada');
    c.dispose();
  });

  it('without a profile name: asks for one, prefilled with the remembered name', async () => {
    api.profile = null;
    saved = 'Turbo Otter';
    const c = controller();
    await c.init();
    expect(c.getSnapshot()).toMatchObject({ stage: 'name', displayName: 'Turbo Otter' });
    expect(api.count('joinRoom')).toBe(0);
    await c.join('  Neon Moth ');
    expect(api.calls.find((x) => x[0] === 'joinRoom')).toEqual(['joinRoom', 'K7QXM', 'Neon Moth']);
    expect(c.getSnapshot().stage).toBe('room');
    c.dispose();
  });

  it('without any name: a random fun default', async () => {
    api.profile = null;
    const c = controller();
    await c.init();
    expect(c.getSnapshot().displayName).toMatch(/^\w+ \w+$/);
    c.dispose();
  });

  it.each(['room_not_found', 'room_closed', 'kicked', 'room_full', 'rate_limited'] as const)(
    '%s ends on the join error screen',
    async (code) => {
      api.onJoin = () => {
        throw new GameError(code);
      };
      const c = controller();
      await c.init();
      expect(c.getSnapshot()).toMatchObject({ stage: 'join_error', error: { code } });
      expect(rt.topics).toHaveLength(0);
      c.dispose();
    },
  );

  it('invalid_display_name goes back to the name prompt', async () => {
    api.onJoin = () => {
      throw new GameError('invalid_display_name');
    };
    const c = controller();
    await c.init();
    expect(c.getSnapshot()).toMatchObject({
      stage: 'name',
      error: { code: 'invalid_display_name' },
    });
    c.dispose();
  });

  it('a malformed code is room_not_found without asking the server', async () => {
    const c = controller('nope!');
    expect(c.getSnapshot().code).toBeNull();
    await c.init();
    expect(c.getSnapshot()).toMatchObject({
      stage: 'join_error',
      error: { code: 'room_not_found' },
    });
    expect(api.calls).toEqual([]);
    c.dispose();
  });

  it('retry joins again after a transient failure', async () => {
    let fail = true;
    api.onJoin = (code) => {
      if (fail) throw new GameError('network');
      return { room_id: ROOM, code, role: 'player' };
    };
    const c = controller();
    await c.init();
    expect(c.getSnapshot().stage).toBe('join_error');
    fail = false;
    await c.retry();
    expect(c.getSnapshot().stage).toBe('room');
    c.dispose();
  });
});

describe('lobby intents', () => {
  it('ready, settings, kick and start call the RPCs with the room id', async () => {
    const c = await joined();
    await c.setReady(true);
    await c.setMaxPlayers(4);
    await c.kick(BOB);
    await c.start();
    expect(
      api.calls.filter((x) => !['getRoomSnapshot', 'serverNow', 'heartbeat'].includes(x[0])),
    ).toEqual([
      ['ensureSession'],
      ['profileName', ME],
      ['joinRoom', 'K7QXM', 'Ada'],
      ['setReady', ROOM, true],
      ['updateSettings', ROOM, { max_players: 4 }],
      ['kickMember', ROOM, BOB],
      ['startBattle', ROOM],
    ]);
    expect(c.getSnapshot().pending).toEqual({
      ready: false,
      start: false,
      settings: false,
      kick: null,
      leave: false,
    });
    c.dispose();
  });

  it('a failed intent shows the error and refetches the room', async () => {
    const c = await joined();
    api.failWith = new GameError('not_enough_players');
    api.clearCalls();
    await c.start();
    expect(c.getSnapshot().actionError?.code).toBe('not_enough_players');
    await flush();
    expect(api.count('getRoomSnapshot')).toBe(1);
    c.dismissActionError();
    expect(c.getSnapshot().actionError).toBeNull();
    c.dispose();
  });

  it('counts ready and active players', () => {
    const room = roomSnapshot({
      members: [
        member(ME, 'Ada', { is_ready: true }),
        member(BOB, 'Bob', { is_ready: true, state: 'left' }),
        member('x', 'Spec', { role: 'spectator', is_ready: true }),
        member('y', 'Yan'),
      ],
    });
    expect(readyCount(room)).toBe(1);
    expect(playerCount(room)).toBe(2);
  });
});

describe('battles', () => {
  it('runs the current battle in an external-mode SoloController, a new one per rematch', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 2, phase: 'building' }));
    const c = await joined();
    const first = c.getSnapshot().battle;
    expect(first?.getSnapshot()).toMatchObject({ stage: 'battle', battleId: BATTLE_1 });
    // No polling: the snapshot comes from the engine only.
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(api.count('getBattleSnapshot')).toBe(0);

    // Events reach the battle controller.
    rt.open(`battle:${BATTLE_1}`).send({
      type: 'build',
      version: 3,
      build_id: 'build-bob',
      user_id: BOB,
      status: 'shipped',
      name: 'Snack Overflow',
      completion_ms: 192_000,
    });
    expect(first?.getSnapshot().snapshot?.builds.find((b) => b.builder_id === BOB)?.status).toBe(
      'shipped',
    );
    expect(c.getSnapshot().toasts.map((t) => t.text)).toContain(
      '🚀 Bob shipped “Snack Overflow” at 3:12',
    );

    // Rematch: a new battle id → a new controller, the old one is disposed.
    api.room = roomSnapshot({ battleId: BATTLE_2, version: 5 });
    api.battles.set(BATTLE_2, battleSnapshot({ id: BATTLE_2, version: 1, phase: 'spinning' }));
    rt.open(ROOM_TOPIC).send({
      type: 'room',
      version: 4,
      change: 'battle_started',
      status: 'in_battle',
      host_id: ME,
      settings: {},
      current_battle_id: BATTLE_2,
    });
    await flush();
    const second = c.getSnapshot().battle;
    expect(second).not.toBe(first);
    expect(second?.getSnapshot().battleId).toBe(BATTLE_2);
    c.dispose();
  });

  it('REVEAL and VOTING run in a RevealVoteController fed by the same snapshots', async () => {
    storeRevealObjects(api);
    api.room = roomSnapshot({ battleId: BATTLE_1, version: 3 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 10, phase: 'reveal', revealIndex: 0 }));
    const c = await joined();
    const show = c.getSnapshot().show;
    expect(show?.getSnapshot()).toMatchObject({ battleId: BATTLE_1 });
    expect(show?.getSnapshot().bundles['build-me']?.status).toBe('ready');
    // A slot step from the host: the spotlight's next build is already there (prefetched).
    rt.open(`battle:${BATTLE_1}`).send({
      type: 'phase',
      version: 11,
      phase: 'reveal',
      phase_started_at: new Date().toISOString(),
      phase_ends_at: new Date(Date.now() + 60_000).toISOString(),
      reason: 'host_next',
      reveal_index: 1,
    });
    await flush();
    expect(c.getSnapshot().battle?.getSnapshot().snapshot?.battle.reveal_index).toBe(1);
    expect(Object.keys(show?.getSnapshot().bundles ?? {}).sort()).toEqual([
      'build-bob',
      'build-cleo',
    ]);
    // The next battle disposes it with its SoloController.
    api.room = roomSnapshot({ battleId: BATTLE_2, version: 5 });
    api.battles.set(BATTLE_2, battleSnapshot({ id: BATTLE_2, version: 1, phase: 'spinning' }));
    rt.open(ROOM_TOPIC).send({
      type: 'room',
      version: 4,
      change: 'battle_started',
      status: 'in_battle',
      host_id: ME,
      settings: {},
      current_battle_id: BATTLE_2,
    });
    await flush();
    expect(c.getSnapshot().show).not.toBe(show);
    expect(c.getSnapshot().show?.getSnapshot().battleId).toBe(BATTLE_2);
    c.dispose();
  });

  it('the battle controller refetches through the engine (e.g. after a deadline nudge)', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot({ version: 2, phase: 'spinning', endsInMs: 1_000 }));
    const c = await joined();
    api.clearCalls();
    await vi.advanceTimersByTimeAsync(1_600); // deadline + max jitter
    // The SoloApi nudged advance_battle; then the engine fetched the snapshot.
    expect(api.count('getBattleSnapshot', BATTLE_1)).toBeGreaterThanOrEqual(1);
    c.dispose();
  });

  it('a host change makes a toast', async () => {
    const c = await joined();
    rt.open(ROOM_TOPIC).send({
      type: 'room',
      version: 2,
      change: 'host_changed',
      status: 'open',
      host_id: BOB,
      settings: { max_players: 8 },
      current_battle_id: null,
    });
    expect(c.getSnapshot().toasts.map((t) => t.text)).toEqual(['👑 Bob is the host now.']);
    // Toasts go away on their own.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.getSnapshot().toasts).toEqual([]);
    c.dispose();
  });
});

describe('roomView', () => {
  it('shows the battle while it runs and during its destroy moment, then the lobby', () => {
    const inBattle = roomSnapshot({ battleId: BATTLE_1 });
    const open = roomSnapshot({ battleId: BATTLE_1, status: 'open' });
    expect(roomView(null, null, 'none')).toBe('loading');
    expect(roomView(roomSnapshot(), null, 'none')).toBe('lobby');
    expect(roomView(inBattle, null, 'none')).toBe('loading');
    expect(roomView(inBattle, battleSnapshot({ phase: 'building' }), 'none')).toBe('battle');
    expect(roomView(inBattle, battleSnapshot({ phase: 'results' }), 'none')).toBe('battle');
    // The room reopened before this client saw DESTROYED: keep showing the results.
    expect(roomView(open, battleSnapshot({ phase: 'results' }), 'none')).toBe('battle');
    expect(roomView(open, battleSnapshot({ phase: 'destroyed' }), 'animating')).toBe('battle');
    expect(roomView(open, battleSnapshot({ phase: 'destroyed' }), 'done')).toBe('lobby');
    expect(roomView(open, battleSnapshot({ phase: 'destroyed' }), 'none')).toBe('lobby');
    // A snapshot of another battle does not count.
    expect(roomView(inBattle, battleSnapshot({ id: BATTLE_2 }), 'none')).toBe('loading');
  });
});

describe('leaving and being kicked', () => {
  it('leave calls leave_room, deletes a running battle workspace and ends the session', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot({ phase: 'building' }));
    const c = await joined();
    await c.leave();
    expect(api.count('leaveRoom', ROOM)).toBe(1);
    expect(local.deleted).toEqual([battleWorkspaceId(BATTLE_1)]);
    expect(c.getSnapshot()).toMatchObject({ stage: 'ended', ended: 'left', battle: null });
    expect(rt.topics.every((t) => t.closed)).toBe(true);
    // Rejoin.
    await c.retry();
    expect(c.getSnapshot().stage).toBe('room');
    c.dispose();
  });

  it('a failed leave keeps the room', async () => {
    const c = await joined();
    api.failWith = new GameError('network');
    await c.leave();
    expect(c.getSnapshot()).toMatchObject({ stage: 'room', actionError: { code: 'network' } });
    c.dispose();
  });

  it('the kick event ends the session with the kicked state', async () => {
    api.room = roomSnapshot({ hostId: BOB });
    const c = await joined();
    rt.open(ROOM_TOPIC).send({
      type: 'member',
      version: 2,
      change: 'member_kicked',
      user_id: ME,
      display_name: 'Ada',
      role: 'player',
      is_ready: false,
      state: 'kicked',
    });
    expect(c.getSnapshot()).toMatchObject({ stage: 'ended', ended: 'kicked' });
    expect(vi.getTimerCount()).toBe(0);
    c.dispose();
  });

  it('dispose stops everything', async () => {
    api.room = roomSnapshot({ battleId: BATTLE_1 });
    api.battles.set(BATTLE_1, battleSnapshot({ phase: 'building' }));
    const c = await joined();
    c.dispose();
    expect(rt.topics.every((t) => t.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
