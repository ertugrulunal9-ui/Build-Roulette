import type { PreviewCrash } from '@br/runtime';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsClient, sanitizeProps, type AnalyticsEvents } from './analytics';
import type { TelemetryConfig } from './config';
import {
  PreviewHealth,
  SandboxHealthTally,
  previewHealthProps,
  type PreviewHealthOptions,
  type WatchdogStats,
} from './sandbox-health';

const BATTLE = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';
const OTHER = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';

/** A crash after a starved stretch: 5.1 s awake, 2.3 s more on the wall clock. */
const CRASH: PreviewCrash = {
  reason: 'heartbeat-timeout',
  silentForMs: 5100.4,
  phase: 'running',
  wallSilentForMs: 7400.6,
  stalledMs: 2300.2,
  longestStallMs: 2299.9,
};

type Sent = { [N in keyof AnalyticsEvents]: [N, AnalyticsEvents[N]] }[keyof AnalyticsEvents];

class FakeWindow extends EventTarget {
  listeners = 0;
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listeners++;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listeners--;
    super.removeEventListener(...args);
  }
}

function setup(over: Partial<PreviewHealthOptions> = {}) {
  const sent: Sent[] = [];
  const tally = new SandboxHealthTally();
  const win = new FakeWindow();
  const flush = vi.fn();
  const health = new PreviewHealth({
    mode: 'live',
    battleId: BATTLE,
    track: (name, props) => {
      sent.push([name, props] as Sent);
    },
    tally,
    flush,
    win,
    ...over,
  });
  return { health, sent, tally, win, flush };
}

const stats = (s: Partial<WatchdogStats> = {}): WatchdogStats => ({
  stalls: 0,
  stallMs: 0,
  sparedSilences: 0,
  ...s,
});

describe('preview_crash (one event per crash, once its outcome is known)', () => {
  it('a crash the user restarts: restarted, with the silences and the stall evidence', () => {
    const { health, sent, tally } = setup();
    health.crashed(CRASH);
    expect(sent).toEqual([]); // not known yet whether the user restarts it
    health.restarted();
    expect(sent).toEqual([
      [
        'preview_crash',
        {
          battle_id: BATTLE,
          mode: 'live',
          reason: 'heartbeat_timeout',
          phase: 'running',
          silent_ms: 5100,
          wall_silent_ms: 7401,
          stalled_ms: 2300,
          longest_stall_ms: 2300,
          restarted: true,
        },
      ],
    ]);
    health.restarted(); // nothing pending any more
    expect(sent).toHaveLength(1);
    expect(tally.take(BATTLE)).toMatchObject({ crashes: 1, restarts: 1 });
  });

  it('a crash never restarted is sent when the slot closes', () => {
    const { health, sent, tally } = setup({ mode: 'reveal' });
    health.crashed({ ...CRASH, reason: 'handshake-timeout', phase: 'connecting' });
    health.close();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toMatchObject({
      mode: 'reveal',
      reason: 'handshake_timeout',
      phase: 'connecting',
      restarted: false,
    });
    health.crashed(CRASH); // closed: ignored
    health.close();
    expect(sent).toHaveLength(1);
    expect(tally.take(BATTLE)).toMatchObject({ crashes: 1, restarts: 0 });
  });

  it('a second crash settles the first as not restarted', () => {
    const { health, sent } = setup();
    health.crashed(CRASH);
    health.crashed({ ...CRASH, phase: 'loading' });
    expect(sent.map(([, p]) => (p as { phase: string; restarted: boolean }).phase)).toEqual([
      'running',
    ]);
    health.restarted();
    expect(sent.map(([, p]) => (p as { restarted: boolean }).restarted)).toEqual([false, true]);
  });

  it('a restart of another build (key) does not count', () => {
    const { health, sent } = setup({ mode: 'reveal' });
    health.crashed(CRASH, 'build-bob');
    health.restarted('build-cleo');
    expect(sent).toEqual([]);
    health.restarted('build-bob');
    expect(sent[0]?.[1]).toMatchObject({ restarted: true });
  });

  it('the page going away sends a pending crash at once (keepalive flush)', () => {
    const { health, sent, win, flush } = setup();
    expect(win.listeners).toBe(0); // only while a crash is pending
    health.crashed(CRASH);
    expect(win.listeners).toBe(1);
    win.dispatchEvent(new Event('pagehide'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toMatchObject({ restarted: false });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(win.listeners).toBe(0);
    health.restarted();
    expect(sent).toHaveLength(1);
  });

  it('outside a battle: battle_id null, and no per-battle counts', () => {
    const { health, sent, tally } = setup({ battleId: null });
    health.follow({ stats: stats({ stalls: 3 }) });
    health.crashed(CRASH);
    health.close();
    expect(sent[0]?.[1]).toMatchObject({ battle_id: null });
    expect(tally.take(BATTLE)).toEqual({
      crashes: 0,
      restarts: 0,
      stalls: 0,
      stallMs: 0,
      spared: 0,
    });
  });

  it('privacy: only the battle UUID, enum tokens, numbers and a boolean (nothing is dropped)', () => {
    const { health, sent } = setup();
    health.crashed(CRASH);
    health.close();
    const props = sent[0]?.[1] ?? {};
    expect(sanitizeProps(props)).toEqual(props);
    expect(Object.keys(props).sort()).toEqual([
      'battle_id',
      'longest_stall_ms',
      'mode',
      'phase',
      'reason',
      'restarted',
      'silent_ms',
      'stalled_ms',
      'wall_silent_ms',
    ]);
  });

  it('off without the PostHog key: the event is never sent', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const off: TelemetryConfig = {
      sentryDsn: null,
      sentryEnvironment: 'production',
      posthogKey: null,
      posthogHost: 'https://ph.example',
      release: 'dev',
    };
    const analytics = new AnalyticsClient({ config: off, fetch: fetchSpy });
    const { health } = setup({
      track: (name, props) => {
        analytics.track(name, props);
      },
    });
    health.crashed(CRASH);
    health.close();
    await analytics.flush({ keepalive: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('per-battle preview counts (sync_health)', () => {
  it('sums crashes, restarts and every preview’s watchdog stats, running ones included', () => {
    const tally = new SandboxHealthTally();
    const a = setup({ tally });
    const b = setup({ tally, mode: 'reveal' });
    const liveStats = stats({ stalls: 1, stallMs: 6800, sparedSilences: 1 });
    a.health.follow({ stats: liveStats });
    const stopB = b.health.follow({ stats: stats({ stalls: 2, stallMs: 2500.4 }) });
    a.health.crashed(CRASH);
    a.health.restarted();
    stopB(); // that reveal preview went: its final stats are kept
    stopB();
    // An unrelated battle is not mixed in.
    tally.add(OTHER, { crashes: 5 });
    const counts = tally.take(BATTLE);
    expect(counts).toEqual({ crashes: 1, restarts: 1, stalls: 3, stallMs: 9300.4, spared: 1 });
    expect(previewHealthProps(counts)).toEqual({
      preview_crashes: 1,
      preview_restarts: 1,
      preview_stalls: 3,
      preview_stall_ms: 9300,
      preview_spared: 1,
    });
  });

  it('a battle is taken once: what comes later is not kept', () => {
    const tally = new SandboxHealthTally();
    const { health } = setup({ tally });
    health.follow({ stats: stats({ stalls: 1, stallMs: 1000 }) });
    expect(tally.take(BATTLE).stalls).toBe(1);
    health.crashed(CRASH);
    health.close(); // the still-running preview stops after the report
    expect(tally.take(BATTLE)).toEqual({
      crashes: 0,
      restarts: 0,
      stalls: 0,
      stallMs: 0,
      spared: 0,
    });
  });

  it('a new handle replaces the followed one (the old one’s stats are kept)', () => {
    const tally = new SandboxHealthTally();
    const { health } = setup({ tally });
    health.follow({ stats: stats({ stalls: 1 }) });
    health.follow({ stats: stats({ stalls: 2 }) });
    health.close();
    expect(tally.take(BATTLE).stalls).toBe(3);
  });
});
