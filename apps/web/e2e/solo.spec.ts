import { expect, test, type Page } from '@playwright/test';
import { buildFrame, replaceEditorText } from './helpers';
import { battleRow, ephemeralObjects, sql } from './stack';

/**
 * The solo game end to end against the real local Supabase stack with the capture worker
 * running (playwright.solo.config.ts). Deadlines are forced with psql as the superuser.
 *
 * SOLO_SCREENSHOT_DIR=/some/dir also saves UI screenshots (spin, build, results, battle page).
 */

const SHOTS = process.env['SOLO_SCREENSHOT_DIR'];

async function snap(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t014-${name}.png` });
}

/** Name entry → Spin. Returns the battle id (from `?battle=`). */
async function startBattle(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('play-solo').click();
  await expect(page).toHaveURL(/\/play$/);
  const input = page.getByTestId('display-name');
  await expect(input).not.toHaveValue(''); // a random fun default
  await input.fill(name);
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  await expect(page.getByTestId('spin')).toBeVisible();
  await expect(page).toHaveURL(/[?&]battle=[0-9a-f-]{36}/);
  return new URL(page.url()).searchParams.get('battle') ?? '';
}

/** Waits until SPIN is over and the template's first preview is up. */
async function waitForBuild(page: Page): Promise<void> {
  await expect(page.getByTestId('spin')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('countdown')).toHaveAttribute('data-level', /normal|low/);
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
    timeout: 30_000,
  });
}

async function openFile(page: Page, path: string): Promise<void> {
  await page.locator(`[data-testid=file-item][data-path="${path}"] > button`).first().click();
  await expect(page.getByTestId('active-file')).toHaveText(path);
}

/** The colour at (x, y) of an image URL, decoded by the browser. */
async function pixel(page: Page, url: string, x: number, y: number) {
  return page.evaluate(
    async ({ url, x, y }) => {
      const res = await fetch(url);
      const bitmap = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      return { width: bitmap.width, height: bitmap.height, r, g, b };
    },
    { url, x, y },
  );
}

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 20;

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('ship: spin → build → ship → results (screenshot, speedrun) → destroy → permanent page', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const battle = await startBattle(page, 'E2E Shipper');
  // The reels land one after another on the server's cards.
  await expect(page.getByTestId('reel-build')).toHaveAttribute('data-landed', 'true');
  await snap(page, 'spin');
  const reelText = await page.getByTestId('reel-build').innerText();
  await expect(page.getByTestId('reel-time')).toHaveAttribute('data-landed', 'true');
  const card = sql(
    `select c.build_text from public.battles b join public.challenges c on c.id = b.challenge_id where b.id = '${battle}'`,
  );
  expect(reelText).toContain(card);

  // BUILD: the challenge header, the countdown, a fresh template.
  await waitForBuild(page);
  await expect(page.getByTestId('challenge')).toContainText(card);
  await expect(buildFrame(page).locator('h1')).toHaveText('Hello, Build Roulette!');
  await openFile(page, 'src/App.tsx');
  await replaceEditorText(
    page,
    `export function App() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeContent: 'center', background: 'rgb(255, 87, 34)', color: 'white' }}>
      <h1 className="e2e-title">Rocket Pomodoro</h1>
    </main>
  );
}
`,
  );
  await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText('Rocket Pomodoro');
  await snap(page, 'build');

  // SHIP.
  await page.getByTestId('ship-button').click();
  await expect(page.getByTestId('ship-dialog')).toContainText("You can't edit after");
  await page.getByTestId('build-name').fill('E2E Rocket');
  await page.getByTestId('confirm-ship').click();

  // RESULTS: speedrun, completion time, then the real screenshot from the capture worker.
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-title')).toHaveText('E2E Rocket');
  await expect(page.locator('[data-testid=award][data-award=speedrun]')).toBeVisible();
  await expect(page.getByTestId('completion-time')).toHaveText(/^\d+:\d\d\.\d$/);
  const shot = page.getByTestId('screenshot');
  await expect(shot).toHaveAttribute('data-capture', 'captured', { timeout: 90_000 });
  await expect
    .poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(1280);
  const src = (await shot.getAttribute('src')) ?? '';
  expect(src).toContain(`/storage/v1/object/public/screenshots/${battle}/`);
  const px = await pixel(page, src, 40, 760);
  expect(near(px.r, 255) && near(px.g, 87) && near(px.b, 34)).toBe(true);
  // The last look runs the shipped bundle in reveal mode.
  const reveal = page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe');
  await expect(reveal.locator('h1.e2e-title')).toHaveText('Rocket Pomodoro');
  await expect(page.locator('[data-testid=reveal-frame]')).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
  );
  // What was uploaded at ship: the final files and the client thumbnail.
  const uid = sql(`select builder_id from public.builds where battle_id = '${battle}'`);
  const files = ephemeralObjects(battle).map((n) => n.slice(`${battle}/${uid}/`.length));
  expect(files).toEqual(
    expect.arrayContaining(['bundle.css', 'bundle.js', 'source.json', 'thumb.webp']),
  );
  await snap(page, 'results');

  // Force the end of the last-look window: DESTROY.
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battle}'`,
  );
  await expect(page.getByTestId('destroy-moment')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('build-destroyed')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid=reveal-frame]')).toHaveCount(0, { timeout: 10_000 });
  // The battle's workspace is gone from IndexedDB.
  const stored = await page.evaluate(async (key) => {
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
    const value = await new Promise((resolve) => {
      const r = tx.objectStore('workspaces').get(key);
      r.onsuccess = () => {
        resolve(r.result as unknown);
      };
    });
    db.close();
    return value ?? null;
  }, `battle:${battle}`);
  expect(stored).toBeNull();
  // The destroy worker deletes the ephemeral files on the server.
  await expect(page.getByTestId('source-status')).toContainText('deleted from the server', {
    timeout: 60_000,
  });
  expect(ephemeralObjects(battle)).toEqual([]);
  const row = battleRow(battle);
  expect(row.phase).toBe('destroyed');
  expect(row.destroyed_at).not.toBeNull();

  // The permanent page.
  await page.getByTestId('permanent-link').click();
  await expect(page).toHaveURL(new RegExp(`/battles/${battle}$`));
  await expect(page.getByTestId('battle-title')).toHaveText(card);
  await expect(page.getByTestId('public-build-name')).toContainText('E2E Rocket');
  await expect(page.locator('[data-testid=award][data-award=speedrun]')).toBeVisible();
  await expect(page.getByTestId('public-completion')).toHaveText(/^\d+:\d\d\.\d$/);
  await expect
    .poll(() =>
      page
        .getByTestId('public-screenshot')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
    )
    .toBe(1280);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    new RegExp(`/battles/${battle}/opengraph-image`),
  );
  await snap(page, 'battle-page');
  const og = await page.request.get(`/battles/${battle}/opengraph-image`);
  expect(og.status()).toBe(200);
  expect(og.headers()['content-type']).toBe('image/png');

  // Play again starts over.
  await page.goto('/play');
  await expect(page.getByTestId('display-name')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('auto-ship: no ship; at the deadline the autosave (with its CSS) is shipped and captured', async ({
  page,
}) => {
  const battle = await startBattle(page, 'E2E Autosaver');
  await waitForBuild(page);

  // The background colour comes only from the CSS file.
  await openFile(page, 'src/styles.css');
  await replaceEditorText(page, `body { margin: 0; background: rgb(0, 160, 80); }\n`);
  // Let that rebuild land before the next edit.
  await expect(buildFrame(page).locator('body')).toHaveCSS('background-color', 'rgb(0, 160, 80)');
  await openFile(page, 'src/App.tsx');
  await replaceEditorText(
    page,
    `export function App() {\n  return <h1 className="e2e-auto">Autosaved build</h1>;\n}\n`,
  );
  await expect(buildFrame(page).locator('h1.e2e-auto')).toHaveText('Autosaved build');

  // Hiding the tab autosaves (as does the 30 s timer).
  await setVisibility(page, 'hidden');
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');
  await setVisibility(page, 'visible');
  const uid = sql(`select builder_id from public.builds where battle_id = '${battle}'`);
  expect(ephemeralObjects(battle)).toEqual([
    `${battle}/${uid}/autosave/bundle.css`,
    `${battle}/${uid}/autosave/bundle.js`,
    `${battle}/${uid}/autosave/source.json`,
  ]);

  // Force the build deadline (and its grace) to the past; the client notices and nudges.
  sql(`update public.battles
         set building_started_at = now() - interval '320 seconds',
             building_ends_at = now() - interval '20 seconds',
             phase_ends_at = now() - interval '20 seconds'
       where id = '${battle}'`);
  await setVisibility(page, 'visible'); // resync now instead of at the next poll
  await expect(page.getByTestId('times-up')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => battleRow(battle).phase, { timeout: 20_000 }).toBe('shipping');
  sql(
    `update public.battles set phase_ends_at = now() - interval '1 second' where id = '${battle}'`,
  );

  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('build-status-text')).toHaveText('Auto-shipped at the deadline');
  await expect(page.getByTestId('award')).toHaveCount(0);
  const shot = page.getByTestId('screenshot');
  await expect(shot).toHaveAttribute('data-capture', 'captured', { timeout: 90_000 });
  const src = (await shot.getAttribute('src')) ?? '';
  // Green background: the capture used autosave/bundle.css.
  const px = await pixel(page, src, 1200, 700);
  expect(near(px.r, 0) && near(px.g, 160) && near(px.b, 80)).toBe(true);
  // The last look shows the autosaved build.
  const reveal = page.frameLocator('[data-testid=reveal-frame]').frameLocator('iframe');
  await expect(reveal.locator('h1.e2e-auto')).toHaveText('Autosaved build');
});
