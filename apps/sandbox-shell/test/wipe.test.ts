import { describe, expect, it } from 'vitest';
import {
  SerialQueue,
  clearCookieStore,
  cookieDomains,
  cookieExpiryAssignments,
  cookieNames,
  cookiePaths,
  type CookieStoreLike,
} from '../src/wipe';

describe('SerialQueue (reset is serialized against load)', () => {
  it('runs a load queued during an async reset only after the reset finished', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let finishReset: () => void = () => undefined;
    void q.push(
      () =>
        new Promise<void>((resolve) => {
          log.push('reset:start');
          finishReset = () => {
            log.push('reset:end');
            resolve();
          };
        }),
    );
    const load = q.push(() => {
      log.push('load');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['reset:start']);
    finishReset();
    await load;
    expect(log).toEqual(['reset:start', 'reset:end', 'load']);
  });

  it('keeps going after a failing task', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const failed = q.push(() => Promise.reject(new Error('boom')));
    const next = q.push(() => {
      log.push('next');
    });
    await expect(failed).rejects.toThrow('boom');
    await next;
    expect(log).toEqual(['next']);
  });
});

describe('cookie wipe helpers', () => {
  it('lists every path prefix of the shell path', () => {
    expect(cookiePaths('/v1/')).toEqual(['/', '/v1', '/v1/']);
    expect(cookiePaths('/v1/index.html')).toEqual(['/', '/v1', '/v1/', '/v1/index.html']);
    expect(cookiePaths('/')).toEqual(['/']);
  });

  it('lists host-only, host and parent-domain variants (none for IPs and localhost)', () => {
    expect(cookieDomains('b1.usercontent.example')).toEqual([
      null,
      'b1.usercontent.example',
      'usercontent.example',
    ]);
    expect(cookieDomains('127.0.0.1')).toEqual([null]);
    expect(cookieDomains('localhost')).toEqual([null]);
    expect(cookieDomains('::1')).toEqual([null]);
  });

  it('expires a name on every path x domain, with and without Secure/SameSite=None/Partitioned', () => {
    const a = cookieExpiryAssignments('sid', '/v1/', 'b1.usercontent.example');
    expect(a).toHaveLength(3 * 3 * 3);
    for (const s of a)
      expect(s).toMatch(/^sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; /);
    expect(a).toContain(
      'sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/v1; Domain=usercontent.example; Secure; SameSite=None; Partitioned',
    );
    expect(a).toContain('sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/');
    expect(a.filter((s) => s.endsWith('; Partitioned'))).toHaveLength(9);
    expect(a.filter((s) => s.includes('Domain=usercontent.example'))).toHaveLength(9);
  });

  it('parses names from document.cookie', () => {
    expect(cookieNames('a=1; b=2; a=3;  c')).toEqual(['a', 'b', 'c']);
    expect(cookieNames('')).toEqual([]);
  });

  it('deletes every cookie the Cookie Store API reports, keeping path/domain/partitioned', async () => {
    const deleted: unknown[] = [];
    const store: CookieStoreLike = {
      getAll: () =>
        Promise.resolve([
          { name: 'a', path: '/', domain: null, partitioned: false },
          { name: 'b', path: '/v1', domain: 'usercontent.example', partitioned: true },
        ]),
      delete: (o) => {
        deleted.push(o);
        return Promise.resolve();
      },
    };
    await clearCookieStore(store);
    expect(deleted).toEqual([
      { name: 'a', path: '/' },
      { name: 'b', path: '/v1', domain: 'usercontent.example', partitioned: true },
    ]);
  });
});
