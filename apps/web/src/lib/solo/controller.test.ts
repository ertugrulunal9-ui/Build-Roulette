/**
 * SoloController with a fake API, a fake workspace and vitest's fake timers (which also
 * drive Date.now()). Covers phase handling, the countdown and deadline nudges, autosave
 * scheduling, the ship flow, results and destroy, and the error mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoloController, battleWorkspaceId, realClock, type SoloState } from './controller';
import { GameError } from './errors';
import { BATTLE, FakeApi, FakeBridge, FakeLocalWorkspaces, USER, snapshotAt } from './test-support';

let api: FakeApi;
let local: FakeLocalWorkspaces;
let battleChanges: (string | null)[];

function controller(random = 0): SoloController {
  return new SoloController({
    api,
    cdnBaseUrl: 'https://pkg.test',
    localWorkspaces: local,
    clock: { ...realClock, random: () => random },
    onBattleChange: (id) => battleChanges.push(id),
  });
}

/** Lets pending promise chains settle without moving the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Opens BATTLE in `phase` (as if `?battle=` was in the URL). */
async function openIn(snapshot = snapshotAt('building', { endsInMs: 300_000, version: 2 })) {
  api.snapshot = snapshot;
  const c = controller();
  c.init(BATTLE);
  await flush();
  return c;
}

const state = (c: SoloController): SoloState => c.getSnapshot();

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-06T12:00:00Z') });
  api = new FakeApi();
  local = new FakeLocalWorkspaces();
  battleChanges = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('start and resume', () => {
  it('signs in, starts a battle and opens it in SPINNING', async () => {
    const c = controller();
    expect(state(c).stage).toBe('name');
    const started = c.start('  Turbo Otter  ');
    expect(state(c).stage).toBe('starting');
    await started;
    expect(api.calls.slice(0, 2)).toEqual([['ensureSession'], ['startSoloBattle', 'Turbo Otter']]);
    expect(state(c)).toMatchObject({ stage: 'battle', battleId: BATTLE, userId: USER });
    expect(state(c).snapshot?.battle.phase).toBe('spinning');
    expect(battleChanges).toEqual([BATTLE]);
    c.dispose();
  });

  it('cleans up stale battle workspaces only: over on the server, or untouched for 24 h', async () => {
    const running = '44444444-4444-4444-8444-444444444444'; // another tab plays it
    const destroyed = '55555555-5555-4555-8555-555555555555';
    const unknown = '66666666-6666-4666-8666-666666666666'; // the server does not say
    const ancient = '77777777-7777-4777-8777-777777777777';
    for (const id of [BATTLE, running, destroyed, unknown]) {
      local.stored.set(battleWorkspaceId(id), Date.now() - 60_000);
    }
    local.stored.set(battleWorkspaceId(ancient), Date.now() - 25 * 60 * 60 * 1000);
    api.phases = { [running]: 'building', [destroyed]: 'destroyed', [ancient]: 'building' };
    const c = controller();
    await c.start('Turbo Otter');
    await flush();
    expect(local.deleted.sort()).toEqual(
      [battleWorkspaceId(destroyed), battleWorkspaceId(ancient)].sort(),
    );
    expect([...local.stored.keys()].sort()).toEqual(
      [BATTLE, running, unknown].map(battleWorkspaceId).sort(),
    );
    // Only the recent ones were asked about (the open battle never).
    expect(api.calls.find((call) => call[0] === 'battlePhases')).toEqual([
      'battlePhases',
      [running, destroyed, unknown],
    ]);
    c.dispose();
  });

  it('battle_in_progress offers to resume the running battle', async () => {
    api.onStart = () => {
      throw new GameError('battle_in_progress', BATTLE);
    };
    const c = controller();
    await c.start('Otter');
    expect(state(c)).toMatchObject({ stage: 'resume', resumeBattleId: BATTLE, error: null });
    await c.resume();
    expect(state(c)).toMatchObject({ stage: 'battle', battleId: BATTLE });
    c.dispose();
  });

  it('cancelResume goes back to the name entry', async () => {
    api.onStart = () => {
      throw new GameError('battle_in_progress', BATTLE);
    };
    const c = controller();
    await c.start('Otter');
    c.cancelResume();
    expect(state(c)).toMatchObject({ stage: 'name', resumeBattleId: null });
    c.dispose();
  });

  it('a refused start stays on the name entry with the error', async () => {
    api.onStart = () => {
      throw new GameError('invalid_display_name', 'The display name must be 1 to 24 characters.');
    };
    const c = controller();
    await c.start('x'.repeat(30));
    expect(state(c).stage).toBe('name');
    expect(state(c).error?.code).toBe('invalid_display_name');
    c.dismissError();
    expect(state(c).error).toBeNull();
    c.dispose();
  });

  it('a battle that cannot be opened returns to the name entry', async () => {
    const c = controller();
    c.init('44444444-4444-4444-8444-444444444444');
    await flush();
    expect(state(c).stage).toBe('name');
    expect(state(c).error?.code).toBe('battle_not_found');
    expect(battleChanges).toEqual([null]);
    c.dispose();
  });
});

describe('clock and countdown', () => {
  it('estimates the server clock offset from server_now samples', async () => {
    api.serverOffsetMs = 5_000;
    const c = await openIn(
      snapshotAt('building', { endsInMs: 60_000, serverOffsetMs: 5_000, version: 2 }),
    );
    expect(api.count('serverNow')).toBe(3);
    expect(state(c).clockOffsetMs).toBe(5_000);
    // phase_ends_at is 60 s after the server's now, which is 5 s ahead of ours.
    expect(c.remainingMs()).toBe(60_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.remainingMs()).toBe(40_000);
    c.dispose();
  });

  it('nudges advance_battle once the deadline passes (plus jitter), then follows the new phase', async () => {
    api.snapshot = snapshotAt('spinning', { endsInMs: 6_000, version: 1 });
    api.onAdvance = (v) => {
      api.snapshot = snapshotAt('building', { version: v + 1, endsInMs: 300_000 });
      return { changed: true, version: v + 1, phase: 'building', phase_ends_at: null };
    };
    const c = controller(0.5); // jitter = 250 ms
    c.init(BATTLE);
    await flush();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(api.count('advanceBattle')).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(api.calls.filter((x) => x[0] === 'advanceBattle')).toEqual([
      ['advanceBattle', BATTLE, 1],
    ]);
    expect(state(c).snapshot?.battle.phase).toBe('building');
    expect(c.remainingMs()).toBe(300_000);
    c.dispose();
  });

  it('a battle that does not move after a nudge is nudged again after 5, 10, 20, then every 30 s; a new version starts over', async () => {
    const at: number[] = [];
    const advance = api.onAdvance;
    api.onAdvance = (v) => {
      at.push(Date.now());
      return advance(v);
    };
    const t0 = Date.now();
    const c = await openIn(snapshotAt('shipping', { endsInMs: 0, version: 5 }));
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 30_000 + 30_000);
    expect(at.map((t) => t - t0)).toEqual([0, 5_000, 15_000, 35_000, 65_000, 95_000]);
    // The battle moves (a new version, still overdue): nudged at once, then 5 s again.
    api.snapshot = snapshotAt('shipping', { endsInMs: 0, version: 6 });
    const t1 = Date.now();
    await vi.advanceTimersByTimeAsync(2_500); // the next poll brings it
    expect(at).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(at).toHaveLength(8);
    expect((at[7] ?? 0) - (at[6] ?? 0)).toBe(5_000);
    expect((at[6] ?? 0) - t1).toBeLessThanOrEqual(2_500);
    c.dispose();
  });

  it('RESULTS is not nudged while a screenshot is pending (the sweep ends it); once it is in, it is', async () => {
    const c = await openIn(
      snapshotAt('results', { endsInMs: 0, version: 5, status: 'shipped', capture: 'pending' }),
    );
    const polls = api.count('getSnapshot');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count('advanceBattle')).toBe(0);
    // Polled at the phase's pace (2 s), not every 250 ms.
    expect(api.count('getSnapshot') - polls).toBeLessThanOrEqual(31);
    // The screenshot is in: the next snapshot shows it, and RESULTS is nudged at once.
    api.snapshot = snapshotAt('results', {
      endsInMs: 0,
      version: 6,
      status: 'shipped',
      capture: 'captured',
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.count('advanceBattle')).toBe(1);
    // The sweep or the nudge ended it: DESTROYED arrives, and the nudging stops.
    api.snapshot = snapshotAt('destroyed', { endsInMs: null, version: 7, status: 'shipped' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state(c).snapshot?.battle.phase).toBe('destroyed');
    expect(api.count('advanceBattle')).toBe(1);
    c.dispose();
  });

  it('a pending capture of a build that is not final (DNF) does not hold the RESULTS nudge back', async () => {
    const c = await openIn(
      snapshotAt('results', { endsInMs: 0, version: 5, status: 'dnf', capture: 'pending' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count('advanceBattle')).toBe(1);
    c.dispose();
  });

  it('resyncs the clock with one server_now sample every 60 s', async () => {
    api.serverOffsetMs = 5_000;
    const c = await openIn(
      snapshotAt('building', { endsInMs: 300_000, serverOffsetMs: 5_000, version: 2 }),
    );
    expect(api.count('serverNow')).toBe(3);
    api.serverOffsetMs = 6_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count('serverNow')).toBe(4);
    expect(state(c).clockOffsetMs).toBe(6_000);
    c.dispose();
  });

  it('polls the snapshot and picks up deadlines the server moved', async () => {
    const c = await openIn(snapshotAt('building', { endsInMs: 300_000, version: 2 }));
    const polls = api.count('getSnapshot');
    api.snapshot = snapshotAt('building', { endsInMs: 5_000, version: 3 });
    await vi.advanceTimersByTimeAsync(10_000); // the BUILD poll interval
    expect(api.count('getSnapshot')).toBeGreaterThan(polls);
    expect(c.remainingMs()).toBeLessThanOrEqual(5_000);
    c.dispose();
  });

  it('dispose stops every timer', async () => {
    const c = await openIn();
    c.dispose();
    const n = api.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(api.calls.length).toBe(n);
  });
});

describe('autosave', () => {
  it('uploads the last good build and the workspace every 30 s, only when something changed', async () => {
    const c = await openIn();
    const bridge = new FakeBridge();
    c.attachWorkspace(bridge);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.uploadsOf('autosave/bundle.js')).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls.filter((x) => x[0] === 'upload').map((x) => x[1])).toEqual([
      'autosave/bundle.js',
      'autosave/bundle.css',
      'autosave/source.json',
      'autosave/manifest.json',
    ]);
    // The manifest has the pinned dependencies only (others read it during REVEAL).
    expect(JSON.parse(api.files.get(`${BATTLE}/${USER}/autosave/manifest.json`) as string)).toEqual(
      {
        dependencies: {
          react: expect.any(String) as string,
          'react-dom': expect.any(String) as string,
        },
      },
    );
    expect(api.files.get(`${BATTLE}/${USER}/autosave/bundle.js`)).toBe('dev-js');
    expect(api.files.get(`${BATTLE}/${USER}/autosave/bundle.css`)).toBe('dev-css');
    const source = JSON.parse(
      api.files.get(`${BATTLE}/${USER}/autosave/source.json`) as string,
    ) as {
      files: Record<string, string>;
      manifest: { entry: string };
    };
    expect(source.manifest.entry).toBe('src/main.tsx');
    expect(Object.keys(source.files)).toContain('src/App.tsx');
    expect(state(c).autosave).toMatchObject({ status: 'saved', error: null });

    // Nothing changed: no upload.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.uploadsOf('autosave/bundle.js')).toBe(1);
    // An edit that built: the next tick uploads it (the manifest only when the
    // dependencies changed).
    bridge.edit('edited-js');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.uploadsOf('autosave/bundle.js')).toBe(2);
    expect(api.files.get(`${BATTLE}/${USER}/autosave/bundle.js`)).toBe('edited-js');
    expect(api.uploadsOf('autosave/manifest.json')).toBe(1);
    bridge.ws = {
      ...bridge.ws,
      manifest: {
        ...bridge.ws.manifest,
        dependencies: { ...bridge.ws.manifest.dependencies, zustand: '4.5.2' },
      },
    };
    bridge.edit('with-zustand');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.uploadsOf('autosave/manifest.json')).toBe(2);
    expect(
      JSON.parse(api.files.get(`${BATTLE}/${USER}/autosave/manifest.json`) as string),
    ).toMatchObject({ dependencies: { zustand: '4.5.2' } });
    c.dispose();
  });

  it('saves when the tab is hidden', async () => {
    const c = await openIn();
    c.attachWorkspace(new FakeBridge());
    c.onHidden();
    await flush();
    expect(api.uploadsOf('autosave/source.json')).toBe(1);
    c.dispose();
  });

  it('does nothing before the first successful build, or without a workspace', async () => {
    const c = await openIn();
    c.onHidden();
    const bridge = new FakeBridge();
    bridge.last = null;
    c.attachWorkspace(bridge);
    c.onHidden();
    await flush();
    expect(api.count('upload')).toBe(0);
    c.dispose();
  });

  it('runs a final autosave 3 s before the build deadline', async () => {
    const c = await openIn(snapshotAt('building', { endsInMs: 20_000, version: 2 }));
    c.attachWorkspace(new FakeBridge());
    await vi.advanceTimersByTimeAsync(16_999);
    expect(api.uploadsOf('autosave/bundle.js')).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.uploadsOf('autosave/bundle.js')).toBe(1);
    c.dispose();
  });

  it('saves once more during the SHIPPING grace, then the server auto-ships', async () => {
    const c = await openIn(snapshotAt('building', { endsInMs: 1_000, version: 2 }));
    const bridge = new FakeBridge();
    c.attachWorkspace(bridge);
    bridge.edit('last-second-edit');
    api.onAdvance = (v) => {
      api.snapshot = snapshotAt('shipping', { version: v + 1, endsInMs: 15_000 });
      return { changed: true, version: v + 1, phase: 'shipping', phase_ends_at: null };
    };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state(c).snapshot?.battle.phase).toBe('shipping');
    expect(api.files.get(`${BATTLE}/${USER}/autosave/bundle.js`)).toBe('last-second-edit');
    api.onAdvance = (v) => {
      api.snapshot = snapshotAt('results', {
        version: v + 2,
        endsInMs: 60_000,
        status: 'auto_shipped',
      });
      return { changed: true, version: v + 2, phase: 'results', phase_ends_at: null };
    };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state(c).snapshot?.builds[0]?.status).toBe('auto_shipped');
    expect(state(c).autosave.status).toBe('closed');
    // The last-look preview comes from the autosave files.
    expect(state(c).reveal).toMatchObject({ status: 'ready', build: { js: 'last-second-edit' } });
    c.dispose();
  });

  it('a refused upload after the deadline closes autosave quietly; earlier it is an error', async () => {
    const c = await openIn(snapshotAt('building', { endsInMs: 300_000, version: 2 }));
    c.attachWorkspace(new FakeBridge());
    api.onUpload = () => {
      throw new GameError('network', 'Failed to fetch');
    };
    await c.autosaveNow();
    expect(state(c).autosave).toMatchObject({ status: 'error' });
    expect(state(c).autosave.error?.code).toBe('network');

    api.snapshot = snapshotAt('shipping', { version: 3, endsInMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    api.onUpload = () => {
      throw new GameError('upload_refused', 'new row violates row-level security policy');
    };
    await c.autosaveNow();
    expect(state(c).autosave).toMatchObject({ status: 'closed', error: null });
    c.dispose();
  });
});

describe('ship', () => {
  it('thumbnail → production build → uploads → ship_build with stats → RESULTS', async () => {
    const c = await openIn();
    const bridge = new FakeBridge();
    c.attachWorkspace(bridge);
    const seen: string[] = [];
    c.subscribe(() => {
      const s = state(c).ship.status;
      if (seen.at(-1) !== s) seen.push(s);
    });
    await c.ship('  Snack Overflow  ');
    expect(seen).toEqual(['thumbnail', 'building', 'uploading', 'shipping', 'done']);
    expect(bridge.thumbnailCalls).toBe(1);
    const uploaded = api.calls.filter((x) => x[0] === 'upload').map((x) => x[1]);
    expect(uploaded.sort()).toEqual([
      'bundle.css',
      'bundle.js',
      'manifest.json',
      'source.json',
      'thumb.webp',
    ]);
    expect(
      Object.keys(JSON.parse(api.files.get(`${BATTLE}/${USER}/manifest.json`) as string) as object),
    ).toEqual(['dependencies']);
    expect(api.files.get(`${BATTLE}/${USER}/bundle.js`)).toBe('prod-js');
    expect(api.files.get(`${BATTLE}/${USER}/bundle.css`)).toBe('prod-css');
    const ship = api.calls.find((x) => x[0] === 'shipBuild');
    expect(ship?.slice(0, 3)).toEqual(['shipBuild', BATTLE, 'Snack Overflow']);
    expect(ship?.[3]).toEqual({
      files: 3,
      lines: expect.any(Number) as number,
      deps: ['react', 'react-dom'],
      bundle_bytes: 'prod-js'.length + 'prod-css'.length,
      rebuilds: 7,
      pastes: 1,
    });
    expect(state(c).snapshot?.battle.phase).toBe('results');
    await flush();
    // The last-look preview loads the shipped bundle back, with React from the CDN.
    expect(state(c).reveal.status).toBe('ready');
    expect(state(c).reveal.build?.js).toBe('prod-js');
    expect(state(c).reveal.build?.importMap.imports['react']).toBe('https://pkg.test/react@19.3.0');
    c.dispose();
  });

  it('ships without a thumbnail when the preview cannot make one', async () => {
    const c = await openIn();
    const bridge = new FakeBridge();
    bridge.thumb = null;
    c.attachWorkspace(bridge);
    await c.ship('No thumb');
    expect(api.uploadsOf('thumb.webp')).toBe(0);
    expect(state(c).ship.status).toBe('done');
    c.dispose();
  });

  it('a failing production build can ship the last working preview instead', async () => {
    const c = await openIn();
    const bridge = new FakeBridge();
    bridge.prod = { ok: false, errorCount: 2, js: '', css: '', importMap: { imports: {} } };
    c.attachWorkspace(bridge);
    await c.ship('Broken');
    expect(state(c).ship).toMatchObject({ status: 'error', canShipLastGood: true });
    expect(state(c).ship.error?.code).toBe('build_failed');
    expect(api.count('shipBuild')).toBe(0);
    await c.ship('Broken', { useLastGood: true });
    expect(api.files.get(`${BATTLE}/${USER}/bundle.js`)).toBe('dev-js');
    expect(state(c).ship.status).toBe('done');
    c.dispose();
  });

  it('retries without stats when the server rejects them', async () => {
    const c = await openIn();
    c.attachWorkspace(new FakeBridge());
    const ship = api.onShip;
    api.onShip = (name, stats) => {
      if (Object.keys(stats).length > 0) throw new GameError('invalid_stats');
      return ship(name, stats);
    };
    await c.ship('Stats');
    expect(api.calls.filter((x) => x[0] === 'shipBuild').map((x) => x[3])).toEqual([
      expect.objectContaining({ files: 3 }),
      {},
    ]);
    expect(state(c).ship.status).toBe('done');
    c.dispose();
  });

  it.each([
    ['deadline_passed', 'Time is up'],
    ['wrong_phase', 'Too late'],
    ['files_missing', 'upload did not finish'],
  ] as const)('%s: an error the player can read, and a resync', async (code, text) => {
    const c = await openIn();
    c.attachWorkspace(new FakeBridge());
    api.onShip = () => {
      throw new GameError(code);
    };
    const polls = api.count('getSnapshot');
    await c.ship('Late');
    expect(state(c).ship.status).toBe('error');
    expect(state(c).ship.error?.code).toBe(code);
    const { describeError } = await import('./errors');
    expect(describeError(code)).toContain(text);
    await flush();
    expect(api.count('getSnapshot')).toBeGreaterThan(polls);
    c.dispose();
  });

  it('already_shipped (a double click) counts as shipped', async () => {
    const c = await openIn();
    c.attachWorkspace(new FakeBridge());
    api.onShip = () => {
      api.snapshot = snapshotAt('results', { version: 5, endsInMs: 60_000, status: 'shipped' });
      throw new GameError('already_shipped');
    };
    await c.ship('Twice');
    expect(state(c).ship.status).toBe('done');
    expect(state(c).snapshot?.battle.phase).toBe('results');
    c.dispose();
  });

  it('an upload refused by storage is reported', async () => {
    const c = await openIn();
    c.attachWorkspace(new FakeBridge());
    api.onUpload = (f) => {
      if (f === 'bundle.js') throw new GameError('file_too_large');
    };
    await c.ship('Huge');
    expect(state(c).ship.error?.code).toBe('file_too_large');
    expect(api.count('shipBuild')).toBe(0);
    c.dispose();
  });
});

describe('results and destroy', () => {
  it('RESULTS → DESTROYED: the destroy moment, then the local workspace is wiped', async () => {
    const c = await openIn(
      snapshotAt('results', {
        version: 5,
        endsInMs: 30_000,
        status: 'shipped',
        capture: 'captured',
      }),
    );
    expect(state(c).destroy).toBe('none');
    api.onAdvance = (v) => {
      api.snapshot = snapshotAt('destroyed', {
        version: v + 1,
        endsInMs: null,
        status: 'shipped',
        capture: 'captured',
      });
      return { changed: true, version: v + 1, phase: 'destroyed', phase_ends_at: null };
    };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state(c).snapshot?.battle.phase).toBe('destroyed');
    expect(state(c).destroy).toBe('animating');
    expect(local.deleted).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_400);
    expect(state(c).destroy).toBe('done');
    expect(state(c).reveal).toEqual({ status: 'destroyed', build: null });
    expect(local.deleted).toEqual([battleWorkspaceId(BATTLE)]);
    expect(state(c).sourceDestroyed).toBe(false);

    // The destroy worker deletes the ephemeral files: destroyed_at shows up, polling stops.
    api.snapshot = snapshotAt('destroyed', {
      version: 7,
      endsInMs: null,
      status: 'shipped',
      capture: 'captured',
      destroyedAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state(c).sourceDestroyed).toBe(true);
    const polls = api.count('getSnapshot');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count('getSnapshot')).toBe(polls);
    c.dispose();
  });

  it('opening an already destroyed battle wipes at once, without the animation', async () => {
    const c = await openIn(
      snapshotAt('destroyed', { version: 7, endsInMs: null, status: 'shipped' }),
    );
    expect(state(c).destroy).toBe('done');
    await flush();
    expect(local.deleted).toEqual([battleWorkspaceId(BATTLE)]);
    c.dispose();
  });

  it('a DNF build has no last-look preview', async () => {
    const c = await openIn(snapshotAt('results', { version: 5, endsInMs: 60_000, status: 'dnf' }));
    expect(state(c).reveal.status).toBe('unavailable');
    c.dispose();
  });

  it('playAgain returns to the name entry and forgets the battle', async () => {
    const c = await openIn(snapshotAt('destroyed', { version: 7, endsInMs: null }));
    c.playAgain();
    expect(state(c)).toMatchObject({ stage: 'name', battleId: null, snapshot: null });
    expect(battleChanges.at(-1)).toBeNull();
    c.dispose();
  });
});

describe('external mode (multiplayer)', () => {
  function external() {
    const refetches: number[] = [];
    const c = new SoloController({
      api,
      cdnBaseUrl: 'https://pkg.test',
      localWorkspaces: local,
      clock: { ...realClock, random: () => 0 },
      external: {
        refetch: () => {
          refetches.push(Date.now());
          return Promise.resolve();
        },
      },
    });
    return { c, refetches };
  }

  it('a room battle opening keeps a solo battle that another tab is playing', async () => {
    const solo = '44444444-4444-4444-8444-444444444444';
    local.stored.set(battleWorkspaceId(solo), Date.now() - 5_000);
    api.phases = { [solo]: 'building' };
    const { c } = external();
    c.openExternal(snapshotAt('building', { version: 2, endsInMs: 300_000 }), 0);
    await flush();
    expect(local.deleted).toEqual([]);
    // Once that battle is over on the server, the next battle that opens cleans it up.
    api.phases = { [solo]: 'destroyed' };
    c.openExternal(snapshotAt('building', { version: 2, endsInMs: 300_000 }), 0);
    await flush();
    expect(local.deleted).toEqual([battleWorkspaceId(solo)]);
    c.dispose();
  });

  it('opens from a pushed snapshot and never polls or samples the clock itself', async () => {
    const { c, refetches } = external();
    c.openExternal(snapshotAt('building', { version: 2, endsInMs: 300_000 }), 1_500);
    expect(state(c)).toMatchObject({ stage: 'battle', battleId: BATTLE, clockOffsetMs: 1_500 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.count('getSnapshot')).toBe(0);
    expect(api.count('serverNow')).toBe(0);
    expect(refetches).toEqual([]);
    c.dispose();
  });

  it('applies newer snapshots, ignores stale and foreign ones', () => {
    const { c } = external();
    c.openExternal(snapshotAt('building', { version: 3 }), 0);
    c.receive(snapshotAt('shipping', { version: 2 }));
    expect(state(c).snapshot?.battle.phase).toBe('building');
    c.receive({
      ...snapshotAt('results', { version: 9 }),
      battle: { ...snapshotAt('results').battle, id: 'other' },
    });
    expect(state(c).snapshot?.battle.phase).toBe('building');
    c.receive(snapshotAt('shipping', { version: 4 }));
    expect(state(c).snapshot?.battle.phase).toBe('shipping');
    c.dispose();
  });

  it('external: a capture event that completes the screenshots re-arms the RESULTS nudge', async () => {
    const { c, refetches } = external();
    c.openExternal(
      snapshotAt('results', { version: 8, endsInMs: 0, status: 'shipped', capture: 'pending' }),
      0,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.count('advanceBattle')).toBe(0);
    expect(refetches).toEqual([]);
    c.receive(
      snapshotAt('results', { version: 9, endsInMs: 0, status: 'shipped', capture: 'captured' }),
    );
    await flush();
    expect(api.calls.filter((x) => x[0] === 'advanceBattle')).toEqual([
      ['advanceBattle', BATTLE, 9],
    ]);
    expect(refetches).toHaveLength(1);
    c.dispose();
  });

  it('a deadline nudge refetches through the engine', async () => {
    const { c, refetches } = external();
    c.openExternal(snapshotAt('spinning', { version: 1, endsInMs: 6_000 }), 0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(api.count('advanceBattle')).toBe(1);
    expect(refetches).toHaveLength(1);
    c.dispose();
  });

  it('a ship refetches through the engine', async () => {
    const { c, refetches } = external();
    c.openExternal(snapshotAt('building', { version: 2, endsInMs: 300_000 }), 0);
    c.attachWorkspace(new FakeBridge());
    await c.ship('Snack Overflow');
    expect(api.count('shipBuild')).toBe(1);
    expect(state(c).ship.status).toBe('done');
    expect(refetches.length).toBeGreaterThanOrEqual(1);
    expect(api.count('getSnapshot')).toBe(0);
    c.dispose();
  });

  it('the last look loads once a later snapshot shows the build auto-shipped', async () => {
    const { c } = external();
    api.files.set(`${BATTLE}/${USER}/autosave/bundle.js`, 'auto-js');
    api.files.set(`${BATTLE}/${USER}/autosave/source.json`, '{"manifest":{"dependencies":{}}}');
    // The `phase` event (applied at once) still has the draft; the refetch has auto_shipped.
    c.openExternal(snapshotAt('shipping', { version: 4 }), 0);
    c.receive(snapshotAt('results', { version: 5, endsInMs: 60_000, status: 'draft' }));
    expect(state(c).reveal.status).toBe('unavailable');
    c.receive(snapshotAt('results', { version: 5, endsInMs: 60_000, status: 'auto_shipped' }));
    await flush();
    expect(state(c).reveal).toMatchObject({ status: 'ready', build: { js: 'auto-js' } });
    expect(api.count('download')).toBe(3);
    // Only once.
    c.receive(snapshotAt('results', { version: 6, endsInMs: 60_000, status: 'auto_shipped' }));
    await flush();
    expect(api.count('download')).toBe(3);
    c.dispose();
  });

  it('a new clock offset moves the countdown', () => {
    const { c } = external();
    c.openExternal(snapshotAt('building', { version: 2, endsInMs: 60_000 }), 0);
    expect(c.remainingMs()).toBe(60_000);
    c.setClockOffset(10_000);
    expect(c.remainingMs()).toBe(50_000);
    c.dispose();
  });
});

describe('restoreWorkspace', () => {
  it('reads the remote autosave back, and ignores garbage', async () => {
    const c = await openIn();
    const bridge = new FakeBridge();
    c.attachWorkspace(bridge);
    expect(await c.restoreWorkspace()).toBeNull();
    await c.autosaveNow();
    expect(await c.restoreWorkspace()).toEqual(bridge.ws);
    api.files.set(`${BATTLE}/${USER}/autosave/source.json`, '{"files": {"a": 1}}');
    expect(await c.restoreWorkspace()).toBeNull();
    c.dispose();
  });
});
