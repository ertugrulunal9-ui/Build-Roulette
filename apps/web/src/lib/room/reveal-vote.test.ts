/**
 * REVEAL and VOTING on the client: the untrusted manifest, the spotlight's files and the
 * prefetch, thumbnails, local skip / freeze, the host's compare-and-set controls (stale
 * calls are quiet), and the ballot (restore, revotes, one request per category, errors).
 */
import type { PreviewCrash } from '@br/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameError } from '../solo/errors';
import type { AnalyticsEvents } from '../telemetry/analytics';
import { SandboxHealthTally } from '../telemetry/sandbox-health';
import type { BattleSnapshot } from '../solo/types';
import {
  MAX_MANIFEST_BYTES,
  parseRevealManifest,
  revealImportMap,
  revealPreviewBuild,
} from './reveal-files';
import { HOST_RETRIES, RevealVoteController, spotlightBuild, type ObjectUrls } from './reveal-vote';
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

function controller(
  extra: Partial<ConstructorParameters<typeof RevealVoteController>[1]> = {},
): RevealVoteController {
  return new RevealVoteController(BATTLE_1, {
    api,
    cdnBaseUrl: CDN,
    refetch: () => {
      refetches++;
      return Promise.resolve();
    },
    objectUrls: urls,
    retryMs: 1_000,
    ...extra,
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

  it('skip, freeze and missing packages are local; watching again clears them', async () => {
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
    // T-032: a build whose packages could not load here.
    c.packagesFailed('build-bob');
    c.packagesFailed('build-bob');
    expect(c.getSnapshot().noPackages).toEqual(['build-bob']);
    c.watch('build-bob');
    c.watch('build-cleo');
    c.watch('build-me');
    expect(c.getSnapshot()).toMatchObject({
      skipped: [],
      frozen: [],
      failedToStart: [],
      noPackages: [],
    });
    // Nothing went to the server.
    expect(
      api.calls.filter((x) => !['getRevealBuilds', 'downloadText', 'downloadBlob'].includes(x[0])),
    ).toEqual([]);
    c.dispose();
  });

  it('a watchdog crash of the spotlight is a preview_crash once the viewer runs it again (T-031)', async () => {
    const sent: AnalyticsEvents['preview_crash'][] = [];
    const tally = new SandboxHealthTally();
    const c = controller({
      sandboxHealth: tally,
      track: (name, props) => {
        if (name === 'preview_crash') sent.push(props as AnalyticsEvents['preview_crash']);
      },
    });
    c.receive(reveal(1));
    await flush();
    const crash: PreviewCrash = {
      reason: 'heartbeat-timeout',
      silentForMs: 5050,
      phase: 'running',
      wallSilentForMs: 5050,
      stalledMs: 0,
      longestStallMs: 0,
    };
    c.previewCrashed('build-bob', crash);
    expect(c.getSnapshot().frozen).toEqual(['build-bob']);
    expect(sent).toEqual([]);
    c.watch('build-cleo'); // another build: not this crash's restart
    c.watch('build-bob');
    expect(sent).toEqual([
      expect.objectContaining({
        battle_id: BATTLE_1,
        mode: 'reveal',
        reason: 'heartbeat_timeout',
        silent_ms: 5050,
        restarted: true,
      }),
    ]);
    // A build that never started, and the battle ends for this controller before a rerun.
    c.previewCrashed('build-cleo', { ...crash, reason: 'handshake-timeout', phase: 'connecting' });
    expect(c.getSnapshot().failedToStart).toEqual(['build-cleo']);
    c.dispose();
    expect(sent.map((e) => [e.reason, e.restarted])).toEqual([
      ['heartbeat_timeout', true],
      ['handshake_timeout', false],
    ]);
    expect(tally.take(BATTLE_1)).toMatchObject({ crashes: 2, restarts: 1 });
  });

  it('a build taken down during REVEAL (T-024) loses its prefetched bundle', async () => {
    const c = controller();
    c.receive(reveal(0));
    await flush();
    const ids = Object.keys(c.getSnapshot().bundles);
    expect(ids.length).toBeGreaterThan(1);
    const removedId = ids.find((id) => id !== reveal(0).battle.reveal_order?.[0]) ?? '';
    const snap = reveal(0, 11);
    snap.builds = snap.builds.map((b) => (b.id === removedId ? { ...b, taken_down: true } : b));
    c.receive(snap);
    expect(Object.keys(c.getSnapshot().bundles)).not.toContain(removedId);
    // The prefetch moves on to the next build that still has a slot.
    await flush();
    expect(Object.keys(c.getSnapshot().bundles).sort()).toEqual(['build-cleo', 'build-me']);
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

  it('a click made stale only by an unrelated event (a capture) is sent again with the server version', async () => {
    // T-023: 8 captures land one after another right at the start of REVEAL; each one moves
    // the battle version, so the host's click lost the compare-and-set now and then.
    const sent: number[] = [];
    api.onHost = (_k, v) => {
      sent.push(v);
      return sent.length === 1
        ? { changed: false, version: v + 1, phase: 'reveal', phase_ends_at: null, reveal_index: 0 }
        : { changed: true, version: v + 1, phase: 'reveal', phase_ends_at: null, reveal_index: 1 };
    };
    const c = controller();
    c.receive(reveal(0, 12));
    await c.next();
    expect(sent).toEqual([12, 13]);
    expect(refetches).toBe(0);
    expect(c.getSnapshot().host).toEqual({ pending: null, error: null });
    // Never more than HOST_RETRIES resends, then the quiet refetch.
    sent.length = 0;
    api.onHost = (_k, v) => {
      sent.push(v);
      return {
        changed: false,
        version: v + 1,
        phase: 'reveal',
        phase_ends_at: null,
        reveal_index: 0,
      };
    };
    await c.next();
    expect(sent).toEqual([12, 13, 14, 15].slice(0, HOST_RETRIES + 1));
    expect(refetches).toBe(1);
    // A skip still means "skip" on another spotlight; it is resent too.
    sent.length = 0;
    api.onHost = (_k, v) => {
      sent.push(v);
      return sent.length === 1
        ? { changed: false, version: v + 2, phase: 'reveal', phase_ends_at: null, reveal_index: 1 }
        : {
            changed: true,
            version: v + 1,
            phase: 'voting',
            phase_ends_at: null,
            reveal_index: null,
          };
    };
    await c.skipToVote();
    expect(sent).toEqual([12, 14]);
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

  it('a build taken down mid-vote (T-024) leaves the ballot; the voter picks again', async () => {
    api.ballot = {
      overall: 'build-bob',
      rule: 'build-cleo',
      style: 'build-bob',
      chaos: 'build-cleo',
    };
    const c = controller();
    c.receive(voting());
    await flush();
    expect(c.getSnapshot().ballot.complete).toBe(true);
    const snap = voting({ version: 21 });
    snap.builds = snap.builds.map((b) =>
      b.id === 'build-bob' ? { ...b, status: 'disqualified', name: null, taken_down: true } : b,
    );
    c.receive(snap);
    expect(c.getSnapshot().ballot).toMatchObject({
      votes: { rule: 'build-cleo', chaos: 'build-cleo' },
      complete: false,
    });
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
