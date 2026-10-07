import { beforeEach, describe, expect, it } from 'vitest';
import { BUCKET_EPHEMERAL, BUCKET_SCREENSHOTS } from '../src/backend';
import { silentLogger } from '../src/log';
import { isScreenshotOf, screenshotPrefix } from '../src/paths';
import { processTakedownJob } from '../src/takedown-job';
import { BATTLE, BUILD, FakeBackend, USER } from './fakes';

const OTHER_BUILD = '66666666-6666-4666-8666-666666666666';
const OTHER_BATTLE = '55555555-5555-4555-8555-555555555555';
const never = new AbortController().signal;

let backend: FakeBackend;

function seed(): void {
  backend.put(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.webp`, 'shot');
  backend.put(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.png`, 'old shot');
  // Must survive: another build of the battle, the same build id in another battle's
  // folder (cannot happen, but the prefix is the battle), and the ephemeral files.
  backend.put(BUCKET_SCREENSHOTS, `${BATTLE}/${OTHER_BUILD}.webp`, 'keep');
  backend.put(BUCKET_SCREENSHOTS, `${OTHER_BATTLE}/${BUILD}.webp`, 'keep');
  backend.put(BUCKET_EPHEMERAL, `${BATTLE}/${USER}/bundle.js`, 'keep');
}

async function claim() {
  const job = await backend.claimJob('takedown');
  if (!job) throw new Error('no job');
  return job;
}

beforeEach(() => {
  backend = new FakeBackend();
});

describe('paths', () => {
  it('isScreenshotOf matches {build}.<ext> only', () => {
    expect(isScreenshotOf(BUILD, `${BUILD}.webp`)).toBe(true);
    expect(isScreenshotOf(BUILD, `${BUILD}.png`)).toBe(true);
    expect(isScreenshotOf(BUILD, `${OTHER_BUILD}.webp`)).toBe(false);
    expect(isScreenshotOf(BUILD, BUILD)).toBe(false);
    expect(isScreenshotOf(BUILD, `${BUILD}.webp/x`)).toBe(false);
    expect(() => isScreenshotOf('', 'x')).toThrow('canonical UUID');
    expect(() => screenshotPrefix('../x')).toThrow('canonical UUID');
  });
});

describe('takedown job', () => {
  it('deletes the build’s screenshots only, then complete_takedown', async () => {
    seed();
    backend.addBuild({ taken_down_at: new Date().toISOString() });
    backend.addJob('takedown', BUILD);
    const out = await processTakedownJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toEqual({ result: 'taken_down', deleted: 2 });
    expect(backend.get(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.webp`)).toBeUndefined();
    expect(backend.get(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.png`)).toBeUndefined();
    expect(backend.get(BUCKET_SCREENSHOTS, `${BATTLE}/${OTHER_BUILD}.webp`)).toBeDefined();
    expect(backend.get(BUCKET_SCREENSHOTS, `${OTHER_BATTLE}/${BUILD}.webp`)).toBeDefined();
    expect(backend.get(BUCKET_EPHEMERAL, `${BATTLE}/${USER}/bundle.js`)).toBeDefined();
    expect(backend.callsTo('list')[0]).toEqual([BUCKET_SCREENSHOTS, `${BATTLE}/`]);
    expect(backend.callsTo('completeTakedown')).toEqual([[BUILD]]);
    expect(backend.jobs[0]?.status).toBe('done');
  });

  it('nothing to delete (no screenshot, or a second run) still completes', async () => {
    backend.addBuild({ taken_down_at: new Date().toISOString() });
    backend.addJob('takedown', BUILD);
    const out = await processTakedownJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toEqual({ result: 'taken_down', deleted: 0 });
    expect(backend.callsTo('completeTakedown')).toEqual([[BUILD]]);
  });

  it('refuses a build that was not taken down (guard rail), and deletes nothing', async () => {
    seed();
    backend.addBuild();
    backend.addJob('takedown', BUILD);
    const out = await processTakedownJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toMatchObject({ result: 'retry', reason: 'build is not taken down' });
    expect(backend.get(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.webp`)).toBeDefined();
    expect(backend.callsTo('remove')).toEqual([]);
    expect(backend.callsTo('completeTakedown')).toEqual([]);
  });

  it('a missing build is retried, then given up', async () => {
    backend.addJob('takedown', BUILD, { attempts: 4 });
    const out = await processTakedownJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toEqual({ result: 'failed', reason: 'build is missing' });
    expect(backend.jobs[0]?.status).toBe('failed');
  });

  it('a file that survives the delete is a retry, not a success', async () => {
    seed();
    backend.addBuild({ taken_down_at: new Date().toISOString() });
    backend.addJob('takedown', BUILD);
    backend.remove = () => Promise.resolve([]);
    const out = await processTakedownJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toMatchObject({ result: 'retry', reason: '2 screenshots left after delete' });
    expect(backend.callsTo('completeTakedown')).toEqual([]);
  });

  it('a Storage error is recorded with fail_job (never thrown)', async () => {
    backend.addBuild({ taken_down_at: new Date().toISOString() });
    backend.addJob('takedown', BUILD);
    backend.failNext.set('list', new Error('storage down'));
    const out = await processTakedownJob({ backend, log: silentLogger }, await claim(), never);
    expect(out).toMatchObject({ result: 'retry', reason: 'unexpected: storage down' });
  });

  it('an aborted job says so', async () => {
    seed();
    backend.addBuild({ taken_down_at: new Date().toISOString() });
    backend.addJob('takedown', BUILD);
    const ctrl = new AbortController();
    ctrl.abort(new Error('worker shutting down'));
    const out = await processTakedownJob(
      { backend, log: silentLogger },
      await claim(),
      ctrl.signal,
    );
    expect(out).toMatchObject({ result: 'retry', reason: 'aborted: worker shutting down' });
    expect(backend.get(BUCKET_SCREENSHOTS, `${BATTLE}/${BUILD}.webp`)).toBeDefined();
  });
});
