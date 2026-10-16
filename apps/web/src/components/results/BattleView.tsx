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
 * with a retry (the server failed). The tab title follows. The HTML a crawler gets already has
 * the battle's title and `og:*` tags, written at the edge by T-038's link-preview Function
 * (lib/hosting/preview-worker.ts), with a 404 status for an unknown battle; this view works
 * the same either way.
 */
import { shellParam } from '../../lib/hosting/shells';
import { useBrowserUrl } from '../../lib/hosting/use-browser-url';
import { useRemote } from '../../lib/hosting/use-remote';
import { useT } from '../../lib/i18n/context';
import { battleTitle } from '../../lib/solo/battle-meta';
import { fetchPublicBattle } from '../../lib/solo/public-battle';
import { DocumentTitle } from '../DocumentTitle';
import { NotFoundView } from '../NotFoundView';
import { BattleResults } from './BattleResults';
import { LoadErrorView, LoadingView } from './LoadStates';

export function BattleView() {
  const t = useT();
  const page = t.battlePage;
  const url = useBrowserUrl();
  const id = url ? shellParam('/battles', url.pathname) : null;
  const { state, retry } = useRemote(id, () => fetchPublicBattle(id ?? ''));

  if (state.status === 'loading') {
    return (
      <>
        <DocumentTitle title={page.shellTitle} />
        <LoadingView text={page.loading} testId="battle-loading" />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <>
        <DocumentTitle title={page.shellTitle} />
        <LoadErrorView testId="battle-load-error" text={page.loadError} onRetry={retry} />
      </>
    );
  }
  if (!state.value) {
    return (
      <>
        <DocumentTitle title={page.notFoundTitle} />
        <NotFoundView testId="battle-not-found">
          <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">{page.notFound}</p>
        </NotFoundView>
      </>
    );
  }
  return (
    <>
      <DocumentTitle title={battleTitle(state.value, page)} />
      <BattleResults data={state.value} />
    </>
  );
}
