/**
 * Availability under load, end to end against the in-memory registry: load shedding (503 +
 * Retry-After), cancellation on client disconnect and request timeout, request coalescing,
 * the disk quota while serving, and the metrics on /health.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type CdnConfig } from '../src/config';
import { Denylist } from '../src/policy';
import type { FetchLike } from '../src/registry';
import { startCdnServer, type CdnServer } from '../src/server';
import { createFakeRegistry, type FakePackage } from './helpers/fake-registry';

const dirs: string[] = [];
const servers: CdnServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function packages(): Record<string, FakePackage> {
  const out: Record<string, FakePackage> = {
    slow: { versions: { '1.0.0': { files: { 'index.js': 'export const slow = 1;' } } } },
    app: {
      versions: {
        '1.0.0': {
          dependencies: { dep: '^1.0.0' },
          files: { 'index.js': "export { name } from 'dep';" },
        },
      },
    },
    dep: { versions: { '1.0.0': { files: { 'index.js': "export const name = 'dep';" } } } },
  };
  for (let i = 0; i < 6; i++) {
    out[`p${String(i)}`] = {
      versions: {
        '1.0.0': {
          dependencies: { dep: '^1.0.0' },
          files: { 'index.js': `export { name } from 'dep';\nexport const n = ${String(i)};` },
        },
      },
    };
  }
  return out;
}

interface Gate {
  /** Signals of the requests held at the gate. */
  held: AbortSignal[];
  open(): void;
}

/** Holds registry requests whose URL matches until the gate opens (or they are aborted). */
function gated(
  inner: FetchLike,
  match: (url: string) => boolean,
): { fetch: FetchLike; gate: Gate } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  const gate: Gate = {
    held: [],
    open: () => {
      open();
    },
  };
  const fetchImpl: FetchLike = async (url, init) => {
    if (match(url)) {
      const signal = init?.signal ?? new AbortController().signal;
      gate.held.push(signal);
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
        void opened.then(resolve);
      });
    }
    return inner(url, init);
  };
  return { fetch: fetchImpl, gate };
}

async function start(fetchImpl: FetchLike, tweak: (c: CdnConfig) => void = () => undefined) {
  const root = mkdtempSync(path.join(tmpdir(), 'pkg-cdn-limits-'));
  dirs.push(root);
  const config: CdnConfig = {
    ...loadConfig({}),
    host: '127.0.0.1',
    port: 0,
    cacheDir: path.join(root, 'cache'),
    registryUrl: 'https://registry.test',
  };
  tweak(config);
  const server = await startCdnServer(config, { fetch: fetchImpl, denylist: new Denylist() });
  servers.push(server);
  return server;
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('load shedding', () => {
  it('answers 503 with Retry-After when the registry queue is full', async () => {
    const reg = createFakeRegistry(packages());
    const { fetch: f, gate } = gated(reg.fetch, (u) => u.endsWith('/slow'));
    const server = await start(f, (c) => {
      c.fetches = { concurrent: 1, queue: 1 };
      c.retryAfterSeconds = 3;
    });
    const held = fetch(`${server.url}/slow@1.0.0`); // holds the only registry slot
    await until(() => gate.held.length === 1);
    const queued = fetch(`${server.url}/app@1.0.0`); // takes the only queue place
    await until(() => server.cdn.limiters.fetches.stats().queued === 1);
    const shed = await fetch(`${server.url}/p0@1.0.0`);
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('3');
    expect(shed.headers.get('cache-control')).toBe('no-store');
    expect(shed.headers.get('x-pkg-cdn-error')).toBe('overloaded');
    gate.open();
    expect((await held).status).toBe(200);
    // (with a queue of 1, its own parallel downloads may be shed too: 200 or 503)
    expect([200, 503]).toContain((await queued).status);
    // Once the queue drains, the shed request succeeds.
    expect((await fetch(`${server.url}/p0@1.0.0`)).status).toBe(200);
    const health = (await (await fetch(`${server.url}/health`)).json()) as {
      requests: { shed: number; byStatus: Record<string, number> };
      queues: { registry: { shed: number; maxActive: number } };
    };
    expect(health.requests.shed).toBeGreaterThanOrEqual(1);
    expect(health.requests.byStatus['503']).toBe(health.requests.shed);
    expect(health.queues.registry.shed).toBeGreaterThanOrEqual(1);
    expect(health.queues.registry.maxActive).toBe(1);
  });

  it('sheds builds past the build queue', async () => {
    const reg = createFakeRegistry(packages());
    const server = await start(reg.fetch, (c) => {
      c.builds = { concurrent: 1, queue: 1 };
    });
    // Occupy the only build slot.
    let release: () => void = () => undefined;
    const busy = server.cdn.limiters.builds.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const queued = fetch(`${server.url}/p0@1.0.0`);
    await until(() => server.cdn.limiters.builds.stats().queued === 1);
    const shed = await fetch(`${server.url}/p1@1.0.0`);
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('5');
    release();
    await busy;
    expect((await queued).status).toBe(200);
    // The tree of p1 was installed before its build was shed: the retry only builds.
    expect((await fetch(`${server.url}/p1@1.0.0`)).status).toBe(200);
    expect(server.cdn.limiters.builds.stats()).toMatchObject({ shed: 1, active: 0, queued: 0 });
  });
});

describe('cancellation', () => {
  it('cancels queued and shared work when the client disconnects', async () => {
    const reg = createFakeRegistry(packages());
    const { fetch: f, gate } = gated(reg.fetch, (u) => u.includes('/-/'));
    const server = await start(f);
    const controller = new AbortController();
    const req = fetch(`${server.url}/app@1.0.0`, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    await until(() => gate.held.length > 0); // a tarball download is in flight
    controller.abort();
    await req;
    // The download is aborted and every slot is released: nothing orphaned keeps running.
    await until(() => gate.held.every((s) => s.aborted));
    await until(() => server.cdn.limiters.fetches.stats().active === 0);
    await until(() => server.cdn.metrics().inflight.bundles === 0);
    expect(server.cdn.metrics().inflight).toEqual({
      bundles: 0,
      trees: 0,
      packages: 0,
      packuments: 0,
    });
    const health = (await (await fetch(`${server.url}/health`)).json()) as {
      requests: { clientClosed: number };
    };
    expect(health.requests.clientClosed).toBe(1);
    // Nothing half-done was cached: the next request does the work again and succeeds.
    gate.open();
    expect((await fetch(`${server.url}/app@1.0.0`)).status).toBe(200);
  });

  it('keeps shared work alive for the requests that still want it', async () => {
    const reg = createFakeRegistry(packages());
    const { fetch: f, gate } = gated(reg.fetch, (u) => u.includes('/-/'));
    const server = await start(f);
    const leaving = new AbortController();
    const a = fetch(`${server.url}/app@1.0.0`, { signal: leaving.signal }).catch(() => null);
    const b = fetch(`${server.url}/app@1.0.0`);
    await until(() => gate.held.length > 0);
    leaving.abort();
    await a;
    await new Promise((r) => setTimeout(r, 20));
    expect(gate.held.some((s) => s.aborted)).toBe(false);
    gate.open();
    const res = await b;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('dep');
  });

  it('answers 504 at the request deadline and cancels the work', async () => {
    const reg = createFakeRegistry(packages());
    const { fetch: f, gate } = gated(reg.fetch, (u) => u.includes('/-/'));
    const server = await start(f, (c) => {
      c.requestTimeoutMs = 100;
    });
    const res = await fetch(`${server.url}/app@1.0.0`);
    expect(res.status).toBe(504);
    expect(await res.text()).toMatch(/request took longer than 100 ms/);
    await until(() => gate.held.length > 0 && gate.held.every((s) => s.aborted));
    await until(() => server.cdn.limiters.fetches.stats().active === 0);
  });
});

describe('request coalescing', () => {
  it('builds a bundle once for concurrent requests (one download per package)', async () => {
    const reg = createFakeRegistry(packages());
    const server = await start(reg.fetch);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const r = await fetch(`${server.url}/app@1.0.0`);
        return { status: r.status, body: await r.text() };
      }),
    );
    expect(results.every((r) => r.status === 200 && r.body === results[0]?.body)).toBe(true);
    expect(reg.requests.filter((r) => r.startsWith('tarball')).sort()).toEqual([
      'tarball /app/-/app-1.0.0.tgz',
      'tarball /dep/-/dep-1.0.0.tgz',
    ]);
    expect(reg.requests.filter((r) => r === 'packument app')).toHaveLength(1);
    expect(server.cdn.stats.bundlesBuilt).toBe(1);
  });
});

describe('disk quota while serving', () => {
  it('keeps serving correct bundles while evicting, and ends under quota', async () => {
    const reg = createFakeRegistry(packages());
    const server = await start(reg.fetch, (c) => {
      c.cacheQuotaBytes = 64 * 1024; // a few entries' worth
    });
    const urls = ['app', 'p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((p) => `${server.url}/${p}@1.0.0`);
    for (let round = 0; round < 2; round++) {
      const bodies = await Promise.all(
        urls.map(async (u) => {
          const r = await fetch(u);
          expect(r.status).toBe(200);
          return r.text();
        }),
      );
      expect(bodies.every((b) => b.includes('"dep"'))).toBe(true);
    }
    await server.cdn.index.evictIfNeeded();
    const health = (await (await fetch(`${server.url}/health`)).json()) as {
      cache: { bytes: number; quotaBytes: number; evictedEntries: number; leased: number };
    };
    expect(health.cache.evictedEntries).toBeGreaterThan(0);
    expect(health.cache.leased).toBe(0);
    expect(health.cache.bytes).toBeLessThanOrEqual(health.cache.quotaBytes);
  });
});

describe('/health', () => {
  it('reports queues, in-flight work, cache usage and request counts', async () => {
    const reg = createFakeRegistry(packages());
    const server = await start(reg.fetch);
    expect((await fetch(`${server.url}/app@1.0.0`)).status).toBe(200);
    const res = await fetch(`${server.url}/health`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      queues: {
        registry: { active: 0, queued: 0, maxActive: 16, maxQueue: 2000 },
        extraction: { active: 0, queued: 0, maxActive: 4 },
        build: { active: 0, queued: 0, maxActive: 4, maxQueue: 64 },
      },
      inflight: { bundles: 0, trees: 0, packages: 0, packuments: 0 },
      cache: { entries: { store: 2, trees: 1, bundles: 1 }, evictedEntries: 0 },
      requests: { byStatus: { '200': 1 }, shed: 0 },
    });
    expect((body['cache'] as { bytes: number }).bytes).toBeGreaterThan(0);
    // No secrets or server paths.
    expect(JSON.stringify(body)).not.toContain(tmpdir());
  });
});
