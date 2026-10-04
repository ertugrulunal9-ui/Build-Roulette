import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_ALLOW_BY_MODE,
  PREVIEW_SANDBOX_BY_MODE,
  PreviewHandle,
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
