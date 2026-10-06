/** Battle workspaces in IndexedDB (`@br/workspace` store), for cleanup and DESTROY. */
import { openWorkspaceStore, type WorkspaceStore } from '@br/workspace';
import type { LocalWorkspaces } from './controller';

const BATTLE_PREFIX = 'battle:';

async function withStore<T>(fn: (store: WorkspaceStore) => Promise<T>): Promise<T> {
  const store = await openWorkspaceStore();
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

export const indexedDbWorkspaces: LocalWorkspaces = {
  delete: (id) => withStore((s) => s.delete(id)),
  deleteBattleWorkspacesExcept: (keepId) =>
    withStore(async (s) => {
      const all = await s.list();
      for (const w of all) {
        if (w.id.startsWith(BATTLE_PREFIX) && w.id !== keepId) await s.delete(w.id);
      }
    }),
};
