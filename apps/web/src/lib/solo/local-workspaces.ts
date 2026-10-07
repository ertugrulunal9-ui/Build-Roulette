/** Battle workspaces in IndexedDB (`@br/workspace` store), for cleanup and DESTROY. */
import { openWorkspaceStore, type WorkspaceStore } from '@br/workspace';
import type { LocalWorkspaces } from './controller';
import { BATTLE_WORKSPACE_PREFIX } from './workspace-cleanup';

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
  listBattleWorkspaces: () =>
    withStore(async (s) =>
      (await s.list())
        .filter((w) => w.id.startsWith(BATTLE_WORKSPACE_PREFIX))
        .map((w) => ({ id: w.id, updatedAt: w.updatedAt })),
    ),
};
