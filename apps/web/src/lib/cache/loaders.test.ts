/**
 * The `'use cache'` loaders apply the caching rules (T-026): the lifetime and the tags of
 * each answer. Outside Next the directive is a plain string, so the functions run as is;
 * `cacheLife` and `cacheTag` are mocked and `fetch` answers like PostgREST.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPlayerHistory, type PlayerHistory } from '../history/player-history';
import { loadPublicBattle } from '../solo/public-battle';
import type { PublicBattle } from '../solo/types';
import {
  LIVE_BATTLE,
  MALFORMED_ID,
  MISSING_BATTLE,
  PLAYER_HISTORY,
  SETTLED_BATTLE,
} from './policy';

const next = vi.hoisted(() => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock('next/cache', () => next);

const ID = 'b0260000-0000-4000-8000-000000000001';
const USER = 'a0260000-0000-4000-8000-00000000000a';

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function publicBattle(phase: 'results' | 'destroyed', destroyedAt: string | null): PublicBattle {
  return {
    battle: {
      id: ID,
      mode: 'solo',
      phase,
      is_complete: true,
      building_started_at: null,
      building_ends_at: null,
      finished_at: '2026-10-08T11:56:00Z',
      destroyed_at: destroyedAt,
      created_at: '2026-10-08T11:49:00Z',
    },
    challenge: {
      build: { text: 'A cache probe', hint: null },
      rule: { text: 'No rules', hint: null },
      style: { text: 'Plain', hint: null },
      time_limit_seconds: 300,
    },
    players: [],
    builds: [],
    awards: [],
  };
}

const fetchMock = vi.fn<typeof fetch>();

/** The JSON body of the first request. */
function sentBody(): Record<string, unknown> {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('no JSON body');
  return JSON.parse(body) as Record<string, unknown>;
}
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('loadPublicBattle', () => {
  it('caches a settled battle for long, under its tag', async () => {
    fetchMock.mockResolvedValue(answer(200, publicBattle('destroyed', '2026-10-08T12:10:00Z')));
    const data = await loadPublicBattle(ID);
    expect(data?.battle.phase).toBe('destroyed');
    expect(next.cacheTag).toHaveBeenCalledWith(`battle:${ID}`);
    expect(next.cacheLife).toHaveBeenCalledExactlyOnceWith(SETTLED_BATTLE);
    // The data cache stays out of it: the function's own cache holds the answer.
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store');
  });

  it('caches a battle in RESULTS for seconds', async () => {
    fetchMock.mockResolvedValue(answer(200, publicBattle('results', null)));
    await loadPublicBattle(ID);
    expect(next.cacheLife).toHaveBeenCalledExactlyOnceWith(LIVE_BATTLE);
  });

  it('caches "not public (yet)" for seconds and a malformed id for long', async () => {
    fetchMock.mockResolvedValue(answer(400, { message: 'battle_not_found' }));
    expect(await loadPublicBattle(ID)).toBeNull();
    expect(next.cacheLife).toHaveBeenLastCalledWith(MISSING_BATTLE);
    expect(await loadPublicBattle('nope')).toBeNull();
    expect(next.cacheLife).toHaveBeenLastCalledWith(MALFORMED_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a server failure (nothing is cached; ISR keeps its last copy)', async () => {
    fetchMock.mockResolvedValue(answer(503, { message: 'down' }));
    await expect(loadPublicBattle(ID)).rejects.toThrow(/get_public_battle failed/);
    expect(next.cacheLife).not.toHaveBeenCalled();
  });
});

describe('loadPlayerHistory', () => {
  it('caches a history page for a minute, tagged with the player and its battles', async () => {
    const other = 'b0260000-0000-4000-8000-000000000002';
    const page: PlayerHistory = {
      player: { display_name: 'Iris' },
      battles: [{ battle_id: ID }, { battle_id: other }] as PlayerHistory['battles'],
      next: null,
    };
    fetchMock.mockResolvedValue(answer(200, page));
    expect(await loadPlayerHistory(USER, null, null)).toEqual(page);
    expect(next.cacheLife).toHaveBeenCalledExactlyOnceWith(PLAYER_HISTORY);
    expect(next.cacheTag).toHaveBeenCalledExactlyOnceWith(
      `player:${USER}`,
      `battle:${ID}`,
      `battle:${other}`,
    );
    expect(sentBody()).toMatchObject({ p_user_id: USER, p_before: null, p_before_battle: null });
  });

  it('passes the cursor of an older page', async () => {
    fetchMock.mockResolvedValue(answer(200, { player: null, battles: [], next: null }));
    await loadPlayerHistory(USER, '2026-10-08T12:00:00.123456Z', ID);
    expect(sentBody()).toMatchObject({
      p_before: '2026-10-08T12:00:00.123456Z',
      p_before_battle: ID,
    });
    expect(next.cacheTag).toHaveBeenCalledExactlyOnceWith(`player:${USER}`);
  });
});

describe('the pages’ segment config', () => {
  it('caps the ISR copies at the settled lifetime, as a literal Next can read', async () => {
    // Imported here (not at the top) so the mocks above apply to the page's imports too.
    const page = await import('../../app/battles/[id]/page');
    expect(page.dynamic).toBe('force-static');
    expect(page.revalidate).toBe(SETTLED_BATTLE.revalidate);
    const og = await import('../../app/battles/[id]/opengraph-image');
    expect(og.dynamic).toBe('force-static');
    expect(og.revalidate).toBe(SETTLED_BATTLE.revalidate);
  });
});
