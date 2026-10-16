import { expect, test } from '@playwright/test';
import { moduleSite } from './fixtures';
import { SHELL_ORIGIN, buildFrame, loadSite, openPlayground } from './helpers';

/**
 * The site worker keeps its sites in Cache Storage on the sandbox origin, so a site sees
 * that one cache (README, "Site worker: threat model"). Everything else is the site's own.
 */
const SITE_CACHE = 'br-sandbox-sites-v2';

// Reads every storage area at load (before touching it), then writes to all of them.
const VISITS = moduleSite(`
const before = {
  visits: localStorage.getItem('visits'),
  session: sessionStorage.getItem('session'),
  dbs: (await indexedDB.databases()).map((d) => d.name).sort().join(','),
  caches: (await caches.keys()).filter((k) => k !== '${SITE_CACHE}').sort().join(','),
  siteCache: (await caches.keys()).includes('${SITE_CACHE}'),
};
const visits = Number(before.visits ?? '0') + 1;
localStorage.setItem('visits', String(visits));
sessionStorage.setItem('session', 'set');
await new Promise((resolve, reject) => {
  const req = indexedDB.open('br-test', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(); // keep the connection open on purpose
  req.onerror = () => reject(req.error);
});
await caches.open('br-cache');
root.innerHTML = '<p data-testid="visits"></p><p data-testid="before"></p>';
root.firstChild.textContent = 'visits: ' + visits;
root.lastChild.textContent = JSON.stringify(before);
`);

test('d. localStorage persists across loads; reset-storage wipes every storage area', async ({
  page,
}) => {
  await openPlayground(page);
  const frame = buildFrame(page);

  // Fresh origin storage: first run.
  expect(await page.evaluate(() => window.__playground.resetStorage().then((r) => r.ok))).toBe(
    true,
  );
  await loadSite(page, VISITS);
  await expect(frame.getByTestId('visits')).toHaveText('visits: 1');
  await expect(frame.getByTestId('before')).toHaveText(
    '{"visits":null,"session":null,"dbs":"","caches":"","siteCache":true}',
  );

  // Another load: a fresh document, same origin storage.
  await loadSite(page, VISITS);
  await expect(frame.getByTestId('visits')).toHaveText('visits: 2');
  await expect(frame.getByTestId('before')).toHaveText(
    '{"visits":"1","session":"set","dbs":"br-test","caches":"br-cache","siteCache":true}',
  );

  // reset-storage (the running site holds an open IndexedDB connection on purpose).
  const reset = await page.evaluate(() => window.__playground.resetStorage());
  expect(reset).toMatchObject({ type: 'storage-reset', ok: true });

  await loadSite(page, VISITS);
  await expect(frame.getByTestId('visits')).toHaveText('visits: 1');
  await expect(frame.getByTestId('before')).toHaveText(
    '{"visits":null,"session":null,"dbs":"","caches":"","siteCache":true}',
  );
});

// A normal site that uses every kind of origin storage, including OPFS and cookies on
// several paths (one path the shell's document can't even see) and a partitioned cookie.
const WRITER = moduleSite(`
const opfsRoot = await navigator.storage.getDirectory();
const opfsNames = [];
for await (const name of opfsRoot.keys()) opfsNames.push(name);
const found = {
  local: localStorage.length,
  dbs: (await indexedDB.databases()).map((d) => d.name).sort().join(','),
  caches: (await caches.keys()).filter((k) => k !== '${SITE_CACHE}').sort().join(','),
  opfs: opfsNames.sort().join(','),
  cookies: document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).sort().join(','),
};
localStorage.setItem('k', 'v');
await new Promise((resolve, reject) => {
  const req = indexedDB.open('app-db', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve();
  req.onerror = () => reject(req.error);
});
const cache = await caches.open('app-cache');
await cache.put('/cached', new Response('x'));
const file = await opfsRoot.getFileHandle('notes.txt', { create: true });
const writable = await file.createWritable();
await writable.write('hello');
await writable.close();
await opfsRoot.getDirectoryHandle('dir', { create: true });
const attrs = '; SameSite=None; Secure';
document.cookie = 'c_root=1; Path=/' + attrs;
document.cookie = 'c_v2=1; Path=/v2' + attrs;
document.cookie = 'c_v2slash=1; Path=/v2/' + attrs;
document.cookie = 'c_elsewhere=1; Path=/elsewhere' + attrs;
document.cookie = 'c_part=1; Path=/' + attrs + '; Partitioned';
root.innerHTML = '<p data-testid="found"></p>';
root.firstChild.textContent = JSON.stringify(found);
`);

const EMPTY = '{"local":0,"dbs":"","caches":"","opfs":"","cookies":""}';

test('d. reset-storage wipes localStorage, IndexedDB, CacheStorage, OPFS and cookies on every path, in a new iframe', async ({
  page,
  context,
}) => {
  await openPlayground(page);
  const frame = buildFrame(page);
  const reset = async () => {
    const t0 = Date.now();
    const r = await page.evaluate(() => window.__playground.resetStorage());
    console.log(
      `[metrics] reset-storage (new iframe + handshake + wipe + ack): ${String(Date.now() - t0)} ms`,
    );
    return r;
  };
  // All cookies of the sandbox host. (`context.cookies(url)` would hide Secure cookies on
  // an http URL and cookies whose path does not match the URL.)
  const sandboxCookies = async () =>
    (await context.cookies())
      .filter((c) => c.domain === new URL(SHELL_ORIGIN).hostname)
      .map((c) => `${c.name}@${c.path}`)
      .sort();

  expect((await reset()).ok).toBe(true);
  await loadSite(page, WRITER);
  await expect(frame.getByTestId('found')).toHaveText(EMPTY);

  // Second load: everything the first load wrote is there (so the wipe below is meaningful).
  // The site's document is at `/`, so it sees the cookies on `/` only.
  await loadSite(page, WRITER);
  await expect(frame.getByTestId('found')).toHaveText(
    '{"local":1,"dbs":"app-db","caches":"app-cache","opfs":"dir,notes.txt","cookies":"c_part,c_root"}',
  );
  expect(await sandboxCookies()).toEqual([
    'c_elsewhere@/elsewhere',
    'c_part@/',
    'c_root@/',
    'c_v2@/v2',
    'c_v2slash@/v2/',
  ]);

  // Reset: the running site is replaced by a new iframe element before the wipe.
  await page.evaluate(() => {
    (document.getElementById('preview') as HTMLIFrameElement & { __old?: boolean }).__old = true;
  });
  const ack = await reset();
  expect(ack, JSON.stringify(ack.errors)).toMatchObject({ type: 'storage-reset', ok: true });
  expect(ack.errors).toBeUndefined();
  expect(
    await page.evaluate(
      () => (document.getElementById('preview') as HTMLIFrameElement & { __old?: boolean }).__old,
    ),
  ).toBeUndefined();

  // A fresh load finds every storage area it can see empty (the site worker registered
  // itself again and stored this site anew).
  await loadSite(page, WRITER);
  await expect(frame.getByTestId('found')).toHaveText(EMPTY);
  // And the browser holds no cookie for the sandbox host, including the one on a path the
  // shell's document never sees (only Clear-Site-Data from /v2/reset reaches that one).
  // The fresh load above may have written new ones, so check after a second reset.
  await reset();
  expect(await sandboxCookies()).toEqual([]);
});
