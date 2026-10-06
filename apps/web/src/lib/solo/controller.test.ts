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
    // Stale battle workspaces in IndexedDB are cleaned up, this one is kept.
    expect(local.kept).toEqual([battleWorkspaceId(BATTLE)]);
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

  it('an overdue battle that does not move is nudged again only every 5 s', async () => {
    const c = await openIn(
      snapshotAt('results', { endsInMs: 0, version: 5, status: 'shipped', capture: 'pending' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count('advanceBattle')).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.count('advanceBattle')).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.count('advanceBattle')).toBe(2);
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
    ]);
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
    // An edit that built: the next tick uploads it.
    bridge.edit('edited-js');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.uploadsOf('autosave/bundle.js')).toBe(2);
    expect(api.files.get(`${BATTLE}/${USER}/autosave/bundle.js`)).toBe('edited-js');
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
    expect(uploaded.sort()).toEqual(['bundle.css', 'bundle.js', 'source.json', 'thumb.webp']);
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
    expect(local.kept).toEqual([null]);
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
