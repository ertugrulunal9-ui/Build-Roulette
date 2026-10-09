import { startFakeIngest, type FakeIngest } from '@br/telemetry/testing';
import { expect, test } from '@playwright/test';
import { watchCsp } from './csp';
import { openFile, openPlayground, replaceEditorText } from './helpers';
import { seedAdmin } from './stack';
import {
  INGEST_PORT,
  UUID,
  createRoomAs,
  sentryLoaded,
  sessionUserId,
  throwInPage,
  type PosthogEvent,
  type SentryEvent,
} from './telemetry';

/**
 * Error reporting and analytics ON (T-030): the build points its Sentry DSN and its PostHog
 * host at a local fake ingest (playwright.telemetry.config.ts, `build:telemetry`). What
 * arrives there must be scrubbed: no query strings or fragments, no room codes, display names,
 * emails or raw user ids, nothing from the sandbox iframe; a hashed user id joins the two.
 * Every event is the browser's: the app is a static site (T-037), so the admin's "Send a test
 * error" throws in the page, and no server-side event (`service: web`) exists any more.
 */

let ingest: FakeIngest;
const sentry = () => ingest.sentryEvents as SentryEvent[];
const posthog = () => ingest.posthogEvents as unknown as PosthogEvent[];
const allBodies = () => ingest.requests.map((r) => `${r.url}\n${r.body}`).join('\n');

test.beforeAll(async () => {
  ingest = await startFakeIngest(INGEST_PORT);
});
test.afterAll(async () => {
  await ingest.close();
});
test.beforeEach(() => {
  ingest.reset();
});

test('a browser error arrives scrubbed, with the route, release and environment', async ({
  page,
}) => {
  await page.goto('/?utm_source=secret-campaign#secret-fragment');
  await sentryLoaded(page);
  await throwInPage(
    page,
    'boom for mod@example.com at https://elsewhere.example/r/K7QXM?invite=secret-invite',
  );
  await expect.poll(() => sentry().length).toBe(1);
  const ev = sentry()[0];
  expect(ev?.exception?.values?.[0]).toMatchObject({
    type: 'Error',
    value: 'boom for <email> at https://elsewhere.example/r/[code]',
  });
  expect(ev?.request?.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  expect(ev?.tags).toMatchObject({ route: '/', runtime: 'browser' });
  expect(ev?.release).toMatch(/^build-roulette-web@/);
  expect(ev?.environment).toBe('e2e');
  expect(ev?.user).toBeUndefined(); // not signed in
  expect(ev?.breadcrumbs).toBeUndefined();
  expect(ev?.extra).toBeUndefined();
  const raw = allBodies();
  for (const secret of ['secret-campaign', 'secret-fragment', 'secret-invite', 'mod@example.com']) {
    expect(raw, secret).not.toContain(secret);
  }
  // Errors only: no session pings, no transactions, no replays.
  expect(ingest.requests.every((r) => r.url.startsWith('/api/1/envelope/'))).toBe(true);
  expect(raw).not.toContain('"type":"session"');
  expect(raw).not.toContain('"type":"transaction"');
});

test('analytics: room_created and room_joined, pseudonymous; errors carry the same id and the room', async ({
  page,
}) => {
  const code = await createRoomAs(page, 'Zed Secretname');
  const userId = await sessionUserId(page);
  expect(userId).toMatch(UUID);
  await expect
    .poll(() => posthog().map((e) => e.event), { timeout: 15_000 })
    .toEqual(expect.arrayContaining(['room_created', 'room_joined']));
  const created = posthog().find((e) => e.event === 'room_created');
  const joined = posthog().find((e) => e.event === 'room_joined');
  expect(created?.distinct_id).toMatch(/^[0-9a-f]{32}$/);
  expect(joined?.distinct_id).toBe(created?.distinct_id);
  expect(created?.properties['room_id']).toMatch(UUID);
  expect(created?.properties).toMatchObject({
    path: '/',
    $process_person_profile: false,
    $geoip_disable: true,
    $lib: 'build-roulette-web',
  });
  expect(joined?.properties).toMatchObject({
    room_id: created?.properties['room_id'],
    role: 'player',
    path: '/r/[code]',
  });
  const batch = ingest.requests.find((r) => r.url.startsWith('/batch'));
  expect(JSON.parse(batch?.body ?? '{}')).toMatchObject({ api_key: 'phc_e2e_test' });

  // An error on the room page: the room id tag and the same pseudonymous user.
  await sentryLoaded(page);
  await throwInPage(page, 'an error in the lobby');
  await expect.poll(() => sentry().length).toBe(1);
  const ev = sentry()[0];
  expect(ev?.user).toEqual({ id: created?.distinct_id });
  expect(ev?.tags).toMatchObject({
    route: '/r/[code]',
    room_id: created?.properties['room_id'],
  });
  expect(ev?.request?.url).toMatch(/\/r\/\[code\]$/);

  const raw = allBodies();
  for (const secret of ['Zed Secretname', code, userId]) {
    expect(raw, secret).not.toContain(secret);
  }
});

test('Do Not Track / Global Privacy Control: no analytics, errors without a user', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
  });
  const page = await ctx.newPage();
  await createRoomAs(page, 'Private Pat');
  await sentryLoaded(page);
  await throwInPage(page, 'an error with GPC on');
  await expect.poll(() => sentry().length).toBe(1);
  expect(sentry()[0]?.user).toBeUndefined();
  // The analytics flush would have run after 2 s.
  await page.waitForTimeout(3_000);
  await page.close(); // pagehide: nothing either
  expect(posthog()).toEqual([]);
  expect(ingest.requests.filter((r) => r.url.startsWith('/batch'))).toEqual([]);
  await ctx.close();
});

test('nothing from the sandbox: its errors, console output and build code stay in the iframe', async ({
  page,
}) => {
  await openPlayground(page);
  await sentryLoaded(page);
  await replaceEditorText(
    page,
    "export function App() {\n  console.error('SANDBOX_SECRET_CONSOLE');\n  throw new Error('SANDBOX_SECRET_THROW');\n}\n",
  );
  await expect(page.getByTestId('error-message')).toContainText('SANDBOX_SECRET_THROW');
  await expect(page.getByTestId('console')).toContainText('SANDBOX_SECRET_CONSOLE');
  // A build error quotes the source.
  await replaceEditorText(page, 'export const SANDBOX_SECRET_SYNTAX = <;\n');
  await expect(page.getByTestId('build-status')).not.toHaveText(/^Built in/);
  await page.waitForTimeout(3_000);
  expect(allBodies()).not.toContain('SANDBOX_SECRET');
  // Reporting is live on this page: the app's own error does arrive.
  await throwInPage(page, 'an app error on the playground');
  await expect.poll(() => sentry().length).toBe(1);
  expect(sentry()[0]?.exception?.values?.[0]?.value).toBe('an app error on the playground');
  expect(allBodies()).not.toContain('SANDBOX_SECRET');
});

test('a preview watchdog crash arrives as preview_crash (T-031): restarted, no build code or names', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // A solo battle (signed in, so analytics has its pseudonymous id), to BUILD.
  await page.goto('/');
  await page.getByTestId('play-solo').click();
  await expect(page).toHaveURL(/\/play$/);
  await page.getByTestId('display-name').fill('Loopy Secretname');
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  await expect(page).toHaveURL(/[?&]battle=[0-9a-f-]{36}/);
  const battleId = new URL(page.url()).searchParams.get('battle');
  await expect(page.getByTestId('spin')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
    timeout: 30_000,
  });

  // A build that loops half a second after it started (after its `ready`).
  await openFile(page, 'src/App.tsx');
  await replaceEditorText(
    page,
    "setTimeout(() => {\n  console.log('SANDBOX_SECRET_LOOP');\n  for (;;) {}\n}, 500);\nexport function App() {\n  return <h1>SANDBOX_SECRET_TITLE</h1>;\n}\n",
  );
  const crashed = page.getByTestId('preview-crashed');
  await expect(crashed).toBeVisible({ timeout: 20_000 });
  await expect(crashed).toHaveAttribute('data-phase', 'running');
  // Not sent yet: whether the player restarts it is part of the event.
  expect(posthog().filter((e) => e.event === 'preview_crash')).toEqual([]);
  await crashed.getByRole('button', { name: 'Restart preview' }).click();

  await expect
    .poll(() => posthog().filter((e) => e.event === 'preview_crash').length, { timeout: 15_000 })
    .toBe(1);
  const ev = posthog().find((e) => e.event === 'preview_crash');
  expect(ev?.distinct_id).toMatch(/^[0-9a-f]{32}$/);
  expect(ev?.properties).toMatchObject({
    battle_id: battleId,
    mode: 'live',
    reason: 'heartbeat_timeout',
    phase: 'running',
    restarted: true,
    path: '/play',
  });
  const p = ev?.properties ?? {};
  const silent = p['silent_ms'] as number;
  const wall = p['wall_silent_ms'] as number;
  expect(silent).toBeGreaterThan(5000);
  // `silent_ms` counts from the last pong, and `ready` moves the deadline to ready + 5 s
  // (preview-handle.ts): the last pong can be up to one ping interval (1 s) before `ready`,
  // and the crash comes on the first tick past the deadline (250 ms + 50 ms jitter). So up
  // to 5000 + 1000 + 300 ms of awake silence (5635 ms was seen once against an older,
  // too tight 5600 ms bound).
  expect(silent).toBeLessThanOrEqual(6300);
  expect(wall).toBeGreaterThanOrEqual(silent);
  expect(p['stalled_ms']).toBe(wall - silent);
  expect(typeof p['longest_stall_ms']).toBe('number');
  const raw = allBodies();
  for (const secret of ['SANDBOX_SECRET', 'Loopy Secretname', 'for (;;)', 'setTimeout']) {
    expect(raw, secret).not.toContain(secret);
  }
});

test('the admin test error is the browser’s (no server any more): it arrives scrubbed', async ({
  browser,
}) => {
  const email = `telemetry-${String(Date.now())}@telemetry.e2e`;
  const password = `pw-${Math.random().toString(36).slice(2)}-Aa1`;
  seedAdmin(email, password);
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  const errors: string[] = [];
  watchCsp(admin, errors);
  await admin.goto('/admin/sign-in');
  await admin.getByTestId('admin-email').fill(email);
  await admin.getByTestId('admin-password').fill(password);
  await admin.getByTestId('admin-sign-in-submit').click();
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(admin.getByTestId('admin-health')).toBeVisible();
  await sentryLoaded(admin);
  const session = await admin.evaluate(() => window.sessionStorage.getItem('br-admin-auth') ?? '');
  const { access_token: accessToken, refresh_token: refreshToken } = JSON.parse(session) as {
    access_token: string;
    refresh_token: string;
  };
  ingest.reset();

  await admin.getByTestId('admin-test-error').click();
  await expect(admin.getByTestId('admin-flash')).toHaveAttribute('data-done', 'test_error_sent');
  await expect.poll(() => sentry().length, { timeout: 15_000 }).toBe(1);
  const ev = sentry()[0];
  expect(ev?.exception?.values?.[0]).toMatchObject({
    type: 'Error',
    value: 'Build Roulette test error (thrown from /admin on purpose)',
  });
  expect(ev?.tags).toMatchObject({ route: '/admin', runtime: 'browser' });
  expect(ev?.request?.url).toMatch(/^http:\/\/localhost:\d+\/admin$/);
  expect(ev?.release).toMatch(/^build-roulette-web@/);
  // The moderator is not a player of this page: no user on the event.
  expect(ev?.user).toBeUndefined();
  // Nothing else arrives: no server reporter (`service: web`) exists since T-037, and the
  // page does not report the error twice.
  await admin.waitForTimeout(2_000);
  expect(sentry()).toHaveLength(1);
  expect(sentry().filter((e) => e.tags?.['service'] !== undefined)).toEqual([]);
  const raw = allBodies();
  for (const secret of [email, password, accessToken, refreshToken, 'br-admin-auth']) {
    expect(raw, secret.slice(0, 12)).not.toContain(secret);
  }
  expect(errors).toEqual([]);
  await ctx.close();
});
