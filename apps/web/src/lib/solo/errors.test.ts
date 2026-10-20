import { describe, expect, it } from 'vitest';
import { CAST_VOTE_ERRORS } from '@br/game';
import {
  CLIENT_ERROR_CODES,
  GameError,
  RPC_ERROR_CODES,
  describeError,
  describeVoteError,
  toGameError,
  type ErrorCode,
} from './errors';
import { awardInfo, isVoteAward } from './format';
import { randomDisplayName, suggestBuildName } from './names';
import { siteStats, statsPhrases } from './stats';
import { fakeSite } from './test-support';
import type { BuildStats } from './types';

describe('toGameError: the T-011 error contract', () => {
  it.each(RPC_ERROR_CODES)('maps a PostgREST error with message %s', (code) => {
    const e = toGameError({ message: code, details: 'human text', hint: null, code: 'P0001' });
    expect(e).toBeInstanceOf(GameError);
    expect(e.code).toBe(code);
    expect(e.details).toBe('human text');
  });

  it('keeps the running battle id of battle_in_progress', () => {
    const e = toGameError({ message: 'battle_in_progress', details: 'b-123', code: 'P0001' });
    expect(e.details).toBe('b-123');
  });

  it('maps storage refusals, size limits and network failures', () => {
    expect(
      toGameError({ message: 'new row violates row-level security policy', statusCode: '403' })
        .code,
    ).toBe('upload_refused');
    expect(toGameError({ message: 'The object exceeded the maximum allowed size' }).code).toBe(
      'file_too_large',
    );
    expect(toGameError({ message: 'Payload too large', statusCode: '413' }).code).toBe(
      'file_too_large',
    );
    expect(toGameError(new TypeError('Failed to fetch')).code).toBe('network');
    expect(toGameError({ message: 'TypeError: NetworkError when attempting to fetch' }).code).toBe(
      'network',
    );
    expect(toGameError({ message: 'Request rate limit reached', status: 429 }).code).toBe(
      'rate_limited',
    );
    expect(toGameError('weird').code).toBe('unknown');
    const g = new GameError('deck_empty');
    expect(toGameError(g)).toBe(g);
  });

  it('every code has a player-facing message', () => {
    const all: ErrorCode[] = [...RPC_ERROR_CODES, ...CLIENT_ERROR_CODES];
    for (const code of all) {
      const text = describeError(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain('_'); // no raw codes
    }
    expect(describeError(new GameError('deadline_passed'))).toMatch(/Time is up/);
  });

  it('rate_limited says how long to wait when the server says it (T-024)', () => {
    const limited = toGameError({
      message: 'rate_limited',
      details: 'You sent too many reports recently. Try again in 9 minutes.',
      hint: '{"retry_after_s": 500}',
      code: 'PT429',
    });
    expect(describeError(limited)).toBe(
      'You sent too many reports recently. Try again in 9 minutes.',
    );
    // An HTTP 429 from elsewhere (Auth sign-ups) keeps the generic sentence.
    expect(describeError(toGameError({ message: 'Request rate limit reached', status: 429 }))).toBe(
      describeError('rate_limited'),
    );
    expect(describeError('name_not_allowed')).toMatch(/not allowed/);
  });

  it('every cast_vote code has its own VOTE message; others fall back to describeError', () => {
    const texts = CAST_VOTE_ERRORS.map((code) => describeVoteError(code));
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain('_');
    }
    expect(new Set(texts).size).toBe(texts.length);
    expect(describeVoteError(new GameError('wrong_phase'))).toMatch(/Voting is over/);
    expect(describeVoteError('network')).toBe(describeError('network'));
  });
});

describe('award labels', () => {
  it('vote categories have their labels and icons; auto-awards stay as they were', () => {
    expect(awardInfo('overall')).toMatchObject({ emoji: '🏆', title: 'Best Build' });
    expect(awardInfo('rule').title).toBe('Best Use of the Rule');
    expect(awardInfo('style')).toMatchObject({ emoji: '🎨', title: 'Best Style' });
    expect(awardInfo('chaos')).toMatchObject({ emoji: '🌀', title: 'Most Chaotic' });
    expect(awardInfo('speedrun').title).toBe('Speedrun');
    expect(awardInfo('something_new').title).toBe('something new');
    expect(['overall', 'rule', 'style', 'chaos'].every(isVoteAward)).toBe(true);
    expect(isVoteAward('fastest_ship')).toBe(false);
  });
});

describe('names', () => {
  it('random display names fit the 24-character limit', () => {
    for (let i = 0; i < 50; i++) {
      const name = randomDisplayName();
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(24);
    }
    expect(randomDisplayName(() => 0)).toBe('Turbo Otter');
  });

  it('suggests a build name from the BUILD card', () => {
    expect(suggestBuildName('A pomodoro timer', () => 0)).toBe('Pomodoro timer 3000');
    expect(suggestBuildName('!!!', () => 0)).toBe('My Build 3000');
    expect(suggestBuildName('x'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe('stats', () => {
  it('an import reports its files, the pack size and the number of imports', () => {
    const site = fakeSite('Stats', { 'assets/app.js': 'x' });
    expect(siteStats(site, 3)).toEqual({
      files: 2,
      bundle_bytes: site.pack.byteLength,
      imports: 3,
    });
    // At least the import being shipped.
    expect(siteStats(site, 0).imports).toBe(1);
  });

  it('shows what a row has: import stats, or an editor build from before M6, or nothing', () => {
    expect(statsPhrases({ files: 12, bundle_bytes: 340 * 1024, imports: 3 })).toEqual([
      '12 files',
      '340 KB',
      'imported 3 times',
    ]);
    expect(statsPhrases({ files: 1, bundle_bytes: 2_500_000, imports: 1 })).toEqual([
      '1 file',
      '2.4 MB',
      'imported once',
    ]);
    expect(
      statsPhrases({ files: 4, lines: 120, deps: ['react', 'three'], rebuilds: 9, pastes: 1 }),
    ).toEqual(['4 files', '120 lines', 'made with react, three']);
    expect(statsPhrases({ files: 3, lines: 1 })).toEqual(['3 files', '1 line']);
    expect(statsPhrases({})).toEqual([]);
    expect(statsPhrases(null)).toEqual([]);
    // Junk from an old or hostile row is left out, never shown or thrown.
    expect(
      statsPhrases({ files: -1, bundle_bytes: Number.NaN, deps: 'x' } as unknown as BuildStats),
    ).toEqual([]);
  });
});
