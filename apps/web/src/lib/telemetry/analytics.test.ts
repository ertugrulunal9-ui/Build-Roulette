import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsClient, sanitizeProps, type AnalyticsDeps } from './analytics';
import type { TelemetryConfig } from './config';
import { privacySignal } from './privacy';

const ROOM = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';
const BATTLE = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';
const HASH = '0123456789abcdef0123456789abcdef';

const ON: TelemetryConfig = {
  sentryDsn: null,
  sentryEnvironment: 'production',
  posthogKey: 'phc_testkey',
  posthogHost: 'https://ph.example',
  release: 'abc123',
};

function client(over: Partial<AnalyticsDeps> = {}) {
  const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
  const deps: AnalyticsDeps = {
    config: ON,
    fetch: fetchSpy,
    privacy: () => false,
    user: { current: () => HASH, ready: () => Promise.resolve(HASH) },
    path: () => '/r/K7QXM',
    flushDelayMs: 1_000_000,
    now: () => Date.parse('2026-10-08T12:00:00Z'),
    ...over,
  };
  return { analytics: new AnalyticsClient(deps), fetchSpy };
}

function sentBody(fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) {
  const init = fetchSpy.mock.calls[call]?.[1];
  return JSON.parse(init?.body as string) as {
    api_key: string;
    batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[];
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('env gating and privacy signals', () => {
  it('sends nothing without a PostHog key', async () => {
    const { analytics, fetchSpy } = client({ config: { ...ON, posthogKey: null } });
    expect(analytics.enabled()).toBe(false);
    analytics.track('room_created', { room_id: ROOM });
    await analytics.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends nothing with Do Not Track or Global Privacy Control', async () => {
    const { analytics, fetchSpy } = client({ privacy: () => true });
    expect(analytics.enabled()).toBe(false);
    analytics.track('room_created', { room_id: ROOM });
    await analytics.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads DNT and GPC', () => {
    expect(privacySignal({ doNotTrack: '1' }, {})).toBe(true);
    expect(privacySignal({ doNotTrack: 'yes' }, {})).toBe(true);
    expect(privacySignal({ globalPrivacyControl: true }, {})).toBe(true);
    expect(privacySignal({}, { doNotTrack: '1' })).toBe(true);
    expect(privacySignal({ msDoNotTrack: '1' }, {})).toBe(true);
    expect(privacySignal({ doNotTrack: '0' }, {})).toBe(false);
    expect(privacySignal({ doNotTrack: 'unspecified', globalPrivacyControl: false }, {})).toBe(
      false,
    );
    expect(privacySignal(undefined, undefined)).toBe(false);
  });
});

describe('the batch', () => {
  it('posts the events to /batch/ with the hashed id, no person profile and a route template', async () => {
    const { analytics, fetchSpy } = client();
    analytics.track('room_created', { room_id: ROOM });
    analytics.track('battle_started', {
      battle_id: BATTLE,
      mode: 'multiplayer',
      room_id: ROOM,
      rematch: true,
    });
    await analytics.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://ph.example/batch/');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    const body = sentBody(fetchSpy);
    expect(body.api_key).toBe('phc_testkey');
    expect(body.batch.map((e) => e.event)).toEqual(['room_created', 'battle_started']);
    const first = body.batch[0];
    expect(first?.distinct_id).toBe(HASH);
    expect(first?.properties).toEqual({
      room_id: ROOM,
      path: '/r/[code]',
      distinct_id: HASH,
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: 'build-roulette-web',
      $lib_version: 'abc123',
      release: 'abc123',
    });
    expect(JSON.stringify(body)).not.toContain('K7QXM');
  });

  it('waits for the user id, then sends', async () => {
    let resolveId: (id: string | null) => void = () => undefined;
    const ready = new Promise<string | null>((r) => {
      resolveId = r;
    });
    let current: string | null = null;
    const { analytics, fetchSpy } = client({
      user: { current: () => current, ready: () => ready },
    });
    analytics.track('room_created', { room_id: ROOM });
    const flushing = analytics.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    current = HASH;
    resolveId(HASH);
    await flushing;
    expect(sentBody(fetchSpy).batch[0]?.distinct_id).toBe(HASH);
  });

  it('keeps the events while no user id is known (nothing anonymous-random is invented)', async () => {
    const { analytics, fetchSpy } = client({
      user: { current: () => null, ready: () => Promise.resolve(null) },
    });
    analytics.track('room_created', { room_id: ROOM });
    await analytics.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a failing endpoint never throws into the game', async () => {
    const { analytics } = client({ fetch: () => Promise.reject(new Error('offline')) });
    analytics.track('room_created', { room_id: ROOM });
    await expect(analytics.flush()).resolves.toBeUndefined();
  });

  it('flushes with keepalive when the page is hidden', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const { analytics, fetchSpy } = client();
    analytics.track('vote_cast', { battle_id: BATTLE, category: 'overall', revote: false });
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(fetchSpy.mock.calls[0]?.[1]?.keepalive).toBe(true);
    // Once hiding, a new event goes out at once (the sync-health report at unload).
    analytics.track('sync_health', {
      battle_id: BATTLE,
      room_id: ROOM,
      ended: 'closed',
      duration_s: 60,
      missed: 1,
      refetches: 4,
      gaps: 0,
      degraded_ms: 1500,
      rejoins: 0,
      server_closed: 0,
      channel_errors: 0,
    });
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    expect(sentBody(fetchSpy, 1).batch[0]?.properties).toMatchObject({
      missed: 1,
      degraded_ms: 1500,
      ended: 'closed',
    });
    vi.unstubAllGlobals();
  });
});

describe('sanitizeProps', () => {
  it('keeps UUID ids, enum tokens, numbers and booleans; drops anything else', () => {
    expect(
      sanitizeProps({
        room_id: ROOM,
        battle_id: 'K7QXM',
        user_id: 'ana@example.com',
        mode: 'solo',
        reason: 'phishing',
        name: 'My cool build',
        details: 'x'.repeat(100),
        rank: 2,
        bad: Number.NaN,
        rematch: true,
        nothing: null,
        nested: { a: 1 },
      }),
    ).toEqual({
      room_id: ROOM,
      mode: 'solo',
      reason: 'phishing',
      rank: 2,
      rematch: true,
      nothing: null,
    });
  });
});
