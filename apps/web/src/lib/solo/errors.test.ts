import { createWorkspace } from '@br/workspace';
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
import { buildStats, sourceJson } from './stats';

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
  it('counts files, lines, deps and bundle bytes', () => {
    const ws = createWorkspace();
    ws.files['src/logo.png'] = 'data:image/png;base64,AAAA';
    const stats = buildStats(ws, { js: 'é', css: 'ab' }, { rebuilds: 3.7, pastes: -1 });
    expect(stats).toMatchObject({
      files: 4,
      deps: ['react', 'react-dom'],
      bundle_bytes: 4, // é is 2 bytes in UTF-8
      rebuilds: 3,
      pastes: 0,
    });
    const lines = ['src/main.tsx', 'src/App.tsx', 'src/styles.css']
      .map((p) => (ws.files[p] ?? '').trimEnd().split('\n').length)
      .reduce((a, b) => a + b, 0);
    expect(stats.lines).toBe(lines);
  });

  it('source.json holds the files and the manifest', () => {
    const ws = createWorkspace('vanilla-ts');
    expect(JSON.parse(sourceJson(ws))).toEqual({ files: ws.files, manifest: ws.manifest });
  });
});
