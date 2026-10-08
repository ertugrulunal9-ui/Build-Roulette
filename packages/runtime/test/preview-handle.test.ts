import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_ALLOW_BY_MODE,
  PREVIEW_SANDBOX_BY_MODE,
  PreviewHandle,
  type PreviewEventMap,
  type PreviewOptions,
} from '../src/preview/preview-handle';
import { ConsoleLog, DEFAULT_PREVIEW_BUDGETS, RateWindow } from '../src/preview/budget';
import type { FakeIframe } from './fake-dom';
import {
  FakeComment,
  FakeMessageChannel,
  FakeShell,
  SHELL_URL,
  fakePage,
  helloFrom,
} from './fake-dom';

const BUILD = { js: 'export {}', css: '', importMap: { imports: {} } };

function setup(opts: Partial<PreviewOptions> = {}) {
  const page = fakePage();
  const handle = new PreviewHandle(page.iframe as unknown as HTMLIFrameElement, {
    shellUrl: SHELL_URL,
    now: () => Date.now(),
    ...opts,
  });
  const current = () => handle.iframe as unknown as FakeIframe;
  /** Delivers a genuine hello from the current iframe and completes the handshake. */
  const connect = () => {
    const frame = current();
    page.win.dispatch('message', helloFrom(frame.contentWindow));
    const shell = new FakeShell(frame.contentWindow);
    shell.connect();
    return shell;
  };
  return { ...page, handle, current, connect };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('MessageChannel', FakeMessageChannel);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('handshake: one hello per iframe navigation', () => {
  it('connects on the first hello from the iframe', () => {
    const { handle, iframe, connect } = setup();
    expect(iframe.navigations).toEqual([
      { src: SHELL_URL, sandbox: PREVIEW_SANDBOX_BY_MODE.live, allow: PREVIEW_ALLOW_BY_MODE.live },
    ]);
    connect();
    expect(handle.state).toBe('connected');
    expect(handle.stats.handshakes).toBe(1);
  });

  it('ignores a further hello once connected: no new port, counted in stats', () => {
    const { handle, win, iframe, connect } = setup();
    const shell = connect();
    const port = shell.port;
    expect(iframe.contentWindow.connectPorts()).toHaveLength(1);

    for (let i = 0; i < 3; i++) win.dispatch('message', helloFrom(iframe.contentWindow));

    expect(iframe.contentWindow.connectPorts()).toHaveLength(1); // no new `connect`
    expect(handle.stats.ignoredHellos).toBe(3);
    expect(handle.stats.handshakes).toBe(1);
    expect(handle.state).toBe('connected');
    // The original port is still the live one.
    expect(port?.closed).toBe(false);
    handle.load(BUILD);
    expect(shell.received('load')).toHaveLength(1);
  });

  it('ignores a repeated hello while the first handshake is still in flight', () => {
    const { handle, win, iframe } = setup();
    win.dispatch('message', helloFrom(iframe.contentWindow));
    win.dispatch('message', helloFrom(iframe.contentWindow)); // the shell's retry timer
    expect(iframe.contentWindow.connectPorts()).toHaveLength(1);
    expect(handle.stats.ignoredHellos).toBe(1);
    new FakeShell(iframe.contentWindow).connect();
    expect(handle.state).toBe('connected');
  });

  it('still rejects hellos from other windows and origins (not counted as ignored)', () => {
    const { handle, win, iframe } = setup();
    win.dispatch('message', helloFrom({ other: 'window' }));
    win.dispatch('message', helloFrom(iframe.contentWindow, 'https://evil.example'));
    expect(handle.stats.rejectedMessages).toBe(2);
    expect(handle.stats.ignoredHellos).toBe(0);
    expect(iframe.contentWindow.connectPorts()).toHaveLength(0);
  });

  it('restart() arms exactly one new handshake, on a new iframe element', () => {
    const { handle, win, iframe, current, connect } = setup();
    const first = connect();
    handle.restart();
    const second = current();
    expect(second).not.toBe(iframe);
    expect(first.port?.other.closed).toBe(true); // the app closed its end
    expect(handle.state).toBe('connecting');

    // The old window can no longer start a handshake.
    win.dispatch('message', helloFrom(iframe.contentWindow));
    expect(handle.stats.rejectedMessages).toBe(1);
    // The new one can, once.
    const shell = connect();
    expect(handle.stats.handshakes).toBe(2);
    win.dispatch('message', helloFrom(second.contentWindow));
    expect(second.contentWindow.connectPorts()).toHaveLength(1);
    expect(handle.stats.ignoredHellos).toBe(1);
    handle.load(BUILD);
    expect(shell.received('load')).toHaveLength(1);
  });

  it('a connected message with a stale or repeated nonce is rejected', () => {
    const { handle, iframe, connect } = setup();
    const shell = connect();
    const nonce = iframe.contentWindow.connectPorts()[0]?.nonce;
    shell.send({ type: 'connected', nonce });
    expect(handle.stats.rejectedMessages).toBe(1);
    expect(handle.stats.handshakes).toBe(1);
  });
});

describe('iframe attributes per mode', () => {
  it('uses the documented sandbox/allow sets', () => {
    expect(PREVIEW_SANDBOX_BY_MODE).toEqual({
      live: 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups',
      reveal: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
      capture: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
    });
    expect(PREVIEW_ALLOW_BY_MODE).toEqual({
      live: 'autoplay; fullscreen; gamepad; clipboard-write',
      reveal: 'autoplay; fullscreen; gamepad',
      capture: 'autoplay; fullscreen; gamepad',
    });
    for (const mode of ['reveal', 'capture'] as const) {
      expect(PREVIEW_SANDBOX_BY_MODE[mode]).not.toMatch(/allow-popups|allow-modals/);
      expect(PREVIEW_ALLOW_BY_MODE[mode]).not.toContain('clipboard-write');
    }
    for (const sandbox of Object.values(PREVIEW_SANDBOX_BY_MODE)) {
      expect(sandbox).not.toMatch(/allow-top-navigation|escape-sandbox|allow-downloads/);
    }
  });

  it('applies the initial mode before the first navigation', () => {
    const { iframe, handle } = setup({ mode: 'reveal' });
    expect(handle.mode).toBe('reveal');
    expect(iframe.navigations).toEqual([
      {
        src: SHELL_URL,
        sandbox: PREVIEW_SANDBOX_BY_MODE.reveal,
        allow: PREVIEW_ALLOW_BY_MODE.reveal,
      },
    ]);
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('a mode change replaces the iframe element and sets the flags before it navigates', () => {
    const { handle, container, iframe, current, connect } = setup();
    connect();
    const frames: unknown[] = [];
    handle.on('frame', (f) => frames.push(f.reason));
    const loadId = handle.load(BUILD, 'reveal');

    const next = current();
    expect(next).not.toBe(iframe);
    expect(iframe.parentNode).toBeNull();
    expect(container.children).toEqual([next]);
    expect(frames).toEqual(['mode-change']);
    expect(next.navigations).toEqual([
      {
        src: SHELL_URL,
        sandbox: PREVIEW_SANDBOX_BY_MODE.reveal,
        allow: PREVIEW_ALLOW_BY_MODE.reveal,
      },
    ]);
    // Identity attributes are carried over; owned ones are not copied from the old element.
    expect(next.getAttribute('id')).toBe('preview');
    expect(next.getAttribute('data-testid')).toBe('preview-frame');

    // The load waits for the new shell and is its first message.
    const shell = connect();
    expect(shell.messages[0]).toMatchObject({ type: 'load', loadId, mode: 'reveal' });
    expect(handle.stats.frames).toBe(2);

    // Same mode again: no new iframe.
    handle.load(BUILD, 'reveal');
    expect(current()).toBe(next);
    // Back to live: new iframe with popups and clipboard-write again.
    handle.load(BUILD, 'live');
    expect(current()).not.toBe(next);
    expect(current().getAttribute('sandbox')).toBe(PREVIEW_SANDBOX_BY_MODE.live);
  });
});

describe('resetStorage: clean slate', () => {
  it('replaces the iframe, sends reset-storage first, then the pending load', async () => {
    const { handle, iframe, current, connect } = setup();
    const old = connect();
    const reset = handle.resetStorage();
    expect(current()).not.toBe(iframe);
    expect(old.port?.other.closed).toBe(true);
    const loadId = handle.load(BUILD);

    const shell = connect();
    expect(shell.messages.map((m) => m.type).slice(0, 2)).toEqual(['reset-storage', 'load']);
    expect(shell.messages[1]).toMatchObject({ loadId });
    const requestId = shell.messages[0]?.['requestId'];
    shell.send({ type: 'storage-reset', requestId, ok: true });
    await expect(reset).resolves.toMatchObject({ ok: true, requestId });
  });

  it('ignores acks for unknown requests', async () => {
    const { handle, connect } = setup();
    const reset = handle.resetStorage(1000);
    const shell = connect();
    shell.send({ type: 'storage-reset', requestId: 999, ok: true });
    expect(handle.stats.rejectedMessages).toBe(1);
    vi.advanceTimersByTime(1001);
    await expect(reset).rejects.toThrow('reset-storage timed out');
  });
});

describe('captureThumbnail: best-effort client thumbnail', () => {
  const WEBP = 'data:image/webp;base64,UklGRg==';

  it('sends capture-thumbnail and resolves with the matching answer', async () => {
    const { handle, connect } = setup();
    const shell = connect();
    const thumb = handle.captureThumbnail({ width: 640, height: 400.4 });
    const [req] = shell.received('capture-thumbnail');
    expect(req).toMatchObject({ width: 640, height: 400 });
    // An answer for another request is rejected and does not settle this one.
    shell.send({ type: 'thumbnail', requestId: 999, webp: WEBP });
    expect(handle.stats.rejectedMessages).toBe(1);
    shell.send({ type: 'thumbnail', requestId: req?.['requestId'], webp: WEBP });
    await expect(thumb).resolves.toBe(WEBP);
    // A second answer to the same request is rejected too.
    shell.send({ type: 'thumbnail', requestId: req?.['requestId'], webp: WEBP });
    expect(handle.stats.rejectedMessages).toBe(2);
  });

  it('drops answers that are not WebP data URLs (schema)', async () => {
    const { handle, connect } = setup();
    const shell = connect();
    const thumb = handle.captureThumbnail({ width: 64, height: 40 }, 500);
    const requestId = shell.received('capture-thumbnail')[0]?.['requestId'];
    shell.send({ type: 'thumbnail', requestId, webp: 'data:image/png;base64,AAAA' });
    expect(handle.stats.rejectedMessages).toBe(1);
    vi.advanceTimersByTime(501);
    await expect(thumb).resolves.toBeNull();
  });

  it('resolves null when not connected, on timeout and when the frame is replaced', async () => {
    const { handle, connect } = setup();
    await expect(handle.captureThumbnail({ width: 64, height: 40 })).resolves.toBeNull();
    connect();
    const timedOut = handle.captureThumbnail({ width: 64, height: 40 }, 1000);
    vi.advanceTimersByTime(1001);
    await expect(timedOut).resolves.toBeNull();
    const replaced = handle.captureThumbnail({ width: 64, height: 40 });
    handle.restart();
    await expect(replaced).resolves.toBeNull();
  });
});

describe('watchdog: ping round trips', () => {
  it('pings every second with increasing seq; pongs keep it alive', () => {
    const { handle, connect } = setup();
    const shell = connect();
    vi.advanceTimersByTime(10_000);
    expect(handle.state).toBe('connected');
    const seqs = shell.received('ping').map((m) => m['seq'] as number);
    expect(seqs.length).toBeGreaterThanOrEqual(10);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(handle.stats.pongs).toBe(seqs.length);
  });

  it('crashes 5 s after the last pong, and removes the iframe', () => {
    const { handle, container, connect } = setup();
    const shell = connect();
    const crashes: { reason: string; silentForMs: number }[] = [];
    handle.on('crash', (c) => crashes.push(c));
    vi.advanceTimersByTime(2000);
    shell.autoPong = false; // the build froze
    vi.advanceTimersByTime(4900);
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(600);
    expect(handle.state).toBe('crashed');
    expect(crashes).toHaveLength(1);
    expect(crashes[0]?.reason).toBe('heartbeat-timeout');
    expect(crashes[0]?.silentForMs).toBeGreaterThan(5000);
    expect(crashes[0]?.silentForMs).toBeLessThanOrEqual(5250);
    expect(container.children).toHaveLength(1);
    expect(container.children[0]).toBeInstanceOf(FakeComment);
  });

  it('pings are exactly one interval apart, so detection is 4.0 to 5.25 s after a freeze', () => {
    for (const freezeAt of [0, 999, 1001, 1500, 1999]) {
      const { handle, connect } = setup();
      // The handshake completes between two watchdog ticks, as it does in a browser.
      vi.advanceTimersByTime(130);
      const shell = connect();
      const start = Date.now();
      vi.advanceTimersByTime(2000 + freezeAt);
      shell.autoPong = false;
      const frozeAt = Date.now();
      let crashedAt = 0;
      handle.on('crash', () => (crashedAt = Date.now()));
      vi.advanceTimersByTime(6000);
      const times = shell.received('ping').map((m) => (m['t'] as number) - start);
      expect(times.slice(0, 3)).toEqual([0, 1000, 2000]);
      expect(crashedAt - frozeAt, `freeze at +${String(freezeAt)}`).toBeGreaterThanOrEqual(4000);
      expect(crashedAt - frozeAt, `freeze at +${String(freezeAt)}`).toBeLessThanOrEqual(5250);
      handle.dispose();
    }
  });

  it('heartbeats do not count as liveness', () => {
    const { handle, connect } = setup();
    const shell = connect();
    shell.autoPong = false;
    const beat = setInterval(() => {
      shell.send({ type: 'heartbeat', t: Date.now() });
    }, 500);
    vi.advanceTimersByTime(5500);
    clearInterval(beat);
    expect(handle.state).toBe('crashed');
    expect(handle.stats.heartbeats).toBeGreaterThan(5);
  });

  it('pongs for unknown or already answered seqs are rejected and do not extend liveness', () => {
    const { handle, connect } = setup();
    const shell = connect();
    shell.autoPong = false;
    const spam = setInterval(() => {
      shell.send({ type: 'pong', seq: 10_000 });
      shell.send({ type: 'pong', seq: 1 }); // answered already (autoPong was on for seq 1)
    }, 250);
    vi.advanceTimersByTime(5500);
    clearInterval(spam);
    expect(handle.state).toBe('crashed');
    expect(handle.stats.rejectedMessages).toBeGreaterThan(20);
  });

  it('a late pong for an outstanding ping still counts', () => {
    const { handle, connect } = setup();
    const shell = connect();
    shell.autoPong = false;
    vi.advanceTimersByTime(3000);
    const last = shell.received('ping').at(-1);
    shell.send({ type: 'pong', seq: last?.['seq'] });
    vi.advanceTimersByTime(4000);
    expect(handle.state).toBe('connected');
    expect(handle.stats.lastRttMs).toBe(0);
  });

  it('times out a handshake that never completes', () => {
    const { handle } = setup({ handshakeTimeoutMs: 3000 });
    const crashes: string[] = [];
    handle.on('crash', (c) => crashes.push(c.reason));
    vi.advanceTimersByTime(3300);
    expect(crashes).toEqual(['handshake-timeout']);
  });

  it('pauses while the app tab is hidden and restarts the grace period when visible', () => {
    const { handle, doc, connect } = setup();
    const shell = connect();
    shell.autoPong = false;
    doc.hidden = true;
    vi.advanceTimersByTime(60_000);
    expect(handle.state).toBe('connected');
    doc.hidden = false;
    doc.dispatch('visibilitychange', {});
    vi.advanceTimersByTime(4000);
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(1500);
    expect(handle.state).toBe('crashed');
  });

  it('restart() recovers a crashed handle into the same slot', () => {
    const { handle, container, connect, current } = setup();
    const shell = connect();
    shell.autoPong = false;
    vi.advanceTimersByTime(6000);
    expect(handle.state).toBe('crashed');
    expect(() => handle.load(BUILD)).toThrow('crashed');
    handle.restart();
    expect(container.children).toEqual([current()]);
    connect();
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(10_000);
    expect(handle.state).toBe('connected');
  });
});

describe('watchdog: load grace (T-027)', () => {
  type Shell = ReturnType<ReturnType<typeof setup>['connect']>;
  /** The shell's main thread is free again: the pong for the newest ping arrives. */
  const unblock = (shell: Shell) => {
    shell.autoPong = true;
    shell.send({ type: 'pong', seq: shell.received('ping').at(-1)?.['seq'] });
  };
  const crashLog = (handle: PreviewHandle) => {
    const crashes: { reason: string; silentForMs: number; phase: string; at: number }[] = [];
    handle.on('crash', (c) => crashes.push({ ...c, at: Date.now() }));
    return crashes;
  };

  it('applies only after a load: with no load the limit stays 5 s', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(2000);
    shell.autoPong = false;
    vi.advanceTimersByTime(5300);
    expect(handle.state).toBe('crashed');
    expect(crashes[0]?.phase).toBe('running');
    expect(crashes[0]?.silentForMs).toBeLessThanOrEqual(5250);
    expect(handle.stats.loadGraceUntil).toBe(0);
  });

  it('tolerates a slow load that finishes (12 s of silence), then reverts to 5 s', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(1500);
    const loadId = handle.load(BUILD);
    shell.autoPong = false; // the shell evaluates the new bundle: one long main-thread task
    vi.advanceTimersByTime(12_000);
    expect(handle.state).toBe('connected');
    shell.send({ type: 'ready', loadId });
    unblock(shell);
    vi.advanceTimersByTime(10_000);
    expect(handle.state).toBe('connected');
    expect(crashes).toEqual([]);
    // Back to normal: a loop now is detected about 5 s after the last pong.
    shell.autoPong = false;
    const frozeAt = Date.now();
    vi.advanceTimersByTime(5300);
    expect(handle.state).toBe('crashed');
    expect(crashes[0]?.phase).toBe('running');
    expect((crashes[0]?.at ?? NaN) - frozeAt).toBeGreaterThanOrEqual(4000);
    expect((crashes[0]?.at ?? NaN) - frozeAt).toBeLessThanOrEqual(5250);
  });

  it('a loop right after ready is still detected at about 5 s', () => {
    for (const freezeAfterReady of [0, 300, 999, 2500]) {
      const { handle, connect } = setup();
      const shell = connect();
      const crashes = crashLog(handle);
      vi.advanceTimersByTime(700);
      const loadId = handle.load(BUILD);
      vi.advanceTimersByTime(150);
      shell.send({ type: 'ready', loadId });
      vi.advanceTimersByTime(freezeAfterReady);
      shell.autoPong = false;
      const frozeAt = Date.now();
      vi.advanceTimersByTime(6000);
      const label = `freeze ${String(freezeAfterReady)} ms after ready`;
      expect(crashes, label).toHaveLength(1);
      expect((crashes[0]?.at ?? NaN) - frozeAt, label).toBeGreaterThanOrEqual(4000);
      expect((crashes[0]?.at ?? NaN) - frozeAt, label).toBeLessThanOrEqual(5250);
      handle.dispose();
    }
  });

  it('ready right after a long silent load does not crash before the queued pongs arrive', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const loadId = handle.load(BUILD);
    shell.autoPong = false;
    vi.advanceTimersByTime(9000);
    shell.send({ type: 'ready', loadId }); // posted at the end of the long task
    vi.advanceTimersByTime(4900); // the pongs are late: ready still gives 5 s, not more
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(400);
    expect(handle.state).toBe('crashed');
  });

  it('a loop during the load (no ready) is detected within the 15 s grace bound', () => {
    for (const lastPongBeforeLoad of [0, 500, 999]) {
      const { handle, connect } = setup();
      const shell = connect();
      const crashes = crashLog(handle);
      vi.advanceTimersByTime(1000 + lastPongBeforeLoad);
      shell.autoPong = false;
      const sentAt = Date.now();
      handle.load(BUILD);
      vi.advanceTimersByTime(14_000 - lastPongBeforeLoad);
      expect(handle.state).toBe('connected');
      vi.advanceTimersByTime(1500);
      expect(handle.state).toBe('crashed');
      expect(crashes[0]?.reason).toBe('heartbeat-timeout');
      expect(crashes[0]?.phase).toBe('loading');
      expect((crashes[0]?.at ?? NaN) - sentAt).toBeLessThanOrEqual(15_250);
      expect(crashes[0]?.silentForMs).toBeGreaterThan(5000);
      expect(crashes[0]?.silentForMs).toBeLessThanOrEqual(15_250);
      handle.dispose();
    }
  });

  it('is bounded: the sandbox cannot extend it, and new loads never allow more than 15 s of silence', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(1000);
    const first = handle.load(BUILD);
    shell.autoPong = false;
    const lastPongAt = handle.stats.lastPongAt;
    // Everything the sandbox can send: heartbeats, stale/duplicate/unknown readys, bogus pongs.
    const spam = setInterval(() => {
      shell.send({ type: 'heartbeat', t: Date.now() });
      shell.send({ type: 'ready', loadId: first + 100 });
      shell.send({ type: 'pong', seq: 99_999 });
    }, 200);
    // Meanwhile the app keeps sending loads (the player keeps typing): each one is a new load,
    // but the silence since the last pong still may not exceed 15 s.
    const typing = setInterval(() => {
      if (handle.state === 'connected') handle.load(BUILD);
    }, 2000);
    vi.advanceTimersByTime(16_000);
    clearInterval(spam);
    clearInterval(typing);
    expect(handle.state).toBe('crashed');
    expect(crashes[0]?.phase).toBe('loading');
    expect((crashes[0]?.at ?? NaN) - lastPongAt).toBeGreaterThan(15_000);
    expect((crashes[0]?.at ?? NaN) - lastPongAt).toBeLessThanOrEqual(15_250);
  });

  it('the window closes 15 s after the load even when ready never comes', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    handle.load(BUILD); // e.g. a module that awaits forever: pongs keep coming, no ready
    vi.advanceTimersByTime(20_000);
    expect(handle.state).toBe('connected');
    shell.autoPong = false;
    const frozeAt = Date.now();
    vi.advanceTimersByTime(5300);
    expect(handle.state).toBe('crashed');
    expect(crashes[0]?.phase).toBe('loading');
    expect((crashes[0]?.at ?? NaN) - frozeAt).toBeLessThanOrEqual(5250);
  });

  it('an early ready (a hostile build answering for the shell) only shortens the window', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const loadId = handle.load(BUILD);
    shell.send({ type: 'ready', loadId });
    shell.autoPong = false;
    const frozeAt = Date.now();
    vi.advanceTimersByTime(5300);
    expect(handle.state).toBe('crashed');
    expect(Date.now() - frozeAt).toBeLessThanOrEqual(5300);
  });

  it('a load sent on connect (pending load) opens the window; a new shell drops an old one', () => {
    const { handle, connect } = setup();
    handle.load(BUILD); // before the handshake: sent on connect
    const shell = connect();
    expect(shell.received('load')).toHaveLength(1);
    shell.autoPong = false;
    vi.advanceTimersByTime(12_000);
    expect(handle.state).toBe('connected');
    // restart(): a new shell with no load. The old load's window does not carry over.
    handle.restart();
    const next = connect();
    expect(handle.stats.loadGraceUntil).toBe(0);
    const crashes = crashLog(handle);
    next.autoPong = false;
    vi.advanceTimersByTime(5300);
    expect(handle.state).toBe('crashed');
    expect(crashes[0]?.phase).toBe('running');
  });

  it('a handshake timeout reports the connecting phase', () => {
    const { handle } = setup();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(10_300);
    expect(crashes[0]).toMatchObject({ reason: 'handshake-timeout', phase: 'connecting' });
  });

  it('loadGraceMs is configurable and never below heartbeatTimeoutMs', () => {
    const { handle, connect } = setup({ loadGraceMs: 1000 });
    const shell = connect();
    handle.load(BUILD);
    shell.autoPong = false;
    vi.advanceTimersByTime(4900);
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(400);
    expect(handle.state).toBe('crashed');
  });
});

describe('watchdog: app starvation (T-031)', () => {
  type Shell = ReturnType<ReturnType<typeof setup>['connect']>;
  /**
   * The app's own main thread does not run for `ms` (a long task of its own, or a starved
   * machine giving the process no CPU): the clock moves on and no timer fires. The overdue
   * ones fire after it, as in a browser.
   */
  const stallApp = (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  };
  /** A starved shell: it answers every ping `delayMs` (timer time) after receiving it. */
  const lagPongs = (shell: Shell, delayMs: number) => {
    shell.autoPong = false;
    const port = shell.port;
    if (!port) throw new Error('the shell is not connected');
    const record = port.onmessage;
    port.onmessage = (event) => {
      record?.(event);
      const msg = event.data as { type: string; seq?: number };
      if (msg.type !== 'ping') return;
      setTimeout(() => {
        shell.send({ type: 'pong', seq: msg.seq });
      }, delayMs);
    };
  };
  /** The shell's main thread is free again: the pong for the newest ping arrives. */
  const unblock = (shell: Shell) => {
    shell.autoPong = true;
    shell.send({ type: 'pong', seq: shell.received('ping').at(-1)?.['seq'] });
  };
  const crashLog = (handle: PreviewHandle) => {
    const crashes: (PreviewEventMap['crash'] & { at: number })[] = [];
    handle.on('crash', (c) => crashes.push({ ...c, at: Date.now() }));
    return crashes;
  };

  it('a starved app (one 7 s stall, then late pongs) does not crash: its own stall is not silence', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(2000);
    // The whole machine is starved: the app gets no CPU for 7 s, and the shell, starved too,
    // answers each ping 600 ms late from then on.
    lagPongs(shell, 600);
    stallApp(7000);
    vi.advanceTimersByTime(3000);
    expect(crashes).toEqual([]);
    expect(handle.state).toBe('connected');
    expect(handle.stats).toMatchObject({ stalls: 1, longestStallMs: 7000, stallMs: 7000 });
    // The old wall-clock rule would have crashed (7.25 s since the last pong); a pong came.
    expect(handle.stats.sparedSilences).toBe(1);
    expect(handle.stats.pongs).toBeGreaterThan(3);
  });

  it('a continuously starved app (every tick 1.25 s late, pings late, pongs late) does not crash', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(1100);
    lagPongs(shell, 900);
    const pongsBefore = handle.stats.pongs;
    const start = Date.now();
    // 40 ticks in 60 s of wall-clock time: a ping only every 6 s, its pong 5.4 s after it.
    for (let i = 0; i < 40; i++) {
      stallApp(1250);
      vi.advanceTimersByTime(250);
    }
    expect(Date.now() - start).toBe(60_000);
    expect(crashes).toEqual([]);
    expect(handle.state).toBe('connected');
    expect(handle.stats.pongs - pongsBefore).toBeGreaterThanOrEqual(9);
    expect(handle.stats.stalls).toBe(40);
    expect(handle.stats.sparedSilences).toBeGreaterThan(0);
  });

  it('a loop with on-time ticks is caught as before, and its crash shows no stall', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(2000);
    shell.autoPong = false; // the build loops; the app's timers run on time
    const frozeAt = Date.now();
    vi.advanceTimersByTime(5300);
    expect(crashes).toHaveLength(1);
    const c = crashes[0];
    expect((c?.at ?? NaN) - frozeAt).toBeGreaterThanOrEqual(4000);
    expect((c?.at ?? NaN) - frozeAt).toBeLessThanOrEqual(5250);
    expect(c).toMatchObject({ reason: 'heartbeat-timeout', phase: 'running', stalledMs: 0 });
    expect(c?.longestStallMs).toBe(0);
    expect(c?.wallSilentForMs).toBe(c?.silentForMs);
    expect(handle.stats).toMatchObject({ stalls: 0, sparedSilences: 0 });
  });

  it('a loop is caught after 5 s of app-awake time, even when the app stalls meanwhile', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(2000);
    const lastPongAt = handle.stats.lastPongAt;
    shell.autoPong = false; // the build loops
    vi.advanceTimersByTime(1000);
    stallApp(2000);
    vi.advanceTimersByTime(1000);
    stallApp(3000);
    vi.advanceTimersByTime(1000);
    // 8 s since the last pong by the wall clock, but only 3 s while the app was awake.
    expect(Date.now() - lastPongAt).toBe(8000);
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(2300);
    expect(crashes).toHaveLength(1);
    const c = crashes[0];
    expect(c).toMatchObject({
      reason: 'heartbeat-timeout',
      phase: 'running',
      longestStallMs: 3000,
    });
    expect(c?.silentForMs).toBeGreaterThan(5000);
    expect(c?.silentForMs).toBeLessThanOrEqual(5250);
    expect(c?.stalledMs).toBe(5000);
    expect(c?.wallSilentForMs).toBe((c?.silentForMs ?? NaN) + 5000);
    // The loop did not end with a pong: nothing was spared.
    expect(handle.stats).toMatchObject({ stalls: 2, stallMs: 5000, sparedSilences: 0 });
  });

  it('a loop during a load is still caught 15 s (app-awake) after the send; an app stall does not eat the grace', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(1000);
    shell.autoPong = false; // a loop at the module's top level: no pong, no ready
    const sentAt = Date.now();
    handle.load(BUILD);
    vi.advanceTimersByTime(4000);
    stallApp(6000);
    vi.advanceTimersByTime(6000);
    // 16 s after the send by the wall clock: the old wall-clock window had closed.
    expect(Date.now() - sentAt).toBe(16_000);
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(5300);
    expect(crashes).toHaveLength(1);
    const c = crashes[0];
    expect(c).toMatchObject({ reason: 'heartbeat-timeout', phase: 'loading', stalledMs: 6000 });
    expect(c?.silentForMs).toBeGreaterThan(15_000);
    expect(c?.silentForMs).toBeLessThanOrEqual(15_250);
    expect((c?.at ?? NaN) - sentAt - 6000).toBeLessThanOrEqual(15_250);
  });

  it('a slow load on a starved machine (8 s app stall, 10 s evaluation) is not a crash', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(1000);
    const loadId = handle.load(BUILD);
    shell.autoPong = false; // the shell evaluates the bundle
    vi.advanceTimersByTime(2000);
    stallApp(8000);
    vi.advanceTimersByTime(8000); // 18 s after the send by the wall clock, 10 s awake
    expect(handle.state).toBe('connected');
    shell.send({ type: 'ready', loadId });
    unblock(shell);
    vi.advanceTimersByTime(10_000);
    expect(crashes).toEqual([]);
    expect(handle.stats.sparedSilences).toBe(1);
  });

  it('the handshake timeout counts app-awake time too', () => {
    const { handle, connect } = setup();
    const crashes = crashLog(handle);
    vi.advanceTimersByTime(1000);
    stallApp(11_000); // e.g. the page's own start-up work on a starved machine
    vi.advanceTimersByTime(1000);
    expect(crashes).toEqual([]);
    expect(handle.state).toBe('connecting');
    connect();
    expect(handle.state).toBe('connected');

    // A shell that never answers is still given up on after 10 s of awake time.
    handle.restart();
    const navigatedAt = Date.now();
    vi.advanceTimersByTime(3000);
    stallApp(4000);
    vi.advanceTimersByTime(7300);
    expect(crashes).toHaveLength(1);
    const c = crashes[0];
    expect(c).toMatchObject({ reason: 'handshake-timeout', phase: 'connecting', stalledMs: 4000 });
    expect(c?.silentForMs).toBeGreaterThan(10_000);
    expect(c?.silentForMs).toBeLessThanOrEqual(10_250);
    expect((c?.at ?? NaN) - navigatedAt).toBeGreaterThan(14_000);
  });

  it('hidden tabs are unchanged: no check while hidden, a fresh 5 s when visible, and hidden time is no stall', () => {
    const { handle, doc, connect } = setup();
    const shell = connect();
    const crashes = crashLog(handle);
    shell.autoPong = false;
    doc.hidden = true;
    // A hidden tab's timers are throttled: here they run once a minute.
    for (let i = 0; i < 5; i++) {
      stallApp(59_750);
      vi.advanceTimersByTime(250);
    }
    expect(handle.state).toBe('connected');
    doc.hidden = false;
    doc.dispatch('visibilitychange', {});
    vi.advanceTimersByTime(4000);
    expect(handle.state).toBe('connected');
    vi.advanceTimersByTime(1500);
    expect(handle.state).toBe('crashed');
    expect(crashes[0]).toMatchObject({ stalledMs: 0, longestStallMs: 0 });
    expect(handle.stats).toMatchObject({ stalls: 0, stallMs: 0, sparedSilences: 0 });
  });
});

describe('app-side message budgets', () => {
  it('rate-limits console messages per second, drops and counts the excess', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const seen: unknown[] = [];
    handle.on('console', (m) => seen.push(m));
    for (let i = 0; i < 1000; i++) shell.send({ type: 'console', level: 'log', args: [`m${i}`] });
    expect(seen).toHaveLength(DEFAULT_PREVIEW_BUDGETS.consolePerSecond);
    expect(handle.stats.droppedMessages.console).toBe(900);
    // Next window: budget again.
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 150; i++) shell.send({ type: 'console', level: 'log', args: ['x'] });
    expect(seen).toHaveLength(200);
    expect(handle.stats.droppedMessages.console).toBe(950);
  });

  it('rate-limits runtime errors and ready messages', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const errors: unknown[] = [];
    handle.on('error', (m) => errors.push(m));
    for (let i = 0; i < 100; i++) shell.send({ type: 'runtime-error', message: `e${i}` });
    expect(errors).toHaveLength(DEFAULT_PREVIEW_BUDGETS.errorsPerSecond);
    expect(handle.stats.droppedMessages.error).toBe(80);

    const loadId = handle.load(BUILD);
    const ready: number[] = [];
    handle.on('ready', (r) => ready.push(r.loadId));
    for (let i = 0; i < 50; i++) shell.send({ type: 'ready', loadId });
    expect(ready).toEqual([loadId]); // once, for the latest load only
    expect(handle.stats.droppedMessages.ready).toBe(50 - DEFAULT_PREVIEW_BUDGETS.readyPerSecond);
  });

  it('accepts ready only for the latest load, once', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const ready: number[] = [];
    handle.on('ready', (r) => ready.push(r.loadId));
    const a = handle.load(BUILD);
    const b = handle.load(BUILD);
    shell.send({ type: 'ready', loadId: a }); // superseded load
    shell.send({ type: 'ready', loadId: b + 5 }); // never sent
    shell.send({ type: 'ready', loadId: b });
    shell.send({ type: 'ready', loadId: b }); // duplicate
    expect(ready).toEqual([b]);
    expect(handle.stats.rejectedMessages).toBe(3);
  });

  it('emits at most one "messages dropped" notice per second', () => {
    const { handle, connect } = setup();
    const shell = connect();
    const notices: { count: number; at: number }[] = [];
    const start = Date.now();
    handle.on('dropped', (d) => notices.push({ count: d.count, at: Date.now() - start }));
    // 5 seconds of flooding, 1000 messages every 100 ms.
    for (let t = 0; t < 50; t++) {
      for (let i = 0; i < 1000; i++) shell.send({ type: 'console', level: 'log', args: ['x'] });
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1000);
    expect(notices.length).toBeGreaterThanOrEqual(4);
    expect(notices.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < notices.length; i++) {
      expect((notices[i]?.at ?? 0) - (notices[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
    }
    const total = notices.reduce((n, d) => n + d.count, 0);
    expect(total).toBe(handle.stats.droppedMessages.console);
    // The notice is also in the retained console, marked as written by the app.
    const own = handle.consoleEntries().filter((e) => e.source === 'preview');
    expect(own.length).toBeGreaterThan(0);
    expect(own[0]?.text).toMatch(/^\[preview\] \d+ messages from the build dropped/);
  });

  it('caps the retained console characters, evicting the oldest entries', () => {
    const { handle, connect } = setup({
      budgets: { consoleMaxChars: 10_000, consolePerSecond: 1000 },
    });
    const shell = connect();
    for (let i = 0; i < 500; i++) {
      shell.send({
        type: 'console',
        level: 'log',
        args: [String(i).padStart(4, '0'), 'y'.repeat(95)],
      });
    }
    const entries = handle.consoleEntries();
    const chars = entries.reduce((n, e) => n + e.text.length, 0);
    expect(chars).toBeLessThanOrEqual(10_000);
    expect(entries.at(-1)?.text.startsWith('0499')).toBe(true);
    expect(entries[0]?.text.startsWith('0000')).toBe(false);
    expect(handle.stats.evictedConsoleEntries).toBe(500 - entries.length);
  });

  it('records runtime errors in the retained console', () => {
    const { handle, connect } = setup();
    const shell = connect();
    shell.send({ type: 'runtime-error', message: 'Error: boom' });
    expect(handle.consoleEntries().map((e) => [e.level, e.text])).toEqual([
      ['error', 'Uncaught Error: boom'],
    ]);
    handle.clearConsole();
    expect(handle.consoleEntries()).toEqual([]);
  });
});

describe('budget primitives', () => {
  it('RateWindow allows n per one-second window', () => {
    const w = new RateWindow(3);
    expect([0, 1, 2, 3].map((t) => w.take(t))).toEqual([true, true, true, false]);
    expect(w.take(999)).toBe(false);
    expect(w.take(1000)).toBe(true);
  });

  it('ConsoleLog keeps snapshots stable until a change and truncates huge entries', () => {
    const log = new ConsoleLog(100, 10);
    log.add('log', 'a', 'sandbox');
    const s1 = log.list();
    expect(log.list()).toBe(s1);
    log.add('log', 'x'.repeat(500), 'sandbox');
    const s2 = log.list();
    expect(s2).not.toBe(s1);
    expect(s2).toHaveLength(1);
    expect(s2[0]?.text.length).toBe(100);
    for (let i = 0; i < 20; i++) log.add('log', 'z', 'sandbox');
    expect(log.list()).toHaveLength(10);
  });
});
