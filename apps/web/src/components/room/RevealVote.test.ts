// @vitest-environment happy-dom
/**
 * The REVEAL, VOTE and vote-based RESULTS screens of a room battle, rendered from fixture
 * snapshots: the spotlight and its local skip / frozen fallbacks, the host controls (only
 * for the host), the strip; the VOTE grid (own build not selectable, picks, ballot
 * complete, errors, spectators); the votes and awards in RESULTS. The e2e runs them for
 * real (multiplayer.spec.ts).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialRevealVoteState,
  type RevealVoteController,
  type RevealVoteState,
} from '../../lib/room/reveal-vote';
import { BATTLE_1, BOB, CLEO, ME, battleSnapshot, revealBuilds } from '../../lib/room/test-support';
import { INITIAL_SOLO_STATE, type SoloController, type SoloState } from '../../lib/solo/controller';
import { GameError } from '../../lib/solo/errors';
import type { BattleSnapshot } from '../../lib/solo/types';
import { TOUCH_PRIMARY_QUERY } from '../../lib/device';
import { RevealStage, spotlightView } from './RevealStage';
import { RoomResults, lostVotesText, votedResults } from './RoomResults';
import { VoteStage, ballotNote, buildImage } from './VoteStage';

afterEach(cleanup);

/** Makes `matchMedia(TOUCH_PRIMARY_QUERY)` match (a phone) or not; returns the restore. */
function stubTouchDevice(touch: boolean): () => void {
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query === TOUCH_PRIMARY_QUERY ? touch : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return () => {
    spy.mockRestore();
  };
}

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('missing element');
  return x;
}

function fakeShow() {
  return {
    skip: vi.fn(),
    watch: vi.fn(),
    markFrozen: vi.fn(),
    next: vi.fn(() => Promise.resolve()),
    skipToVote: vi.fn(() => Promise.resolve()),
    dismissHostError: vi.fn(),
    vote: vi.fn(),
    dismissVoteError: vi.fn(),
  };
}

function soloState(snapshot: BattleSnapshot): SoloState {
  return { ...INITIAL_SOLO_STATE, stage: 'battle', battleId: BATTLE_1, snapshot };
}

const battleController = { remainingMs: () => 42_000 } as unknown as SoloController;

function showState(patch: Partial<RevealVoteState> = {}): RevealVoteState {
  return {
    ...initialRevealVoteState(BATTLE_1),
    builds: revealBuilds(),
    thumbs: { 'build-me': 'blob:me', 'build-bob': 'blob:bob', 'build-cleo': null },
    ...patch,
  };
}

function renderReveal(snapshot: BattleSnapshot, state: RevealVoteState, show = fakeShow()) {
  render(
    createElement(RevealStage, {
      battle: battleController,
      battleState: soloState(snapshot),
      show: show as unknown as RevealVoteController,
      showState: state,
      code: 'K7QXM',
      headerActions: null,
    }),
  );
  return show;
}

describe('RevealStage', () => {
  it('the spotlight: Build k of n, name, builder; the strip hides upcoming builds', () => {
    renderReveal(
      battleSnapshot({ phase: 'reveal', revealIndex: 1 }),
      showState({ bundles: { 'build-bob': { status: 'loading', build: null } } }),
    );
    const stage = screen.getByTestId('reveal-stage');
    expect(stage.dataset['index']).toBe('1');
    expect(stage.dataset['build']).toBe('build-bob');
    expect(screen.getByTestId('reveal-position').textContent).toBe('Build 2 of 3');
    expect(screen.getByTestId('reveal-title').textContent).toBe('build-bob app');
    expect(screen.getByTestId('reveal-builder').textContent).toContain('Bob');
    expect(screen.getByTestId('user-build-label')).toBeTruthy();
    expect(screen.getByTestId('build-loading')).toBeTruthy();
    const strip = screen.getAllByTestId('reveal-strip-item');
    expect(strip.map((li) => li.dataset['state'])).toEqual(['revealed', 'current', 'upcoming']);
    // A revealed build shows its thumbnail; an upcoming one does not.
    expect(within(must(strip[0])).getByTestId('strip-thumb').getAttribute('src')).toBe('blob:me');
    expect(within(must(strip[2])).queryByTestId('strip-thumb')).toBeNull();
  });

  it('host controls only for the host; they call reveal_next / skip_to_vote', () => {
    const show = renderReveal(battleSnapshot({ phase: 'reveal' }), showState());
    fireEvent.click(screen.getByTestId('reveal-next'));
    fireEvent.click(screen.getByTestId('skip-to-vote'));
    expect(show.next).toHaveBeenCalledTimes(1);
    expect(show.skipToVote).toHaveBeenCalledTimes(1);
    cleanup();
    renderReveal(battleSnapshot({ phase: 'reveal', hostId: BOB }), showState());
    expect(screen.queryByTestId('reveal-next')).toBeNull();
    expect(screen.getByTestId('reveal-host-note').textContent).toContain('Bob');
  });

  it('a pending host action disables both buttons; an error can be dismissed', () => {
    const show = renderReveal(
      battleSnapshot({ phase: 'reveal' }),
      showState({ host: { pending: 'next', error: null } }),
    );
    expect(screen.getByTestId<HTMLButtonElement>('reveal-next').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('skip-to-vote').disabled).toBe(true);
    cleanup();
    renderReveal(
      battleSnapshot({ phase: 'reveal' }),
      showState({ host: { pending: null, error: new GameError('network') } }),
      show,
    );
    fireEvent.click(within(screen.getByTestId('host-error')).getByText('OK'));
    expect(show.dismissHostError).toHaveBeenCalled();
  });

  it('Skip this build is outside the frame and local; a skipped build shows its thumbnail', () => {
    const show = renderReveal(
      battleSnapshot({ phase: 'reveal', revealIndex: 1 }),
      showState({ bundles: { 'build-bob': { status: 'loading', build: null } } }),
    );
    fireEvent.click(screen.getByTestId('skip-build'));
    expect(show.skip).toHaveBeenCalledWith('build-bob');
    cleanup();
    renderReveal(
      battleSnapshot({ phase: 'reveal', revealIndex: 1 }),
      showState({ skipped: ['build-bob'] }),
      show,
    );
    expect(screen.getByTestId('build-skipped').textContent).toContain('everyone else');
    expect(screen.getByTestId('fallback-thumb').getAttribute('src')).toBe('blob:bob');
    expect(screen.queryByTestId('reveal-live')).toBeNull();
    fireEvent.click(screen.getByTestId('watch-build'));
    expect(show.watch).toHaveBeenCalledWith('build-bob');
  });

  it('a frozen build without a thumbnail: the froze message on a placeholder card', () => {
    renderReveal(
      battleSnapshot({ phase: 'reveal', revealIndex: 2 }),
      showState({ frozen: ['build-cleo'] }),
    );
    expect(screen.getByTestId('build-froze').textContent).toContain('froze');
    expect(within(screen.getByTestId('build-froze')).getByTestId('placeholder-card')).toBeTruthy();
    expect(screen.queryByTestId('reveal-live')).toBeNull();
  });

  it('a build that never started says so, not that it froze', () => {
    renderReveal(
      battleSnapshot({ phase: 'reveal', revealIndex: 1 }),
      showState({ failedToStart: ['build-bob'] }),
    );
    const note = screen.getByTestId('build-no-start');
    expect(note.textContent).toContain('couldn’t start');
    expect(note.textContent).not.toContain('froze');
    expect(screen.queryByTestId('build-froze')).toBeNull();
    expect(screen.getByTestId('watch-build')).toBeTruthy();
  });

  it('spotlightView: local stops first, then the touch still, then the bundle', () => {
    const ready = {
      status: 'ready' as const,
      build: { js: 'x', css: '', importMap: { imports: {} } },
    };
    const base = showState({ bundles: { 'build-bob': ready } });
    const desktop = { stillFirst: false, tapped: [] };
    const phone = { stillFirst: true, tapped: [] };
    expect(spotlightView(base, 'build-bob', desktop)).toBe('live');
    expect(spotlightView(base, 'build-bob', phone)).toBe('still');
    expect(spotlightView(base, 'build-bob', { stillFirst: true, tapped: ['build-bob'] })).toBe(
      'live',
    );
    expect(spotlightView({ ...base, skipped: ['build-bob'] }, 'build-bob', phone)).toBe('skipped');
    expect(spotlightView({ ...base, frozen: ['build-bob'] }, 'build-bob', phone)).toBe('frozen');
    expect(spotlightView({ ...base, failedToStart: ['build-bob'] }, 'build-bob', desktop)).toBe(
      'no_start',
    );
    expect(spotlightView(showState(), 'build-bob', desktop)).toBe('loading');
    expect(
      spotlightView(
        showState({ bundles: { 'build-bob': { status: 'missing', build: null } } }),
        'build-bob',
        desktop,
      ),
    ).toBe('unavailable');
    expect(spotlightView(base, null, desktop)).toBe('loading');
  });

  it('touch devices: the screenshot first; the build runs only after a tap', () => {
    const restore = stubTouchDevice(true);
    try {
      renderReveal(
        battleSnapshot({ phase: 'reveal', revealIndex: 1 }),
        showState({
          bundles: {
            'build-bob': {
              status: 'ready',
              build: { js: 'x', css: '', importMap: { imports: {} } },
            },
          },
        }),
      );
      expect(screen.getByTestId('reveal-stage').dataset['view']).toBe('still');
      expect(
        within(screen.getByTestId('reveal-still'))
          .getByTestId('fallback-thumb')
          .getAttribute('src'),
      ).toBe('blob:bob');
      expect(document.querySelectorAll('iframe')).toHaveLength(0);
      expect(screen.queryByTestId('skip-build')).toBeNull();
      fireEvent.click(screen.getByTestId('tap-to-run'));
      expect(screen.getByTestId('reveal-stage').dataset['view']).toBe('live');
      expect(document.querySelectorAll('iframe[data-testid=reveal-live-frame]')).toHaveLength(1);
      expect(screen.getByTestId('skip-build')).toBeTruthy();
    } finally {
      cleanup();
      restore();
    }
  });

  it('desktop: the spotlight runs live at once; the host bar is fixed only below lg', () => {
    const restore = stubTouchDevice(false);
    try {
      renderReveal(
        battleSnapshot({ phase: 'reveal' }),
        showState({
          bundles: {
            'build-me': {
              status: 'ready',
              build: { js: 'x', css: '', importMap: { imports: {} } },
            },
          },
        }),
      );
      expect(screen.getByTestId('reveal-stage').dataset['view']).toBe('live');
      expect(screen.queryByTestId('tap-to-run')).toBeNull();
      const bar = screen.getByTestId('reveal-host-controls');
      expect(bar.className).toContain('fixed');
      expect(bar.className).toContain('lg:static');
    } finally {
      cleanup();
      restore();
    }
  });

  it('a ready bundle runs in one reveal-mode iframe (no popups, modals or clipboard)', () => {
    renderReveal(
      battleSnapshot({ phase: 'reveal' }),
      showState({
        bundles: {
          'build-me': { status: 'ready', build: { js: 'x', css: '', importMap: { imports: {} } } },
        },
      }),
    );
    const frames = document.querySelectorAll('iframe[data-testid=reveal-live-frame]');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
    );
    expect(frames[0]?.getAttribute('allow')).toBe('autoplay; fullscreen; gamepad');
    cleanup();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });
});

// ─── VOTE ─────────────────────────────────────────────────────────────────────────────

function renderVote(snapshot: BattleSnapshot, state: RevealVoteState, show = fakeShow()) {
  render(
    createElement(VoteStage, {
      battle: battleController,
      battleState: soloState(snapshot),
      show: show as unknown as RevealVoteController,
      showState: state,
      code: 'K7QXM',
      headerActions: null,
    }),
  );
  return show;
}

const ballot = (patch: Partial<RevealVoteState['ballot']>): RevealVoteState['ballot'] => ({
  ...initialRevealVoteState(BATTLE_1).ballot,
  loaded: true,
  ...patch,
});

describe('VoteStage', () => {
  it('a grid per category; the own build is shown but not selectable', () => {
    const show = renderVote(battleSnapshot({ phase: 'voting' }), showState());
    const categories = screen.getAllByTestId('vote-category');
    expect(categories.map((c) => c.dataset['category'])).toEqual([
      'overall',
      'rule',
      'style',
      'chaos',
    ]);
    const overall = must(categories[0]);
    const options = within(overall).getAllByTestId('vote-option');
    expect(options.map((o) => [o.dataset['build'], o.tagName, o.dataset['own']])).toEqual([
      ['build-me', 'DIV', 'true'],
      ['build-bob', 'BUTTON', 'false'],
      ['build-cleo', 'BUTTON', 'false'],
    ]);
    expect(within(overall).getByTestId('own-build-badge')).toBeTruthy();
    fireEvent.click(must(options[1]));
    expect(show.vote).toHaveBeenCalledWith('overall', 'build-bob');
    expect(screen.getByTestId('vote-progress').textContent).toContain('0/3 voted');
    expect(screen.queryByTestId('ballot-complete')).toBeNull();
  });

  it('confirmed picks, a pending pick, ballot complete', () => {
    renderVote(
      battleSnapshot({ phase: 'voting', voteProgress: { voted_count: 2, eligible_count: 3 } }),
      showState({
        ballot: ballot({
          votes: {
            overall: 'build-bob',
            rule: 'build-cleo',
            style: 'build-bob',
            chaos: 'build-bob',
          },
          pending: { rule: 'build-bob' },
          complete: true,
        }),
      }),
    );
    const option = (cat: string, id: string) =>
      must(
        within(
          must(screen.getAllByTestId('vote-category').find((c) => c.dataset['category'] === cat)),
        )
          .getAllByTestId('vote-option')
          .find((o) => o.dataset['build'] === id),
      );
    expect(option('overall', 'build-bob').dataset['selected']).toBe('true');
    expect(option('overall', 'build-bob').getAttribute('aria-pressed')).toBe('true');
    // The rule pick is being changed: not confirmed yet.
    expect(option('rule', 'build-cleo').dataset['selected']).toBe('false');
    expect(option('rule', 'build-bob').textContent).toContain('Saving…');
    expect(screen.getByTestId('ballot-complete').textContent).toContain('2/3 voted');
  });

  it('offline picks say "not saved yet" (a banner and the card), not a plain error', () => {
    renderVote(
      battleSnapshot({ phase: 'voting' }),
      showState({
        ballot: ballot({
          votes: { overall: 'build-cleo' },
          unsent: { overall: 'build-bob' },
          errors: { overall: new GameError('network') },
        }),
      }),
    );
    expect(screen.getByTestId('votes-unsent').textContent).toContain('Not saved yet');
    const overall = must(
      screen.getAllByTestId('vote-category').find((c) => c.dataset['category'] === 'overall'),
    );
    expect(overall.dataset['state']).toBe('unsent');
    expect(within(overall).getByTestId('category-status').textContent).toContain('retrying');
    const bob = must(
      within(overall)
        .getAllByTestId('vote-option')
        .find((o) => o.dataset['build'] === 'build-bob'),
    );
    expect(bob.dataset['unsent']).toBe('true');
    expect(bob.dataset['selected']).toBe('false');
    expect(bob.textContent).toContain('Not saved yet');
    // The network error itself is not repeated under the category.
    expect(within(overall).queryByTestId('vote-error')).toBeNull();
  });

  it('every vote error has its own message and can be dismissed', () => {
    const show = renderVote(
      battleSnapshot({ phase: 'voting' }),
      showState({ ballot: ballot({ errors: { style: new GameError('self_vote') } }) }),
    );
    const error = screen.getByTestId('vote-error');
    expect(error.dataset['code']).toBe('self_vote');
    expect(error.textContent).toContain('cannot vote for your own build');
    fireEvent.click(within(error).getByText('OK'));
    expect(show.dismissVoteError).toHaveBeenCalledWith('style');
  });

  it('spectators see the progress but no ballot', () => {
    renderVote(battleSnapshot({ phase: 'voting', role: 'spectator' }), showState());
    expect(screen.getByTestId('vote-stage').dataset['canVote']).toBe('false');
    expect(screen.getByTestId('vote-spectator-note').textContent).toContain('only the players');
    expect(document.querySelectorAll('button[data-testid=vote-option]')).toHaveLength(0);
    expect(screen.getByTestId('vote-progress').dataset['eligible']).toBe('3');
  });

  it('buildImage: the screenshot first, then the thumbnail, else nothing', () => {
    const snap = battleSnapshot({ phase: 'voting' });
    const build = snap.builds[1];
    if (!build) throw new Error('fixture');
    expect(buildImage(build, 'blob:t')).toBe('blob:t');
    expect(buildImage(build, null)).toBeNull();
    build.capture_status = 'captured';
    build.screenshot_path = `${BATTLE_1}/build-bob.webp`;
    expect(buildImage(build, 'blob:t')).toMatch(/\/storage\/v1\/object\/public\/screenshots\//);
    build.capture_status = 'failed';
    expect(buildImage(build, 'blob:t')).toBe('blob:t');
  });

  it('ballotNote explains why there is no ballot', () => {
    expect(ballotNote(battleSnapshot({ phase: 'voting' }))).toBeNull();
    expect(ballotNote(battleSnapshot({ phase: 'voting', role: 'spectator' }))).toContain(
      'only the players',
    );
    const left = battleSnapshot({ phase: 'voting' });
    left.me.can_vote = false;
    left.players = left.players.map((p) => (p.user_id === ME ? { ...p, state: 'left' } : p));
    expect(ballotNote(left)).toContain('You left the room');
    const notVoter = battleSnapshot({ phase: 'voting' });
    notVoter.me.can_vote = false;
    notVoter.me.is_voter = false;
    expect(ballotNote(notVoter)).toBe('You cannot vote in this battle.');
  });
});

// ─── RESULTS ──────────────────────────────────────────────────────────────────────────

function votedResultsSnapshot(): BattleSnapshot {
  const snap = battleSnapshot({
    phase: 'results',
    revealOrder: ['build-me', 'build-bob', 'build-cleo'],
  });
  const votes: Record<string, [Record<string, number>, number, number]> = {
    'build-bob': [{ overall: 1, rule: 2, style: 1, chaos: 2 }, 6, 1],
    'build-me': [{ overall: 1, rule: 1, style: 0, chaos: 1 }, 3, 2],
    'build-cleo': [{ overall: 1, rule: 0, style: 2, chaos: 0 }, 3, 3],
  };
  snap.builds = snap.builds.map((b) => {
    const [v, total, rank] = votes[b.id] ?? [{}, 0, null];
    return { ...b, votes: v, total_votes: total, final_rank: rank };
  });
  // One winner per category (T-022): the three-way Best Build tie (1–1–1) goes to Bob, who
  // has the most votes in all (6 vs 3 and 3).
  snap.awards = [
    { build_id: 'build-bob', award: 'fastest_ship', source: 'auto', votes: null },
    { build_id: 'build-bob', award: 'chaos', source: 'vote', votes: 2 },
    { build_id: 'build-bob', award: 'overall', source: 'vote', votes: 1 },
    { build_id: 'build-bob', award: 'rule', source: 'vote', votes: 2 },
    { build_id: 'build-me', award: 'speedrun', source: 'auto', votes: null },
    { build_id: 'build-cleo', award: 'style', source: 'vote', votes: 2 },
  ];
  return snap;
}

describe('RoomResults with votes', () => {
  it('votes per category, category awards first, the winner highlighted', () => {
    const snap = votedResultsSnapshot();
    expect(votedResults(snap)).toBe(true);
    render(createElement(RoomResults, { state: soloState(snap), remaining: 30_000 }));
    const rows = screen.getAllByTestId('ranked-build');
    expect(rows.map((r) => r.dataset['builder'])).toEqual([BOB, ME, CLEO]);
    expect(rows.map((r) => r.dataset['winner'])).toEqual(['true', 'false', 'false']);
    expect(screen.getAllByTestId('winner-banner')).toHaveLength(1);
    const bob = must(rows[0]);
    expect(
      within(bob)
        .getAllByTestId('vote-count')
        .map((c) => [c.dataset['category'], c.dataset['count']]),
    ).toEqual([
      ['overall', '1'],
      ['rule', '2'],
      ['style', '1'],
      ['chaos', '2'],
    ]);
    expect(within(bob).getByTestId('vote-tally').dataset['total']).toBe('6');
    expect(within(bob).getAllByTestId('award')[1]?.textContent).toContain('Best Use of the Rule');
    expect(within(bob).getAllByTestId('award')[1]?.textContent).toContain('2 votes');
    // Vote awards come first, in category order, then the auto-awards.
    expect(
      within(bob)
        .getAllByTestId('award')
        .map((a) => a.dataset['award']),
    ).toEqual(['overall', 'rule', 'chaos', 'fastest_ship']);
    expect(
      within(must(rows[1]))
        .getAllByTestId('award')
        .map((a) => a.dataset['award']),
    ).toEqual(['speedrun']);
    expect(
      screen.getAllByTestId('award').filter((a) => a.dataset['award'] === 'overall'),
    ).toHaveLength(1);
    expect(screen.getByTestId('ranking-rule').textContent).toContain('Ranked by votes');
    expect(screen.getByTestId('ranking-rule').textContent).toContain(
      'one winner: a tie goes to more votes in all, then the earlier ship',
    );
  });

  it('a battle without votes keeps the M3 ranking text and no tallies', () => {
    const snap = battleSnapshot({ phase: 'results' });
    expect(votedResults(snap)).toBe(false);
    render(createElement(RoomResults, { state: soloState(snap), remaining: 30_000 }));
    expect(screen.queryAllByTestId('vote-tally')).toHaveLength(0);
    expect(screen.getByTestId('ranking-rule').textContent).toContain('completion time');
  });

  it('picks that never reached the server are reported, not hidden', () => {
    const snap = votedResultsSnapshot();
    render(
      createElement(RoomResults, {
        state: soloState(snap),
        remaining: 30_000,
        lostVotes: { overall: 'build-bob', chaos: 'build-cleo' },
      }),
    );
    const note = screen.getByTestId('lost-votes').textContent;
    expect(note).toContain('Not counted');
    expect(note).toContain('Best Build');
    expect(note).toContain('Most Chaotic');
    expect(lostVotesText(snap, {})).toBeNull();
    expect(lostVotesText(snap, undefined)).toBeNull();
    cleanup();
    render(createElement(RoomResults, { state: soloState(snap), remaining: 30_000 }));
    expect(screen.queryByTestId('lost-votes')).toBeNull();
    // Every player name links to their history (a new tab: the room keeps running).
    const links = screen.getAllByTestId('player-history-link');
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual(
      [`/u/${BOB}`, `/u/${CLEO}`, `/u/${ME}`].sort(),
    );
    expect(links[0]?.getAttribute('target')).toBe('_blank');
  });
});
