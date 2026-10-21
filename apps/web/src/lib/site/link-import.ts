/**
 * Importing a published site from its link (docs/10, M7): the `import-url` Edge Function copies
 * the site server-side (browsers cannot read another site's files) and answers the same site
 * pack a dropped `dist/` folder gives. This module calls it and turns the answer into the
 * `ImportedSite` the rest of the import uses (preview, autosave, ship), or a `LinkError` the
 * catalogs word (`linkErrors`, every code typed).
 *
 *   POST {SUPABASE_URL}/functions/v1/import-url
 *   Authorization: Bearer <the user's access token>   (an anonymous session is fine)
 *   {"url": "https://my-app.lovable.app/"}
 *   → 200 application/octet-stream (the pack, X-Site-Root / X-Site-Skipped)
 *   → JSON {code, detail?, retry_after?}
 *
 * The session comes from `ensureSignedIn` (lib/supabase/browser), loaded only when a link is
 * imported: `/try` makes no Supabase request for a folder or a .zip.
 *
 * The link is checked first in the page (`checkPublicUrl`, the same rules as the function), so
 * an obviously bad link fails at once without a request. `extraOrigins` adds the local test
 * server of the e2e (`NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS`, link-config.ts); production builds
 * have none (scripts/pages-config.ts checks).
 */
import { siteBytes, unpackSite, type CopyErrorCode, type ImportedSite } from '@br/site';

/** The codes the app words for a link: the copy's, the function's own, and no answer at all. */
export const LINK_ERROR_CODES = [
  'url-invalid',
  'url-host-not-allowed',
  'url-unreachable',
  'url-not-html',
  'url-private',
  'url-timeout',
  'rate-limited',
  'too-large',
  'too-many-files',
  'unauthenticated',
  'origin-not-allowed',
  'method-not-allowed',
  'internal',
  /** No answer from the function (offline, blocked, the session could not be made). */
  'network',
] as const;

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];

/** Every copy code of `@br/site` is in the list: a new one fails to compile until it is worded. */
type NoneMissing<T extends never> = T;
export type CopyCodesWorded = NoneMissing<Exclude<CopyErrorCode, LinkErrorCode>>;

export interface LinkError {
  code: LinkErrorCode;
  /** Seconds to wait (`rate-limited`), a status (`url-unreachable`), a host… */
  detail?: string;
}

export type LinkResult = { ok: true; site: ImportedSite } | { ok: false; error: LinkError };

/** Copies one checked link; never throws (an abort ends as `network`, which callers ignore). */
export type LinkCopier = (url: URL, signal: AbortSignal) => Promise<LinkResult>;

export interface LinkCopyDeps {
  /** `{SUPABASE_URL}/functions/v1/import-url`. */
  endpoint: string;
  /** The user's access token (signs in anonymously when needed). */
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}

const KNOWN = new Set<string>(LINK_ERROR_CODES);

function isLinkErrorCode(code: unknown): code is LinkErrorCode {
  return typeof code === 'string' && KNOWN.has(code);
}

function fail(code: LinkErrorCode, detail?: string): LinkResult {
  return { ok: false, error: detail === undefined ? { code } : { code, detail } };
}

/** A whole, non-negative number from a header, or null. */
function count(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** The error of a non-200 answer. */
async function errorOf(res: Response): Promise<LinkResult> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: a gateway's own page
  }
  const b = (body ?? {}) as { code?: unknown; detail?: unknown; retry_after?: unknown };
  const code = isLinkErrorCode(b.code) && b.code !== 'network' ? b.code : 'internal';
  if (code === 'rate-limited') {
    const wait =
      typeof b.retry_after === 'number' && Number.isFinite(b.retry_after)
        ? Math.ceil(b.retry_after)
        : count(res.headers.get('retry-after'));
    return fail(code, wait === null ? undefined : String(wait));
  }
  return fail(code, typeof b.detail === 'string' ? b.detail.slice(0, 200) : undefined);
}

/**
 * Asks the function to copy `url`. The pack is checked (`unpackSite`) and counted here, so a
 * broken answer is an error and not a broken preview; `root` is the copied address
 * (`X-Site-Root`, else the link), which the bar shows as "Copied from <host>".
 */
export async function copyFromLink(
  url: URL,
  signal: AbortSignal,
  deps: LinkCopyDeps,
): Promise<LinkResult> {
  // Read when needed: an abort can happen while anything below awaits.
  const aborted = () => signal.aborted;
  let token: string;
  try {
    token = await deps.accessToken();
  } catch {
    return fail('network', 'session');
  }
  if (aborted()) return fail('network', 'aborted');
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(deps.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: url.href }),
      signal,
      cache: 'no-store',
    });
  } catch {
    return fail('network', aborted() ? 'aborted' : undefined);
  }
  if (!res.ok) return errorOf(res);
  let pack: Uint8Array<ArrayBuffer>;
  try {
    pack = new Uint8Array(await res.arrayBuffer());
  } catch {
    return fail('network', aborted() ? 'aborted' : 'body');
  }
  try {
    const files = unpackSite(pack);
    const root = res.headers.get('x-site-root') ?? url.href;
    return {
      ok: true,
      site: {
        pack,
        root: isLinkRoot(root) ? root : url.href,
        files: files.size,
        bytes: siteBytes(files),
        skipped: count(res.headers.get('x-site-skipped')) ?? 0,
      },
    };
  } catch {
    return fail('internal', 'pack');
  }
}

/** Whether a site's `root` is a copied address (a link import) rather than a folder. */
export function isLinkRoot(root: string): boolean {
  return /^https?:\/\/[^/]/i.test(root);
}

/** `my-app.lovable.app` for `https://my-app.lovable.app/`; null for a folder or a bad link. */
export function linkHost(link: string): string | null {
  if (!isLinkRoot(link)) return null;
  try {
    return new URL(link).host;
  } catch {
    return null;
  }
}

/**
 * The app's copier: the session from `lib/supabase/browser` (loaded on first use, so a page
 * that never imports a link never loads it or asks Supabase anything), then the function.
 * `load` is for tests.
 */
export function supabaseLinkCopier(
  supabaseUrl: string,
  load: () => Promise<{
    accessToken: () => Promise<string>;
  }> = loadSession,
): LinkCopier {
  const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/import-url`;
  return async (url, signal) => {
    let session: { accessToken: () => Promise<string> };
    try {
      session = await load();
    } catch {
      return fail('network', 'session');
    }
    return copyFromLink(url, signal, { endpoint, accessToken: session.accessToken });
  };
}

async function loadSession(): Promise<{ accessToken: () => Promise<string> }> {
  const { ensureSignedIn, getSupabase } = await import('../supabase/browser');
  return {
    accessToken: async () => {
      const supabase = getSupabase();
      await ensureSignedIn(supabase);
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('no session');
      return token;
    },
  };
}
