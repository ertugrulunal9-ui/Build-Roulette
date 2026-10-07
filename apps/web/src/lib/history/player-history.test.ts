/**
 * The /u/[id] data layer: the cursor from the query string (malformed → first page), the
 * links between pages, and the RPC call (anon key, the cursor, errors are thrown, not
 * shown as "no battles").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPlayerHistory,
  historyHref,
  isUserId,
  parseCursor,
  type PlayerHistory,
} from './player-history';

const USER = '1a000000-0000-4000-8000-00000000000a';
const BATTLE = 'b1000000-0000-4000-8000-000000000001';
const CONFIG = { url: 'https://db.example', anonKey: 'eyJ.anon.key' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('player history', () => {
  it('parses the cursor; anything malformed is the first page', () => {
    const before = '2026-10-07T09:00:00.123456+00:00';
    expect(parseCursor({ before, before_battle: BATTLE.toUpperCase() })).toEqual({
      before,
      before_battle: BATTLE,
    });
    expect(parseCursor({})).toBeNull();
    expect(parseCursor({ before })).toBeNull();
    expect(parseCursor({ before: 'yesterday', before_battle: BATTLE })).toBeNull();
    expect(parseCursor({ before, before_battle: 'x' })).toBeNull();
    expect(parseCursor({ before: [before, before], before_battle: BATTLE })).toBeNull();
  });

  it('links pages with the cursor in the query string', () => {
    expect(historyHref(USER, null)).toBe(`/u/${USER}`);
    const href = historyHref(USER, { before: '2026-10-07T09:00:00+00:00', before_battle: BATTLE });
    const url = new URL(href, 'https://x.example');
    expect(url.pathname).toBe(`/u/${USER}`);
    expect(parseCursor(Object.fromEntries(url.searchParams))).toEqual({
      before: '2026-10-07T09:00:00+00:00',
      before_battle: BATTLE,
    });
  });

  it('calls get_player_history with the anon key and the cursor', async () => {
    const body: PlayerHistory = { player: { display_name: 'Ada' }, battles: [], next: null };
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchPlayerHistory(
      USER.toUpperCase(),
      { before: '2026-10-07T09:00:00+00:00', before_battle: BATTLE },
      10,
      CONFIG,
    );
    expect(out).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.example/rest/v1/rpc/get_player_history');
    expect(init.headers).toMatchObject({
      apikey: CONFIG.anonKey,
      authorization: `Bearer ${CONFIG.anonKey}`,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      p_user_id: USER,
      p_before: '2026-10-07T09:00:00+00:00',
      p_before_battle: BATTLE,
      p_limit: 10,
    });
  });

  it('not a uuid: no request; a server failure throws', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ message: 'boom' }), { status: 500 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(isUserId('nope')).toBe(false);
    expect(await fetchPlayerHistory('nope', null, 10, CONFIG)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetchPlayerHistory(USER, null, 10, CONFIG)).rejects.toThrow(/HTTP 500 boom/);
  });
});
