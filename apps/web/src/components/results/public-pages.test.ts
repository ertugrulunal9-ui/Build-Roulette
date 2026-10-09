// @vitest-environment happy-dom
/**
 * The public results surfaces (/battles/{id} and /u/{id}), which are static shells that load
 * their data in the browser (T-037):
 *
 * - the shells read the id (and the history's cursor) from the browser's URL, call the RPC
 *   with the anon key, and show loading, the results, "not found" or "could not load" with a
 *   retry, and set the tab title;
 * - with a build a moderator removed after RESULTS (T-028): the removed rank-1 build keeps
 *   its place, rank and vote counts, and shows no Winner banner, gold ring, medal or award
 *   chips; nobody else becomes the winner or gets its awards. The data is what
 *   get_public_battle / get_player_history return (their awards already left out), plus an
 *   older server's answer that still carries them;
 * - the title, description and social image (lib/solo/battle-meta.ts, og-image.ts) that
 *   T-038's link previews will use.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HistoryBattle,
  PlayerHistory as PlayerHistoryData,
} from '../../lib/history/player-history';
import { playerMeta } from '../../lib/history/player-meta';
import { battleMeta } from '../../lib/solo/battle-meta';
import { STATIC_OG_CARD, battleOgImage } from '../../lib/solo/og-image';
import type { Award, PublicBattle, PublicBuild } from '../../lib/solo/types';
import { BattleResults } from './BattleResults';
import { BattleView } from './BattleView';
import { PlayerHistory } from './PlayerHistory';
import { PlayerHistoryView } from './PlayerHistoryView';

// The viewer's own history link needs a browser session; not part of these pages' data.
vi.mock('./MyHistoryLink', () => ({ MyHistoryLink: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BATTLE = 'b0280000-0000-4000-8000-000000000001';
const MALLORY = 'a0280000-0000-4000-8000-00000000000a';
const CHALLENGE = {
  build: { text: 'A pomodoro timer', hint: null },
  rule: { text: 'Only one button', hint: null },
  style: { text: 'Brutalist', hint: null },
  time_limit_seconds: 300,
};

function publicBuild(id: string, patch: Partial<PublicBuild>): PublicBuild {
  return {
    id,
    builder_name: 'Someone',
    name: 'A build',
    status: 'shipped',
    shipped_at: '2026-10-08T11:58:00Z',
    completion_ms: 150_000,
    final_rank: null,
    total_votes: 0,
    votes: { overall: 0, rule: 0, style: 0, chaos: 0 },
    stats: {},
    capture_status: 'captured',
    screenshot_path: null,
    taken_down: false,
    ...patch,
  };
}

/** Mallory's "Free Gift Card" won (rank 1, Best Build, speedrun), then was taken down. */
function removedWinnerBattle(withStaleAwards = false): PublicBattle {
  const kept: Award[] = [
    { build_id: 'ana', award: 'style', source: 'vote', votes: 2 },
    { build_id: 'ana', award: 'clutch_ship', source: 'auto', votes: null },
    { build_id: 'cy', award: 'rule', source: 'vote', votes: 1 },
  ];
  const stale: Award[] = [
    { build_id: 'mallory', award: 'overall', source: 'vote', votes: 3 },
    { build_id: 'mallory', award: 'speedrun', source: 'auto', votes: null },
  ];
  return {
    battle: {
      id: BATTLE,
      mode: 'multiplayer',
      phase: 'results',
      is_complete: true,
      building_started_at: '2026-10-08T11:55:00Z',
      building_ends_at: '2026-10-08T12:00:00Z',
      finished_at: '2026-10-08T12:03:00Z',
      destroyed_at: null,
      created_at: '2026-10-08T11:54:00Z',
    },
    challenge: CHALLENGE,
    players: ['Ana', 'Cy', 'Mallory'],
    builds: [
      publicBuild('mallory', {
        builder_name: 'Mallory',
        name: null,
        final_rank: 1,
        total_votes: 5,
        votes: { overall: 3, rule: 1, style: 1, chaos: 0 },
        taken_down: true,
      }),
      publicBuild('ana', {
        builder_name: 'Ana',
        name: 'Pomodoro Pal',
        final_rank: 2,
        total_votes: 3,
        votes: { overall: 1, rule: 0, style: 2, chaos: 0 },
        screenshot_path: `${BATTLE}/ana.png`,
      }),
      publicBuild('cy', {
        builder_name: 'Cy',
        name: 'Tomato',
        final_rank: 3,
        total_votes: 1,
        votes: { overall: 0, rule: 1, style: 0, chaos: 0 },
      }),
    ],
    awards: withStaleAwards ? [...stale, ...kept] : kept,
  };
}

function cardOf(id: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(`[data-testid=public-build][data-build=${id}]`);
  if (!card) throw new Error(`no card ${id}`);
  return card;
}

const chipsOf = (el: HTMLElement) =>
  within(el)
    .queryAllByTestId('award')
    .map((a) => a.dataset['award']);

/** PostgREST's answers to the page's one RPC call, in order; every request is recorded. */
function stubRpc(...answers: { status: number; body: unknown }[]) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => {
    const next = answers.shift();
    if (!next) return Promise.reject(new Error('unexpected request'));
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The browser is at `path` (the host rewrote it to the shell). */
function visit(path: string): void {
  window.history.replaceState(null, '', path);
}

describe('/battles/{id}: the shell loads the battle in the browser (T-037)', () => {
  it('reads the id from the URL, calls get_public_battle with the anon key, sets the title', async () => {
    const fetchMock = stubRpc({ status: 200, body: removedWinnerBattle() });
    visit(`/battles/${BATTLE.toUpperCase()}`);
    render(createElement(BattleView));
    expect(screen.getByTestId('battle-loading')).toBeTruthy();
    await screen.findByTestId('battle-title');
    expect(screen.getAllByTestId('public-build')).toHaveLength(3);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:54321/rest/v1/rpc/get_public_battle');
    expect(JSON.parse(init?.body as string)).toEqual({ p_battle_id: BATTLE });
    expect(init?.cache).toBe('no-store');
    expect(document.title).toBe('A pomodoro timer · Battle results · Build Roulette');
  });

  it('an unknown battle (battle_not_found) and a malformed id: the not-found view', async () => {
    const fetchMock = stubRpc({ status: 400, body: { message: 'battle_not_found' } });
    visit(`/battles/${BATTLE}`);
    render(createElement(BattleView));
    await screen.findByTestId('battle-not-found');
    expect(document.title).toBe('Battle not found · Build Roulette');
    cleanup();

    visit('/battles/not-a-battle');
    render(createElement(BattleView));
    await screen.findByTestId('battle-not-found');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no request for a malformed id
  });

  it('a server failure is "could not load", not "not found"; Try again loads it', async () => {
    stubRpc(
      { status: 503, body: { message: 'upstream' } },
      { status: 200, body: removedWinnerBattle() },
    );
    visit(`/battles/${BATTLE}`);
    render(createElement(BattleView));
    const failed = await screen.findByTestId('battle-load-error');
    within(failed).getByRole('button', { name: 'Try again' }).click();
    await screen.findByTestId('battle-title');
  });
});

describe('/battles/{id} with a removed rank-1 build (T-028)', () => {
  for (const stale of [false, true]) {
    it(`no Winner banner, gold ring or awards on it; nobody inherits${stale ? ' (an older server still sends its awards)' : ''}`, () => {
      render(createElement(BattleResults, { data: removedWinnerBattle(stale) }));

      const cards = screen.getAllByTestId('public-build');
      expect(
        cards.map((c) => [c.dataset['build'], c.dataset['rank'], c.dataset['winner']]),
      ).toEqual([
        ['mallory', '1', 'false'],
        ['ana', '2', 'false'],
        ['cy', '3', 'false'],
      ]);
      expect(screen.queryByTestId('public-winner')).toBeNull();

      const removed = cardOf('mallory');
      expect(removed.dataset['removed']).toBe('true');
      expect(removed.className).not.toContain('ring-amber');
      expect(within(removed).getByTestId('public-build-name').textContent).toBe(
        '#1Removed by moderators',
      );
      expect(chipsOf(removed)).toEqual([]);
      expect(within(removed).getByTestId('vote-tally').dataset['total']).toBe('5');
      expect(within(removed).getByTestId('removed-build')).toBeTruthy();

      // The others keep exactly their own awards; no Best Build, no speedrun for anyone.
      expect(chipsOf(cardOf('ana'))).toEqual(['style', 'clutch_ship']);
      expect(chipsOf(cardOf('cy'))).toEqual(['rule']);
      expect(chipsOf(document.body)).not.toContain('overall');
      expect(chipsOf(document.body)).not.toContain('speedrun');
    });
  }

  it('a winner that was not removed keeps the banner and the ring', () => {
    const data = removedWinnerBattle();
    data.builds = data.builds.map((b) =>
      b.id === 'mallory' ? { ...b, name: 'Free Gift Card', taken_down: false } : b,
    );
    data.awards = [{ build_id: 'mallory', award: 'overall', source: 'vote', votes: 3 }];
    render(createElement(BattleResults, { data }));
    expect(screen.getAllByTestId('public-winner')).toHaveLength(1);
    expect(cardOf('mallory').dataset['winner']).toBe('true');
    expect(cardOf('mallory').className).toContain('ring-amber');
    expect(chipsOf(cardOf('mallory'))).toEqual(['overall']);
  });

  it('the page title does not name the removed build', () => {
    expect(battleMeta(removedWinnerBattle()).title).toBe('A pomodoro timer · Battle results');
  });
});

describe('the social image of a battle (T-028, T-033; used by T-038)', () => {
  it('a removed top build: the static card, not its screenshot, and nobody else promoted', () => {
    const data = removedWinnerBattle();
    // Even if an older server still sent its screenshot path.
    data.builds = data.builds.map((b) =>
      b.id === 'mallory' ? { ...b, screenshot_path: `${BATTLE}/mallory.webp` } : b,
    );
    const meta = battleMeta(data);
    expect(meta.image).toEqual(STATIC_OG_CARD);
    // Ana (rank 2) has a screenshot: it is not used in the removed winner's place.
    expect(JSON.stringify(meta)).not.toContain('ana.png');
    expect(JSON.stringify(meta)).not.toContain('mallory.webp');
  });

  it('a winner with a screenshot: its public Storage URL', () => {
    const data = removedWinnerBattle();
    data.builds = data.builds.map((b) =>
      b.id === 'mallory'
        ? {
            ...b,
            name: 'Free Gift Card',
            taken_down: false,
            screenshot_path: `${BATTLE}/mallory.webp`,
          }
        : b,
    );
    expect(battleMeta(data)).toEqual({
      title: 'Free Gift Card by Mallory',
      description: 'BUILD: A pomodoro timer · RULE: Only one button · STYLE: Brutalist · 5 min',
      image: {
        url: `http://127.0.0.1:54321/storage/v1/object/public/screenshots/${BATTLE}/mallory.webp`,
        width: 1280,
        height: 800,
        alt: 'Screenshot of Free Gift Card by Mallory',
        type: 'image/webp',
      },
    });
  });
});

describe('battleOgImage', () => {
  const config = { url: 'https://db.example', anonKey: 'k' };
  const battle = (top: Partial<PublicBuild> | null): PublicBattle => {
    const data = removedWinnerBattle();
    data.builds = top
      ? [publicBuild('top', { builder_name: 'Ana', name: 'Pomodoro Pal', ...top })]
      : [];
    return data;
  };

  it('the rank-1 screenshot, typed and sized by how it was taken', () => {
    expect(
      battleOgImage(battle({ screenshot_path: 'b/top.png', capture_status: 'captured' }), config),
    ).toEqual({
      url: 'https://db.example/storage/v1/object/public/screenshots/b/top.png',
      width: 1280,
      height: 800,
      alt: 'Screenshot of Pomodoro Pal by Ana',
      type: 'image/png',
    });
    expect(
      battleOgImage(battle({ screenshot_path: 'b/top.JPG', capture_status: 'fallback' }), config),
    ).toMatchObject({ width: 640, height: 400, type: 'image/jpeg' });
    const unknown = battleOgImage(
      battle({ screenshot_path: 'b/top', capture_status: 'pending', name: null }),
      config,
    );
    expect(unknown).toEqual({
      url: 'https://db.example/storage/v1/object/public/screenshots/b/top',
      alt: 'Screenshot of the top build by Ana',
    });
  });

  it('the static card: no builds, no screenshot, or a removed top build', () => {
    expect(battleOgImage(battle(null), config)).toBe(STATIC_OG_CARD);
    expect(battleOgImage(battle({ screenshot_path: null }), config)).toBe(STATIC_OG_CARD);
    expect(battleOgImage(battle({ screenshot_path: 'b/top.webp', taken_down: true }), config)).toBe(
      STATIC_OG_CARD,
    );
    expect(STATIC_OG_CARD).toMatchObject({ url: '/og-card.png', width: 1200, height: 630 });
  });
});

// ─── /u/[id] ─────────────────────────────────────────────────────────────────────────

function historyBattle(
  id: string,
  patch: Partial<HistoryBattle['build']>,
  awards: HistoryBattle['awards'],
): HistoryBattle {
  return {
    battle_id: id,
    mode: 'multiplayer',
    phase: 'results',
    finished_at: '2026-10-08T12:03:00Z',
    destroyed_at: null,
    display_name: 'Mallory',
    challenge: {
      build: { text: 'A pomodoro timer' },
      rule: { text: 'Only one button' },
      style: { text: 'Brutalist' },
      time_limit_seconds: 300,
    },
    players_count: 3,
    build: {
      id: `build-${id}`,
      name: 'A build',
      status: 'shipped',
      completion_ms: 150_000,
      final_rank: 1,
      total_votes: 5,
      votes: { overall: 3, rule: 1, style: 1, chaos: 0 },
      capture_status: 'captured',
      screenshot_path: null,
      taken_down: false,
      ...patch,
    },
    awards,
  };
}

const REMOVED = 'b0280000-0000-4000-8000-000000000002';
const WON = 'b0280000-0000-4000-8000-000000000003';

function malloryHistory(): PlayerHistoryData & { player: { display_name: string } } {
  return {
    player: { display_name: 'Mallory' },
    battles: [
      // An older server might still send the awards; the page ignores them.
      historyBattle(REMOVED, { name: null, taken_down: true }, [
        { award: 'overall', source: 'vote', votes: 3 },
        { award: 'speedrun', source: 'auto', votes: null },
      ]),
      historyBattle(WON, { name: 'Tick Tock' }, [{ award: 'overall', source: 'vote', votes: 3 }]),
    ],
    next: { before: '2026-10-08T12:00:00+00:00', before_battle: WON },
  };
}

describe('/u/{id}: the shell loads the history in the browser (T-037)', () => {
  it('reads the id and the cursor from the URL; links to the next page and the battles', async () => {
    const fetchMock = stubRpc({ status: 200, body: malloryHistory() });
    const before = '2026-10-09T08:00:00.5+00:00';
    visit(`/u/${MALLORY}?before=${encodeURIComponent(before)}&before_battle=${WON}`);
    render(createElement(PlayerHistoryView));
    expect(screen.getByTestId('player-loading')).toBeTruthy();
    await screen.findByTestId('player-name');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:54321/rest/v1/rpc/get_player_history');
    expect(JSON.parse(init?.body as string)).toEqual({
      p_user_id: MALLORY,
      p_before: before,
      p_before_battle: WON,
      p_limit: 10,
    });
    expect(document.title).toBe("Mallory's battles · Build Roulette");
    expect(screen.getByTestId('history-newest').getAttribute('href')).toBe(`/u/${MALLORY}`);
    const older = new URL(
      screen.getByTestId('history-older').getAttribute('href') ?? '',
      'https://x.example',
    );
    expect(older.searchParams.get('before_battle')).toBe(WON);
    expect(screen.getAllByTestId('history-battle-link').map((a) => a.getAttribute('href'))).toEqual(
      [`/battles/${REMOVED}`, `/battles/${WON}`],
    );
  });

  it('an unknown player and a malformed id: "No battles to show"', async () => {
    const fetchMock = stubRpc({ status: 200, body: { player: null, battles: [], next: null } });
    visit(`/u/${MALLORY}`);
    render(createElement(PlayerHistoryView));
    await screen.findByTestId('player-not-found');
    expect(document.title).toBe('Player not found · Build Roulette');
    cleanup();
    visit('/u/nobody');
    render(createElement(PlayerHistoryView));
    await screen.findByTestId('player-not-found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a server failure is "could not load"', async () => {
    stubRpc({ status: 500, body: { message: 'boom' } });
    visit(`/u/${MALLORY}`);
    render(createElement(PlayerHistoryView));
    await screen.findByTestId('player-load-error');
  });
});

describe('/u/{id} with a removed rank-1 build (T-028)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('rank kept ("#1 of 3"), votes kept; no gold ring, medal or awards', () => {
    render(createElement(PlayerHistory, { id: MALLORY, cursor: null, data: malloryHistory() }));
    const [removed, won] = screen.getAllByTestId('history-battle');
    if (!removed || !won) throw new Error('two battles expected');
    expect(removed.dataset['removed']).toBe('true');
    expect(removed.dataset['rank']).toBe('1');
    expect(removed.dataset['winner']).toBe('false');
    expect(removed.className).not.toContain('ring-amber');
    expect(within(removed).getByTestId('history-rank').textContent).toBe('· #1 of 3');
    expect(within(removed).getByTestId('history-build-name').textContent).toBe(
      'Removed by moderators',
    );
    expect(chipsOf(removed)).toEqual([]);
    expect(within(removed).getByTestId('vote-tally').dataset['total']).toBe('5');

    expect(won.dataset['winner']).toBe('true');
    expect(won.className).toContain('ring-amber');
    expect(within(won).getByTestId('history-rank').textContent).toBe('🥇 #1 of 3');
    expect(chipsOf(won)).toEqual(['overall']);
  });

  it('the description counts only the win that was not removed', () => {
    expect(playerMeta(malloryHistory()).description).toContain('1 win on this page');
  });
});
