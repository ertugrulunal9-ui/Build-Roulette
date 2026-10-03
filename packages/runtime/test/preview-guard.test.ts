import { PROTOCOL_VERSION } from '@br/protocol';
import { describe, expect, it } from 'vitest';
import { checkHello } from '../src/preview/preview-handle';

const SHELL_ORIGIN = 'https://b123.usercontent.example';
const frameWindow = { name: 'the preview iframe window' };
const otherWindow = { name: 'some other window' };
const hello = { type: 'hello', protocol: PROTOCOL_VERSION };

describe('checkHello (handshake guard)', () => {
  it('accepts a hello from our iframe window and the shell origin', () => {
    expect(
      checkHello(
        { origin: SHELL_ORIGIN, source: frameWindow, data: hello },
        frameWindow,
        SHELL_ORIGIN,
      ),
    ).toEqual({ ok: true, value: hello });
  });

  it('rejects the right origin from a different window (e.g. another copy of the shell)', () => {
    const r = checkHello(
      { origin: SHELL_ORIGIN, source: otherWindow, data: hello },
      frameWindow,
      SHELL_ORIGIN,
    );
    expect(r).toMatchObject({ ok: false, error: 'source is not the preview iframe' });
  });

  it('rejects our window with a wrong origin (e.g. the frame navigated elsewhere)', () => {
    const r = checkHello(
      { origin: 'https://evil.example', source: frameWindow, data: hello },
      frameWindow,
      SHELL_ORIGIN,
    );
    expect(!r.ok && r.error).toContain('unexpected origin');
    // Same registrable domain, different build subdomain: still rejected.
    expect(
      checkHello(
        { origin: 'https://b999.usercontent.example', source: frameWindow, data: hello },
        frameWindow,
        SHELL_ORIGIN,
      ).ok,
    ).toBe(false);
  });

  it('rejects when there is no frame window yet (null source matches null window)', () => {
    expect(
      checkHello({ origin: SHELL_ORIGIN, source: null, data: hello }, null, SHELL_ORIGIN).ok,
    ).toBe(false);
  });

  it('rejects wrong protocol versions, other message types and garbage', () => {
    const ev = (data: unknown) => ({ origin: SHELL_ORIGIN, source: frameWindow, data });
    const v = checkHello(
      ev({ type: 'hello', protocol: PROTOCOL_VERSION + 1 }),
      frameWindow,
      SHELL_ORIGIN,
    );
    expect(!v.ok && v.error).toContain('unsupported protocol');
    expect(checkHello(ev({ type: 'heartbeat' }), frameWindow, SHELL_ORIGIN)).toMatchObject({
      ok: false,
      error: 'expected hello, got heartbeat',
    });
    expect(checkHello(ev('hello'), frameWindow, SHELL_ORIGIN).ok).toBe(false);
    expect(checkHello(ev(null), frameWindow, SHELL_ORIGIN).ok).toBe(false);
  });
});
