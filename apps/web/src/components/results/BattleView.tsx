'use client';

/**
 * `/battles/{id}` (T-037): every battle shares one exported page (app/battles/page.tsx),
 * reached through the host's rewrite (src/lib/hosting/shells.ts). The id comes from the
 * browser's URL; the results come from `get_public_battle` (anon key) on every page load, so
 * a takedown shows on the very next load (the RPC already hides a removed build's name and
 * screenshot and drops its awards, T-024/T-028).
 *
 * States: loading, the results (BattleResults), "not found" (an unknown id, a battle that is
 * not in RESULTS yet, or a malformed id: one answer, like the RPC's), or "could not load"
 * with a retry (the server failed). The tab title follows; the shell's meta tags are the
 * generic ones (link previews per battle: T-038).
 */
import { shellParam } from '../../lib/hosting/shells';
import { useBrowserUrl } from '../../lib/hosting/use-browser-url';
import { useRemote } from '../../lib/hosting/use-remote';
import { BATTLE_NOT_FOUND_TITLE, battleMeta } from '../../lib/solo/battle-meta';
import { fetchPublicBattle } from '../../lib/solo/public-battle';
import { DocumentTitle } from '../DocumentTitle';
import { NotFoundView } from '../NotFoundView';
import { BattleResults } from './BattleResults';
import { LoadErrorView, LoadingView } from './LoadStates';

/** The shell's title until the battle is known (also the exported HTML's). */
export const BATTLE_SHELL_TITLE = 'Battle results';

export function BattleView() {
  const url = useBrowserUrl();
  const id = url ? shellParam('/battles', url.pathname) : null;
  const { state, retry } = useRemote(id, () => fetchPublicBattle(id ?? ''));

  if (state.status === 'loading') {
    return (
      <>
        <DocumentTitle title={BATTLE_SHELL_TITLE} />
        <LoadingView text="Loading the results…" testId="battle-loading" />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <>
        <DocumentTitle title={BATTLE_SHELL_TITLE} />
        <LoadErrorView
          testId="battle-load-error"
          text="The results could not be loaded. Check your connection, then try again."
          onRetry={retry}
        />
      </>
    );
  }
  if (!state.value) {
    return (
      <>
        <DocumentTitle title={BATTLE_NOT_FOUND_TITLE} />
        <NotFoundView testId="battle-not-found">
          <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
            No battle has this link, or its results are not in yet.
          </p>
        </NotFoundView>
      </>
    );
  }
  return (
    <>
      <DocumentTitle title={battleMeta(state.value).title} />
      <BattleResults data={state.value} />
    </>
  );
}
