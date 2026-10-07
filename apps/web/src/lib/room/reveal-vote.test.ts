/**
 * REVEAL and VOTING on the client: the untrusted manifest, the spotlight's files and the
 * prefetch, thumbnails, local skip / freeze, the host's compare-and-set controls (stale
 * calls are quiet), and the ballot (restore, revotes, one request per category, errors).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameError } from '../solo/errors';
import type { BattleSnapshot } from '../solo/types';
import {
  MAX_MANIFEST_BYTES,
  parseRevealManifest,
  revealImportMap,
  revealPreviewBuild,
} from './reveal-files';
import { RevealVoteController, spotlightBuild, type ObjectUrls } from './reveal-vote';
import {
  BATTLE_1,
  BOB,
  FakeRoomApi,
  ME,
  battleSnapshot,
  revealBuilds,
  storeRevealObjects,
} from './test-support';

const CDN = 'https://pkg.example';

describe('reveal files: the manifest is untrusted', () => {
  it('reads pinned dependencies and ignores everything else', () => {
    expect(parseRevealManifest('{"dependencies":{"react":"19.2.0","zustand":"4.5.2"}}')).toEqual({
      react: '19.2.0',
      zustand: '4.5.2',
    });
    expect(parseRevealManifest('{"dependencies":{"react":19,"x":null,"y":"1.0.0"}}')).toEqual({
      y: '1.0.0',
    });
    for (const bad of [
      null,
      'not json',
      '[]',
      '"str"',
      '{"dependencies":[]}',
      '{"dependencies":"react"}',
      '{}',
      'x'.repeat(MAX_MANIFEST_BYTES + 1),
    ]) {
      expect(parseRevealManifest(bad)).toEqual({});
    }
  });

  it('maps only exact React pins to the CDN; a hostile manifest gives an empty map', () => {
    const map = revealImportMap('{"dependencies":{"react":"19.2.0","react-dom":"19.2.0"}}', CDN);
    expect(map.imports['react']).toBe(`${CDN}/react@19.2.0`);
    expect(map.imports['react-dom/client']).toMatch(/^https:\/\/pkg\.example\/react-dom@19\.2\.0/);
    // Ranges, URLs, path tricks: nothing.
    for (const version of ['^19.0.0', 'https://evil.example/react.js', '../../x', 'latest']) {
      expect(
        revealImportMap(JSON.stringify({ dependencies: { react: version } }), CDN).imports,
      ).toEqual({});
    }
  });

  it('a build without a bundle has no preview; css and manifest are optional', () => {
    expect(revealPreviewBuild({ js: null, css: 'a{}', manifest: null }, CDN)).toBeNull();
    expect(revealPreviewBuild({ js: 'x()', css: null, manifest: null }, CDN)).toEqual({
      js: 'x()',
      css: '',
      importMap: { imports: {} },
    });
  });
});

// ─── The controller ───────────────────────────────────────────────────────────────────

let api: FakeRoomApi;
let refetches: number;
let urls: ObjectUrls & { created: string[]; revoked: string[] };

function controller(): RevealVoteController {
  return new RevealVoteController(BATTLE_1, {
    api,
    cdnBaseUrl: CDN,
    refetch: () => {
      refetches++;
      return Promise.resolve();
    },
    objectUrls: urls,
    retryMs: 1_000,
  });
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') });
  api = new FakeRoomApi();
  storeRevealObjects(api);
  refetches = 0;
  let n = 0;
  urls = {
    created: [],
    revoked: [],
    create() {
      const url = `blob:thumb-${String(++n)}`;
      this.created.push(url);
      return url;
    },
    revoke(url) {
      this.revoked.push(url);
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
});

const reveal = (index: number, version = 10 + index): BattleSnapshot =>
  battleSnapshot({ phase: 'reveal', revealIndex: index, version, endsInMs: 60_000 });

describe('REVEAL', () => {
  it('loads the reveal list, the spotlighted build and prefetches the next one', async () => {
    const c = controller();
    c.receive(reveal(0));
    await flush();
    const s = c.getSnapshot();
    expect(s.builds?.map((b) => b.build_id)).toEqual(['build-me', 'build-bob', 'build-cleo']);
    expect(Object.keys(s.bundles).sort()).toEqual(['build-bob', 'build-me']);
    const me = s.bundles['build-me'];
    expect(me?.status).toBe('ready');
    expect(me?.build?.js).toBe('console.log("build-me")');
    expect(me?.build?.css).toBe('.build-me{}');
    expect(me?.build?.importMap.imports['react']).toBe(`${CDN}/react@19.2.0`);
    // Only these objects: never source.json.
    const read = api.calls.filter((x) => x[0] === 'downloadText').map((x) => String(x[1]));
    expect(read.every((p) => /\/(bundle\.js|bundle\.css|manifest\.json)$/.test(p))).toBe(true);
    expect(spotlightBuild(reveal(0), s.builds)?.build_id).toBe('build-me');
    c.dispose();
  });

  it('moving the spotlight keeps the prefetched bundle, drops the old one, fetches the next', async () => {
    const c = controller();
    c.receive(reveal(0));
    await flush();
    const bobBundle = c.getSnapshot().bundles['build-bob'];
    api.clearCalls();
    c.receive(reveal(1));
    await flush();
    const s = c.getSnapshot();
    expect(Object.keys(s.bundles).sort()).toEqual(['build-bob', 'build-cleo']);
    expect(s.bundles['build-bob']).toBe(bobBundle); // no second download
    expect(api.calls.filter((x) => x[0] === 'downloadText').map((x) => x[1])).toEqual([
      `${BATTLE_1}/${revealBuilds()[2]?.builder_id ?? ''}/bundle.js`,
      `${BATTLE_1}/${revealBuilds()[2]?.builder_id ?? ''}/bundle.css`,
      `${BATTLE_1}/${revealBuilds()[2]?.builder_id ?? ''}/manifest.json`,
    ]);
    expect(api.count('getRevealBuilds')).toBe(0);
    c.dispose();
  });

  it('a missing bundle or a failed download is a state, not a throw', async () => {
    api.objects.delete(api.revealBuilds[0]?.files.js ?? '');
    const failing = api.revealBuilds[1]?.files.css ?? '';
    const download = api.downloadText.bind(api);
    api.downloadText = (path) =>
      path === failing ? Promise.reject(new TypeError('Failed to fetch')) : download(path);
    const c = controller();
    c.receive(reveal(0));
    await flush();
    expect(c.getSnapshot().bundles['build-me']?.status).toBe('missing');
    const bob = c.getSnapshot().bundles['build-bob'];
    expect(bob?.status).toBe('error');
    c.dispose();
  });

  it('thumbnails: object URLs for builds that have one, placeholders otherwise; revoked at DESTROY', async () => {
    const c = controller();
    c.receive(reveal(0));
    await flush();
    expect(c.getSnapshot().thumbs).toEqual({
      'build-me': 'blob:thumb-1',
      'build-bob': 'blob:thumb-2',
      'build-cleo': null,
    });
    c.receive(battleSnapshot({ phase: 'destroyed', revealOrder: ['build-me'], version: 40 }));
    expect(urls.revoked.sort()).toEqual(['blob:thumb-1', 'blob:thumb-2']);
    expect(c.getSnapshot()).toMatchObject({ thumbs: {}, bundles: {} });
    c.dispose();
  });

  it('get_reveal_builds is retried until it answers', async () => {
    let fail = true;
    api.onRevealBuilds = () => {
      if (fail) throw new TypeError('Failed to fetch');
      return revealBuilds();
    };
    const c = controller();
    c.receive(reveal(0));
    await flush();
    expect(c.getSnapshot().buildsError?.code).toBe('network');
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.getSnapshot().builds).toHaveLength(3);
    expect(c.getSnapshot().buildsError).toBeNull();
    c.dispose();
  });

  it('skip and freeze are local; watching again clears both', async () => {
    const c = controller();
    c.receive(reveal(1));
    await flush();
    c.skip('build-bob');
    c.skip('build-bob');
    expect(c.getSnapshot().skipped).toEqual(['build-bob']);
    c.markFrozen('build-cleo');
    expect(c.getSnapshot().frozen).toEqual(['build-cleo']);
    // A build that never started is not "frozen".
    c.markFrozen('build-me', 'handshake-timeout');
    expect(c.getSnapshot()).toMatchObject({ frozen: ['build-cleo'], failedToStart: ['build-me'] });
    c.watch('build-bob');
    c.watch('build-cleo');
    c.watch('build-me');
    expect(c.getSnapshot()).toMatchObject({ skipped: [], frozen: [], failedToStart: [] });
    // Nothing went to the server.
    expect(
      api.calls.filter((x) => !['getRevealBuilds', 'downloadText', 'downloadBlob'].includes(x[0])),
    ).toEqual([]);
    c.dispose();
  });

  it('VOTING drops the bundles (no build runs any more)', async () => {
    const c = controller();
    c.receive(reveal(2));
    await flush();
    expect(Object.keys(c.getSnapshot().bundles)).toEqual(['build-cleo']);
    c.receive(battleSnapshot({ phase: 'voting', version: 20 }));
    await flush();
    expect(c.getSnapshot().bundles).toEqual({});
    c.dispose();
  });
});

describe('host controls', () => {
  it('reveal_next and skip_to_vote send the snapshot version (compare-and-set)', async () => {
    const c = controller();
    c.receive(reveal(0, 12));
    await c.next();
    expect(api.calls.find((x) => x[0] === 'revealNext')).toEqual(['revealNext', BATTLE_1, 12]);
    await c.skipToVote();
    expect(api.calls.find((x) => x[0] === 'skipToVote')).toEqual(['skipToVote', BATTLE_1, 12]);
    expect(c.getSnapshot().host).toEqual({ pending: null, error: null });
    c.dispose();
  });

  it('a double click sends once; a stale call is a quiet no-op that refetches', async () => {
    api.onHost = (_k, v) => ({
      changed: false,
      version: v + 3,
      phase: 'reveal',
      phase_ends_at: null,
      reveal_index: 2,
    });
    const c = controller();
    c.receive(reveal(0));
    const first = c.next();
    void c.next();
    expect(c.getSnapshot().host.pending).toBe('next');
    await first;
    expect(api.count('revealNext')).toBe(1);
    expect(c.getSnapshot().host).toEqual({ pending: null, error: null });
    expect(refetches).toBe(1);
    c.dispose();
  });

  it('not_host (the crown moved) and wrong_phase are quiet; a network failure is shown', async () => {
    const c = controller();
    c.receive(reveal(0));
    for (const code of ['not_host', 'wrong_phase', 'invalid_version'] as const) {
      api.onHost = () => {
        throw new GameError(code);
      };
      await c.next();
      expect(c.getSnapshot().host.error).toBeNull();
    }
    expect(refetches).toBe(3);
    api.onHost = () => {
      throw new TypeError('Failed to fetch');
    };
    await c.skipToVote();
    expect(c.getSnapshot().host.error?.code).toBe('network');
    c.dismissHostError();
    expect(c.getSnapshot().host.error).toBeNull();
    c.dispose();
  });

  it('only the host, and only during REVEAL', async () => {
    const c = controller();
    c.receive(battleSnapshot({ phase: 'reveal', hostId: BOB, version: 10 }));
    await c.next();
    c.receive(battleSnapshot({ phase: 'voting', version: 20 }));
    await c.skipToVote();
    expect(api.count('revealNext') + api.count('skipToVote')).toBe(0);
    c.dispose();
  });
});

describe('ballot', () => {
  const voting = (extra: Parameters<typeof battleSnapshot>[0] = {}) =>
    battleSnapshot({ phase: 'voting', version: 20, ...extra });

  it('restores the ballot with get_my_votes (after a refresh too)', async () => {
    api.ballot = { overall: 'build-bob', rule: 'build-cleo' };
    const c = controller();
    c.receive(voting());
    await flush();
    expect(c.getSnapshot().ballot).toMatchObject({
      votes: { overall: 'build-bob', rule: 'build-cleo' },
      complete: false,
      loaded: true,
    });
    // Once.
    c.receive(voting({ version: 21 }));
    await flush();
    expect(api.count('getMyVotes')).toBe(1);
    c.dispose();
  });

  it('spectators do not load a ballot and cannot vote', async () => {
    const c = controller();
    c.receive(voting({ role: 'spectator' }));
    await flush();
    c.vote('overall', 'build-bob');
    await flush();
    expect(api.count('getMyVotes') + api.count('castVote')).toBe(0);
    c.dispose();
  });

  it('votes, revotes, completes the ballot; never for the own build', async () => {
    const c = controller();
    c.receive(voting());
    await flush();
    c.vote('overall', 'build-me'); // own build: not even sent
    expect(api.count('castVote')).toBe(0);
    c.vote('overall', 'build-bob');
    expect(c.getSnapshot().ballot.pending).toEqual({ overall: 'build-bob' });
    await flush();
    expect(c.getSnapshot().ballot.votes).toEqual({ overall: 'build-bob' });
    c.vote('overall', 'build-cleo'); // revote
    await flush();
    expect(c.getSnapshot().ballot.votes['overall']).toBe('build-cleo');
    c.vote('overall', 'build-cleo'); // same choice: nothing to send
    for (const cat of ['rule', 'style', 'chaos']) c.vote(cat, 'build-bob');
    await flush();
    expect(c.getSnapshot().ballot).toMatchObject({ complete: true, pending: {} });
    expect(api.calls.filter((x) => x[0] === 'castVote').map((x) => x.slice(1))).toEqual([
      ['overall', 'build-bob'],
      ['overall', 'build-cleo'],
      ['rule', 'build-bob'],
      ['style', 'build-bob'],
      ['chaos', 'build-bob'],
    ]);
    c.dispose();
  });

  it('one request per category at a time: the latest click goes next', async () => {
    let release: (() => void) | null = null;
    const vote = api.onVote;
    api.onVote = async (cat, id) => {
      if (id === 'build-bob') {
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return vote(cat, id);
    };
    const c = controller();
    c.receive(voting());
    await flush();
    c.vote('overall', 'build-bob');
    c.vote('overall', 'build-cleo');
    c.vote('overall', 'build-bob');
    c.vote('overall', 'build-cleo');
    expect(c.getSnapshot().ballot.pending).toEqual({ overall: 'build-cleo' });
    expect(api.count('castVote')).toBe(1);
    (release as (() => void) | null)?.();
    await flush();
    expect(api.calls.filter((x) => x[0] === 'castVote').map((x) => x[2])).toEqual([
      'build-bob',
      'build-cleo',
    ]);
    expect(c.getSnapshot().ballot).toMatchObject({ votes: { overall: 'build-cleo' }, pending: {} });
    c.dispose();
  });

  it('keeps every refusal per category; a closed vote refetches', async () => {
    const c = controller();
    c.receive(voting());
    await flush();
    api.onVote = () => {
      throw new GameError('not_votable');
    };
    c.vote('rule', 'build-bob');
    await flush();
    expect(c.getSnapshot().ballot.errors['rule']?.code).toBe('not_votable');
    expect(refetches).toBe(0);
    api.onVote = () => {
      throw new GameError('deadline_passed');
    };
    c.vote('style', 'build-bob');
    await flush();
    expect(c.getSnapshot().ballot.errors['style']?.code).toBe('deadline_passed');
    expect(refetches).toBe(1);
    // A new attempt in a category clears its error.
    api.onVote = (cat, id) => ({
      category: cat,
      build_id: id,
      ballot_complete: false,
      battle: { version: 30, phase: 'voting', phase_ends_at: null },
    });
    c.vote('rule', 'build-cleo');
    expect(c.getSnapshot().ballot.errors['rule']).toBeUndefined();
    c.dismissVoteError('style');
    expect(c.getSnapshot().ballot.errors).toEqual({});
    c.dispose();
  });

  it('rapid clicks on two builds end with the last one, whatever the order of the answers', async () => {
    // Every request answers after a random delay; clicks alternate between two builds.
    const vote = api.onVote;
    const delays = [40, 5, 30, 1, 25, 10, 50, 2];
    let call = 0;
    api.onVote = async (cat, id) => {
      await new Promise((r) => setTimeout(r, delays[call++ % delays.length]));
      return vote(cat, id);
    };
    const c = controller();
    c.receive(voting());
    await flush();
    const clicks = ['build-bob', 'build-cleo', 'build-bob', 'build-cleo', 'build-bob'];
    for (const id of clicks) {
      c.vote('overall', id);
      await vi.advanceTimersByTimeAsync(3);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.getSnapshot().ballot).toMatchObject({
      votes: { overall: 'build-bob' },
      pending: {},
      unsent: {},
    });
    // The server's last write is the last click.
    expect(api.calls.filter((x) => x[0] === 'castVote').at(-1)).toEqual([
      'castVote',
      'overall',
      'build-bob',
    ]);
    c.dispose();
  });

  it('a refused click does not swallow the next one (it is a different build)', async () => {
    let release: (() => void) | null = null;
    const vote = api.onVote;
    api.onVote = async (cat, id) => {
      if (id === 'build-bob') {
        await new Promise<void>((r) => {
          release = r;
        });
        throw new GameError('not_votable');
      }
      return vote(cat, id);
    };
    const c = controller();
    c.receive(voting());
    await flush();
    c.vote('rule', 'build-bob');
    c.vote('rule', 'build-cleo');
    (release as (() => void) | null)?.();
    await flush();
    expect(c.getSnapshot().ballot.votes['rule']).toBe('build-cleo');
    c.dispose();
  });

  it('offline: the pick is kept, retried, and lands when the connection is back', async () => {
    const vote = api.onVote;
    let online = false;
    api.onVote = (cat, id) => {
      if (!online) throw new TypeError('Failed to fetch');
      return vote(cat, id);
    };
    const c = controller();
    c.receive(voting());
    await flush();
    c.vote('overall', 'build-bob');
    await flush();
    expect(c.getSnapshot().ballot).toMatchObject({
      votes: {},
      pending: {},
      unsent: { overall: 'build-bob' },
    });
    expect(c.getSnapshot().ballot.errors['overall']?.code).toBe('network');
    // Retried every retryMs (1 s here) while offline; a new click replaces the pick.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.count('castVote')).toBe(3);
    c.vote('overall', 'build-cleo');
    await flush();
    expect(c.getSnapshot().ballot.unsent).toEqual({ overall: 'build-cleo' });
    online = true;
    // A fresh snapshot (the sync engine reconnected) sends it at once.
    c.receive(voting({ version: 21 }));
    await flush();
    expect(c.getSnapshot().ballot).toMatchObject({
      votes: { overall: 'build-cleo' },
      unsent: {},
      lost: {},
      errors: {},
    });
    // Nothing is retried after that.
    const sent = api.count('castVote');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.count('castVote')).toBe(sent);
    c.dispose();
  });

  it('offline until the vote closes: the pick is reported as lost, never silently dropped', async () => {
    api.onVote = () => {
      throw new TypeError('Failed to fetch');
    };
    const c = controller();
    c.receive(voting());
    await flush();
    c.vote('style', 'build-cleo');
    await flush();
    c.receive(battleSnapshot({ phase: 'results', version: 30 }));
    expect(c.getSnapshot().ballot).toMatchObject({
      unsent: {},
      lost: { style: 'build-cleo' },
    });
    const sent = api.count('castVote');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.count('castVote'), 'no retry after VOTING').toBe(sent);
    c.dispose();
  });

  it('a click that reaches the server just after the vote closed is reported as lost', async () => {
    api.onVote = () => {
      throw new GameError('deadline_passed');
    };
    const c = controller();
    c.receive(voting());
    await flush();
    c.vote('chaos', 'build-bob');
    await flush();
    expect(c.getSnapshot().ballot.lost).toEqual({ chaos: 'build-bob' });
    expect(refetches).toBe(1);
    c.dispose();
  });

  it('nothing is sent outside VOTING or without the right to vote', async () => {
    const c = controller();
    c.receive(reveal(0));
    c.vote('overall', 'build-bob');
    const left = voting();
    left.me.can_vote = false;
    c.receive(left);
    await flush();
    c.vote('overall', 'build-bob');
    await flush();
    expect(api.count('castVote')).toBe(0);
    expect(left.me.user_id).toBe(ME);
    c.dispose();
  });
});
