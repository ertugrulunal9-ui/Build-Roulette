import { beforeEach, describe, expect, it } from 'vitest';
import { BUCKET_EPHEMERAL, BUCKET_SCREENSHOTS } from '../src/backend';
import { listRecursive, processDestroyJob } from '../src/destroy-job';
import { silentLogger } from '../src/log';
import { BATTLE, FakeBackend, USER } from './fakes';

const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const OTHER_BATTLE = '55555555-5555-4555-8555-555555555555';
const never = new AbortController().signal;

let backend: FakeBackend;

function seed(): void {
  for (const f of ['source.json', 'bundle.js', 'bundle.css', 'thumb.webp']) {
    backend.put(BUCKET_EPHEMERAL, `${BATTLE}/${USER}/${f}`, f);
  }
  backend.put(BUCKET_EPHEMERAL, `${BATTLE}/${USER}/autosave/bundle.js`, 'a');
  backend.put(BUCKET_EPHEMERAL, `${BATTLE}/${USER}/autosave/source.json`, 'a');
  backend.put(BUCKET_EPHEMERAL, `${BATTLE}/${OTHER_USER}/autosave/bundle.js`, 'a');
  // Must survive: another battle, and the permanent screenshot.
  backend.put(BUCKET_EPHEMERAL, `${OTHER_BATTLE}/${USER}/bundle.js`, 'keep');
  backend.put(BUCKET_SCREENSHOTS, `${BATTLE}/x.webp`, 'keep');
}

async function claim() {
  const job = await backend.claimJob('destroy');
  if (!job) throw new Error('no job');
  return job;
}

beforeEach(() => {
  backend = new FakeBackend();
});

describe('listRecursive', () => {
  it('walks folders (autosave/) and returns full object names', async () => {
    seed();
    expect((await listRecursive(backend, BUCKET_EPHEMERAL, `${BATTLE}/`)).sort()).toEqual(
      [
        `${BATTLE}/${OTHER_USER}/autosave/bundle.js`,
        `${BATTLE}/${USER}/autosave/bundle.js`,
        `${BATTLE}/${USER}/autosave/source.json`,
        `${BATTLE}/${USER}/bundle.css`,
        `${BATTLE}/${USER}/bundle.js`,
        `${BATTLE}/${USER}/source.json`,
        `${BATTLE}/${USER}/thumb.webp`,
      ].sort(),
    );
  });

  it('refuses suspicious entry names and very deep trees', async () => {
    backend.list = () => Promise.resolve([{ name: '..', isFolder: true }]);
    await expect(listRecursive(backend, BUCKET_EPHEMERAL, `${BATTLE}/`)).rejects.toThrow(
      'unexpected entry name',
    );
    backend.list = () => Promise.resolve([{ name: 'd', isFolder: true }]);
    await expect(listRecursive(backend, BUCKET_EPHEMERAL, `${BATTLE}/`)).rejects.toThrow(
      'nesting deeper',
    );
  });
});

describe('destroy job', () => {
  it('deletes every object under the battle prefix, then complete_destroy', async () => {
    seed();
    backend.phases.set(BATTLE, 'destroyed');
    backend.addJob('destroy', BATTLE);
    const out = await processDestroyJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toEqual({ result: 'destroyed', deleted: 7 });
    const left = [...backend.objects.keys()].filter((k) =>
      k.startsWith(`${BUCKET_EPHEMERAL}/${BATTLE}/`),
    );
    expect(left).toEqual([]);
    expect(backend.get(BUCKET_EPHEMERAL, `${OTHER_BATTLE}/${USER}/bundle.js`)).toBeDefined();
    expect(backend.get(BUCKET_SCREENSHOTS, `${BATTLE}/x.webp`)).toBeDefined();
    expect(backend.callsTo('completeDestroy')).toEqual([[BATTLE]]);
    expect(backend.jobs[0]?.status).toBe('done');
  });

  it('an empty prefix (nothing uploaded, or a second run) still completes', async () => {
    backend.phases.set(BATTLE, 'abandoned');
    backend.addJob('destroy', BATTLE);
    const out = await processDestroyJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toEqual({ result: 'destroyed', deleted: 0 });
    expect(backend.callsTo('remove')).toEqual([]);
  });

  it('objects that survive the delete → fail_job, no complete_destroy', async () => {
    seed();
    backend.phases.set(BATTLE, 'destroyed');
    backend.remove = () => Promise.resolve([]);
    backend.addJob('destroy', BATTLE);
    const out = await processDestroyJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toMatchObject({ result: 'retry', reason: '7 objects left after delete' });
    expect(backend.callsTo('completeDestroy')).toEqual([]);
  });

  it('never deletes anything of a battle that is not destroyed or abandoned', async () => {
    seed();
    backend.phases.set(BATTLE, 'results');
    backend.addJob('destroy', BATTLE);
    const out = await processDestroyJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toMatchObject({ result: 'retry', reason: 'battle is results, not destroyed' });
    expect(backend.callsTo('list')).toEqual([]);
    expect(backend.callsTo('remove')).toEqual([]);
  });

  it('a ref that is not a UUID never becomes a prefix', async () => {
    seed();
    backend.addJob('destroy', '');
    const out = await processDestroyJob({ backend, log: silentLogger }, await claim(), never);
    expect(out.result).toBe('retry');
    expect(backend.callsTo('list')).toEqual([]);
    expect(backend.callsTo('getBattlePhase')).toEqual([]);
  });

  it('an RPC error from complete_destroy is retried', async () => {
    backend.phases.set(BATTLE, 'destroyed');
    backend.failNext.set('completeDestroy', new Error('wrong_phase'));
    backend.addJob('destroy', BATTLE);
    const out = await processDestroyJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toMatchObject({ result: 'retry', reason: 'unexpected: wrong_phase' });
  });
});
