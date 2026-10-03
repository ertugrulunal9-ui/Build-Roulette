import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAutosaver,
  openWorkspaceStore,
  parseStoredWorkspace,
  type StoredWorkspace,
  type WorkspaceStore,
} from './persistence';
import { createWorkspace } from './templates';
import type { Workspace } from './types';

let store: WorkspaceStore;
let clock = 1000;

beforeEach(async () => {
  // A fresh in-memory IndexedDB per test.
  globalThis.indexedDB = new IDBFactory();
  clock = 1000;
  store = await openWorkspaceStore({ now: () => clock });
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

function edited(text: string): Workspace {
  const ws = createWorkspace();
  ws.files['src/App.tsx'] = text;
  return ws;
}

describe('WorkspaceStore', () => {
  it('returns missing for an unknown id', async () => {
    expect(await store.load('nope')).toEqual({ status: 'missing' });
  });

  it('saves and loads files + manifest', async () => {
    const ws = edited('export const v = 1;\n');
    await store.save('w1', ws);
    const loaded = await store.load('w1');
    expect(loaded).toEqual({
      status: 'found',
      workspace: {
        id: 'w1',
        files: ws.files,
        manifest: ws.manifest,
        createdAt: 1000,
        updatedAt: 1000,
        schemaVersion: 1,
      },
    });
  });

  it('stores a copy, not a live reference', async () => {
    const ws = edited('a');
    await store.save('w1', ws);
    ws.files['src/App.tsx'] = 'mutated later';
    const loaded = await store.load('w1');
    expect(loaded.status === 'found' && loaded.workspace.files['src/App.tsx']).toBe('a');
  });

  it('keeps createdAt and bumps updatedAt on overwrite', async () => {
    await store.save('w1', edited('a'));
    clock = 5000;
    const second = await store.save('w1', edited('b'));
    expect(second.createdAt).toBe(1000);
    expect(second.updatedAt).toBe(5000);
  });

  it('survives reopening the database (a page reload)', async () => {
    await store.save('w1', edited('persisted'));
    store.close();
    store = await openWorkspaceStore();
    const loaded = await store.load('w1');
    expect(loaded.status === 'found' && loaded.workspace.files['src/App.tsx']).toBe('persisted');
  });

  it('lists workspaces newest first and deletes them', async () => {
    await store.save('old', createWorkspace('vanilla-ts'));
    clock = 2000;
    await store.save('new', createWorkspace('react-ts'));
    expect(await store.list()).toEqual([
      { id: 'new', template: 'react-ts', fileCount: 3, createdAt: 2000, updatedAt: 2000 },
      { id: 'old', template: 'vanilla-ts', fileCount: 2, createdAt: 1000, updatedAt: 1000 },
    ]);
    await store.delete('old');
    expect((await store.list()).map((s) => s.id)).toEqual(['new']);
    expect(await store.load('old')).toEqual({ status: 'missing' });
  });

  it('reports a corrupt record instead of returning it', async () => {
    // Write a bad record behind the store's back.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('br-workspaces');
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('open failed'));
      };
    });
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction('workspaces', 'readwrite');
      tx.objectStore('workspaces').put({ id: 'bad', schemaVersion: 1, files: { a: 1 } });
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('tx failed'));
      };
    });
    raw.close();
    expect(await store.load('bad')).toEqual({
      status: 'invalid',
      reason: 'files is not a map of strings',
    });
  });
});

describe('parseStoredWorkspace', () => {
  const good: StoredWorkspace = {
    id: 'x',
    files: { 'src/main.tsx': '' },
    manifest: createWorkspace().manifest,
    createdAt: 1,
    updatedAt: 2,
    schemaVersion: 1,
  };

  it('accepts a valid record', () => {
    expect(parseStoredWorkspace(good)).toEqual({ status: 'found', workspace: good });
  });

  it.each([
    [null, 'not an object'],
    [{ ...good, schemaVersion: 2 }, 'unsupported schema version 2'],
    [{ ...good, id: 3 }, 'missing id'],
    [{ ...good, manifest: undefined }, 'missing manifest'],
    [{ ...good, manifest: { ...good.manifest, template: 'svelte' } }, 'unknown template'],
    [{ ...good, manifest: { ...good.manifest, entry: 1 } }, 'manifest.entry is not a string'],
    [
      { ...good, manifest: { ...good.manifest, dependencies: { react: 18 } } },
      'manifest.dependencies is not a map of strings',
    ],
  ])('rejects %j', (value, reason) => {
    expect(parseStoredWorkspace(value)).toEqual({ status: 'invalid', reason });
  });

  it('defaults a missing tailwind flag to false', () => {
    const manifest: Partial<StoredWorkspace['manifest']> = { ...good.manifest };
    delete manifest.tailwind;
    const parsed = parseStoredWorkspace({ ...good, manifest });
    expect(parsed.status === 'found' && parsed.workspace.manifest.tailwind).toBe(false);
  });
});

describe('createAutosaver', () => {
  it('debounces saves by 300 ms and saves only the latest state', async () => {
    vi.useFakeTimers();
    const save = vi.fn((id: string, ws: Workspace) =>
      Promise.resolve({ id, ...ws, createdAt: 0, updatedAt: 0, schemaVersion: 1 as const }),
    );
    const saver = createAutosaver({ save }, 'w1');
    saver.schedule(edited('1'));
    await vi.advanceTimersByTimeAsync(200);
    saver.schedule(edited('2'));
    await vi.advanceTimersByTimeAsync(200);
    saver.schedule(edited('3'));
    expect(saver.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].files['src/App.tsx']).toBe('3');
    expect(saver.pending).toBe(false);
  });

  it('flush saves immediately; cancel drops a pending state', async () => {
    vi.useFakeTimers();
    const save = vi.fn((id: string, ws: Workspace) =>
      Promise.resolve({ id, ...ws, createdAt: 0, updatedAt: 0, schemaVersion: 1 as const }),
    );
    const saver = createAutosaver({ save }, 'w1');
    saver.schedule(edited('a'));
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    saver.schedule(edited('b'));
    saver.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    await saver.flush(); // nothing pending: no extra save
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('serializes saves so an older state never lands after a newer one', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const save = vi.fn(async (id: string, ws: Workspace) => {
      const text = ws.files['src/App.tsx'] ?? '';
      if (text === 'slow') {
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
      }
      order.push(text);
      return { id, ...ws, createdAt: 0, updatedAt: 0, schemaVersion: 1 as const };
    });
    const saver = createAutosaver({ save }, 'w1');
    saver.schedule(edited('slow'));
    const first = saver.flush();
    saver.schedule(edited('fast'));
    const second = saver.flush();
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('reports errors through onError and keeps going', async () => {
    const errors: unknown[] = [];
    const saved: string[] = [];
    let fail = true;
    const saver = createAutosaver(
      {
        save: (id, ws) => {
          if (fail) return Promise.reject(new Error('quota exceeded'));
          return Promise.resolve({ id, ...ws, createdAt: 0, updatedAt: 0, schemaVersion: 1 });
        },
      },
      'w1',
      { onError: (e) => errors.push(e), onSaved: (r) => saved.push(r.id) },
    );
    saver.schedule(edited('a'));
    await saver.flush();
    fail = false;
    saver.schedule(edited('b'));
    await saver.flush();
    expect(errors).toHaveLength(1);
    expect(saved).toEqual(['w1']);
  });

  it('works end to end with the IndexedDB store', async () => {
    const saver = createAutosaver(store, 'w1', { debounceMs: 10 });
    saver.schedule(edited('via autosave'));
    await saver.flush();
    const loaded = await store.load('w1');
    expect(loaded.status === 'found' && loaded.workspace.files['src/App.tsx']).toBe('via autosave');
  });
});
