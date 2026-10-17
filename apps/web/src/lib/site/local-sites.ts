/**
 * The latest imported site of each battle, in IndexedDB on the app origin (docs/09 §9.5), so
 * a reload during BUILD brings the import back at once (the remote `autosave/site.bin` is the
 * fallback on another device). Keys are `battle:{id}`; DESTROY deletes the battle's entry and
 * site-cleanup.ts the ones a closed tab left behind.
 *
 * Two object stores with the same out-of-line keys: `sites` holds `{site, imports, updatedAt}`
 * (the pack is a `Uint8Array`, structured clone, no encoding) and `meta` only `{updatedAt}`,
 * so the stale cleanup lists the battles without reading their packs. Raw IndexedDB, as the
 * store is this small.
 *
 * Opening it also deletes the editor's old database (`br-workspaces`, before M6) once per
 * page: the source code of battles from before the switch must not linger in the browser.
 */
import { BATTLE_SITE_PREFIX, type StoredBattleSite } from './site-cleanup';
import type { ImportedSite } from './site';

export const SITES_DB_NAME = 'br-sites';
export const SITES_STORE = 'sites';
const META_STORE = 'meta';
const DB_VERSION = 1;
/** The in-browser editor's database (removed with M6). */
const OLD_WORKSPACES_DB = 'br-workspaces';

export interface StoredSite {
  site: ImportedSite;
  /** Successful imports in this battle so far (the `imports` stat). */
  imports: number;
  /** Last save (epoch ms). */
  updatedAt: number;
}

/** What the battle controller needs from the local store (tests pass a fake). */
export interface LocalSites {
  get(key: string): Promise<StoredSite | null>;
  put(key: string, value: Omit<StoredSite, 'updatedAt'>): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every battle entry with its last save (for the stale cleanup). */
  listBattleSites(): Promise<StoredBattleSite[]>;
}

/** IndexedDB key of a battle's site. */
export function battleSiteKey(battleId: string): string {
  return `${BATTLE_SITE_PREFIX}${battleId}`;
}

let oldDatabaseDropped = false;

function dropOldDatabase(): void {
  if (oldDatabaseDropped) return;
  oldDatabaseDropped = true;
  try {
    indexedDB.deleteDatabase(OLD_WORKSPACES_DB);
  } catch {
    // blocked storage: nothing to delete either
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function openDb(): Promise<IDBDatabase> {
  dropOldDatabase();
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(SITES_DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    req.onupgradeneeded = () => {
      for (const name of [SITES_STORE, META_STORE]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onblocked = () => {
      reject(new Error('IndexedDB open blocked'));
    };
  });
}

async function withStores<T>(
  mode: IDBTransactionMode,
  fn: (sites: IDBObjectStore, meta: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction([SITES_STORE, META_STORE], mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('IndexedDB transaction failed'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      };
    });
    const result = await fn(tx.objectStore(SITES_STORE), tx.objectStore(META_STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
}

/** A stored value read back defensively (another version of the app may have written it). */
function asStoredSite(value: unknown): StoredSite | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<StoredSite>;
  const s = v.site as Partial<ImportedSite> | undefined;
  if (!s || !(s.pack instanceof Uint8Array)) return null;
  return {
    site: {
      pack: s.pack,
      root: typeof s.root === 'string' ? s.root : '',
      files: typeof s.files === 'number' ? s.files : 0,
      bytes: typeof s.bytes === 'number' ? s.bytes : s.pack.byteLength,
      skipped: typeof s.skipped === 'number' ? s.skipped : 0,
    },
    imports: typeof v.imports === 'number' && v.imports >= 0 ? Math.floor(v.imports) : 1,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
  };
}

export const indexedDbSites: LocalSites = {
  get: (key) =>
    withStores('readonly', async (sites) => asStoredSite(await request(sites.get(key)))),
  put: (key, value) =>
    withStores('readwrite', async (sites, meta) => {
      const updatedAt = Date.now();
      const stored: StoredSite = { ...value, updatedAt };
      await Promise.all([request(sites.put(stored, key)), request(meta.put({ updatedAt }, key))]);
    }),
  delete: (key) =>
    withStores('readwrite', async (sites, meta) => {
      await Promise.all([request(sites.delete(key)), request(meta.delete(key))]);
    }),
  listBattleSites: () =>
    withStores('readonly', async (sites, meta) => {
      const [keys, metaKeys, metas] = await Promise.all([
        request(sites.getAllKeys()),
        request(meta.getAllKeys()),
        request(meta.getAll() as IDBRequest<unknown[]>),
      ]);
      const updated = new Map<IDBValidKey, number>();
      metaKeys.forEach((k, i) => {
        const at = (metas[i] as { updatedAt?: unknown } | undefined)?.updatedAt;
        updated.set(k, typeof at === 'number' ? at : 0);
      });
      return keys
        .filter((k): k is string => typeof k === 'string' && k.startsWith(BATTLE_SITE_PREFIX))
        .map((id) => ({ id, updatedAt: updated.get(id) ?? 0 }));
    }),
};
