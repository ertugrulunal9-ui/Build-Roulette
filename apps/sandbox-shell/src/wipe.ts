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

/** Deletes every cookie the Cookie Store API can see (it sees exactly what document.cookie sees). */
export async function clearCookieStore(store: CookieStoreLike): Promise<void> {
  for (const c of await store.getAll()) {
    await store.delete({
      name: c.name,
      ...(c.domain ? { domain: c.domain } : {}),
      ...(c.path ? { path: c.path } : {}),
      ...(c.partitioned ? { partitioned: true } : {}),
    });
  }
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
