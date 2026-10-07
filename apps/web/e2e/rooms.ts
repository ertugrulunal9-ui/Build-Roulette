/**
 * Helpers for the rooms e2e (multiplayer.spec.ts) and the chaos e2e (chaos.spec.ts): browser
 * contexts as anonymous players, joining, the BUILD screen, shipping, and IndexedDB reads.
 */
import {
  devices,
  expect,
  type Browser,
  type BrowserContext,
  type FrameLocator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { trackPage } from './diagnostics';
import { buildFrame, clickRouted, replaceEditorText } from './helpers';
import { sql } from './stack';

export interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

export interface PlayerOptions {
  /**
   * Shifts this player's clock (`Date`, in every frame) by this many ms, like a computer
   * whose system clock is wrong. `performance.now()` is a monotonic clock and stays as is.
   */
  clockSkewMs?: number;
}

/** A fresh browser context: its own storage, so its own anonymous user. */
export async function newPlayer(
  browser: Browser,
  info: TestInfo,
  name: string,
  opts: PlayerOptions = {},
): Promise<Player> {
  const baseURL = info.project.use.baseURL;
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    viewport: { width: 1440, height: 900 },
  });
  if (opts.clockSkewMs) await context.addInitScript(skewClock, opts.clockSkewMs);
  // Every page of the context is logged for diagnostics.ts (a failure attaches the logs).
  context.on('page', (pg) => {
    trackPage(info, name, pg);
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { name, context, page, errors };
}

/**
 * A phone: Playwright's iPhone 13 profile (390×664 viewport, touch, mobile, DPR 3) in the
 * same Chromium as everyone else. It matches `(hover: none) and (pointer: coarse)`, which
 * is what the app checks (src/lib/device.ts).
 */
export async function newPhone(browser: Browser, info: TestInfo, name: string): Promise<Player> {
  const baseURL = info.project.use.baseURL;
  // The profile's default browser is WebKit; newContext only takes its device settings.
  const phone = devices['iPhone 13'];
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), ...phone });
  context.on('page', (pg) => {
    trackPage(info, name, pg);
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { name, context, page, errors };
}

/** Nothing on the page is wider than the viewport (no horizontal scrolling). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  // On a mobile viewport, content wider than the device makes Chromium widen the layout
  // viewport (`innerWidth` grows with it), so measure against the device width instead:
  // `clientWidth` of the root (the `width=device-width` viewport) and the visual viewport.
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: Math.min(
      document.documentElement.clientWidth,
      window.visualViewport?.width ?? Number.POSITIVE_INFINITY,
    ),
    innerWidth: window.innerWidth,
  }));
  expect(
    widths.scroll,
    `page wider than the viewport: ${JSON.stringify(widths)}`,
  ).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
  expect(widths.innerWidth, 'the layout viewport was widened').toBeLessThanOrEqual(widths.viewport);
}

/** Runs in the page (an init script): `Date` reads a clock that is `offset` ms off. */
function skewClock(offset: number): void {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class SkewedDate extends RealDate {
    constructor(...args: [] | [string | number | Date]) {
      if (args.length === 0) super(realNow() + offset);
      else super(args[0]);
    }
    static override now(): number {
      return realNow() + offset;
    }
  }
  // `Date()` without `new` returns a string.
  const SkewedDateFn = new Proxy(SkewedDate, {
    apply: () => new SkewedDate().toString(),
  });
  Object.defineProperty(globalThis, 'Date', {
    value: SkewedDateFn,
    configurable: true,
    writable: true,
  });
}

/** Opens the invite link and joins with `name` (no profile yet: the name prompt). */
export async function joinByLink(p: Player, code: string): Promise<void> {
  await p.page.goto(`/r/${code}`);
  const input = p.page.getByTestId('display-name');
  await expect(input).not.toHaveValue(''); // a fun default
  await input.fill(p.name);
  await p.page.getByTestId('join-room').click();
}

/** Creates a room from the landing page; returns its code. */
export async function createRoom(host: Player): Promise<string> {
  await host.page.goto('/');
  await host.page.getByTestId('create-room').click();
  await expect(host.page.getByTestId('host-name')).not.toHaveValue('');
  await host.page.getByTestId('host-name').fill(host.name);
  await host.page.getByTestId('create-room-submit').click();
  await expect(host.page).toHaveURL(/\/r\/[A-HJ-NP-Z2-9]{5}$/);
  await expect(host.page.getByTestId('lobby')).toBeVisible();
  return new URL(host.page.url()).pathname.split('/').pop() ?? '';
}

export const member = (page: Page, name: string) =>
  page.locator(`[data-testid=member][data-name="${name}"]`);
export const progress = (page: Page, name: string) =>
  page.locator(`[data-testid=progress-player][data-name="${name}"]`);

export async function openFile(page: Page, path: string): Promise<void> {
  await page.locator(`[data-testid=file-item][data-path="${path}"] > button`).first().click();
  await expect(page.getByTestId('active-file')).toHaveText(path);
}

/** SPIN is over and the template's first preview is up. */
export async function waitForBuild(page: Page): Promise<void> {
  await expect(page.getByTestId('spin')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('build-stage')).toBeVisible();
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
    timeout: 30_000,
  });
}

/** `extra`: more JSX inside the page (e.g. {@link FREEZE_BUTTON}). */
export function appSource(title: string, background: string, extra = ''): string {
  return `export function App() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeContent: 'center', background: '${background}', color: 'white' }}>
      <h1 className="e2e-title">${title}</h1>${extra}
    </main>
  );
}
`;
}

/**
 * A button that hangs the build's main thread for good, shortly after the click (so the
 * click itself is acknowledged first and the test driver does not wait on a hung frame).
 */
export const FREEZE_BUTTON = `
      <button className="e2e-freeze" onClick={() => { setTimeout(() => { for (;;) {} }, 300); }}>Freeze</button>`;

/** Writes src/App.tsx through the editor; `waitForPreview` waits for the new preview. */
export async function writeApp(
  page: Page,
  title: string,
  background: string,
  { waitForPreview = true, extra = '' }: { waitForPreview?: boolean; extra?: string } = {},
): Promise<void> {
  await openFile(page, 'src/App.tsx');
  await replaceEditorText(page, appSource(title, background, extra));
  if (waitForPreview) {
    await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText(title);
  }
}

/**
 * Ships from the BUILD screen. `last`: this is the last roster player to ship, so BUILD ends
 * at once (everyone shipped) and the page may go straight to the REVEAL instead of showing
 * the shipped banner.
 */
export async function ship(
  page: Page,
  name: string,
  { last = false }: { last?: boolean } = {},
): Promise<void> {
  await page.getByTestId('ship-button').click();
  await page.getByTestId('build-name').fill(name);
  // The dialog is drawn over the cross-site preview iframe (see clickRouted).
  await clickRouted(page.getByTestId('confirm-ship'));
  if (last) {
    await expect(
      page.getByTestId('shipped-banner').or(page.getByTestId('reveal-stage')),
    ).toBeVisible();
    return;
  }
  // Shipped: the dialog closes; a banner says the build is locked.
  await expect(page.getByTestId('shipped-banner')).toContainText(`Shipped “${name}”`);
  await expect(page.getByTestId('ship-dialog')).toBeHidden();
}

export async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** Hides and shows the tab: the battle autosaves now (as on a real tab switch). */
export async function autosaveNow(page: Page): Promise<void> {
  await setVisibility(page, 'hidden');
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  await setVisibility(page, 'visible');
}

/** The workspace text of `path` stored in this page's IndexedDB under `battle:{id}`. */
export async function storedFile(
  page: Page,
  battleId: string,
  path: string,
): Promise<string | null> {
  return page.evaluate(
    async ({ key, path }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('br-workspaces');
        req.onsuccess = () => {
          resolve(req.result);
        };
        req.onerror = () => {
          reject(new Error('open failed'));
        };
      });
      const tx = db.transaction('workspaces', 'readonly');
      const value = await new Promise<unknown>((resolve) => {
        const r = tx.objectStore('workspaces').get(key);
        r.onsuccess = () => {
          resolve(r.result as unknown);
        };
      });
      db.close();
      const files = (value as { files?: Record<string, string> } | undefined)?.files;
      return files?.[path] ?? null;
    },
    { key: `battle:${battleId}`, path },
  );
}

/** The live REVEAL build in this page: preview iframe → shell → the build's document. */
export function revealLive(page: Page): FrameLocator {
  return page.frameLocator('[data-testid=reveal-live-frame]').frameLocator('iframe');
}

/** Clicks a vote card (`category`, build id) and waits until the server confirmed it. */
export async function vote(page: Page, category: string, buildId: string): Promise<void> {
  const option = page.locator(
    `[data-testid=vote-category][data-category=${category}] [data-testid=vote-option][data-build="${buildId}"]`,
  );
  await option.click();
  await expect(option).toHaveAttribute('data-selected', 'true');
}

export const battleOf = (code: string) =>
  sql(`select current_battle_id from public.rooms where code = '${code}'`);
export const phaseOf = (battleId: string) =>
  sql(`select phase from public.battles where id = '${battleId}'`);
export const userIdOf = (code: string, name: string) =>
  sql(
    `select m.user_id from public.room_members m join public.rooms r on r.id = m.room_id join public.profiles p on p.id = m.user_id where r.code = '${code}' and p.display_name = '${name}'`,
  );
