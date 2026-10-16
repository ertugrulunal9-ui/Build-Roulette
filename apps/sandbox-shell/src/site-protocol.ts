/**
 * What the page side (the shell, `shell.ts`, and the capture page, `capture.ts`) and the
 * site worker (`sw.ts`) agree on (docs/09 §9.3). Internal to the sandbox origin: the app
 * never sees these messages. Both sides are deployed together under `/v{N}/`, but the shell
 * files are cached `immutable` while `sw.js` is `no-store`, so keep this format stable within
 * a protocol version.
 *
 * Trust: build code runs on the same origin, so it can post anything to the worker and read
 * or write its Cache Storage. Nothing here is a security boundary on its own; see the README
 * ("Site worker: threat model") for what keeps one build from serving content to another.
 */
import { SITE_ENTRY, SITE_LIMITS, isValidContentType, isValidSitePath } from '@br/site';

/** Query parameter that names the site of a frame's first navigation (`/?__br_site=<id>`). */
export const SITE_PARAM = '__br_site';

/** A site id: 128 random bits as 32 lowercase hex digits, new for every load. */
export const SITE_ID_RE = /^[0-9a-f]{32}$/;

/** File name of the site worker, next to the shell (`/v{N}/sw.js`). */
export const SITE_WORKER_FILE = 'sw.js';

/** Cache Storage name under which the worker keeps its sites and its client map. */
export const SITE_CACHE = 'br-sandbox-sites-v2';

/** Name of the function the shell (or the capture page) defines for the site's bootstrap. */
export const ATTACH_HOOK = '__brAttach';

/** Message type of an upload (page -> worker) and of its answer (worker -> page, on the port). */
export const SITE_UPLOAD = 'br-site';
export const SITE_UPLOAD_ACK = 'br-site-ack';

export interface SiteUploadFile {
  path: string;
  type: string;
  bytes: ArrayBuffer;
}

/** page -> worker (`ServiceWorker.postMessage`, with a `MessagePort` for the answer). */
export interface SiteUpload {
  type: typeof SITE_UPLOAD;
  id: string;
  files: SiteUploadFile[];
}

/** worker -> page, on the upload's port. */
export type SiteUploadAck =
  | { type: typeof SITE_UPLOAD_ACK; id: string; ok: true }
  | { type: typeof SITE_UPLOAD_ACK; id: string; ok: false; error: string };

/** A fresh site id from the platform's CSPRNG (128 bits). */
export function newSiteId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The URL a site's frame is navigated to first. */
export function siteUrl(origin: string, id: string): string {
  return `${origin}/?${SITE_PARAM}=${id}`;
}

/**
 * Checks an upload as the worker receives it (any page of the origin can post one, build code
 * included). Returns null for anything that is not a well-formed upload within `SITE_LIMITS`.
 * Never throws.
 */
export function parseSiteUpload(data: unknown): SiteUpload | null {
  try {
    if (typeof data !== 'object' || data === null) return null;
    const d = data as { type?: unknown; id?: unknown; files?: unknown };
    if (d.type !== SITE_UPLOAD || typeof d.id !== 'string' || !SITE_ID_RE.test(d.id)) return null;
    if (!Array.isArray(d.files) || d.files.length > SITE_LIMITS.maxFiles) return null;
    const files: SiteUploadFile[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const raw of d.files as unknown[]) {
      if (typeof raw !== 'object' || raw === null) return null;
      const { path, type, bytes } = raw as { path?: unknown; type?: unknown; bytes?: unknown };
      if (typeof path !== 'string' || !isValidSitePath(path) || seen.has(path)) return null;
      if (typeof type !== 'string' || !isValidContentType(type)) return null;
      if (!(bytes instanceof ArrayBuffer)) return null;
      total += bytes.byteLength;
      if (total > SITE_LIMITS.maxPackBytes) return null;
      seen.add(path);
      files.push({ path, type, bytes });
    }
    if (!seen.has(SITE_ENTRY)) return null;
    return { type: SITE_UPLOAD, id: d.id, files };
  } catch {
    return null;
  }
}
