/**
 * PlaywrightRenderer against the real shell capture page (protocol v2: a site pack served by
 * the site worker) and real Chromium (no Supabase): readiness (signal / idle / cap), the
 * navigation guard, popups, modals, the hard timeout, and the capture gate refusing bad
 * signatures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signCaptureUrl } from '@br/sandbox-shell/capture-sig';
import { decodeRaw, isBlank, pixelStats } from '../src/image';
import { PlaywrightRenderer } from '../src/playwright-renderer';
import { RenderError } from '../src/renderer';
import {
  SECRET,
  SITE_PACK_TYPE,
  builtSite,
  colorClose,
  scriptSite,
  sitePack,
  startFileServer,
  startFixtures,
  type FileServer,
  type Fixtures,
} from './support';

const VIEWPORT = { width: 1280, height: 800 };
let fx: Fixtures;
let files: FileServer;
let renderer: PlaywrightRenderer;

function serve(path: string, site: Record<string, string>): void {
  files.files.set(path, { body: sitePack(site), type: SITE_PACK_TYPE });
}

beforeAll(async () => {
  files = await startFileServer();
  fx = await startFixtures([files.url]);
  renderer = new PlaywrightRenderer();
  serve(
    '/built.bin',
    builtSite({ title: 'Snack Overflow', background: 'rgb(255, 87, 34)', signalReady: true }),
  );
  serve(
    '/quiet.bin',
    builtSite({ title: 'No signal', background: 'rgb(33, 150, 243)', signalReady: false }),
  );
  const paint = `document.body.style.cssText = 'margin:0;background:#2e7d32';
document.body.innerHTML = '<h1 style="color:#fff;font:bold 96px sans-serif;margin:40px">hi</h1>';`;
  serve('/hang.bin', scriptSite(`${paint}\nfetch('${files.url}/hang').catch(() => {});`));
  serve(
    '/escape.bin',
    scriptSite(`${paint}
const tries = [];
try { window.open('${files.url}/popup'); tries.push('open'); } catch (e) { tries.push('open threw'); }
try { top.location.href = '${files.url}/top'; } catch (e) { tries.push('top threw'); }
// The site may reach the (same-origin) capture page's DOM and make it navigate itself, here
// with a link of its own (its CSP stops parent.eval): the renderer must block that.
try {
  const a = parent.document.createElement('a');
  a.href = '${files.url}/via-parent';
  parent.document.body.append(a);
  a.click();
} catch (e) { tries.push('link threw'); }
alert('modal must not block'); confirm('x'); prompt('y');
window.buildRoulette.ready();`),
  );
  serve('/loop.bin', scriptSite(`${paint}\nsetTimeout(() => { for (;;) {} }, 100);`));
});

afterAll(async () => {
  await renderer.close();
  await fx.close();
  await files.close();
});

async function captureUrl(src: string) {
  return signCaptureUrl({
    captureUrl: fx.shell.captureUrl,
    src: `${files.url}${src}`,
    exp: Math.floor(Date.now() / 1000) + 60,
    secret: SECRET,
  });
}

describe('PlaywrightRenderer + shell capture page', () => {
  it('renders a built site at 1280×800 and takes the ready signal', async () => {
    const result = await renderer.render({
      url: await captureUrl('/built.bin'),
      viewport: VIEWPORT,
      timeoutMs: 20_000,
    });
    expect(result.ready.reason).toBe('signal');
    expect(result.ready.afterMs).toBeLessThan(6000);
    const img = await decodeRaw(result.image);
    expect([img.width, img.height]).toEqual([1280, 800]);
    const stats = pixelStats(img);
    expect(isBlank(stats)).toBe(false);
    // The colour comes from the stylesheet, the title from a lazy chunk and /data.json: the
    // site worker served every file of the pack.
    expect(colorClose(stats.dominant, { r: 255, g: 87, b: 34 })).toBe(true);
    expect(result.notes).toContain('ready');
    expect(result.notes).toContain('loaded');
    // The site frame's navigation (/?__br_site=…) is answered by the site worker: the
    // navigation guard neither sees nor blocks it.
    expect(result.blocked).toEqual({ navigations: 0, popups: 0 });
  });

  it('without a signal: network idle + 2 s', async () => {
    const result = await renderer.render({
      url: await captureUrl('/quiet.bin'),
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
      url: await captureUrl('/hang.bin'),
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
      url: await captureUrl('/escape.bin'),
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
      .render({ url: await captureUrl('/loop.bin'), viewport: VIEWPORT, timeoutMs: 9000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(12_000);

    const again = await renderer.render({
      url: await captureUrl('/built.bin'),
      viewport: VIEWPORT,
      timeoutMs: 20_000,
    });
    expect(again.ready.reason).toBe('signal');
  });

  it('a bad or expired signature: the gate serves nothing (shell-refused)', async () => {
    const good = await captureUrl('/built.bin');
    const forged = good.replace(/sig=[^&]+/, `sig=${'A'.repeat(43)}`);
    const expired = await signCaptureUrl({
      captureUrl: fx.shell.captureUrl,
      src: `${files.url}/built.bin`,
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

  it('a missing site pack fails fast with the page hint', async () => {
    const t0 = Date.now();
    const err = await renderer
      .render({ url: await captureUrl('/nope.bin'), viewport: VIEWPORT, timeoutMs: 20_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as Error).message).toContain('site.bin: HTTP 404');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
