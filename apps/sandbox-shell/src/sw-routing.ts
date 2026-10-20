/**
 * The site worker's routing (docs/09 §9.3), pure so it is unit tested in Node
 * (test/sw-routing.test.ts). `sw.ts` wires it to fetch events and to its store.
 *
 * Which site a request belongs to:
 * - a navigation to a reserved shell path (`/v1/…`, `/v2/…`: the shell, its reset endpoint,
 *   the capture page) is never intercepted, whatever its query;
 * - a navigation with `__br_site=<id>` is that site (an id the worker does not hold gets a
 *   404, never another site), and the document it creates (`resultingClientId`) is mapped to
 *   it;
 * - any other same-origin navigation (an in-site link to `/about.html`, `location.reload()`
 *   after `history.pushState`, a nested frame of the site) is the most recently loaded site,
 *   and its document is mapped too. The latest site is global to the worker, not per shell:
 *   two previews of different sites in one browser partition (two tabs) can cross over on a
 *   reload or an in-site navigation. Per-build origins (stage 2) remove that;
 * - any other request is its client's site (`clientId`), whatever its path (`/assets/x.js`,
 *   `/data.json`, even `/v2/…`). A worker script a site starts maps the worker's client too
 *   (`resultingClientId`), so the worker's own requests are served from the same site;
 * - requests from clients that are not mapped (the shell page itself, its `/v2/reset`
 *   fetch, the capture page) and every cross-origin request are not intercepted.
 */
import { SITE_ID_RE, SITE_PARAM } from './site-protocol';

/** The site's entry document, and the SPA fallback for unknown navigations. */
export const INDEX_FILE = 'index.html';

/**
 * Paths of the shell's versions (`/v1/`, `/v2/`, and every later `/vN/`). Navigations there
 * always go to the network: a worker of this version survives in returning browsers, so it
 * must let a newer shell (`/v3/` after the next protocol bump) load and install its own.
 */
export function isReservedPath(pathname: string): boolean {
  return /^\/v\d+(?:\/|$)/.test(pathname);
}

export interface RequestFacts {
  url: string;
  /** The worker's own origin. */
  selfOrigin: string;
  /** `Request.mode`: `navigate` for documents (frames, top-level). */
  mode: string;
  /** `FetchEvent.clientId`: the client that made the request ('' for navigations). */
  clientId: string;
  /** `FetchEvent.resultingClientId`: the client a navigation or worker script creates. */
  resultingClientId: string;
}

export type Classified =
  | { kind: 'pass' }
  | { kind: 'navigate'; siteParam: string | null; resultingClientId: string }
  | { kind: 'subresource'; clientId: string; resultingClientId: string };

/** What can be told without the worker's state: always synchronous. */
export function classifyRequest(f: RequestFacts): Classified {
  let url: URL;
  try {
    url = new URL(f.url);
  } catch {
    return { kind: 'pass' };
  }
  if (url.origin !== f.selfOrigin) return { kind: 'pass' };
  if (f.mode === 'navigate') {
    if (isReservedPath(url.pathname)) return { kind: 'pass' };
    return {
      kind: 'navigate',
      siteParam: url.searchParams.get(SITE_PARAM),
      resultingClientId: f.resultingClientId,
    };
  }
  if (!f.clientId) return { kind: 'pass' };
  return { kind: 'subresource', clientId: f.clientId, resultingClientId: f.resultingClientId };
}

/** The worker's state as routing reads it (in memory, or restored from Cache Storage). */
export interface RoutingState {
  siteOfClient(clientId: string): string | undefined;
  hasSite(siteId: string): boolean;
  readonly latest: string | null;
}

export type Decision =
  | { kind: 'pass' }
  /** Serve from `siteId`; map `mapClient` (a new document or worker) to it first. */
  | { kind: 'serve'; siteId: string; mapClient: string | null }
  /** A site the worker does not hold (unknown id, or a mapped site evicted since): 404. */
  | { kind: 'missing-site' };

export function decide(c: Exclude<Classified, { kind: 'pass' }>, s: RoutingState): Decision {
  if (c.kind === 'navigate') {
    if (c.siteParam !== null) {
      if (!SITE_ID_RE.test(c.siteParam) || !s.hasSite(c.siteParam)) return { kind: 'missing-site' };
      return { kind: 'serve', siteId: c.siteParam, mapClient: c.resultingClientId || null };
    }
    if (s.latest === null || !s.hasSite(s.latest)) return { kind: 'pass' };
    return { kind: 'serve', siteId: s.latest, mapClient: c.resultingClientId || null };
  }
  const siteId = s.siteOfClient(c.clientId);
  if (siteId === undefined) return { kind: 'pass' };
  if (!s.hasSite(siteId)) return { kind: 'missing-site' };
  return { kind: 'serve', siteId, mapClient: c.resultingClientId || null };
}

/** The site path of a URL path (`/assets/a%20b.js` -> `assets/a b.js`), or null if malformed. */
export function decodeSitePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

export type Resolution =
  | { kind: 'file'; path: string; status: 200 }
  /** A folder asked for without its trailing slash: `/about` -> `/about/` (navigations). */
  | { kind: 'redirect'; location: string }
  | { kind: 'not-found' };

/**
 * Static-host rules: `/` and `…/` -> `index.html` in that folder; the exact file; `path.html`;
 * `path/index.html` (a navigation is redirected to `path/` first, so relative URLs in that page
 * resolve as on any static host); an unknown navigation gets the root `index.html` with a 200
 * (the SPA fallback, for client-side routers); any other miss is a 404. `search` is kept on a
 * redirect.
 */
export function resolveSitePath(
  has: (path: string) => boolean,
  pathname: string,
  navigate: boolean,
  search = '',
): Resolution {
  const decoded = decodeSitePath(pathname);
  if (decoded !== null) {
    if (decoded === '' || decoded.endsWith('/')) {
      const index = `${decoded}${INDEX_FILE}`;
      if (has(index)) return { kind: 'file', path: index, status: 200 };
    } else {
      if (has(decoded)) return { kind: 'file', path: decoded, status: 200 };
      if (has(`${decoded}.html`)) return { kind: 'file', path: `${decoded}.html`, status: 200 };
      if (has(`${decoded}/${INDEX_FILE}`)) {
        if (navigate) return { kind: 'redirect', location: `${pathname}/${search}` };
        return { kind: 'file', path: `${decoded}/${INDEX_FILE}`, status: 200 };
      }
    }
  }
  if (navigate && has(INDEX_FILE)) return { kind: 'file', path: INDEX_FILE, status: 200 };
  return { kind: 'not-found' };
}

/** True for a content type that gets the bootstrap (`text/html`, any parameters). */
export function isHtmlType(type: string): boolean {
  return /^text\/html(?:\s*;|$)/i.test(type);
}
