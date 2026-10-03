/**
 * IndexedDB persistence for workspaces (docs/03 §3.6 "Working files"): one record per
 * workspace id holding files + manifest, plus a debounced autosaver.
 *
 * Uses `idb` (~1.2 KB brotli): it turns IDB requests and transactions into promises with a
 * typed schema, which is the error-prone part of a hand-written wrapper (transaction
 * auto-commit across awaits, upgrade/blocking events).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { isTemplateId } from './templates';
import type { FileMap, Manifest, Workspace } from './types';

export const WORKSPACE_DB_NAME = 'br-workspaces';
const DB_VERSION = 1;
const STORE = 'workspaces';
const SCHEMA_VERSION = 1;

export interface StoredWorkspace extends Workspace {
  id: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: typeof SCHEMA_VERSION;
}

export interface WorkspaceSummary {
  id: string;
  template: string;
  fileCount: number;
  createdAt: number;
  updatedAt: number;
}

export type LoadResult =
  | { status: 'found'; workspace: StoredWorkspace }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

interface WorkspaceDB extends DBSchema {
  workspaces: {
    key: string;
    value: StoredWorkspace;
    indexes: { 'by-updated': number };
  };
}

export interface WorkspaceStore {
  load(id: string): Promise<LoadResult>;
  /** Saves files + manifest now (keeps `createdAt` of an existing record). */
  save(id: string, workspace: Workspace): Promise<StoredWorkspace>;
  /** All workspaces, most recently updated first. */
  list(): Promise<WorkspaceSummary[]>;
  delete(id: string): Promise<void>;
  close(): void;
}

export interface OpenStoreOptions {
  /** Database name; tests pass a unique one. Default `br-workspaces`. */
  dbName?: string;
  /** Clock for timestamps (tests). */
  now?: () => number;
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

/** Validates the shape of a stored record (it may come from an older build or be corrupt). */
export function parseStoredWorkspace(value: unknown): LoadResult {
  if (typeof value !== 'object' || value === null)
    return { status: 'invalid', reason: 'not an object' };
  const v = value as Record<string, unknown>;
  if (v['schemaVersion'] !== SCHEMA_VERSION) {
    return {
      status: 'invalid',
      reason: `unsupported schema version ${String(v['schemaVersion'])}`,
    };
  }
  if (typeof v['id'] !== 'string') return { status: 'invalid', reason: 'missing id' };
  if (!isRecordOfStrings(v['files']))
    return { status: 'invalid', reason: 'files is not a map of strings' };
  const m = v['manifest'];
  if (typeof m !== 'object' || m === null) return { status: 'invalid', reason: 'missing manifest' };
  const mf = m as Record<string, unknown>;
  if (!isTemplateId(mf['template'])) return { status: 'invalid', reason: 'unknown template' };
  if (typeof mf['entry'] !== 'string')
    return { status: 'invalid', reason: 'manifest.entry is not a string' };
  if (!isRecordOfStrings(mf['dependencies'])) {
    return { status: 'invalid', reason: 'manifest.dependencies is not a map of strings' };
  }
  const manifest: Manifest = {
    template: mf['template'],
    entry: mf['entry'],
    dependencies: { ...mf['dependencies'] },
    tailwind: mf['tailwind'] === true,
  };
  const createdAt = typeof v['createdAt'] === 'number' ? v['createdAt'] : 0;
  const updatedAt = typeof v['updatedAt'] === 'number' ? v['updatedAt'] : createdAt;
  return {
    status: 'found',
    workspace: {
      id: v['id'],
      files: { ...(v['files'] as FileMap) },
      manifest,
      createdAt,
      updatedAt,
      schemaVersion: SCHEMA_VERSION,
    },
  };
}

export async function openWorkspaceStore(opts: OpenStoreOptions = {}): Promise<WorkspaceStore> {
  const now = opts.now ?? Date.now;
  let db: IDBPDatabase<WorkspaceDB> | null = null;
  db = await openDB<WorkspaceDB>(opts.dbName ?? WORKSPACE_DB_NAME, DB_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('by-updated', 'updatedAt');
    },
    blocking() {
      // A newer version (another tab) wants to upgrade: get out of its way.
      db?.close();
    },
  });
  const conn = db;

  return {
    async load(id) {
      const value: unknown = await conn.get(STORE, id);
      if (value === undefined) return { status: 'missing' };
      return parseStoredWorkspace(value);
    },
    async save(id, workspace) {
      const tx = conn.transaction(STORE, 'readwrite');
      const existing = await tx.store.get(id);
      const t = now();
      const record: StoredWorkspace = {
        id,
        files: { ...workspace.files },
        manifest: structuredClone(workspace.manifest),
        createdAt: existing?.createdAt ?? t,
        updatedAt: t,
        schemaVersion: SCHEMA_VERSION,
      };
      await tx.store.put(record);
      await tx.done;
      return record;
    },
    async list() {
      const all = await conn.getAllFromIndex(STORE, 'by-updated');
      return all.reverse().map((r) => ({
        id: r.id,
        template: r.manifest.template,
        fileCount: Object.keys(r.files).length,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    },
    async delete(id) {
      await conn.delete(STORE, id);
    },
    close() {
      conn.close();
    },
  };
}

export interface Autosaver {
  /** Remembers the latest state and saves it after `debounceMs` of quiet. */
  schedule(workspace: Workspace): void;
  /** Saves a pending state now. Resolves when every save so far has finished. */
  flush(): Promise<void>;
  /** Drops a pending (not yet started) save. */
  cancel(): void;
  readonly pending: boolean;
}

export interface AutosaverOptions {
  /** Default 300 ms. */
  debounceMs?: number;
  onSaved?: (record: StoredWorkspace) => void;
  onError?: (error: unknown) => void;
}

/** Debounced, serialized saves of one workspace id. */
export function createAutosaver(
  store: Pick<WorkspaceStore, 'save'>,
  id: string,
  opts: AutosaverOptions = {},
): Autosaver {
  const debounceMs = opts.debounceMs ?? 300;
  let latest: Workspace | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = (): Promise<void> => {
    clearTimer();
    const ws = latest;
    latest = null;
    if (ws !== null) {
      // Saves run one after another, so an older state can never overwrite a newer one.
      chain = chain.then(() =>
        store.save(id, ws).then(
          (record) => opts.onSaved?.(record),
          (e: unknown) => opts.onError?.(e),
        ),
      );
    }
    return chain;
  };

  return {
    schedule(workspace) {
      latest = workspace;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },
    flush,
    cancel() {
      clearTimer();
      latest = null;
    },
    get pending() {
      return latest !== null;
    },
  };
}
