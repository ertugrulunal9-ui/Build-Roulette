import { describe, expect, it } from 'vitest';
import {
  classifyRequest,
  decide,
  decodeSitePath,
  isHtmlType,
  isReservedPath,
  resolveSitePath,
  type Classified,
  type RoutingState,
} from '../src/sw-routing';

const ORIGIN = 'https://sandbox.example';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

const facts = (url: string, over: Partial<Parameters<typeof classifyRequest>[0]> = {}) => ({
  url,
  selfOrigin: ORIGIN,
  mode: 'cors',
  clientId: '',
  resultingClientId: '',
  ...over,
});

function state(
  over: Partial<{ clients: Record<string, string>; sites: string[]; latest: string | null }> = {},
): RoutingState {
  const clients = over.clients ?? {};
  const sites = over.sites ?? [A, B];
  return {
    siteOfClient: (id) => clients[id],
    hasSite: (id) => sites.includes(id),
    latest: over.latest === undefined ? B : over.latest,
  };
}

const live = (c: Classified): Exclude<Classified, { kind: 'pass' }> => {
  if (c.kind === 'pass') throw new Error('expected an intercepted request');
  return c;
};

describe('isReservedPath', () => {
  it('reserves the shell versions /v1 and /v2 only', () => {
    for (const p of [
      '/v1',
      '/v1/',
      '/v1/reset',
      '/v2/',
      '/v2/capture',
      '/v2/sw.js',
      '/v2',
      // Later shell versions: a surviving v2 worker must let them load.
      '/v3/',
      '/v10/capture',
    ]) {
      expect(isReservedPath(p), p).toBe(true);
    }
    for (const p of ['/', '/v', '/v2x', '/vx/', '/about', '/assets/v2/x.js', '/V2/']) {
      expect(isReservedPath(p), p).toBe(false);
    }
  });
});

describe('classifyRequest', () => {
  it('never intercepts another origin', () => {
    expect(classifyRequest(facts('https://cdn.example/x.js', { clientId: 'c1' }))).toEqual({
      kind: 'pass',
    });
    expect(
      classifyRequest(facts('https://sandbox.example.evil/?__br_site=x', { mode: 'navigate' })),
    ).toEqual({ kind: 'pass' });
  });

  it('never intercepts a navigation to a reserved path, whatever its query', () => {
    for (const url of [
      `${ORIGIN}/v2/`,
      `${ORIGIN}/v2/capture?src=x`,
      `${ORIGIN}/v1/?__br_site=${A}`,
    ]) {
      expect(classifyRequest(facts(url, { mode: 'navigate' })), url).toEqual({ kind: 'pass' });
    }
  });

  it('a navigation carries its site parameter and the client it creates', () => {
    expect(
      classifyRequest(
        facts(`${ORIGIN}/?__br_site=${A}`, { mode: 'navigate', resultingClientId: 'r1' }),
      ),
    ).toEqual({ kind: 'navigate', siteParam: A, resultingClientId: 'r1' });
    expect(classifyRequest(facts(`${ORIGIN}/about.html`, { mode: 'navigate' }))).toEqual({
      kind: 'navigate',
      siteParam: null,
      resultingClientId: '',
    });
  });

  it('a subresource is its client’s; one without a client is not intercepted', () => {
    expect(classifyRequest(facts(`${ORIGIN}/v2/anything.js`, { clientId: 'c1' }))).toEqual({
      kind: 'subresource',
      clientId: 'c1',
      resultingClientId: '',
    });
    expect(
      classifyRequest(
        facts(`${ORIGIN}/assets/worker.js`, { clientId: 'c1', resultingClientId: 'w1' }),
      ),
    ).toEqual({ kind: 'subresource', clientId: 'c1', resultingClientId: 'w1' });
    expect(classifyRequest(facts(`${ORIGIN}/x.js`))).toEqual({ kind: 'pass' });
    expect(classifyRequest(facts('not a url'))).toEqual({ kind: 'pass' });
  });
});

describe('decide', () => {
  it('a navigation with a known site id serves that site and maps the new document', () => {
    const c = live(
      classifyRequest(
        facts(`${ORIGIN}/?__br_site=${A}`, { mode: 'navigate', resultingClientId: 'r1' }),
      ),
    );
    expect(decide(c, state())).toEqual({ kind: 'serve', siteId: A, mapClient: 'r1' });
  });

  it('a navigation with an unknown or malformed site id is a missing site, never another site', () => {
    for (const id of ['c'.repeat(32), 'nope', `${A}x`, '']) {
      const c = live(classifyRequest(facts(`${ORIGIN}/?__br_site=${id}`, { mode: 'navigate' })));
      expect(decide(c, state()), id).toEqual({ kind: 'missing-site' });
    }
  });

  it('a navigation without a site id serves the latest site (links, reloads) and maps it', () => {
    const c = live(
      classifyRequest(facts(`${ORIGIN}/about.html`, { mode: 'navigate', resultingClientId: 'r2' })),
    );
    expect(decide(c, state({ latest: A }))).toEqual({ kind: 'serve', siteId: A, mapClient: 'r2' });
    // No site loaded (yet, or any more): the network answers.
    expect(decide(c, state({ latest: null }))).toEqual({ kind: 'pass' });
    expect(decide(c, state({ latest: A, sites: [B] }))).toEqual({ kind: 'pass' });
  });

  it('a subresource of a mapped client is its site, whatever the path', () => {
    const c = live(classifyRequest(facts(`${ORIGIN}/v2/reset`, { clientId: 'c1' })));
    expect(decide(c, state({ clients: { c1: A } }))).toEqual({
      kind: 'serve',
      siteId: A,
      mapClient: null,
    });
  });

  it('a worker script maps the worker to its creator’s site', () => {
    const c = live(
      classifyRequest(facts(`${ORIGIN}/assets/w.js`, { clientId: 'c1', resultingClientId: 'w1' })),
    );
    expect(decide(c, state({ clients: { c1: B } }))).toEqual({
      kind: 'serve',
      siteId: B,
      mapClient: 'w1',
    });
  });

  it('an unmapped client (the shell, the capture page) is not intercepted', () => {
    const c = live(classifyRequest(facts(`${ORIGIN}/v2/reset`, { clientId: 'shell' })));
    expect(decide(c, state({ clients: { c1: A } }))).toEqual({ kind: 'pass' });
  });

  it('a mapped client whose site was evicted gets a missing site, not the latest one', () => {
    const c = live(classifyRequest(facts(`${ORIGIN}/assets/x.js`, { clientId: 'c1' })));
    expect(decide(c, state({ clients: { c1: A }, sites: [B] }))).toEqual({ kind: 'missing-site' });
  });
});

describe('decodeSitePath', () => {
  it('drops the leading slash and percent-decodes', () => {
    expect(decodeSitePath('/')).toBe('');
    expect(decodeSitePath('/assets/a%20b.js')).toBe('assets/a b.js');
    expect(decodeSitePath('/%C3%BCber.html')).toBe('über.html');
    expect(decodeSitePath('/bad%E0%A4%A')).toBeNull();
  });
});

describe('resolveSitePath (static-host rules)', () => {
  const files = new Set([
    'index.html',
    'about.html',
    'assets/index-abc.js',
    'docs/index.html',
    'docs/guide.html',
    'a b.txt',
    'blog/index.html',
  ]);
  const has = (p: string) => files.has(p);

  it('/ and folder/ are their index.html', () => {
    expect(resolveSitePath(has, '/', false)).toEqual({
      kind: 'file',
      path: 'index.html',
      status: 200,
    });
    expect(resolveSitePath(has, '/docs/', true)).toEqual({
      kind: 'file',
      path: 'docs/index.html',
      status: 200,
    });
  });

  it('exact file, then path.html, then path/index.html', () => {
    expect(resolveSitePath(has, '/assets/index-abc.js', false)).toEqual({
      kind: 'file',
      path: 'assets/index-abc.js',
      status: 200,
    });
    expect(resolveSitePath(has, '/about', true)).toEqual({
      kind: 'file',
      path: 'about.html',
      status: 200,
    });
    expect(resolveSitePath(has, '/docs/guide', false)).toEqual({
      kind: 'file',
      path: 'docs/guide.html',
      status: 200,
    });
    expect(resolveSitePath(has, '/a%20b.txt', false)).toEqual({
      kind: 'file',
      path: 'a b.txt',
      status: 200,
    });
  });

  it('a folder without its slash: a navigation is redirected (keeping the query), a fetch is served', () => {
    expect(resolveSitePath(has, '/docs', true, '?x=1')).toEqual({
      kind: 'redirect',
      location: '/docs/?x=1',
    });
    expect(resolveSitePath(has, '/blog', false)).toEqual({
      kind: 'file',
      path: 'blog/index.html',
      status: 200,
    });
  });

  it('an unknown navigation gets index.html with a 200 (SPA fallback)', () => {
    for (const p of [
      '/about/team',
      '/settings',
      '/missing.html',
      '/assets/gone.js',
      '/bad%E0%A4%A',
    ]) {
      expect(resolveSitePath(has, p, true), p).toEqual({
        kind: 'file',
        path: 'index.html',
        status: 200,
      });
    }
  });

  it('any other miss is a 404', () => {
    for (const p of ['/assets/gone.js', '/missing.json', '/docs/nope/', '/bad%E0%A4%A']) {
      expect(resolveSitePath(has, p, false), p).toEqual({ kind: 'not-found' });
    }
    // A site without index.html at its root has no fallback (packs always have one).
    expect(resolveSitePath(() => false, '/x', true)).toEqual({ kind: 'not-found' });
  });
});

describe('isHtmlType', () => {
  it('matches text/html with or without parameters', () => {
    expect(isHtmlType('text/html')).toBe(true);
    expect(isHtmlType('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlType('TEXT/HTML;charset=utf-8')).toBe(true);
    expect(isHtmlType('text/htmlx')).toBe(false);
    expect(isHtmlType('application/xhtml+xml')).toBe(false);
    expect(isHtmlType('text/plain')).toBe(false);
  });
});
