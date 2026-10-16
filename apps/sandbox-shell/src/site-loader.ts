/**
 * Page side of the site worker (docs/09 §9.3), shared by the shell (`shell.ts`) and the
 * capture page (`capture.ts`): unpack the site pack, make sure the site worker is registered
 * and active, upload the files under a fresh random site id, and return the URL the site's
 * child frame is navigated to.
 *
 * Every step that can fail throws a `SiteLoadError` with a message for the player (shown as a
 * `module-load` runtime error in the preview, or as the capture page's failure).
 */
import { unpackSite, type SiteFiles } from '@br/site';
import {
  SITE_UPLOAD,
  SITE_UPLOAD_ACK,
  SITE_WORKER_FILE,
  newSiteId,
  siteUrl,
  type SiteUpload,
  type SiteUploadAck,
} from './site-protocol';

export class SiteLoadError extends Error {
  override readonly name = 'SiteLoadError';
}

/** Time for each step: registration, activation, upload. */
const STEP_TIMEOUT_MS = 10_000;

/**
 * The site worker's URL: next to the page that registers it (the shell at `/v{N}/`, the
 * capture page at `/v{N}/capture`), so the shell of a protocol version registers its own
 * version's worker.
 */
export function siteWorkerUrl(pageUrl: string): string {
  return new URL(SITE_WORKER_FILE, pageUrl).href;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout<T>(p: Promise<T>, what: string, ms = STEP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SiteLoadError(`${what} did not finish within ${String(ms / 1000)} s`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Reads a site pack; a pack that is not well formed is the player's import, not our fault. */
export function readSitePack(pack: ArrayBuffer | Uint8Array): SiteFiles {
  try {
    return unpackSite(pack);
  } catch (e) {
    throw new SiteLoadError(`The imported site could not be read: ${message(e)}. Import it again.`);
  }
}

/** Resolves with the registration's active worker once it is `activated`. */
function activated(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const active = reg.active;
      if (active?.state === 'activated') {
        resolve(active);
        return true;
      }
      return false;
    };
    if (check()) return;
    const watch = (w: ServiceWorker | null) => {
      w?.addEventListener('statechange', () => {
        if (check()) return;
        if (w.state === 'redundant' && !reg.installing && !reg.waiting && !reg.active) {
          reject(new SiteLoadError('the site worker failed to install'));
        }
      });
    };
    for (const w of [reg.installing, reg.waiting, reg.active]) watch(w);
    reg.addEventListener('updatefound', () => {
      watch(reg.installing);
    });
  });
}

/**
 * Registers the site worker (again: a reset unregisters it) and waits until it is active.
 * `register()` with the same script and options is cheap when the registration exists.
 */
export async function activeSiteWorker(nav: Navigator = navigator): Promise<ServiceWorker> {
  const container = (nav as Partial<Navigator>).serviceWorker;
  if (!container) {
    throw new SiteLoadError(
      'This browser does not let the sandbox run an imported site here: service workers are ' +
        'unavailable (a private window in Firefox, or a browser setting). Try a normal window.',
    );
  }
  let reg: ServiceWorkerRegistration;
  try {
    reg = await withTimeout(
      container.register(siteWorkerUrl(location.href), { scope: '/', updateViaCache: 'none' }),
      'Registering the site worker',
    );
  } catch (e) {
    throw new SiteLoadError(`The sandbox could not start its site worker: ${message(e)}`);
  }
  return withTimeout(activated(reg), 'Starting the site worker');
}

/** Uploads `files` as site `id` and waits for the worker's acknowledgement. */
export async function uploadSite(worker: ServiceWorker, id: string, files: SiteFiles) {
  const upload: SiteUpload = { type: SITE_UPLOAD, id, files: [] };
  const transfer: Transferable[] = [];
  for (const f of files.values()) {
    // A copy per file: posting views of the pack would clone the whole pack for each one.
    const bytes = f.bytes.slice().buffer;
    upload.files.push({ path: f.path, type: f.type, bytes });
    transfer.push(bytes);
  }
  const channel = new MessageChannel();
  const ack = new Promise<unknown>((resolve) => {
    channel.port1.onmessage = (e: MessageEvent) => {
      resolve(e.data);
    };
  });
  worker.postMessage(upload, [channel.port2, ...transfer]);
  try {
    const answer = (await withTimeout(ack, 'Handing the site to the site worker')) as Partial<
      Record<keyof SiteUploadAck | 'error', unknown>
    > | null;
    if (answer?.type !== SITE_UPLOAD_ACK || answer.id !== id || answer.ok !== true) {
      const why = typeof answer?.error === 'string' ? answer.error : 'no valid answer';
      throw new SiteLoadError(`The site worker refused the site: ${why}`);
    }
  } finally {
    channel.port1.close();
  }
}

/**
 * Everything before the frame: unpack, register, upload. Returns the URL to navigate a fresh
 * child frame to (`/?__br_site=<id>`). Throws `SiteLoadError`.
 */
export async function startSite(pack: ArrayBuffer | Uint8Array): Promise<string> {
  const files = readSitePack(pack);
  const worker = await activeSiteWorker();
  const id = newSiteId();
  try {
    await uploadSite(worker, id, files);
  } catch (e) {
    throw e instanceof SiteLoadError
      ? e
      : new SiteLoadError(`The site could not be handed to the site worker: ${message(e)}`);
  }
  return siteUrl(location.origin, id);
}
