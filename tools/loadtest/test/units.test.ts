import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PROFILES, UsageError, compressedSettings, parseArgs } from '../src/config';
import { parseDockerStats } from '../src/docker';
import { bodySize, classifyRequest, frameEvent } from '../src/instrument';
import { isBillable } from '../src/metrics';
import { bundleJs, drawBuildSizes } from '../src/payloads';
import { CLIENT_RULES, activityMatters, errorCode, rejoinDelayMs } from '../src/player';
import { Rng } from '../src/rng';
import { NUDGE_BACKOFF_MS, nudgeBackoffMs } from '../src/session';
import { percentile, summarize } from '../src/stats';

describe('stats', () => {
  it('nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile([7], 95)).toBe(7);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it('summaries sort their input', () => {
    const s = summarize([5, 1, 3]);
    expect(s).toMatchObject({ n: 3, min: 1, p50: 3, max: 5, mean: 3 });
  });
});

describe('rng', () => {
  it('is deterministic per seed and forks independently', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    expect(new Rng(1).fork(1).next()).not.toBe(new Rng(1).fork(2).next());
  });

  it('log-normal sizes stay in bounds and have roughly the asked median', () => {
    const r = new Rng(7);
    const xs = Array.from({ length: 4000 }, () => r.logNormal(10_000, 50_000, 1000, 200_000));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...xs)).toBeLessThanOrEqual(200_000);
    const med = percentile(
      [...xs].sort((x, y) => x - y),
      50,
    );
    expect(med).toBeGreaterThan(8_500);
    expect(med).toBeLessThan(11_500);
  });
});

describe('config', () => {
  it('applies a profile and overrides', () => {
    const c = parseArgs(['--profile', 'smoke', '--rooms', '5', '--capture=false']);
    expect(c.rooms).toBe(5);
    expect(c.players).toBe(PROFILES['smoke']?.players);
    expect(c.capture).toBe(false);
    expect(parseArgs(['--smoke']).profile).toBe('smoke');
  });

  it('refuses bad values', () => {
    expect(() => parseArgs(['--players', '9'])).toThrow(UsageError);
    expect(() => parseArgs(['--build-s', '30'])).toThrow(/buildS/);
    expect(() => parseArgs(['--nope', '1'])).toThrow(/unknown option/);
  });

  it('caps processes at the number of rooms', () => {
    expect(parseArgs(['--rooms', '2', '--procs', '4']).procs).toBe(2);
  });

  it('writes every duration the SQL compression needs', () => {
    expect(Object.keys(compressedSettings(parseArgs([]))).sort()).toEqual([
      'capture_deadline_s',
      'results_s',
      'reveal_slot_s',
      'shipping_s',
      'spinning_s',
      'voting_s',
    ]);
  });
});

describe('instrument', () => {
  const api = 'http://127.0.0.1:54321';
  const battle = '0b3c3e1e-1111-4222-8333-444455556666';
  const user = '9f9f9f9f-1111-4222-8333-444455556666';

  it('classifies requests', () => {
    expect(classifyRequest('POST', `${api}/rest/v1/rpc/heartbeat`).key).toBe('rpc:heartbeat');
    expect(classifyRequest('GET', `${api}/rest/v1/battles?select=version`).key).toBe(
      'rest:battles',
    );
    expect(classifyRequest('POST', `${api}/auth/v1/token?grant_type=password`).key).toBe(
      'auth:token',
    );
    expect(classifyRequest('POST', `${api}/auth/v1/admin/users`).key).toBe('auth:admin_users');
    expect(
      classifyRequest(
        'POST',
        `${api}/storage/v1/object/ephemeral-builds/${battle}/${user}/autosave/bundle.js`,
      ),
    ).toEqual({
      key: 'storage:upload',
      file: 'autosave/bundle.js',
      battleId: battle,
    });
    expect(
      classifyRequest(
        'GET',
        `${api}/storage/v1/object/ephemeral-builds/${battle}/${user}/thumb.webp`,
      ),
    ).toEqual({
      key: 'storage:download',
      file: 'thumb.webp',
      battleId: battle,
    });
    expect(
      classifyRequest('GET', `${api}/storage/v1/object/public/screenshots/${battle}/x.webp`),
    ).toEqual({
      key: 'storage:public',
      file: 'screenshot',
      battleId: battle,
    });
  });

  it('sizes bodies', () => {
    expect(bodySize('héllo')).toBe(6);
    expect(bodySize(new Blob(['abc']))).toBe(3);
    const fd = new FormData();
    fd.append('', new Blob(['12345']));
    fd.append('cacheControl', '3600');
    expect(bodySize(fd)).toBe(5 + 'cacheControl'.length + 4);
  });

  it('reads Realtime frame events', () => {
    expect(frameEvent(JSON.stringify(['1', '2', 'realtime:room:x', 'broadcast', {}])).event).toBe(
      'broadcast',
    );
    expect(frameEvent(JSON.stringify({ event: 'phx_reply' })).event).toBe('phx_reply');
    expect(frameEvent(new Uint8Array([4, 1, 2]).buffer).event).toBe('binary:4');
    expect(isBillable('broadcast')).toBe(true);
    expect(isBillable('presence_diff')).toBe(true);
    expect(isBillable('heartbeat')).toBe(false);
    expect(isBillable('phx_reply')).toBe(false);
  });
});

describe('payloads', () => {
  it('bundles are valid JavaScript near the drawn size', () => {
    const r = new Rng(3);
    const sizes = drawBuildSizes(r);
    const js = bundleJs(r, sizes, 'Cat "Clicker"', 1);
    expect(() => new vm.Script(js)).not.toThrow();
    expect(Math.abs(js.length - sizes.bundle)).toBeLessThan(200);
  });
});

describe('errors and docker stats', () => {
  it('maps errors to stable codes', () => {
    expect(errorCode({ message: 'rate_limited', code: 'PT429' })).toBe('rate_limited');
    expect(errorCode({ message: 'wrong_phase' })).toBe('wrong_phase');
    expect(errorCode({ message: 'This operation was aborted' })).toBe('timeout');
    expect(errorCode({ message: 'Some Long Message' })).toBe('other:Some Long Message');
  });

  it('parses docker stats lines', () => {
    const out = [
      JSON.stringify({
        Name: 'supabase_db_build-roulette',
        CPUPerc: '153.20%',
        MemUsage: '512.5MiB / 15.6GiB',
      }),
      JSON.stringify({
        Name: 'supabase_realtime_build-roulette',
        CPUPerc: '40.00%',
        MemUsage: '1.5GiB / 15.6GiB',
      }),
    ].join('\n');
    expect(parseDockerStats(out)).toEqual({
      db: { cpu: 153.2, memMiB: 512.5 },
      realtime: { cpu: 40, memMiB: 1536 },
    });
  });
});

describe('the web client rules mirrored by the simulated players (T-029)', () => {
  it('presence activity matters on active on/off, a failing or fixed build, ±20 lines', () => {
    const sent = { lines: 50, last_build: 'ok' as const, typing: true };
    expect(activityMatters(null, sent)).toBe(true);
    expect(activityMatters(sent, { ...sent, typing: false })).toBe(true);
    expect(activityMatters(sent, { ...sent, last_build: 'error' })).toBe(true);
    expect(activityMatters(sent, { ...sent, lines: 69 })).toBe(false);
    expect(activityMatters(sent, { ...sent, lines: 70 })).toBe(true);
    expect(CLIENT_RULES.presenceActivityMs).toBe(15_000);
  });

  it('rejoins after 5, 10, 20, then 30 s, plus up to half again as jitter', () => {
    expect([0, 1, 2, 3, 4].map((n) => rejoinDelayMs(n, 0))).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000,
    ]);
    expect(rejoinDelayMs(0, 0.999)).toBe(7_498);
  });

  it('nudges back off 5, 10, 20, then every 30 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(nudgeBackoffMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ]);
    expect(NUDGE_BACKOFF_MS).toHaveLength(4);
  });
});
