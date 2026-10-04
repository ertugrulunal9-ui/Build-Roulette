import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  PROTOCOL_VERSION,
  createNonce,
  describeThrown,
  parseAppToShell,
  parseConnect,
  parseShellToApp,
  serializeConsoleArgs,
  serializeValue,
  truncate,
} from '../src/index';

const validLoad = {
  type: 'load',
  loadId: 1,
  js: 'console.log(1)',
  css: 'body{}',
  importMap: { imports: { react: 'https://pkg.example/react@19.3.0' } },
  mode: 'live',
};

describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('parseAppToShell', () => {
  it('accepts every valid app -> shell message', () => {
    for (const m of [
      validLoad,
      { ...validLoad, mode: 'reveal' },
      {
        ...validLoad,
        mode: 'capture',
        importMap: {
          imports: {},
          scopes: { 'https://a.example/': { x: 'https://b.example/x.js' } },
        },
      },
      { type: 'reset-storage' },
      { type: 'reset-storage', requestId: 3 },
      { type: 'capture-thumbnail', width: 320, height: 200 },
      { type: 'ping', seq: 0 },
      { type: 'ping', seq: 4, t: 123.5 },
    ]) {
      const r = parseAppToShell(m);
      expect(r, JSON.stringify(m)).toMatchObject({ ok: true });
    }
  });

  it('strips unknown keys instead of passing them through', () => {
    const r = parseAppToShell({ type: 'ping', seq: 1, evil: true });
    expect(r.ok && 'evil' in r.value).toBe(false);
  });

  it('rejects invalid messages with a reason and never throws', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'load',
      [],
      {},
      { type: 'nope' },
      { ...validLoad, mode: 'debug' },
      { ...validLoad, loadId: -1 },
      { ...validLoad, loadId: 1.5 },
      { ...validLoad, js: 5 },
      { ...validLoad, importMap: { imports: { react: 'javascript:alert(1)' } } },
      { ...validLoad, importMap: { imports: { react: 'blob:https://x/1' } } },
      { type: 'capture-thumbnail', width: 0, height: 10 },
      { type: 'capture-thumbnail', width: 5000, height: 10 },
      { type: 'hello', protocol: 1 }, // shell -> app message on the wrong direction
      { type: 'ping' }, // seq is required (pongs must echo it)
      { type: 'ping', seq: -1 },
      { type: 'ping', seq: 1.5 },
      { type: 'pong', seq: 1 }, // shell -> app
    ];
    for (const m of bad) {
      const r = parseAppToShell(m);
      expect(r.ok, `case #${String(bad.indexOf(m))}`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('does not throw on hostile objects', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(() => parseAppToShell(hostile)).not.toThrow();
    expect(parseAppToShell(hostile).ok).toBe(false);
  });

  it('rejects oversized bundles and import maps', () => {
    expect(parseAppToShell({ ...validLoad, js: 'x'.repeat(LIMITS.bundleJsMaxChars + 1) }).ok).toBe(
      false,
    );
    expect(
      parseAppToShell({ ...validLoad, css: 'x'.repeat(LIMITS.bundleCssMaxChars + 1) }).ok,
    ).toBe(false);
    const imports: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.importMapMaxEntries; i++)
      imports[`p${i}`] = `https://x.example/p${i}`;
    expect(parseAppToShell({ ...validLoad, importMap: { imports } }).ok).toBe(false);
  });
});

describe('parseShellToApp', () => {
  it('accepts every valid shell -> app message', () => {
    const nonce = createNonce();
    for (const m of [
      { type: 'hello', protocol: PROTOCOL_VERSION },
      { type: 'connected', nonce },
      { type: 'ready', loadId: 7 },
      { type: 'heartbeat' },
      { type: 'heartbeat', t: 1 },
      { type: 'pong', seq: 0 },
      { type: 'pong', seq: 99 },
      { type: 'console', level: 'warn', args: ['a', 'b'] },
      { type: 'console', level: 'log', args: [] },
      { type: 'runtime-error', message: 'boom' },
      { type: 'runtime-error', message: 'boom', stack: 'at x', kind: 'unhandledrejection' },
      { type: 'storage-reset', ok: true },
      { type: 'storage-reset', ok: false, requestId: 2, errors: ['blocked'] },
      { type: 'thumbnail', webp: 'data:image/webp;base64,AAAA' },
    ]) {
      expect(parseShellToApp(m), JSON.stringify(m)).toMatchObject({ ok: true });
    }
  });

  it('rejects invalid messages', () => {
    for (const m of [
      { type: 'hello' },
      { type: 'hello', protocol: '1' },
      { type: 'connected', nonce: 'short' },
      { type: 'connected', nonce: 'x'.repeat(20) + '<script>' },
      { type: 'ready' },
      { type: 'pong' },
      { type: 'pong', seq: '1' },
      { type: 'ping', seq: 1 }, // app -> shell
      { type: 'console', level: 'trace', args: [] },
      { type: 'console', level: 'log', args: [1] },
      { type: 'console', level: 'log' },
      { type: 'runtime-error' },
      { type: 'runtime-error', message: 'x', kind: 'other' },
      { type: 'thumbnail', webp: 'data:image/png;base64,AAAA' },
      validLoad, // app -> shell message on the wrong direction
    ]) {
      expect(parseShellToApp(m).ok, JSON.stringify(m)).toBe(false);
    }
  });

  it('rejects oversized console and error payloads', () => {
    const longArg = 'x'.repeat(LIMITS.consoleArgMaxChars + 1);
    expect(parseShellToApp({ type: 'console', level: 'log', args: [longArg] }).ok).toBe(false);
    const manyArgs = Array.from({ length: LIMITS.consoleMaxArgs + 1 }, () => 'a');
    expect(parseShellToApp({ type: 'console', level: 'log', args: manyArgs }).ok).toBe(false);
    expect(
      parseShellToApp({
        type: 'runtime-error',
        message: 'x'.repeat(LIMITS.errorMessageMaxChars + 1),
      }).ok,
    ).toBe(false);
    expect(
      parseShellToApp({
        type: 'runtime-error',
        message: 'x',
        stack: 'x'.repeat(LIMITS.errorStackMaxChars + 1),
      }).ok,
    ).toBe(false);
    expect(
      parseShellToApp({
        type: 'thumbnail',
        webp: 'data:image/webp;base64,' + 'A'.repeat(LIMITS.thumbnailMaxChars),
      }).ok,
    ).toBe(false);
  });
});

describe('parseConnect', () => {
  it('accepts a generated nonce and rejects malformed ones', () => {
    expect(
      parseConnect({ type: 'connect', protocol: PROTOCOL_VERSION, nonce: createNonce() }).ok,
    ).toBe(true);
    expect(parseConnect({ type: 'connect', protocol: PROTOCOL_VERSION, nonce: '' }).ok).toBe(false);
    expect(parseConnect({ type: 'connect', protocol: PROTOCOL_VERSION }).ok).toBe(false);
    expect(parseConnect({ type: 'hello', protocol: PROTOCOL_VERSION }).ok).toBe(false);
  });

  it('generates distinct nonces', () => {
    const set = new Set(Array.from({ length: 100 }, () => createNonce()));
    expect(set.size).toBe(100);
  });
});

describe('serialization (shell side)', () => {
  it('truncates with a marker', () => {
    expect(truncate('abc', 5)).toBe('abc');
    const t = truncate('x'.repeat(100), 50);
    expect(t.length).toBe(50);
    expect(t).toContain('truncated');
  });

  it('serializes console args so they always pass the app-side schema', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    const throwing = {
      get boom() {
        throw new Error('getter');
      },
    };
    const args = [
      'hello',
      42,
      undefined,
      null,
      10n,
      Symbol('s'),
      () => 1,
      new Error('bad'),
      circular,
      throwing,
      [1, [2, [3, [4, [5]]]]],
      { big: 'y'.repeat(10_000) },
      new Map([[1, 2]]),
      ...Array.from({ length: 30 }, (_, i) => i),
    ];
    const out = serializeConsoleArgs(args);
    expect(out.length).toBe(LIMITS.consoleMaxArgs);
    expect(out[0]).toBe('hello');
    expect(out[out.length - 1]).toMatch(/more arguments/);
    expect(out[8]).toContain('[Circular]');
    expect(out[9]).toContain('[Throws]');
    expect(out[7]).toContain('bad');
    const r = parseShellToApp({ type: 'console', level: 'log', args: out });
    expect(r.ok).toBe(true);
  });

  it('serializeValue never throws on hostile proxies', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    expect(() => serializeValue(hostile)).not.toThrow();
  });

  it('describeThrown produces bounded error payloads', () => {
    const e = new Error('m'.repeat(5000));
    const d = describeThrown(e);
    expect(d.message.length).toBeLessThanOrEqual(LIMITS.errorMessageMaxChars);
    expect(parseShellToApp({ type: 'runtime-error', ...d }).ok).toBe(true);
    expect(describeThrown('plain string').message).toBe('plain string');
    expect(describeThrown(undefined).message).toBe('undefined');
  });
});
