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
import { watchCsp } from './csp';
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
  await context.addInitScript(recordBundlerStarts);
  // Every page of the context is logged for diagnostics.ts (a failure attaches the logs).
  context.on('page', (pg) => {
    trackPage(info, name, pg);
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  watchCsp(page, errors);
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
  await context.addInitScript(recordBundlerStarts);
  context.on('page', (pg) => {
    trackPage(info, name, pg);
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  watchCsp(page, errors);
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

/** One step of a bundler start or of the BUILD screen, as the app page saw it (T-041). */
export interface BundlerStartEvent {
  /** The page's `performance.now()`, rounded. */
  t: number;
  /**
   * `created` … `terminated`: the bundler worker (`worker` counts them in this page; a stall
   * retry or the next battle makes a new one). `request`: its first message (it runs and sent
   * the esbuild.wasm request); `last-byte`: the download is complete (`loaded` bytes); `ready`:
   * esbuild-wasm is ready. `spin`: the SPIN screen appeared; `built`: the build status turned
   * to "Built in …".
   */
  type: 'created' | 'request' | 'last-byte' | 'ready' | 'error' | 'terminated' | 'spin' | 'built';
  worker?: number;
  loaded?: number;
}

/**
 * Runs in every page of a player (an init script, T-041): records the bundler worker's start
 * steps and when SPIN appeared and the first build was done, in `window.__brStarts`, and logs
 * them to the console (so they are in players.md). `waitForBuild` names them when the first
 * build does not come, and `buildStartMetrics` sums them up.
 */
function recordBundlerStarts(): void {
  if (window.top !== window) return; // the app page, not the preview frames
  const events: {
    t: number;
    type: string;
    worker: number | undefined;
    loaded: number | undefined;
  }[] = [];
  (window as unknown as { __brStarts: typeof events }).__brStarts = events;
  const add = (type: string, worker?: number, loaded?: number) => {
    events.push({ t: Math.round(performance.now()), type, worker, loaded });
    if (events.length > 500) events.splice(0, events.length - 500);
    const what = worker === undefined ? type : `worker ${String(worker)} ${type}`;
    console.debug(`[e2e bundler] ${what}${loaded ? ` (${String(loaded)} B)` : ''}`);
  };
  const Native = window.Worker;
  let workers = 0;
  class RecordingWorker extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name !== 'br-bundler') return; // runtime-factory.ts names it
      const n = ++workers;
      let requested = false;
      add('created', n);
      this.addEventListener('message', (e: MessageEvent<{ type?: unknown; stage?: unknown }>) => {
        const m = e.data;
        if (m.type === 'init-progress' && !requested) {
          requested = true;
          add('request', n);
        }
        if (m.type === 'init-progress' && m.stage === 'compile') {
          add('last-byte', n, (m as { loaded?: number }).loaded);
        }
        if (m.type === 'init-done') add('ready', n);
        if (m.type === 'init-error') add('error', n);
      });
      const terminate = this.terminate.bind(this);
      this.terminate = () => {
        add('terminated', n);
        terminate();
      };
    }
  }
  window.Worker = RecordingWorker;
  // SPIN and the first build: a cheap look four times a second.
  let spinning = false;
  let built = false;
  setInterval(() => {
    const spin = document.querySelector('[data-testid="spin"]') !== null;
    if (spin && !spinning) {
      add('spin');
      built = false;
    }
    spinning = spin;
    const status = document.querySelector('[data-testid="build-status"]')?.textContent ?? '';
    if (status.startsWith('Built in') && !built) {
      built = true;
      add('built');
    } else if (!status.startsWith('Built in')) {
      built = false;
    }
  }, 250);
}

/** The page's recorded steps, and its clock now. */
export async function bundlerStarts(
  page: Page,
): Promise<{ events: BundlerStartEvent[]; now: number }> {
  return page.evaluate(() => ({
    events: (window as unknown as { __brStarts?: BundlerStartEvent[] }).__brStarts ?? [],
    now: Math.round(performance.now()),
  }));
}

/** The steps since the last SPIN, in ms after it: `spin 0, worker 1 created +40, …`. */
export function describeBundlerStarts({
  events,
  now,
}: {
  events: BundlerStartEvent[];
  now: number;
}): string {
  const lastSpin = events.findLastIndex((e) => e.type === 'spin');
  const since = lastSpin >= 0 ? events.slice(lastSpin) : events;
  const t0 = since[0]?.t ?? now;
  const steps = since.map(
    (e) =>
      `${e.worker === undefined ? '' : `worker ${String(e.worker)} `}${e.type}${e.loaded ? ` (${(e.loaded / 1e6).toFixed(1)} MB)` : ''} +${String(e.t - t0)}`,
  );
  if (!since.some((e) => e.type === 'created')) steps.push('(no bundler worker yet)');
  return `${steps.join(', ')}; now +${String(now - t0)} ms`;
}

/**
 * For a battle start (all pages just showed their first build, T-041): per page, ms from SPIN
 * to the bundler worker's creation, to esbuild-wasm ready and to "Built in", and how many
 * workers stopped before they were ready (stall retries).
 */
export async function buildStartMetrics(pages: Page[]): Promise<string> {
  const rows = await Promise.all(
    pages.map(async (page) => {
      const { events } = await bundlerStarts(page);
      const lastSpin = events.findLastIndex((e) => e.type === 'spin');
      const since = events.slice(Math.max(0, lastSpin));
      const t0 = since[0]?.t ?? 0;
      const at = (type: BundlerStartEvent['type']) => {
        const e = since.find((x) => x.type === type);
        return e ? e.t - t0 : NaN;
      };
      const readyWorkers = new Set(since.filter((e) => e.type === 'ready').map((e) => e.worker));
      const stopped = since.filter(
        (e) => e.type === 'terminated' && !readyWorkers.has(e.worker),
      ).length;
      return { created: at('created'), ready: at('ready'), built: at('built'), stopped };
    }),
  );
  const stat = (key: 'created' | 'ready' | 'built') => {
    const values = rows.map((r) => r[key]).filter((v) => !Number.isNaN(v));
    if (values.length === 0) return 'n/a';
    values.sort((a, b) => a - b);
    const p50 = values[Math.floor((values.length - 1) / 2)] ?? NaN;
    return `p50 ${String(p50)} ms, max ${String(values.at(-1))} ms`;
  };
  const stopped = rows.reduce((n, r) => n + r.stopped, 0);
  return `${String(pages.length)} pages, from SPIN: bundler worker created ${stat('created')}; esbuild-wasm ready ${stat('ready')}; first build ${stat('built')}; workers stopped before ready ${String(stopped)}`;
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

/**
 * SPIN is over and the template's first preview is up. If it does not come, the error says
 * how far this page's bundler start got (T-041): CI's artifacts are not always at hand.
 */
export async function waitForBuild(page: Page): Promise<void> {
  await expect(page.getByTestId('spin')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('build-stage')).toBeVisible();
  try {
    await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
      timeout: 30_000,
    });
  } catch (e) {
    const starts = await bundlerStarts(page).then(describeBundlerStarts, () => '(page gone)');
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n\nThis page since SPIN (its clock): ${starts}`,
      { cause: e },
    );
  }
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
