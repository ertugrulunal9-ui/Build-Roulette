// @vitest-environment happy-dom
/**
 * The public results surfaces with a build a moderator removed after RESULTS (T-028):
 * /battles/[id] (the page and its social image) and /u/[id]. The removed rank-1 build
 * keeps its place, rank and vote counts, and shows no Winner banner, gold ring, medal or
 * award chips; nobody else becomes the winner or gets its awards. The data is what
 * get_public_battle / get_player_history return (their awards already left out), plus an
 * older server's answer that still carries them.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BattlePage, { generateMetadata as battleMetadata } from '../../app/battles/[id]/page';
import PlayerPage, { generateMetadata as playerMetadata } from '../../app/u/[id]/page';
import type * as HistoryModule from '../../lib/history/player-history';
import type { HistoryBattle, PlayerHistory } from '../../lib/history/player-history';
import { STATIC_OG_CARD, battleOgImage } from '../../lib/solo/og-image';
import type { Award, PublicBattle, PublicBuild } from '../../lib/solo/types';

const mocks = vi.hoisted(() => ({
  getPublicBattle: vi.fn<(id: string) => Promise<PublicBattle | null>>(),
  getPlayerHistory: vi.fn<() => Promise<PlayerHistory | null>>(),
}));

vi.mock('../../lib/solo/public-battle', () => ({
  getPublicBattle: mocks.getPublicBattle,
  fetchPublicBattle: mocks.getPublicBattle,
}));
vi.mock('../../lib/history/player-history', async (importOriginal) => ({
  ...(await importOriginal<typeof HistoryModule>()),
  getPlayerHistory: mocks.getPlayerHistory,
}));
// The viewer's own history link needs a browser session; not part of these pages' data.
vi.mock('./MyHistoryLink', () => ({ MyHistoryLink: () => null }));

const { getPublicBattle, getPlayerHistory } = mocks;

afterEach(cleanup);

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

describe('/battles/[id] with a removed rank-1 build (T-028)', () => {
  beforeEach(() => {
    getPublicBattle.mockReset();
  });

  for (const stale of [false, true]) {
    it(`no Winner banner, gold ring or awards on it; nobody inherits${stale ? ' (an older server still sends its awards)' : ''}`, async () => {
      getPublicBattle.mockResolvedValue(removedWinnerBattle(stale));
      render(await BattlePage({ params: Promise.resolve({ id: BATTLE }) }));

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

  it('a winner that was not removed keeps the banner and the ring', async () => {
    const data = removedWinnerBattle();
    data.builds = data.builds.map((b) =>
      b.id === 'mallory' ? { ...b, name: 'Free Gift Card', taken_down: false } : b,
    );
    data.awards = [{ build_id: 'mallory', award: 'overall', source: 'vote', votes: 3 }];
    getPublicBattle.mockResolvedValue(data);
    render(await BattlePage({ params: Promise.resolve({ id: BATTLE }) }));
    expect(screen.getAllByTestId('public-winner')).toHaveLength(1);
    expect(cardOf('mallory').dataset['winner']).toBe('true');
    expect(cardOf('mallory').className).toContain('ring-amber');
    expect(chipsOf(cardOf('mallory'))).toEqual(['overall']);
  });

  it('the page title does not name the removed build', async () => {
    getPublicBattle.mockResolvedValue(removedWinnerBattle());
    const meta = await battleMetadata({ params: Promise.resolve({ id: BATTLE }) });
    expect(meta.title).toBe('A pomodoro timer · Battle results');
  });
});

describe('the social image of /battles/[id] (T-028, T-033)', () => {
  const images = (meta: Awaited<ReturnType<typeof battleMetadata>>) => ({
    og: meta.openGraph?.images,
    twitter: meta.twitter?.images,
  });

  beforeEach(() => {
    getPublicBattle.mockReset();
  });

  it('a removed top build: the static card, not its screenshot, and nobody else promoted', async () => {
    const data = removedWinnerBattle();
    // Even if an older server still sent its screenshot path.
    data.builds = data.builds.map((b) =>
      b.id === 'mallory' ? { ...b, screenshot_path: `${BATTLE}/mallory.webp` } : b,
    );
    getPublicBattle.mockResolvedValue(data);
    const meta = await battleMetadata({ params: Promise.resolve({ id: BATTLE }) });
    expect(images(meta)).toEqual({ og: [STATIC_OG_CARD], twitter: [STATIC_OG_CARD] });
    // Ana (rank 2) has a screenshot: it is not used in the removed winner's place.
    expect(JSON.stringify(meta)).not.toContain('ana.png');
    expect(JSON.stringify(meta)).not.toContain('mallory.webp');
  });

  it('a winner with a screenshot: its public Storage URL', async () => {
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
    getPublicBattle.mockResolvedValue(data);
    const meta = await battleMetadata({ params: Promise.resolve({ id: BATTLE }) });
    const image = {
      url: `http://127.0.0.1:54321/storage/v1/object/public/screenshots/${BATTLE}/mallory.webp`,
      width: 1280,
      height: 800,
      alt: 'Screenshot of Free Gift Card by Mallory',
      type: 'image/webp',
    };
    expect(images(meta)).toEqual({ og: [image], twitter: [image] });
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

describe('/u/[id] with a removed rank-1 build (T-028)', () => {
  const REMOVED = 'b0280000-0000-4000-8000-000000000002';
  const WON = 'b0280000-0000-4000-8000-000000000003';

  beforeEach(() => {
    getPlayerHistory.mockReset();
    getPlayerHistory.mockResolvedValue({
      player: { display_name: 'Mallory' },
      battles: [
        // An older server might still send the awards; the page ignores them.
        historyBattle(REMOVED, { name: null, taken_down: true }, [
          { award: 'overall', source: 'vote', votes: 3 },
          { award: 'speedrun', source: 'auto', votes: null },
        ]),
        historyBattle(WON, { name: 'Tick Tock' }, [{ award: 'overall', source: 'vote', votes: 3 }]),
      ],
      next: null,
    });
  });

  const props = {
    params: Promise.resolve({ id: MALLORY }),
    searchParams: Promise.resolve({}),
  };

  it('rank kept ("#1 of 3"), votes kept; no gold ring, medal or awards', async () => {
    render(await PlayerPage(props));
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

  it('the description counts only the win that was not removed', async () => {
    const meta = await playerMetadata(props);
    expect(meta.description).toContain('1 win on this page');
  });
});
