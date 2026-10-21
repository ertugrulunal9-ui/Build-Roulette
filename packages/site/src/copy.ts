/**
 * Copying a published site from its link into a site pack (docs/10 §10.2). Runs in the
 * `import-url` Edge Function (Deno) with the real `fetch`, and in Node in the tests with a fake
 * one; pure TypeScript, no dependencies.
 *
 * 1. The link: at most `maxRedirects` redirects, followed by hand and each hop checked
 *    against the host rules (`checkPublicUrl`). The final URL's origin is the site's origin,
 *    its folder the site root (`https://x.lovable.app/` → `/`). The page is stored as
 *    `index.html`.
 * 2. Breadth-first over what the files reference (`discover.ts`), same origin and inside the
 *    root only: cross-origin URLs (CDNs, fonts, APIs) are left alone, the sandbox loads them
 *    itself. Query strings are dropped from stored paths (`app.js?v=3` → `app.js`), and each
 *    stored path is fetched once.
 * 3. Limits: `maxFiles` files and `maxBytes` bytes (the pack limits), `concurrency` requests at
 *    a time, `requestTimeoutMs` per request (redirects included), `totalTimeoutMs` for the whole
 *    copy. The copy stops at the first limit it reaches.
 *
 * Never throws: every failure is a `CopyError`.
 */
import { contentTypeOf } from './content-types';
import { discoverCss, discoverHtml, discoverJs, discoverManifest, type FoundRef } from './discover';
import { checkPublicUrl, isLoginUrl } from './hosts';
import type { ImportedSite } from './import';
import { SITE_LIMITS } from './limits';
import { SITE_ENTRY, SitePackError, packSite, type SiteFile } from './pack';
import { isValidSitePath } from './paths';

export type UrlImportErrorCode =
  /** Not a link at all, not `https:`, a port, a user name. */
  | 'url-invalid'
  /** Not on one of the allowed hosts (`IMPORT_URL_HOSTS`), or redirected off them. */
  | 'url-host-not-allowed'
  /** The page could not be loaded (not found, a server error, no connection). */
  | 'url-unreachable'
  /** The link answers with something other than a web page. */
  | 'url-not-html'
  /** A login wall or a password page. */
  | 'url-private'
  /** The site took too long. */
  | 'url-timeout'
  /** Too many links imported recently (the `import-url` function's rate limit). */
  | 'rate-limited';

export type CopyErrorCode = UrlImportErrorCode | 'too-many-files' | 'too-large';

export interface CopyError {
  code: CopyErrorCode;
  /** A status, a path or a number that makes the message concrete. */
  detail?: string;
}

/** The same shape as `ImportResult`: the app treats a copied site like a dropped one. */
export type CopyResult = { ok: true; site: ImportedSite } | { ok: false; error: CopyError };

export interface CopyLimits {
  maxFiles: number;
  /** Sum of the files' sizes; the pack (with its header) must still fit `SITE_LIMITS`. */
  maxBytes: number;
  concurrency: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
}

export const COPY_LIMITS: Readonly<CopyLimits> = {
  maxFiles: SITE_LIMITS.maxFiles,
  maxBytes: SITE_LIMITS.maxPackBytes,
  concurrency: 4,
  requestTimeoutMs: 10_000,
  totalTimeoutMs: 45_000,
  maxRedirects: 3,
};

/** The subset of `fetch` the copier uses. */
export type CopyFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export interface CopyOptions {
  fetch: CopyFetch;
  /** Milliseconds, for the total deadline (default `Date.now`). */
  now?: () => number;
  limits?: Partial<CopyLimits>;
  /** Aborts the copy (the function passes the request's signal: the caller went away). */
  signal?: AbortSignal;
  /**
   * Exact origins accepted besides the public host rules (`http://127.0.0.1:4321`). Only the
   * function's local test run passes any (supabase/functions/import-url/index.ts).
   */
  extraOrigins?: readonly string[];
}

const HEADERS = {
  accept: '*/*',
  'user-agent': 'BuildRouletteImport/1 (copies a published site for the game Build Roulette)',
};
const PAGE_HEADERS = {
  ...HEADERS,
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
};
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A failure that ends the copy. */
class CopyFailure extends Error {
  constructor(readonly error: CopyError) {
    super(error.code);
  }
}

/** A file that is skipped (not found, not a file of the site). `counted`: shown as skipped. */
class Skip extends Error {
  constructor(readonly counted: boolean) {
    super('skip');
  }
}

interface Task {
  url: URL;
  path: string;
  kind: 'sure' | 'guess';
  as?: 'page' | 'manifest';
}

function fail(code: CopyErrorCode, detail?: string): never {
  throw new CopyFailure(detail === undefined ? { code } : { code, detail });
}

/** `https://x.app/a/b.html?q` → `/a/`. */
function folderOf(url: URL): string {
  return url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
}

/** The path of `url` inside the site, or null when it is outside the root or not storable. */
function sitePathOf(url: URL, root: string): string | null {
  if (!url.pathname.startsWith(root)) return null;
  let rel = url.pathname.slice(root.length);
  if (rel === '' || rel.endsWith('/')) rel += SITE_ENTRY;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  return isValidSitePath(decoded) ? decoded : null;
}

function isHtmlType(type: string | null): boolean {
  return /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(type ?? '');
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

function isAbort(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    ((e as { name?: unknown }).name === 'AbortError' ||
      (e as { name?: unknown }).name === 'TimeoutError')
  );
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

/**
 * Reads a body, at most `cap` bytes: more is `too-large` (the copy would not fit anyway), so
 * a huge or endless response never fills the memory.
 */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await cancelBody(res);
    fail('too-large');
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
      fail('too-large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Copies the site at `link`. See the file comment. */
export async function copySite(link: string | URL, opts: CopyOptions): Promise<CopyResult> {
  const limits: CopyLimits = { ...COPY_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => Date.now());
  const extra = opts.extraOrigins ?? [];
  const checked = checkPublicUrl(link, extra);
  if (!checked.ok) return { ok: false, error: checked.error };

  const started = now();
  const deadline = started + limits.totalTimeoutMs;
  // Why every request was aborted: the total deadline, the caller, or a failed file.
  const all = new AbortController();
  let stop: 'timeout' | 'cancelled' | 'failed' | null = null;
  const abortAll = (why: 'timeout' | 'cancelled' | 'failed') => {
    stop ??= why;
    all.abort();
  };
  const totalTimer = setTimeout(() => {
    abortAll('timeout');
  }, limits.totalTimeoutMs);
  const onOuterAbort = () => {
    abortAll('cancelled');
  };
  opts.signal?.addEventListener('abort', onOuterAbort);
  if (opts.signal?.aborted) abortAll('cancelled');
  const stopped = (): never => {
    if (stop === 'cancelled') fail('url-unreachable', 'cancelled');
    fail('url-timeout');
  };

  /**
   * One request with its redirects (each hop checked by `allowHop`), within the per-request
   * timeout and the total deadline. Returns the final response and URL.
   */
  const request = async (
    start: URL,
    headers: Record<string, string>,
    allowHop: (next: URL) => void,
    read: (res: Response, url: URL) => Promise<Uint8Array>,
  ): Promise<{ res: Response; url: URL; bytes: Uint8Array | null }> => {
    const remaining = deadline - now();
    if (all.signal.aborted) stopped();
    if (remaining <= 0) {
      abortAll('timeout');
      stopped();
    }
    const one = new AbortController();
    const own = { timedOut: false };
    // When the total deadline comes first, its timeout is the copy's, not this request's.
    const last = remaining <= limits.requestTimeoutMs;
    const timer = setTimeout(
      () => {
        if (last) {
          abortAll('timeout');
          return;
        }
        own.timedOut = true;
        one.abort();
      },
      Math.min(limits.requestTimeoutMs, remaining),
    );
    const relay = () => {
      one.abort();
    };
    all.signal.addEventListener('abort', relay);
    try {
      let url = start;
      for (let hop = 0; ; hop++) {
        const res = await opts.fetch(url.href, {
          redirect: 'manual',
          signal: one.signal,
          headers,
        });
        const location = res.headers.get('location');
        if (REDIRECT_STATUSES.has(res.status) && location !== null) {
          await cancelBody(res);
          if (hop >= limits.maxRedirects) fail('url-unreachable', 'too many redirects');
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            fail('url-unreachable', 'bad redirect');
          }
          next.hash = '';
          allowHop(next);
          url = next;
          continue;
        }
        if (res.status === 200) return { res, url, bytes: await read(res, url) };
        await cancelBody(res);
        return { res, url, bytes: null };
      }
    } catch (e) {
      if (e instanceof CopyFailure || e instanceof Skip) throw e;
      if (all.signal.aborted) stopped();
      if (own.timedOut || isAbort(e)) fail('url-timeout', start.pathname);
      fail('url-unreachable', 'no connection');
    } finally {
      clearTimeout(timer);
      all.signal.removeEventListener('abort', relay);
    }
  };

  try {
    // ── 1. The page ──
    const entry = await request(
      checked.url,
      PAGE_HEADERS,
      (next) => {
        const hop = checkPublicUrl(next, extra);
        if (hop.ok) return;
        if (isLoginUrl(next)) fail('url-private', next.hostname);
        fail(hop.error.code, hop.error.detail);
      },
      (res) => readCapped(res, limits.maxBytes),
    );
    const status = entry.res.status;
    if (status === 401 || status === 403) fail('url-private', String(status));
    if (entry.bytes === null) fail('url-unreachable', String(status));
    const type = entry.res.headers.get('content-type');
    if (type ? !isHtmlType(type) : !looksLikeHtml(entry.bytes)) {
      fail('url-not-html', type?.split(';')[0]?.trim() ?? undefined);
    }

    const origin = entry.url.origin;
    const root = folderOf(entry.url);
    const files = new Map<string, SiteFile>();
    let bytes = 0;
    let skipped = 0;
    const store = (path: string, data: Uint8Array) => {
      if (files.size >= limits.maxFiles) {
        fail('too-many-files', `more than ${String(limits.maxFiles)}`);
      }
      bytes += data.byteLength;
      if (bytes > limits.maxBytes) fail('too-large');
      files.set(path, { path, type: contentTypeOf(path), bytes: data });
    };
    store(SITE_ENTRY, entry.bytes);

    // ── 2. What the files reference ──
    const queued = new Set<string>([SITE_ENTRY]);
    const entryPath = sitePathOf(entry.url, root);
    if (entryPath !== null) queued.add(entryPath);
    const queue: Task[] = [];
    const rootUrl = new URL(root, origin);

    const enqueue = (refs: readonly FoundRef[], fileUrl: URL, base: URL | null) => {
      for (const r of refs) {
        let url: URL;
        try {
          url = new URL(r.ref, r.base === 'root' ? rootUrl : (base ?? fileUrl));
        } catch {
          continue;
        }
        if (url.origin !== origin) continue; // cross-origin: the sandbox loads it itself
        url.hash = '';
        const path = sitePathOf(url, root);
        if (path === null) {
          if (r.kind === 'sure') skipped++;
          continue;
        }
        if (queued.has(path)) continue;
        queued.add(path);
        queue.push(r.as ? { url, path, kind: r.kind, as: r.as } : { url, path, kind: r.kind });
      }
    };

    const decoder = new TextDecoder();
    const discover = (path: string, data: Uint8Array, url: URL, as?: 'page' | 'manifest') => {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      if (as === 'manifest' || ext === 'webmanifest') {
        enqueue(discoverManifest(decoder.decode(data)), url, null);
      } else if (ext === 'html' || ext === 'htm') {
        const { refs, base } = discoverHtml(decoder.decode(data));
        let baseUrl: URL | null = null;
        if (base !== null) {
          try {
            baseUrl = new URL(base, url);
          } catch {
            baseUrl = null;
          }
        }
        enqueue(refs, url, baseUrl);
      } else if (ext === 'css') {
        enqueue(discoverCss(decoder.decode(data)), url, null);
      } else if (ext === 'js' || ext === 'mjs') {
        enqueue(discoverJs(decoder.decode(data)), url, null);
      }
    };
    discover(SITE_ENTRY, entry.bytes, entry.url);

    const fetchFile = async (t: Task) => {
      // A file redirected off the site is not a file of the site.
      const sameOrigin = (next: URL) => {
        if (next.origin !== origin || !checkPublicUrl(next, extra).ok) {
          throw new Skip(t.kind === 'sure');
        }
      };
      try {
        const got = await request(
          t.url,
          t.as === 'page' ? PAGE_HEADERS : HEADERS,
          sameOrigin,
          (res) => readCapped(res, Math.max(0, limits.maxBytes - bytes)),
        );
        if (got.bytes === null) {
          const s = got.res.status;
          // Not there: a broken link or a wrong guess. A server error on a file the page
          // needs fails the copy (the site would be broken without saying so).
          if (s === 404 || s === 410 || t.kind === 'guess' || (s >= 400 && s < 500)) {
            throw new Skip(t.kind === 'sure');
          }
          fail('url-unreachable', `${String(s)} ${t.path}`);
        }
        const isHtmlPath = /\.html?$/i.test(t.path);
        // A host's SPA fallback answers any path with the page itself: not a file.
        if (!isHtmlPath && isHtmlType(got.res.headers.get('content-type'))) {
          throw new Skip(t.kind === 'sure');
        }
        if (isHtmlPath && t.kind === 'guess' && !isHtmlType(got.res.headers.get('content-type'))) {
          throw new Skip(false);
        }
        store(t.path, got.bytes);
        discover(t.path, got.bytes, got.url, t.as);
      } catch (e) {
        if (e instanceof Skip) {
          if (e.counted) skipped++;
          return;
        }
        // A guess that hangs or cannot be fetched is not worth failing the copy for (the total
        // deadline and the size limit still hold).
        if (t.kind === 'guess' && e instanceof CopyFailure && stop === null) {
          if (e.error.code === 'url-timeout' || e.error.code === 'url-unreachable') return;
        }
        throw e;
      }
    };

    // ── 3. At most `concurrency` requests at a time ──
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let failed = false;
      const pump = () => {
        if (failed) return;
        while (active < limits.concurrency && queue.length > 0) {
          const t = queue.shift();
          if (!t) break;
          active++;
          fetchFile(t).then(
            () => {
              active--;
              pump();
            },
            (e: unknown) => {
              failed = true;
              abortAll('failed');
              reject(e instanceof Error ? e : new Error(String(e)));
            },
          );
        }
        if (active === 0 && queue.length === 0) resolve();
      };
      pump();
    });

    // ── 4. The pack ──
    let pack: Uint8Array<ArrayBuffer>;
    try {
      pack = packSite([...files.values()]);
    } catch (e) {
      if (e instanceof SitePackError) fail('too-large', String(bytes));
      throw e;
    }
    return {
      ok: true,
      site: { pack, root: `${origin}${root}`, files: files.size, bytes, skipped },
    };
  } catch (e) {
    if (e instanceof CopyFailure) return { ok: false, error: e.error };
    return {
      ok: false,
      error: { code: 'url-unreachable', detail: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    clearTimeout(totalTimer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
