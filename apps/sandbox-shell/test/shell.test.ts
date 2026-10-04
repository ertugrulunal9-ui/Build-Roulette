import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildShell, SHELL_BASE_PATH } from '../src/build-shell';

describe('buildShell', () => {
  it('bakes the app origins in and stays small', async () => {
    const built = await buildShell({
      appOrigins: ['https://buildroulette.app', 'http://localhost:3000'],
    });
    expect(built.js).toContain('https://buildroulette.app');
    expect(built.js).toContain('http://localhost:3000');
    expect(built.js).not.toContain('__BR_APP_ORIGINS__');
    expect(built.html).toContain('<script src="./shell.js"></script>');
    expect(SHELL_BASE_PATH).toBe('/v1/');
    // Budget guard: most of shell.js is zod (see the @br/runtime README).
    expect(gzipSync(built.js).byteLength).toBeLessThan(16 * 1024);
  });

  it('builds the capture page script without app origins or secrets', async () => {
    const built = await buildShell({ appOrigins: ['https://buildroulette.app'] });
    expect(built.captureJs).toContain('[br-capture]');
    expect(built.captureJs).not.toContain('https://buildroulette.app');
    // No HMAC code in the public script: verification happens in the gate only.
    expect(built.captureJs).not.toContain('HMAC');
    expect(built.captureJs).not.toContain('br-capture-v1');
    expect(gzipSync(built.captureJs).byteLength).toBeLessThan(16 * 1024);
  });

  it('rejects malformed origins', async () => {
    await expect(buildShell({ appOrigins: ['https://buildroulette.app/path'] })).rejects.toThrow(
      'invalid app origin',
    );
  });
});
