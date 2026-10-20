/**
 * SoloController with a fake API, fake local storage, real site packs and vitest's fake timers
 * (which also drive Date.now()). Covers phase handling, the countdown and deadline nudges,
 * the import → autosave → ship flow, the restore after a reload, results and destroy, and the
 * error mapping.
 */
import { unpackSite } from '@br/site';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { battleSiteKey } from '../site/local-sites';
import type { AnalyticsEventName } from '../telemetry/analytics';
import { SoloController, realClock, type SoloState } from './controller';
import { GameError } from './errors';
import {
  BATTLE,
  FakeApi,
  FakeLocalSites,
  FakePreviewBridge,
  USER,
  fakeSite,
  snapshotAt,
} from './test-support';

let api: FakeApi;
let local: FakeLocalSites;
let battleChanges: (string | null)[];

function controller(random = 0): SoloController {
  return new SoloController({
    api,
    localSites: local,
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
  local = new FakeLocalSites();
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

  it('cleans up stale battle sites only: over on the server, or untouched for 24 h', async () => {
    const running = '44444444-4444-4444-8444-444444444444'; // another tab plays it
    const destroyed = '55555555-5555-4555-8555-555555555555';
    const unknown = '66666666-6666-4666-8666-666666666666'; // the server does not say
    const ancient = '77777777-7777-4777-8777-777777777777';
    for (const id of [BATTLE, running, destroyed, unknown]) {
      local.storeAt(battleSiteKey(id), Date.now() - 60_000);
    }
    local.storeAt(battleSiteKey(ancient), Date.now() - 25 * 60 * 60 * 1000);
    api.phases = { [running]: 'building', [destroyed]: 'destroyed', [ancient]: 'building' };
    const c = controller();
    await c.start('Turbo Otter');
    await flush();
    expect(local.deleted.sort()).toEqual([battleSiteKey(destroyed), battleSiteKey(ancient)].sort());
    expect([...local.stored.keys()].sort()).toEqual(
      [BATTLE, running, unknown].map(battleSiteKey).sort(),
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

/** The autosave on the server, unpacked: its `index.html` text. */
function autosavedIndex(): string | null {
  const pack = api.files.get(`${BATTLE}/${USER}/autosave/site.bin`);
  if (!(pack instanceof Uint8Array)) return null;
  const index = unpackSite(pack).get('index.html');
  return index ? new TextDecoder().decode(index.bytes) : null;
}

describe('import and autosave', () => {
  it('an import becomes the build: kept on this device and uploaded as autosave/site.bin', async () => {
    const c = await openIn();
    expect(c.canImport()).toBe(true);
    const site = fakeSite('First');
    expect(c.importSite(site)).toBe(true);
    expect(state(c)).toMatchObject({ site, imports: 1 });
    expect(state(c).autosave.status).toBe('saving');
    await flush();
    expect(api.calls.filter((x) => x[0] === 'upload').map((x) => x[1])).toEqual([
      'autosave/site.bin',
    ]);
    expect(api.files.get(`${BATTLE}/${USER}/autosave/site.bin`)).toBe(site.pack);
    expect(state(c).autosave).toMatchObject({ status: 'saved', error: null });
    expect(local.stored.get(battleSiteKey(BATTLE))).toMatchObject({ site, imports: 1 });

    // Importing again replaces it (and counts).
    const second = fakeSite('Second');
    c.importSite(second);
    await flush();
    expect(state(c)).toMatchObject({ site: second, imports: 2 });
    expect(api.uploadsOf('autosave/site.bin')).toBe(2);
    expect(autosavedIndex()).toContain('Second');
    expect(local.stored.get(battleSiteKey(BATTLE))?.imports).toBe(2);

    // Nothing new: hiding the tab or the final autosave upload nothing more.
    c.onHidden();
    await flush();
    expect(api.uploadsOf('autosave/site.bin')).toBe(2);
    c.dispose();
  });

  it('a newer import during an upload is uploaded right after it', async () => {
    const c = await openIn();
    let release: () => void = () => undefined;
    api.onUpload = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    c.importSite(fakeSite('One'));
    await flush();
    c.importSite(fakeSite('Two'));
    api.onUpload = () => undefined;
    release();
    await flush();
    expect(api.uploadsOf('autosave/site.bin')).toBe(2);
    expect(autosavedIndex()).toContain('Two');
    expect(state(c).autosave.status).toBe('saved');
    c.dispose();
  });

  it('a failed upload says so and is retried after 5, 10, 20, then every 30 s until it lands', async () => {
    const c = await openIn();
    let failures = 4;
    api.onUpload = () => {
      if (failures-- > 0) throw new GameError('network', 'Failed to fetch');
    };
    c.importSite(fakeSite('Flaky'));
    await flush();
    expect(state(c).autosave).toMatchObject({ status: 'error' });
    expect(state(c).autosave.error?.code).toBe('network');
    for (const wait of [5_000, 10_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      const before = api.uploadsOf('autosave/site.bin');
      await vi.advanceTimersByTimeAsync(1);
      expect(api.uploadsOf('autosave/site.bin')).toBe(before + 1);
      expect(state(c).autosave.status).toBe('error');
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.uploadsOf('autosave/site.bin')).toBe(5);
    expect(state(c).autosave.status).toBe('saved');
    // Saved: no more retries.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.uploadsOf('autosave/site.bin')).toBe(5);
    c.dispose();
  });

  it('nothing to save before the first import; imports are refused outside BUILDING', async () => {
    const c = await openIn(snapshotAt('spinning', { endsInMs: 6_000, version: 1 }));
    c.onHidden();
    await flush();
    expect(api.count('upload')).toBe(0);
    expect(c.canImport()).toBe(false);
    expect(c.importSite(fakeSite())).toBe(false);
    expect(state(c).site).toBeNull();
    c.dispose();

    const shipping = await openIn(snapshotAt('shipping', { endsInMs: 10_000, version: 3 }));
    expect(shipping.importSite(fakeSite())).toBe(false);
    shipping.dispose();
  });

  it('a final try 3 s before the deadline when the import is not saved yet', async () => {
    const c = await openIn(snapshotAt('building', { endsInMs: 20_000, version: 2 }));
    api.onUpload = () => {
      throw new GameError('network', 'offline');
    };
    c.importSite(fakeSite('Late'));
    await flush();
    // The retries (5, 10 s) fail too; the network is back for the final one at 17 s.
    await vi.advanceTimersByTimeAsync(16_000);
    const before = api.uploadsOf('autosave/site.bin');
    api.onUpload = () => undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.uploadsOf('autosave/site.bin')).toBe(before + 1);
    expect(state(c).autosave.status).toBe('saved');
    c.dispose();
  });

  it('the SHIPPING grace uploads an import that is not saved yet, then the server auto-ships it', async () => {
    const c = await openIn(snapshotAt('building', { endsInMs: 1_000, version: 2 }));
    api.onUpload = () => {
      throw new GameError('network', 'offline');
    };
    c.importSite(fakeSite('Last second'));
    await flush();
    api.onUpload = () => undefined;
    api.onAdvance = (v) => {
      api.snapshot = snapshotAt('shipping', { version: v + 1, endsInMs: 15_000 });
      return { changed: true, version: v + 1, phase: 'shipping', phase_ends_at: null };
    };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state(c).snapshot?.battle.phase).toBe('shipping');
    expect(autosavedIndex()).toContain('Last second');
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
    // The last look runs the autosaved pack.
    expect(state(c).reveal.status).toBe('ready');
    expect(state(c).reveal.build?.site).toEqual(
      api.files.get(`${BATTLE}/${USER}/autosave/site.bin`),
    );
    // The restore looked for an autosave when the battle opened; the last look read it.
    expect(api.calls.filter((x) => x[0] === 'download').map((x) => x[1])).toEqual([
      'autosave/site.bin',
      'autosave/site.bin',
    ]);
    c.dispose();
  });

  it('a refused upload after the deadline closes autosave quietly; earlier it is an error', async () => {
    const c = await openIn(snapshotAt('building', { endsInMs: 300_000, version: 2 }));
    c.importSite(fakeSite());
    await flush();
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

describe('restore after a reload', () => {
  it('brings the last import back from this device and uploads it again', async () => {
    const site = fakeSite('Kept');
    local.stored.set(battleSiteKey(BATTLE), { site, imports: 3, updatedAt: Date.now() });
    const c = await openIn();
    await flush();
    expect(state(c)).toMatchObject({ site, imports: 3, restoring: false });
    expect(api.count('download')).toBe(0);
    expect(api.files.get(`${BATTLE}/${USER}/autosave/site.bin`)).toBe(site.pack);
    expect(state(c).autosave.status).toBe('saved');
    // The next import counts on.
    c.importSite(fakeSite('Fourth'));
    expect(state(c).imports).toBe(4);
    c.dispose();
  });

  it('falls back to the remote autosave (another device) and keeps it on this one', async () => {
    const site = fakeSite('Remote');
    api.files.set(`${BATTLE}/${USER}/autosave/site.bin`, site.pack);
    const c = await openIn();
    await flush();
    expect(state(c).site).toMatchObject({ files: 1, root: '', skipped: 0 });
    expect(state(c).site?.pack).toEqual(site.pack);
    expect(state(c).imports).toBe(1);
    expect(state(c).autosave.status).toBe('saved');
    // It is on the server already: not uploaded again.
    expect(api.count('upload')).toBe(0);
    expect(local.stored.get(battleSiteKey(BATTLE))?.site.pack).toEqual(site.pack);
    c.dispose();
  });

  it('a shipped player gets the shipped site back; garbage or nothing leaves the drop zone', async () => {
    const site = fakeSite('Shipped');
    api.files.set(`${BATTLE}/${USER}/site.bin`, site.pack);
    const shipped = await openIn(
      snapshotAt('building', { endsInMs: 300_000, version: 4, status: 'shipped' }),
    );
    await flush();
    expect(state(shipped).site?.pack).toEqual(site.pack);
    expect(api.count('upload')).toBe(0);
    shipped.dispose();

    local.stored.clear(); // the shipped one was kept on this device
    api.files.set(`${BATTLE}/${USER}/autosave/site.bin`, new TextEncoder().encode('not a pack'));
    const garbage = await openIn();
    await flush();
    expect(state(garbage)).toMatchObject({ site: null, imports: 0, restoring: false });
    garbage.dispose();
  });

  it('an import made while the restore runs wins; SPINNING restores nothing', async () => {
    let answer: (v: null) => void = () => undefined;
    local.get = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const c = await openIn();
    expect(state(c).restoring).toBe(true);
    const mine = fakeSite('Mine');
    c.importSite(mine);
    answer(null);
    await flush();
    expect(state(c).site).toBe(mine);
    expect(api.count('download')).toBe(0);
    c.dispose();

    const spinning = await openIn(snapshotAt('spinning', { endsInMs: 6_000, version: 1 }));
    expect(state(spinning).restoring).toBe(false);
    expect(api.count('download')).toBe(0);
    spinning.dispose();
  });

  it('blocked storage on this device: the remote autosave still restores', async () => {
    local.broken = true;
    const site = fakeSite('Remote only');
    api.files.set(`${BATTLE}/${USER}/autosave/site.bin`, site.pack);
    const c = await openIn();
    await flush();
    expect(state(c).site?.pack).toEqual(site.pack);
    c.importSite(fakeSite('Still works'));
    await flush();
    expect(autosavedIndex()).toContain('Still works');
    c.dispose();
  });
});

describe('ship', () => {
  it('thumbnail → uploads site.bin + thumb.webp → ship_build with stats → RESULTS', async () => {
    const c = await openIn();
    const bridge = new FakePreviewBridge();
    c.attachPreview(bridge);
    const site = fakeSite('Snack', { 'assets/app.js': 'console.log(1)' });
    c.importSite(site);
    c.importSite(site);
    await flush();
    const seen: string[] = [];
    c.subscribe(() => {
      const s = state(c).ship.status;
      if (seen.at(-1) !== s) seen.push(s);
    });
    await c.ship('  Snack Overflow  ');
    expect(seen).toEqual(['thumbnail', 'uploading', 'shipping', 'done']);
    expect(bridge.thumbnailCalls).toBe(1);
    const uploaded = api.calls.filter((x) => x[0] === 'upload').map((x) => x[1]);
    expect(uploaded.filter((f) => f !== 'autosave/site.bin').sort()).toEqual([
      'site.bin',
      'thumb.webp',
    ]);
    expect(api.files.get(`${BATTLE}/${USER}/site.bin`)).toBe(site.pack);
    const ship = api.calls.find((x) => x[0] === 'shipBuild');
    expect(ship?.slice(0, 3)).toEqual(['shipBuild', BATTLE, 'Snack Overflow']);
    expect(ship?.[3]).toEqual({ files: 2, bundle_bytes: site.pack.byteLength, imports: 2 });
    expect(state(c).snapshot?.battle.phase).toBe('results');
    await flush();
    // The last look loads the shipped pack back.
    expect(state(c).reveal.status).toBe('ready');
    expect(state(c).reveal.build?.site).toBe(site.pack);
    // (The first download: the restore looked for an autosave when the battle opened.)
    expect(api.calls.filter((x) => x[0] === 'download').map((x) => x[1])).toEqual([
      'autosave/site.bin',
      'site.bin',
    ]);
    c.dispose();
  });

  it('nothing imported: nothing to ship', async () => {
    const c = await openIn();
    await c.ship('Empty');
    expect(state(c).ship.status).toBe('error');
    expect(state(c).ship.error?.code).toBe('nothing_built');
    expect(api.count('upload')).toBe(0);
    expect(api.count('shipBuild')).toBe(0);
    c.dispose();
  });

  it('ships without a thumbnail when the preview cannot make one, or is not mounted', async () => {
    const c = await openIn();
    const bridge = new FakePreviewBridge();
    bridge.thumb = null;
    const detach = c.attachPreview(bridge);
    c.importSite(fakeSite());
    await c.ship('No thumb');
    expect(api.uploadsOf('thumb.webp')).toBe(0);
    expect(state(c).ship.status).toBe('done');
    detach();
    c.dispose();

    api.snapshot = snapshotAt('building', { endsInMs: 300_000, version: 2 });
    const unmounted = await openIn();
    unmounted.importSite(fakeSite());
    await unmounted.ship('No preview');
    expect(state(unmounted).ship.status).toBe('done');
    unmounted.dispose();
  });

  it('retries without stats when the server rejects them', async () => {
    const c = await openIn();
    c.importSite(fakeSite());
    const ship = api.onShip;
    api.onShip = (name, stats) => {
      if (Object.keys(stats).length > 0) throw new GameError('invalid_stats');
      return ship(name, stats);
    };
    await c.ship('Stats');
    expect(api.calls.filter((x) => x[0] === 'shipBuild').map((x) => x[3])).toEqual([
      expect.objectContaining({ files: 1, imports: 1 }),
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
    c.importSite(fakeSite());
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
    c.importSite(fakeSite());
    api.onShip = () => {
      api.snapshot = snapshotAt('results', { version: 5, endsInMs: 60_000, status: 'shipped' });
      throw new GameError('already_shipped');
    };
    await c.ship('Twice');
    expect(state(c).ship.status).toBe('done');
    expect(state(c).snapshot?.battle.phase).toBe('results');
    c.dispose();
  });

  it('an upload refused by storage is reported; no import while a ship runs', async () => {
    const c = await openIn();
    c.importSite(fakeSite());
    await flush();
    api.onUpload = (f) => {
      if (f === 'site.bin') throw new GameError('file_too_large');
    };
    const shipping = c.ship('Huge');
    expect(c.canImport()).toBe(false);
    expect(c.importSite(fakeSite('During'))).toBe(false);
    await shipping;
    expect(state(c).ship.error?.code).toBe('file_too_large');
    expect(api.count('shipBuild')).toBe(0);
    // After the error the player may import again.
    expect(c.canImport()).toBe(true);
    c.dispose();
  });
});

describe('results and destroy', () => {
  it('RESULTS → DESTROYED: the destroy moment, then the local site is wiped', async () => {
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
    expect(state(c).site).toBeNull();
    expect(local.deleted).toEqual([battleSiteKey(BATTLE)]);
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
    expect(local.deleted).toEqual([battleSiteKey(BATTLE)]);
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
      localSites: local,
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
    local.storeAt(battleSiteKey(solo), Date.now() - 5_000);
    api.phases = { [solo]: 'building' };
    const { c } = external();
    c.openExternal(snapshotAt('building', { version: 2, endsInMs: 300_000 }), 0);
    await flush();
    expect(local.deleted).toEqual([]);
    // Once that battle is over on the server, the next battle that opens cleans it up.
    api.phases = { [solo]: 'destroyed' };
    c.openExternal(snapshotAt('building', { version: 2, endsInMs: 300_000 }), 0);
    await flush();
    expect(local.deleted).toEqual([battleSiteKey(solo)]);
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
    c.importSite(fakeSite());
    await c.ship('Snack Overflow');
    expect(api.count('shipBuild')).toBe(1);
    expect(state(c).ship.status).toBe('done');
    expect(refetches.length).toBeGreaterThanOrEqual(1);
    expect(api.count('getSnapshot')).toBe(0);
    c.dispose();
  });

  it('the last look loads once a later snapshot shows the build auto-shipped', async () => {
    const { c } = external();
    const site = fakeSite('Auto');
    api.files.set(`${BATTLE}/${USER}/autosave/site.bin`, site.pack);
    // The `phase` event (applied at once) still has the draft; the refetch has auto_shipped.
    c.openExternal(snapshotAt('shipping', { version: 4 }), 0);
    await flush(); // (SHIPPING: the restore brings the autosave back for the BUILD screen)
    expect(api.count('download')).toBe(1);
    c.receive(snapshotAt('results', { version: 5, endsInMs: 60_000, status: 'draft' }));
    expect(state(c).reveal.status).toBe('unavailable');
    c.receive(snapshotAt('results', { version: 5, endsInMs: 60_000, status: 'auto_shipped' }));
    await flush();
    expect(state(c).reveal).toMatchObject({ status: 'ready', build: { site: site.pack } });
    expect(api.count('download')).toBe(2);
    // Only once.
    c.receive(snapshotAt('results', { version: 6, endsInMs: 60_000, status: 'auto_shipped' }));
    await flush();
    expect(api.count('download')).toBe(2);
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

describe('analytics (T-030)', () => {
  let events: [AnalyticsEventName, Record<string, unknown>][];
  const tracked = (): SoloController =>
    new SoloController({
      api,
      localSites: local,
      clock: { ...realClock, random: () => 0 },
      track: (name, props) => {
        events.push([name, props as Record<string, unknown>]);
      },
    });
  beforeEach(() => {
    events = [];
  });

  it('a solo start, a manual ship and the battle completing', async () => {
    const c = tracked();
    await c.start('Turbo Otter');
    expect(events).toEqual([
      ['battle_started', { battle_id: BATTLE, mode: 'solo', room_id: null, rematch: false }],
    ]);
    api.snapshot = snapshotAt('building', { endsInMs: 300_000, version: 2 });
    c.receive(api.snapshot); // the battle moves on to BUILDING
    c.importSite(fakeSite());
    await c.ship('Snack Overflow');
    await flush();
    expect(events.slice(1)).toEqual([
      ['build_shipped', { battle_id: BATTLE, mode: 'solo', how: 'manual', completion_ms: 1000 }],
      [
        'battle_completed',
        {
          battle_id: BATTLE,
          mode: 'solo',
          role: 'player',
          outcome: 'results',
          build: 'manual',
          rank: null,
          builds: 1,
        },
      ],
    ]);
    c.dispose();
  });

  it('an auto-ship seen live counts as shipped (auto); reopening a finished battle counts nothing', async () => {
    api.snapshot = snapshotAt('shipping', { endsInMs: 1_000, version: 3 });
    const c = tracked();
    c.init(BATTLE);
    await flush();
    api.onAdvance = (v) => {
      api.snapshot = snapshotAt('results', {
        version: v + 2,
        endsInMs: 60_000,
        status: 'auto_shipped',
      });
      return { changed: true, version: v + 2, phase: 'results', phase_ends_at: null };
    };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.map((e) => [e[0], e[1]['how'] ?? e[1]['build']])).toEqual([
      ['build_shipped', 'auto'],
      ['battle_completed', 'auto'],
    ]);
    c.dispose();

    events = [];
    const again = tracked();
    again.init(BATTLE);
    await flush();
    expect(events).toEqual([]);
    again.dispose();
  });
});
