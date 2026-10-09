/**
 * PlaywrightRenderer against the real shell capture page and real Chromium (no Supabase):
 * readiness (signal / idle / cap), the navigation guard, popups, modals, the hard timeout,
 * and the capture gate refusing bad signatures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signCaptureUrl } from '@br/sandbox-shell/capture-sig';
import { decodeRaw, isBlank, pixelStats } from '../src/image';
import { PlaywrightRenderer } from '../src/playwright-renderer';
import { RenderError } from '../src/renderer';
import {
  SECRET,
  buildReactBundle,
  colorClose,
  reactApp,
  startFileServer,
  startFixtures,
  type FileServer,
  type Fixtures,
} from './support';

const VIEWPORT = { width: 1280, height: 800 };
let fx: Fixtures;
let files: FileServer;
let renderer: PlaywrightRenderer;
let importMap: string;

beforeAll(async () => {
  files = await startFileServer();
  fx = await startFixtures([files.url]);
  renderer = new PlaywrightRenderer();
  const react = await buildReactBundle(
    fx.cdn.url,
    reactApp({ title: 'Snack Overflow', background: 'rgb(255, 87, 34)', signalReady: true }),
  );
  files.files.set('/react.js', { body: react.js, type: 'text/javascript' });
  files.files.set('/react.css', { body: react.css, type: 'text/css' });
  const quiet = await buildReactBundle(
    fx.cdn.url,
    reactApp({ title: 'No signal', background: 'rgb(33, 150, 243)', signalReady: false }),
  );
  files.files.set('/quiet.js', { body: quiet.js, type: 'text/javascript' });
  files.files.set('/quiet.css', { body: quiet.css, type: 'text/css' });
  importMap = JSON.stringify(
    (await import('@br/runtime/bundler')).buildImportMap(
      { react: '19.3.0', 'react-dom': '19.3.0' },
      fx.cdn.url,
    ),
  );
  const paint = `document.body.style.cssText = 'margin:0;background:#2e7d32';
document.body.innerHTML = '<h1 style="color:#fff;font:bold 96px sans-serif;margin:40px">hi</h1>';`;
  files.files.set('/hang.js', {
    body: `${paint}\nfetch('${files.url}/hang').catch(() => {});`,
    type: 'text/javascript',
  });
  files.files.set('/escape.js', {
    body: `${paint}
const tries = [];
try { window.open('${files.url}/popup'); tries.push('open'); } catch (e) { tries.push('open threw'); }
try { top.location.href = '${files.url}/top'; } catch (e) { tries.push('top threw'); }
// Code in the (same-origin) capture page realm may navigate it: the renderer must block that.
try { parent.eval("location.href = '${files.url}/via-parent'"); } catch (e) { tries.push('eval threw'); }
alert('modal must not block'); confirm('x'); prompt('y');
window.buildRoulette.ready();`,
    type: 'text/javascript',
  });
  files.files.set('/loop.js', {
    body: `${paint}\nsetTimeout(() => { for (;;) {} }, 100);`,
    type: 'text/javascript',
  });
});

afterAll(async () => {
  await renderer.close();
  await fx.close();
  await files.close();
});

async function captureUrl(src: string, extra: { css?: string; map?: string } = {}) {
  return signCaptureUrl({
    captureUrl: fx.shell.captureUrl,
    src: `${files.url}${src}`,
    css: extra.css === undefined ? undefined : `${files.url}${extra.css}`,
    map: extra.map,
    exp: Math.floor(Date.now() / 1000) + 60,
    secret: SECRET,
  });
}

describe('PlaywrightRenderer + shell capture page', () => {
  it('renders a React build at 1280×800 and takes the ready signal', async () => {
    const result = await renderer.render({
      url: await captureUrl('/react.js', { css: '/react.css', map: importMap }),
      viewport: VIEWPORT,
      timeoutMs: 20_000,
    });
    expect(result.ready.reason).toBe('signal');
    expect(result.ready.afterMs).toBeLessThan(6000);
    const img = await decodeRaw(result.image);
    expect([img.width, img.height]).toEqual([1280, 800]);
    const stats = pixelStats(img);
    expect(isBlank(stats)).toBe(false);
    expect(colorClose(stats.dominant, { r: 255, g: 87, b: 34 })).toBe(true);
    expect(result.notes).toContain('ready');
    expect(result.notes).toContain('loaded');
  });

  it('without a signal: network idle + 2 s', async () => {
    const result = await renderer.render({
      url: await captureUrl('/quiet.js', { css: '/quiet.css', map: importMap }),
      viewport: VIEWPORT,
      timeoutMs: 20_000,
    });
    expect(result.ready.reason).toBe('idle');
    expect(result.ready.afterMs).toBeGreaterThanOrEqual(2500);
    expect(result.ready.afterMs).toBeLessThan(6000);
    expect(
      colorClose(pixelStats(await decodeRaw(result.image)).dominant, { r: 33, g: 150, b: 243 }),
    ).toBe(true);
  });

  it('a request that never ends: capped at 6 s', async () => {
    const result = await renderer.render({
      url: await captureUrl('/hang.js'),
      viewport: VIEWPORT,
      timeoutMs: 20_000,
    });
    expect(result.ready.reason).toBe('cap');
    expect(result.ready.afterMs).toBeGreaterThanOrEqual(6000);
    expect(result.ready.afterMs).toBeLessThan(7000);
    expect(isBlank(pixelStats(await decodeRaw(result.image)))).toBe(false);
  });

  it('blocks popups, top-level navigations and modals; the capture still succeeds', async () => {
    const result = await renderer.render({
      url: await captureUrl('/escape.js'),
      viewport: VIEWPORT,
      timeoutMs: 20_000,
    });
    expect(result.ready.reason).toBe('signal');
    expect(result.blocked.popups).toBe(0); // the CSP sandbox already stops window.open
    expect(result.blocked.navigations).toBeGreaterThanOrEqual(1); // parent.eval navigation
    expect(result.notes.some((n) => n.startsWith('blocked navigation to http://127.0.0.1'))).toBe(
      true,
    );
    const stats = pixelStats(await decodeRaw(result.image));
    expect(colorClose(stats.dominant, { r: 46, g: 125, b: 50 })).toBe(true);
  });

  it('an infinite loop hits the hard timeout, and the renderer keeps working', async () => {
    const t0 = Date.now();
    const err = await renderer
      .render({ url: await captureUrl('/loop.js'), viewport: VIEWPORT, timeoutMs: 9000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(12_000);

    const again = await renderer.render({
      url: await captureUrl('/react.js', { css: '/react.css', map: importMap }),
      viewport: VIEWPORT,
      timeoutMs: 20_000,
    });
    expect(again.ready.reason).toBe('signal');
  });

  it('a bad or expired signature: the gate serves nothing (shell-refused)', async () => {
    const good = await captureUrl('/react.js');
    const forged = good.replace(/sig=[^&]+/, `sig=${'A'.repeat(43)}`);
    const expired = await signCaptureUrl({
      captureUrl: fx.shell.captureUrl,
      src: `${files.url}/react.js`,
      exp: Math.floor(Date.now() / 1000) - 1,
      secret: SECRET,
    });
    for (const url of [forged, expired]) {
      const err = await renderer
        .render({ url, viewport: VIEWPORT, timeoutMs: 10_000 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RenderError);
      expect((err as RenderError).code).toBe('shell-refused');
      expect((err as Error).message).not.toContain('sig=');
    }
  });

  it('a missing bundle fails fast with the page hint', async () => {
    const t0 = Date.now();
    const err = await renderer
      .render({ url: await captureUrl('/nope.js'), viewport: VIEWPORT, timeoutMs: 20_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as Error).message).toContain('bundle.js: HTTP 404');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
