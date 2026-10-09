/**
 * What the link-preview Function (T-038, docs/08-free-tier.md §3; the worker entry is
 * preview-worker.ts) does with one request, with its I/O passed in so that Node can test it.
 *
 * Per request to `/battles/{id}` (any other path, or a method other than GET/HEAD, is handed
 * to Pages' static assets unchanged):
 *
 * 1. a malformed id: the shell with a 404 status and the "not found" head; Supabase is not
 *    asked;
 * 2. otherwise `get_public_battle` (the page's own call, with the anon key) and the shell
 *    (`/battles`, from Pages' assets) at the same time;
 * 3. a public battle: the shell with its head replaced by the battle's (battle-preview.ts); an
 *    unknown or not-yet-public battle: the shell with a 404 status and the "not found" head.
 *    The page's script then loads the data itself and shows the results or its not-found
 *    view, as it does without the Function;
 * 4. **fail open:** Supabase slower than the timeout ({@link SUPABASE_TIMEOUT_MS}), an error,
 *    or an answer that is not the expected shape: the shell unchanged, with 200 (the generic
 *    tags and the static card), which is what Pages served before T-038. Anything that throws
 *    is caught by the worker entry, which serves the plain static path.
 *
 * Every answer carries the security headers of `_headers`' `/*` rule (baked in at build
 * time), whether or not Pages applies `_headers` to a Function's response, and no `ETag` (the
 * body differs per battle and per moment). `x-br-preview` says which case it was.
 *
 * Nothing is cached: every request reads Supabase, so a takedown changes the preview on the
 * very next request (docs/08 §3 has why).
 */
import type { PublicBattle } from '../solo/types';
import { battlePreview, previewHeadHtml, previewTarget, type PreviewHead } from './battle-preview';

/** How long the Function waits for `get_public_battle` before it serves the plain shell. */
export const SUPABASE_TIMEOUT_MS = 1_500;

/** The shell every `/battles/{id}` is answered with (`out/battles.html`). */
export const SHELL_PATH = '/battles';

/** Which case an answer was (the `x-br-preview` header). */
export type PreviewOutcome = 'battle' | 'not-found' | 'malformed' | 'fail-open';

export interface PreviewDeps {
  /** Pages' static assets (`env.ASSETS.fetch`). */
  assets(request: Request): Promise<Response>;
  /** `get_public_battle`: the battle, null when unknown or not public; throws on failure. */
  loadBattle(id: string, signal: AbortSignal): Promise<PublicBattle | null>;
  /** Writes `html` into the shell's head, replacing its title and social tags. */
  inject(shell: Response, html: string): Response;
  /** Headers every answer carries (the `/*` rule of `_headers`). */
  headers: Readonly<Record<string, string>>;
  /** The site's public origin, or null to use the request's. */
  siteUrl: string | null;
  timeoutMs: number;
  /** Where a fail-open is reported (the Function's log). */
  warn(message: string): void;
}

type Loaded = { ok: true; data: PublicBattle | null } | { ok: false; reason: string };

/** `loadBattle`, bounded by `timeoutMs` even if the fetch ignored its signal; never throws. */
async function loadWithin(deps: PreviewDeps, id: string): Promise<Loaded> {
  const signal = AbortSignal.timeout(deps.timeoutMs);
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('timeout'));
    });
  });
  try {
    const data = await Promise.race([deps.loadBattle(id, signal), timedOut]);
    if (data !== null && !isPublicBattle(data)) return { ok: false, reason: 'shape' };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: signal.aborted ? 'timeout' : 'error' };
  }
}

/** Enough of `get_public_battle`'s shape for the head (anything else fails open). */
function isPublicBattle(value: unknown): value is PublicBattle {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { builds?: unknown; challenge?: Record<string, unknown> | null };
  const card = (key: string) => {
    const c = v.challenge?.[key];
    return (
      typeof c === 'object' && c !== null && typeof (c as { text?: unknown }).text === 'string'
    );
  };
  return (
    Array.isArray(v.builds) &&
    v.builds.every((b) => typeof b === 'object' && b !== null) &&
    card('build') &&
    card('rule') &&
    card('style') &&
    typeof v.challenge?.['time_limit_seconds'] === 'number'
  );
}

/** One request (see the top of this file). Throws only if something unexpected breaks. */
export async function handlePreview(request: Request, deps: PreviewDeps): Promise<Response> {
  const url = new URL(request.url);
  const target = previewTarget(url.pathname);
  if (target.kind === 'other' || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return deps.assets(request);
  }
  // Supabase first (the slow part), the shell meanwhile.
  const loaded = target.kind === 'battle' ? loadWithin(deps, target.id) : null;
  // A plain GET for the shell: the client's conditional headers would get a body-less 304.
  const shell = await deps.assets(
    new Request(new URL(SHELL_PATH, url), { headers: { accept: 'text/html' } }),
  );
  if (!shell.ok || shell.body === null) return shell;

  const headers = new Headers(shell.headers);
  headers.delete('etag');
  headers.delete('content-length');
  for (const [k, v] of Object.entries(deps.headers)) headers.set(k, v);
  const answer = (body: Response, status: number, outcome: PreviewOutcome, why = '') => {
    headers.set('x-br-preview', why ? `${outcome}; reason=${why}` : outcome);
    if (request.method === 'HEAD') {
      void body.body?.cancel();
      return new Response(null, { status, headers });
    }
    return new Response(body.body, { status, headers });
  };
  const write = (head: PreviewHead, outcome: PreviewOutcome) =>
    answer(deps.inject(shell, previewHeadHtml(head)), head.status, outcome);

  const origin = deps.siteUrl ?? url.origin;
  if (target.kind === 'malformed' || loaded === null) {
    return write(battlePreview(null, { id: null, origin }), 'malformed');
  }
  const result = await loaded;
  if (!result.ok) {
    deps.warn(`battle preview: fail open (${result.reason}) for ${url.pathname}`);
    return answer(shell, 200, 'fail-open', result.reason);
  }
  const head = battlePreview(result.data, { id: target.id, origin });
  return write(head, result.data ? 'battle' : 'not-found');
}
