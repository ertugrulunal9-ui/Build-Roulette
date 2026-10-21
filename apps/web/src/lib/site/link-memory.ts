/**
 * The last link a player imported (docs/10 §10.1: "Import again" offers it), so re-publishing
 * and importing the same link again is one click ("Copy again from <host>").
 *
 * Kept in localStorage on this device only, never sent anywhere: per battle on the BUILD
 * stage (`battle:{id}`, only the current battle's is kept) and one for `/try` (`try`). Every
 * access is in try/catch: blocked storage just means nothing is remembered.
 */
import { MAX_URL_CHARS } from '@br/site';

export const LINK_KEY_PREFIX = 'br:import-link:';

export type LinkScope = `battle:${string}` | 'try';

export function linkScope(battleId: string | null): LinkScope {
  return battleId === null ? 'try' : `battle:${battleId}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function local(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function valid(value: string | null): string | null {
  if (value === null || value.length === 0 || value.length > MAX_URL_CHARS) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** The link remembered for `scope`, or null. */
export function recallLink(scope: LinkScope, storage: StorageLike | null = local()): string | null {
  try {
    return valid(storage?.getItem(LINK_KEY_PREFIX + scope) ?? null);
  } catch {
    return null;
  }
}

/** Remembers `link` for `scope`; a battle's replaces the other battles' (they are over). */
export function rememberLink(
  scope: LinkScope,
  link: string,
  storage: StorageLike | null = local(),
): void {
  if (!storage || valid(link) === null) return;
  try {
    if (scope !== 'try') {
      const stale: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(`${LINK_KEY_PREFIX}battle:`) && key !== LINK_KEY_PREFIX + scope) {
          stale.push(key);
        }
      }
      for (const key of stale) storage.removeItem(key);
    }
    storage.setItem(LINK_KEY_PREFIX + scope, link);
  } catch {
    // blocked or full: not remembered
  }
}
