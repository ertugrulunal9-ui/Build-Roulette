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
import { useEffect } from 'react';
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
import { documentTitle } from '../../lib/solo/battle-meta';
import { LoadErrorView, LoadingView } from './LoadStates';
import { PlayerHistory, PlayerNotFound } from './PlayerHistory';

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
      ? null
      : found?.player
        ? playerMeta({ ...found, player: found.player }).title
        : PLAYER_NOT_FOUND_TITLE;
  useEffect(() => {
    if (title) document.title = documentTitle(title);
  }, [title]);

  if (state.status === 'loading') {
    return <LoadingView text="Loading the battles…" testId="player-loading" />;
  }
  if (state.status === 'error') {
    return (
      <LoadErrorView
        testId="player-load-error"
        text="The battles could not be loaded. Check your connection, then try again."
        onRetry={retry}
      />
    );
  }
  if (!found?.player || !id) return <PlayerNotFound />;
  return <PlayerHistory id={id} cursor={cursor} data={{ ...found, player: found.player }} />;
}
