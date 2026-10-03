'use client';

import {
  createAutosaver,
  createWorkspace,
  openWorkspaceStore,
  type Autosaver,
  type Workspace,
  type WorkspaceStore,
} from '@br/workspace';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'unavailable';

export interface PersistentWorkspace {
  /** null until the stored workspace (or the template) has been loaded. */
  workspace: Workspace | null;
  /** Replaces the workspace and schedules a debounced save (300 ms). */
  update: (next: Workspace) => void;
  saveState: SaveState;
  /** Something the user should know about loading/saving, e.g. a corrupt stored workspace. */
  notice: string | null;
}

/**
 * Loads workspace `id` from IndexedDB (or starts from the default template) and keeps it
 * saved. Saves are flushed when the tab is hidden or closed.
 */
export function usePersistentWorkspace(id: string): PersistentWorkspace {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const saverRef = useRef<Autosaver | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A function, so TypeScript does not narrow the flag across awaits.
    const isCancelled = () => cancelled;
    let store: WorkspaceStore | null = null;

    void (async () => {
      try {
        store = await openWorkspaceStore();
      } catch (e) {
        // Private browsing modes or blocked storage: keep working, just without saving.
        if (isCancelled()) return;
        setWorkspace(createWorkspace());
        setSaveState('unavailable');
        setNotice(
          `Your browser blocked IndexedDB, so edits will not survive a reload (${e instanceof Error ? e.message : String(e)}).`,
        );
        return;
      }
      if (isCancelled()) {
        store.close();
        return;
      }
      const loaded = await store.load(id);
      if (isCancelled()) return;
      saverRef.current = createAutosaver(store, id, {
        onSaved: () => {
          if (!saverRef.current?.pending) setSaveState('saved');
        },
        onError: (e) => {
          setSaveState('error');
          setNotice(`Saving failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      });
      if (loaded.status === 'found') {
        setWorkspace({ files: loaded.workspace.files, manifest: loaded.workspace.manifest });
        setSaveState('saved');
        return;
      }
      if (loaded.status === 'invalid') {
        setNotice(
          `The saved workspace could not be read (${loaded.reason}); started from the template.`,
        );
      }
      const initial = createWorkspace();
      setWorkspace(initial);
      saverRef.current.schedule(initial);
      setSaveState('saving');
    })();

    const flush = () => {
      void saverRef.current?.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      const saver = saverRef.current;
      saverRef.current = null;
      const s = store;
      void (saver ? saver.flush() : Promise.resolve()).finally(() => s?.close());
    };
  }, [id]);

  const update = useCallback((next: Workspace) => {
    setWorkspace(next);
    const saver = saverRef.current;
    if (saver) {
      saver.schedule(next);
      setSaveState('saving');
    }
  }, []);

  return { workspace, update, saveState, notice };
}
