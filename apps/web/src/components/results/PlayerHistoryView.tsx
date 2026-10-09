'use client';

/**
 * `/u/{id}` (T-037): every player shares one exported page (app/u/page.tsx), reached through
 * the host's rewrite (src/lib/hosting/shells.ts). The id comes from the browser's URL, the
 * page of battles from its query string (`?before=…&before_battle=…`, the server's keyset
 * cursor; a malformed one shows the first page), and the data from `get_player_history`
 * (anon key) on every page load, so a takedown shows on the next load.
 *
 * States: loading, the history, "No battles to show" (an unknown or malformed id, or a player
 * without a finished battle: one answer on purpose), or "could not load" with a retry.
 */
import {
  fetchPlayerHistory,
  isUserId,
  parseCursor,
  type HistoryCursor,
} from '../../lib/history/player-history';
import { PLAYER_NOT_FOUND_TITLE, playerMeta } from '../../lib/history/player-meta';
import { shellParam } from '../../lib/hosting/shells';
import { useBrowserUrl } from '../../lib/hosting/use-browser-url';
import { useRemote } from '../../lib/hosting/use-remote';
import { DocumentTitle } from '../DocumentTitle';
import { LoadErrorView, LoadingView } from './LoadStates';
import { PlayerHistory, PlayerNotFound } from './PlayerHistory';

/** The shell's title until the player is known (also the exported HTML's). */
export const PLAYER_SHELL_TITLE = 'Player history';

function cursorOf(search: URLSearchParams): HistoryCursor | null {
  return parseCursor({ before: search.get('before'), before_battle: search.get('before_battle') });
}

export function PlayerHistoryView() {
  const url = useBrowserUrl();
  const id = url ? shellParam('/u', url.pathname).toLowerCase() : null;
  const cursor = url ? cursorOf(url.searchParams) : null;
  const key = id === null ? null : `${id}?${cursor ? `${cursor.before}|${cursor.before_battle}` : ''}`;
  const { state, retry } = useRemote(key, async () =>
    id && isUserId(id) ? fetchPlayerHistory(id, cursor) : null,
  );

  const found = state.status === 'ready' && state.value?.player ? state.value : null;
  const title =
    state.status !== 'ready'
      ? PLAYER_SHELL_TITLE
      : found?.player
        ? playerMeta({ ...found, player: found.player }).title
        : PLAYER_NOT_FOUND_TITLE;

  return (
    <>
      <DocumentTitle title={title} />
      {state.status === 'loading' ? (
        <LoadingView text="Loading the battles…" testId="player-loading" />
      ) : state.status === 'error' ? (
        <LoadErrorView
          testId="player-load-error"
          text="The battles could not be loaded. Check your connection, then try again."
          onRetry={retry}
        />
      ) : !found?.player || !id ? (
        <PlayerNotFound />
      ) : (
        <PlayerHistory id={id} cursor={cursor} data={{ ...found, player: found.player }} />
      )}
    </>
  );
}
