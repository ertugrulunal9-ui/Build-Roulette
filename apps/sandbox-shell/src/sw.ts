/**
 * The site worker, `/v{N}/sw.js` (docs/09 §9.3): a Service Worker with scope `/` on the
 * sandbox origin that serves imported sites as a static host would. Registered by the shell
 * and by the capture page (`site-loader.ts`) before every load.
 *
 * - Uploads: the page posts a site's files with a fresh random id (`SiteUpload`) and a port;
 *   the worker stores them (memory and Cache Storage, `sw-store.ts`) and answers on the port.
 *   Uploads are accepted only from window clients that are not mapped to a site. That is
 *   best effort: build code shares the origin and can post from a frame of its own, so the
 *   security argument does not rest on it (README, "Site worker: threat model").
 * - Requests: routed by `sw-routing.ts` (which site, static-host rules), answered with the
 *   site's file and `siteHeaders` (the site CSP and the host's security headers). HTML gets
 *   the bootstrap (`bootstrap.ts`).
 * - Restarts: the browser stops idle workers, so whether a request belongs to a site can
 *   depend on state that is still being read back from Cache Storage. Such a request is
 *   answered once the state is read; if it turns out to belong to no site, it is fetched from
 *   the network as is (the same as not intercepting it). Without a restart, the decision is
 *   synchronous and unmapped requests are not intercepted at all.
 *
 * Bundled by `build-shell.ts` as a classic script, with `__BR_SITE_HEADERS__` baked in.
 */
import { SitePackError } from '@br/site';
import { injectBootstrap } from './bootstrap';
import type { SiteContext } from './headers';
import { SITE_CACHE, SITE_UPLOAD_ACK, parseSiteUpload, type SiteUploadAck } from './site-protocol';
import {
  classifyRequest,
  decide,
  isHtmlType,
  resolveSitePath,
  type Classified,
  type Decision,
} from './sw-routing';
import { SiteStore, type CacheStorageLike, type SiteProfile } from './sw-store';

/** `siteHeaders(…, 'preview')` and `siteHeaders(…, 'capture')`, baked in at build time. */
declare const __BR_SITE_HEADERS__: Readonly<Record<SiteContext, Readonly<Record<string, string>>>>;
/** The capture page's path (`/v{N}/capture`): uploads from it get the capture headers. */
declare const __BR_CAPTURE_PATH__: string;

// The worker's global scope, typed by hand: the DOM and WebWorker libs cannot be mixed in one
// TypeScript program.
interface ExtendableEventLike extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  readonly clientId: string;
  readonly resultingClientId: string;
  respondWith(r: Response | Promise<Response>): void;
}
interface ClientLike {
  readonly id: string;
  readonly type: string;
  readonly url: string;
}
interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
  readonly source: unknown;
  readonly ports: readonly MessagePort[];
}
interface WorkerScope {
  readonly location: Location;
  readonly caches: CacheStorageLike;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEventLike) => void): void;
  addEventListener(type: 'message', fn: (e: MessageEventLike) => void): void;
}

const scope = self as unknown as WorkerScope;
const origin = scope.location.origin;
const store = new SiteStore(scope.caches, { origin, cacheName: SITE_CACHE });
// Start reading the state at once: the event that woke the worker usually needs it.
void store.load();

scope.addEventListener('install', (e) => {
  // A new version takes over at once; sites and the client map survive in Cache Storage.
  e.waitUntil(scope.skipWaiting());
});

scope.addEventListener('message', (e) => {
  const port = e.ports[0];
  if (!port) return;
  e.waitUntil(
    acceptUpload(e).then(
      (ack) => {
        port.postMessage(ack);
      },
      (err: unknown) => {
        port.postMessage({
          type: SITE_UPLOAD_ACK,
          id: '',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies SiteUploadAck);
      },
    ),
  );
});

async function acceptUpload(e: MessageEventLike): Promise<SiteUploadAck> {
  const upload = parseSiteUpload(e.data);
  if (!upload) throw new SitePackError('not a valid site upload');
  const fail = (error: string): SiteUploadAck => ({
    type: SITE_UPLOAD_ACK,
    id: upload.id,
    ok: false,
    error,
  });
  const source = e.source as Partial<ClientLike> | null;
  if (source?.type !== 'window' || typeof source.id !== 'string') {
    return fail('uploads are accepted from pages only');
  }
  await store.load();
  if (store.siteOfClient(source.id) !== undefined) {
    return fail('a site cannot upload a site');
  }
  let profile: SiteProfile = 'preview';
  try {
    if (new URL(source.url ?? '').pathname === __BR_CAPTURE_PATH__) profile = 'capture';
  } catch {
    // keep 'preview'
  }
  await store.put(
    upload.id,
    profile,
    upload.files.map((f) => ({ path: f.path, type: f.type, bytes: new Uint8Array(f.bytes) })),
  );
  return { type: SITE_UPLOAD_ACK, id: upload.id, ok: true };
}

scope.addEventListener('fetch', (e) => {
  const c = classifyRequest({
    url: e.request.url,
    selfOrigin: origin,
    mode: e.request.mode,
    clientId: e.clientId,
    resultingClientId: e.resultingClientId,
  });
  if (c.kind === 'pass') return;
  if (store.isLoaded()) {
    const d = decide(c, store);
    if (d.kind === 'pass') return;
    e.respondWith(respond(e, c, d));
    return;
  }
  // Just restarted: the client map is still being read back.
  e.respondWith(
    store.load().then(() => {
      const d = decide(c, store);
      return d.kind === 'pass' ? fetch(e.request) : respond(e, c, d);
    }),
  );
});

async function respond(
  e: FetchEventLike,
  c: Exclude<Classified, { kind: 'pass' }>,
  decision: Exclude<Decision, { kind: 'pass' }>,
): Promise<Response> {
  const navigate = c.kind === 'navigate';
  let d = decision;
  if (d.kind === 'missing-site' && navigate) {
    // Another instance of the worker (an update activated meanwhile) may hold it.
    await store.refresh();
    const again = decide(c, store);
    if (again.kind === 'pass') return fetch(e.request);
    d = again;
  }
  if (d.kind === 'missing-site') {
    return plain(
      404,
      navigate
        ? 'This site is not loaded in the sandbox any more. Load it again from the game.'
        : 'Not found',
      __BR_SITE_HEADERS__.preview,
    );
  }
  if (d.mapClient) e.waitUntil(store.mapClient(d.mapClient, d.siteId));
  const site = await store.site(d.siteId);
  if (!site) return plain(404, 'Not found', __BR_SITE_HEADERS__.preview);
  const headers = __BR_SITE_HEADERS__[site.profile];
  const method = e.request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return plain(405, 'Method not allowed: this is a static site', headers, { Allow: 'GET, HEAD' });
  }
  const url = new URL(e.request.url);
  const r = resolveSitePath((p) => site.types.has(p), url.pathname, navigate, url.search);
  if (r.kind === 'redirect') {
    return new Response(null, {
      status: 301,
      headers: { ...headers, Location: new URL(r.location, origin).href },
    });
  }
  if (r.kind === 'not-found') return plain(404, 'Not found', headers);
  const file = await store.file(d.siteId, r.path);
  if (!file) return plain(404, 'Not found', headers);
  const body = isHtmlType(file.type) ? injectBootstrap(file.bytes) : file.bytes;
  return new Response(method === 'HEAD' ? null : body.slice(), {
    status: r.status,
    headers: { ...headers, 'Content-Type': file.type },
  });
}

function plain(
  status: number,
  text: string,
  headers: Readonly<Record<string, string>>,
  extra: Record<string, string> = {},
): Response {
  return new Response(text, {
    status,
    headers: { ...headers, ...extra, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
