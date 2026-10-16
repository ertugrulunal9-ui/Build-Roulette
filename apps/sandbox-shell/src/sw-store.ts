/**
 * The site worker's memory, and its copy in Cache Storage (docs/09 §9.3, "Surviving worker
 * restarts"). The browser stops an idle service worker whenever it likes (Chromium: after
 * about 30 s without events) and starts it again for the next event with empty globals, so
 * everything routing needs is written to the `SITE_CACHE` cache as well:
 *
 *   /__br_sw/state                      {v, order, latest, clients}: the site ids, oldest
 *                                       first, the latest site, and the client -> site map
 *   /__br_sw/sites/<id>/manifest        {v, profile, files: [[path, type]]}
 *   /__br_sw/sites/<id>/files/<path>    one file's bytes
 *
 * Only the `maxSites` most recent sites are kept (in memory and in the cache), and the client
 * map holds at most `maxClients` entries (oldest dropped first). A restarted worker reads the
 * state once (`load()`), and a site's manifest and files when a request needs them.
 *
 * The cache is on the sandbox origin, so build code can read, change or delete it. That can
 * break the build's own site (or one running at the same time in the same browser
 * partition), never a later load: every load uses a new random site id, and REVEAL wipes the
 * origin (Cache Storage included) before each other player's build. See the README.
 */

/** Where a site was uploaded from: the preview shell or the capture page (picks its headers). */
export type SiteProfile = 'preview' | 'capture';

export interface StoredFile {
  type: string;
  bytes: Uint8Array;
}

/** The parts of `CacheStorage` / `Cache` the store uses (a fake in unit tests). */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

interface SiteEntry {
  profile: SiteProfile;
  types: Map<string, string>;
  /** In memory after an upload; null when restored from the cache (read file by file). */
  bytes: Map<string, Uint8Array> | null;
}

interface PersistedState {
  v: 1;
  order: string[];
  latest: string | null;
  clients: [string, string][];
}

interface PersistedManifest {
  v: 1;
  profile: SiteProfile;
  files: [string, string][];
}

export interface SiteStoreOptions {
  /** The worker's origin: cache keys are URLs on it (never fetched). */
  origin: string;
  cacheName: string;
  maxSites?: number;
  maxClients?: number;
}

export class SiteStore {
  private readonly prefix: string;
  private readonly maxSites: number;
  private readonly maxClients: number;
  /** Site ids, oldest first. */
  private order: string[] = [];
  private readonly sites = new Map<string, SiteEntry>();
  private readonly clients = new Map<string, string>();
  private latestId: string | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  /** Cache writes run one after another, in call order. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: CacheStorageLike,
    private readonly opts: SiteStoreOptions,
  ) {
    this.prefix = `${opts.origin}/__br_sw/`;
    this.maxSites = opts.maxSites ?? 6;
    this.maxClients = opts.maxClients ?? 256;
  }

  get latest(): string | null {
    return this.latestId;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  hasSite(id: string): boolean {
    return this.order.includes(id);
  }

  siteOfClient(clientId: string): string | undefined {
    return this.clients.get(clientId);
  }

  /** Reads the persisted state once per worker start (an empty state if there is none). */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.readState().finally(() => {
      this.loaded = true;
      this.loading = null;
    });
    return this.loading;
  }

  /**
   * Merges the persisted state into memory again: another instance of the worker (an update
   * that activated meanwhile) may have stored a site this one has not seen.
   */
  async refresh(): Promise<void> {
    await this.load();
    await this.writes;
    await this.readState();
  }

  /** Stores a site (memory first, then the cache) and makes it the latest. */
  async put(id: string, profile: SiteProfile, files: readonly (StoredFile & { path: string })[]) {
    await this.load();
    const types = new Map<string, string>();
    const bytes = new Map<string, Uint8Array>();
    for (const f of files) {
      types.set(f.path, f.type);
      bytes.set(f.path, f.bytes);
    }
    this.sites.set(id, { profile, types, bytes });
    this.order = [...this.order.filter((s) => s !== id), id];
    this.latestId = id;
    const evicted = this.order.slice(0, Math.max(0, this.order.length - this.maxSites));
    for (const old of evicted) this.forget(old);
    await this.write(async (cache) => {
      const manifest: PersistedManifest = { v: 1, profile, files: [...types] };
      await cache.put(this.siteKey(id, 'manifest'), jsonResponse(manifest));
      for (const f of files) {
        await cache.put(
          this.fileKey(id, f.path),
          new Response(f.bytes.slice(), { headers: { 'Content-Type': f.type } }),
        );
      }
      for (const old of evicted) await this.deleteSite(cache, old);
      await this.writeState(cache);
    });
  }

  /** Maps a client (a site's document or worker) to a site, in memory and in the cache. */
  async mapClient(clientId: string, siteId: string): Promise<void> {
    if (this.clients.get(clientId) === siteId) return;
    this.clients.delete(clientId);
    this.clients.set(clientId, siteId);
    while (this.clients.size > this.maxClients) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
    await this.write((cache) => this.writeState(cache));
  }

  /** The profile and the content types by path of a site, or null if it is not held. */
  async site(
    id: string,
  ): Promise<{ profile: SiteProfile; types: ReadonlyMap<string, string> } | null> {
    if (!this.hasSite(id)) return null;
    const entry = await this.entry(id);
    return entry ? { profile: entry.profile, types: entry.types } : null;
  }

  /** One file of a site, or null. */
  async file(id: string, path: string): Promise<StoredFile | null> {
    const entry = this.hasSite(id) ? await this.entry(id) : null;
    const type = entry?.types.get(path);
    if (!entry || type === undefined) return null;
    const inMemory = entry.bytes?.get(path);
    if (inMemory) return { type, bytes: inMemory };
    const cache = await this.storage.open(this.opts.cacheName);
    const res = await cache.match(this.fileKey(id, path));
    if (!res) return null;
    return { type, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  // ---------------------------------------------------------------------------

  private async entry(id: string): Promise<SiteEntry | null> {
    const known = this.sites.get(id);
    if (known) return known;
    try {
      const cache = await this.storage.open(this.opts.cacheName);
      const res = await cache.match(this.siteKey(id, 'manifest'));
      if (!res) return null;
      // Read back as untrusted: build code can write this cache.
      const m = (await res.json()) as { v?: unknown; profile?: unknown; files?: unknown };
      if (m.v !== 1 || !Array.isArray(m.files)) return null;
      const files = (m.files as unknown[]).filter(
        (f): f is [string, string] =>
          Array.isArray(f) && typeof f[0] === 'string' && typeof f[1] === 'string',
      );
      const entry: SiteEntry = {
        profile: m.profile === 'capture' ? 'capture' : 'preview',
        types: new Map(files),
        bytes: null,
      };
      if (this.hasSite(id)) this.sites.set(id, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private forget(id: string): void {
    this.order = this.order.filter((s) => s !== id);
    this.sites.delete(id);
    for (const [client, site] of [...this.clients]) if (site === id) this.clients.delete(client);
    if (this.latestId === id) this.latestId = this.order.at(-1) ?? null;
  }

  private async readState(): Promise<void> {
    try {
      const cache = await this.storage.open(this.opts.cacheName);
      const res = await cache.match(`${this.prefix}state`);
      if (!res) return;
      // Read back as untrusted: build code can write this cache.
      const s = (await res.json()) as {
        v?: unknown;
        order?: unknown;
        latest?: unknown;
        clients?: unknown;
      };
      if (s.v !== 1 || !Array.isArray(s.order) || !Array.isArray(s.clients)) return;
      const persisted = (s.order as unknown[]).filter((id): id is string => typeof id === 'string');
      const before = new Set(this.order);
      // The cache's order is the authority (another instance may have stored newer sites);
      // ids only memory knows (none after a fresh start) count as older.
      this.order = [...this.order.filter((id) => !persisted.includes(id)), ...persisted].slice(
        -this.maxSites,
      );
      for (const pair of s.clients as unknown[]) {
        if (!Array.isArray(pair)) continue;
        const [client, site] = pair as unknown[];
        if (typeof client === 'string' && typeof site === 'string' && !this.clients.has(client))
          this.clients.set(client, site);
      }
      const latest = s.latest;
      if (
        typeof latest === 'string' &&
        this.order.includes(latest) &&
        (this.latestId === null || !before.has(latest))
      )
        this.latestId = latest;
      if (this.latestId !== null && !this.order.includes(this.latestId))
        this.latestId = this.order.at(-1) ?? null;
    } catch {
      // An unreadable state is an empty one: the next load uploads its site again.
    }
  }

  private writeState(cache: CacheLike): Promise<void> {
    const state: PersistedState = {
      v: 1,
      order: this.order,
      latest: this.latestId,
      clients: [...this.clients].filter(([, site]) => this.order.includes(site)),
    };
    return cache.put(`${this.prefix}state`, jsonResponse(state));
  }

  private async deleteSite(cache: CacheLike, id: string): Promise<void> {
    const prefix = `${this.prefix}sites/${id}/`;
    for (const req of await cache.keys())
      if (req.url.startsWith(prefix)) await cache.delete(req.url);
  }

  private write(fn: (cache: CacheLike) => Promise<void>): Promise<void> {
    const run = this.writes.then(async () => {
      await fn(await this.storage.open(this.opts.cacheName));
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private siteKey(id: string, name: string): string {
    return `${this.prefix}sites/${id}/${name}`;
  }

  private fileKey(id: string, path: string): string {
    return `${this.prefix}sites/${id}/files/${encodeURIComponent(path)}`;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
