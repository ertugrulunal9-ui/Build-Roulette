/**
 * Storage wipe helpers for the shell's `reset-storage` (docs/03 §3.6, §3.9 "Incomplete
 * storage wipe"). Pure parts are exported for unit tests; the browser parts take what they
 * need as arguments and never throw past `attempt`.
 */

/** Runs tasks one after another, in the order they were queued; a failing task does not stop the queue. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(task: () => void | Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/** `/`, then every prefix of `pathname` with and without a trailing slash (`/v1`, `/v1/`, …). */
export function cookiePaths(pathname: string): string[] {
  const out = new Set<string>(['/']);
  const segments = pathname.split('/').filter(Boolean);
  let acc = '';
  for (let i = 0; i < segments.length; i++) {
    acc += `/${segments[i] ?? ''}`;
    out.add(acc);
    if (i < segments.length - 1 || pathname.endsWith('/')) out.add(`${acc}/`);
  }
  return [...out];
}

/**
 * `Domain=` values a cookie visible here may have been set with: none (host-only), the host
 * itself and each parent domain with at least two labels. IP addresses and single-label
 * hosts (localhost) only have host-only cookies.
 */
export function cookieDomains(hostname: string): (string | null)[] {
  const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  const labels = hostname.split('.');
  if (isIp || labels.length < 2) return [null];
  const out: (string | null)[] = [null];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/**
 * `document.cookie` assignments that expire cookie `name` for every path prefix of the
 * current path and every domain variant, each without security attributes, with
 * `Secure; SameSite=None` (needed to touch cookies in a third-party iframe), and with
 * `Partitioned` on top (CHIPS cookies are a separate jar).
 */
export function cookieExpiryAssignments(
  name: string,
  pathname: string,
  hostname: string,
): string[] {
  const out: string[] = [];
  for (const path of cookiePaths(pathname)) {
    for (const domain of cookieDomains(hostname)) {
      const base = `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=${path}${domain ? `; Domain=${domain}` : ''}`;
      out.push(
        base,
        `${base}; Secure; SameSite=None`,
        `${base}; Secure; SameSite=None; Partitioned`,
      );
    }
  }
  return out;
}

/** Cookie names currently visible in a `document.cookie` string. */
export function cookieNames(cookieString: string): string[] {
  const names = new Set<string>();
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (name) names.add(name);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Browser APIs not (yet) in TypeScript's DOM lib.
// ---------------------------------------------------------------------------

interface CookieListItemLike {
  name: string;
  domain?: string | null;
  path?: string | null;
  partitioned?: boolean | null;
}
export interface CookieStoreLike {
  getAll(): Promise<CookieListItemLike[]>;
  set(options: {
    name: string;
    value: string;
    expires?: number;
    domain?: string;
    path?: string;
    sameSite?: 'strict' | 'lax' | 'none';
    partitioned?: boolean;
  }): Promise<void>;
  delete(options: {
    name: string;
    domain?: string;
    path?: string;
    partitioned?: boolean;
  }): Promise<void>;
}
interface StorageBucketManagerLike {
  keys(): Promise<string[]>;
  delete(name: string): Promise<void>;
}
interface DirectoryLike {
  keys(): AsyncIterable<string>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * Deletes every cookie the Cookie Store API can see (it sees what `document.cookie` sees).
 * `delete()` writes its expired cookie as `SameSite=Strict`, which Chromium refuses in a
 * cross-site iframe (the shell always is one), so each cookie is first overwritten with an
 * expired `SameSite=None` copy, and `delete()` is only the fallback. Returns the names it
 * could not remove; the caller sweeps with `document.cookie` afterwards anyway.
 */
export async function clearCookieStore(store: CookieStoreLike): Promise<string[]> {
  const failed: string[] = [];
  for (const c of await store.getAll()) {
    const where = {
      ...(c.domain ? { domain: c.domain } : {}),
      ...(c.path ? { path: c.path } : {}),
      ...(c.partitioned ? { partitioned: true } : {}),
    };
    try {
      await store.set({ name: c.name, value: '', expires: 0, sameSite: 'none', ...where });
    } catch {
      try {
        await store.delete({ name: c.name, ...where });
      } catch {
        failed.push(c.name);
      }
    }
  }
  return failed;
}

/** Expires every visible cookie name for every path prefix and domain variant. */
export function expireDocumentCookies(doc: Document, loc: Location): void {
  for (const name of cookieNames(doc.cookie)) {
    for (const assignment of cookieExpiryAssignments(name, loc.pathname, loc.hostname)) {
      doc.cookie = assignment;
    }
  }
}

/** Removes every entry of the origin private file system. */
export async function clearOpfs(storage: StorageManager): Promise<void> {
  if (typeof storage.getDirectory !== 'function') return;
  const root = (await storage.getDirectory()) as unknown as DirectoryLike;
  const names: string[] = [];
  for await (const name of root.keys()) names.push(name);
  for (const name of names) await root.removeEntry(name, { recursive: true });
}

/** Deletes every Storage Bucket (Chromium), if the API exists. */
export async function clearStorageBuckets(nav: Navigator): Promise<void> {
  const buckets = (nav as Navigator & { storageBuckets?: StorageBucketManagerLike }).storageBuckets;
  if (!buckets) return;
  for (const name of await buckets.keys()) await buckets.delete(name);
}

/** Unregisters every service worker registration of the origin. */
export async function clearServiceWorkers(nav: Navigator): Promise<void> {
  const sw = (nav as Partial<Navigator>).serviceWorker;
  if (!sw) return;
  for (const reg of await sw.getRegistrations()) await reg.unregister();
}

/**
 * Fetches the shell host's reset endpoint, whose `Clear-Site-Data: "cache", "cookies",
 * "storage"` response header makes the browser wipe what script cannot reach (HttpOnly
 * cookies, cookies on unrelated paths or parent domains, the HTTP cache).
 */
export async function fetchClearSiteData(url: URL, timeoutMs: number): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

function deleteDatabase(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(`IndexedDB "${name}" deletion timed out`);
    }, 3000);
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(null);
    };
    req.onerror = () => {
      clearTimeout(timer);
      resolve(`IndexedDB "${name}": ${req.error?.message ?? 'error'}`);
    };
  });
}

/**
 * Wipes everything the origin can hold (browser only): `localStorage`, `sessionStorage`,
 * every IndexedDB database, CacheStorage, cookies, OPFS, Storage Buckets and service
 * workers, then fetches `resetUrl` for `Clear-Site-Data`. Close the running build first: an
 * open IndexedDB connection blocks deletion. Never throws; returns the errors.
 */
export async function wipeOriginStorage(resetUrl: URL): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await attempt('localStorage', () => {
    localStorage.clear();
  });
  await attempt('sessionStorage', () => {
    sessionStorage.clear();
  });
  await attempt('indexedDB', async () => {
    const dbs = await indexedDB.databases();
    const results = await Promise.all(
      dbs.map((db) => (db.name ? deleteDatabase(db.name) : Promise.resolve(null))),
    );
    for (const r of results) if (r) errors.push(r);
  });
  await attempt('caches', async () => {
    if (typeof caches === 'undefined') return;
    for (const key of await caches.keys()) await caches.delete(key);
  });
  await attempt('cookies', async () => {
    const store = (globalThis as { cookieStore?: CookieStoreLike }).cookieStore;
    if (store) await clearCookieStore(store);
    // Also without the Cookie Store API (Firefox < 140, Safari < 18.4), and for anything it
    // left: expire every visible name for each path prefix and Domain variant, with and
    // without `Partitioned`.
    expireDocumentCookies(document, location);
    const left = cookieNames(document.cookie);
    if (left.length > 0) throw new Error(`still visible: ${left.join(', ')}`);
  });
  await attempt('opfs', () => clearOpfs(navigator.storage));
  await attempt('storageBuckets', () => clearStorageBuckets(navigator));
  await attempt('serviceWorkers', () => clearServiceWorkers(navigator));
  // Last: the host's Clear-Site-Data endpoint covers what script cannot reach (HttpOnly
  // cookies, cookies on other paths or the parent domain, the HTTP cache).
  await attempt('clearSiteData', () => fetchClearSiteData(resetUrl, 5000));
  return errors;
}
