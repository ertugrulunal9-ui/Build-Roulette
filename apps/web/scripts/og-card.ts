/**
 * Draws the static social card, public/og-card.png (1200×630): the `og:image` of a battle
 * without a screenshot to show (lib/solo/og-image.ts, T-033). Run it again after changing the
 * design, and commit the PNG:
 *
 *   pnpm --filter @br/web og-card
 *
 * Playwright's Chromium renders the HTML below once; nothing renders a card per request.
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../public/og-card.png', import.meta.url));

const chip = (text: string, bg: string, fg: string) =>
  `<span style="background:${bg};color:${fg};font-size:26px;font-weight:900;letter-spacing:6px;padding:6px 18px;border-radius:10px">${text}</span>`;

const html = `<!doctype html>
<html><body style="margin:0">
<div style="box-sizing:border-box;width:1200px;height:630px;padding:0 88px;display:flex;flex-direction:column;justify-content:center;background:#09090b;color:#fafafa;font-family:system-ui,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="font-size:26px;font-weight:800;letter-spacing:6px;color:#a1a1aa">A PARTY GAME FOR VIBE CODERS</div>
  <div style="font-size:124px;font-weight:900;letter-spacing:-3px;line-height:1.05;margin:14px 0 34px">Build Roulette</div>
  <div style="display:flex;gap:18px;margin-bottom:46px">
    ${chip('BUILD', '#0ea5e9', '#ffffff')}${chip('RULE', '#f59e0b', '#1c1917')}${chip('STYLE', '#d946ef', '#ffffff')}
  </div>
  <div style="font-size:42px;font-weight:800;color:#d4d4d8">Builds are temporary. Results are permanent.</div>
</div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html);
  await page.screenshot({ path: out, type: 'png' });
  process.stdout.write(`wrote ${out}\n`);
} finally {
  await browser.close();
}
