import { expect, test } from '@playwright/test';
import { CDN_ORIGIN, buildFrame, setCdnOutage } from './helpers';
import { createRoom, joinByLink, newPlayer, waitForBuild, type Player } from './rooms';

/**
 * T-032: the room lobby warms the template's packages into each desktop browser's cache
 * (TemplateWarmup), so the package CDN can go down before SPIN and the BUILD previews still
 * run React. playwright.multi.config.ts (the real local stack with Realtime).
 */

test.afterEach(async ({ request }) => {
  await setCdnOutage(request, 'off');
});

/** The warm-up fetches the import map in order; react-dom/client is the last URL. */
function warmedUp(p: Player) {
  return p.page.waitForEvent('requestfinished', {
    predicate: (r) =>
      r.url().startsWith(`${CDN_ORIGIN}/react-dom@`) && r.url().includes('/client?'),
    timeout: 30_000,
  });
}

test('the CDN goes down in the lobby: BUILD still renders the template from the cache', async ({
  browser,
}, info) => {
  const host = await newPlayer(browser, info, 'Ann Offline');
  const bob = await newPlayer(browser, info, 'Ben Offline');
  const hostWarm = warmedUp(host);
  const code = await createRoom(host);
  const bobWarm = warmedUp(bob);
  await joinByLink(bob, code);
  await Promise.all([hostWarm, bobWarm]);

  await setCdnOutage(host.page, 'refuse');
  const failed: string[] = [];
  for (const p of [host, bob]) {
    p.page.on('requestfailed', (r) => {
      if (r.url().startsWith(CDN_ORIGIN)) failed.push(r.url());
    });
  }

  for (const p of [host, bob]) {
    await p.page.getByTestId('ready-toggle').click();
    await expect(p.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(host.page.getByTestId('start-battle')).toBeEnabled();
  await host.page.getByTestId('start-battle').click();

  for (const p of [host, bob]) {
    await waitForBuild(p.page);
    const frame = buildFrame(p.page);
    await expect(frame.locator('h1')).toHaveText('Hello, Build Roulette!');
    await frame.getByRole('button').click();
    await expect(frame.getByRole('button')).toHaveText('Clicked 1 time');
    await expect(p.page.getByTestId('error-overlay')).toHaveCount(0);
  }
  expect(failed).toEqual([]);
  expect([...host.errors, ...bob.errors]).toEqual([]);
});
