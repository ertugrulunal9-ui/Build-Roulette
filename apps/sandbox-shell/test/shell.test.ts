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
    expect(SHELL_BASE_PATH).toBe('/v2/');
    // Budget guard: most of shell.js is zod (see the @br/runtime README).
    expect(gzipSync(built.js).byteLength).toBeLessThan(16 * 1024);
    // No package CDN machinery any more, and no zip reader (the site pack is not a zip).
    expect(built.js).not.toContain('esm.sh');
    expect(built.js).not.toContain('Package server');
    expect(built.js).not.toContain('importmap');
  });

  it("builds the site worker with the sites' headers baked in", async () => {
    const built = await buildShell({
      appOrigins: ['https://buildroulette.app'],
      extraConnectSrc: ['http://127.0.0.1:54321'],
    });
    expect(built.swJs).not.toContain('__BR_SITE_HEADERS__');
    expect(built.swJs).not.toContain('__BR_CAPTURE_PATH__');
    expect(built.swJs).toContain("frame-ancestors 'self' https://buildroulette.app");
    expect(built.swJs).toContain("frame-ancestors 'self'; base-uri");
    expect(built.swJs).toContain('http://127.0.0.1:54321');
    expect(built.swJs).toContain('/v2/capture');
    expect(built.swJs).toContain('br-sandbox-sites-v2');
    expect(gzipSync(built.swJs).byteLength).toBeLessThan(8 * 1024);
  });

  it('builds the capture page script without app origins or secrets', async () => {
    const built = await buildShell({ appOrigins: ['https://buildroulette.app'] });
    expect(built.captureJs).toContain('[br-capture]');
    expect(built.captureJs).not.toContain('https://buildroulette.app');
    // No HMAC code in the public script: verification happens in the gate only.
    expect(built.captureJs).not.toContain('HMAC');
    expect(built.captureJs).not.toContain('br-capture-v');
    expect(gzipSync(built.captureJs).byteLength).toBeLessThan(16 * 1024);
  });

  it('rejects malformed origins', async () => {
    await expect(buildShell({ appOrigins: ['https://buildroulette.app/path'] })).rejects.toThrow(
      'invalid app origin',
    );
  });
});
