import { expect, test } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { buildFrame, openPlayground } from './helpers';

// Reads every storage area at load (before touching it), then writes to all of them.
const PRELUDE = `
const before = {
  visits: localStorage.getItem('visits'),
  session: sessionStorage.getItem('session'),
  dbs: (await indexedDB.databases()).map((d) => d.name).sort().join(','),
  caches: (await caches.keys()).sort().join(','),
};
const visits = Number(before.visits ?? '0') + 1;
localStorage.setItem('visits', String(visits));
sessionStorage.setItem('session', 'set');
await new Promise<void>((resolve, reject) => {
  const req = indexedDB.open('br-test', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(); // keep the connection open on purpose
  req.onerror = () => reject(req.error);
});
await caches.open('br-cache');
`;

const BODY = `<div>
  <p data-testid="visits">visits: {visits}</p>
  <p data-testid="before">{JSON.stringify(before)}</p>
</div>`;

test('d. localStorage persists across rebuilds; reset-storage wipes every storage area', async ({
  page,
}) => {
  await openPlayground(page);
  const frame = buildFrame(page);
  const files = reactApp(BODY, PRELUDE);

  const run = () =>
    page.evaluate(
      async ({ files, manifest }) => {
        await window.__playground.setProject(files, manifest);
        return window.__playground.buildAndLoad();
      },
      { files, manifest: REACT_MANIFEST },
    );

  // Fresh origin storage: first run.
  expect(await page.evaluate(() => window.__playground.resetStorage().then((r) => r.ok))).toBe(
    true,
  );
  expect((await run()).ok).toBe(true);
  await expect(frame.getByTestId('visits')).toHaveText('visits: 1');
  await expect(frame.getByTestId('before')).toHaveText(
    '{"visits":null,"session":null,"dbs":"","caches":""}',
  );

  // Rebuild: a fresh document, same origin storage.
  expect((await run()).ok).toBe(true);
  await expect(frame.getByTestId('visits')).toHaveText('visits: 2');
  await expect(frame.getByTestId('before')).toHaveText(
    '{"visits":"1","session":"set","dbs":"br-test","caches":"br-cache"}',
  );

  // reset-storage (the running build holds an open IndexedDB connection on purpose).
  const reset = await page.evaluate(() => window.__playground.resetStorage());
  expect(reset).toMatchObject({ type: 'storage-reset', ok: true });

  expect((await run()).ok).toBe(true);
  await expect(frame.getByTestId('visits')).toHaveText('visits: 1');
  await expect(frame.getByTestId('before')).toHaveText(
    '{"visits":null,"session":null,"dbs":"","caches":""}',
  );
});

// A normal app that uses every kind of origin storage, including OPFS and cookies on
// several paths (one path the shell's document can't even see) and a partitioned cookie.
const WRITER_PRELUDE = `
const opfsRoot = await navigator.storage.getDirectory();
const opfsNames: string[] = [];
for await (const name of (opfsRoot as unknown as { keys(): AsyncIterable<string> }).keys()) opfsNames.push(name);
const found = {
  local: localStorage.length,
  dbs: (await indexedDB.databases()).map((d) => d.name).sort().join(','),
  caches: (await caches.keys()).sort().join(','),
  opfs: opfsNames.sort().join(','),
  cookies: document.cookie.split(';').map((c) => c.split('=')[0]!.trim()).filter(Boolean).sort().join(','),
};
localStorage.setItem('k', 'v');
await new Promise<void>((resolve, reject) => {
  const req = indexedDB.open('app-db', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve();
  req.onerror = () => reject(req.error);
});
const cache = await caches.open('app-cache');
await cache.put('/v1/cached', new Response('x'));
const file = await opfsRoot.getFileHandle('notes.txt', { create: true });
const writable = await file.createWritable();
await writable.write('hello');
await writable.close();
await opfsRoot.getDirectoryHandle('dir', { create: true });
const attrs = '; SameSite=None; Secure';
document.cookie = 'c_root=1; Path=/' + attrs;
document.cookie = 'c_v1=1; Path=/v1' + attrs;
document.cookie = 'c_v1slash=1; Path=/v1/' + attrs;
document.cookie = 'c_elsewhere=1; Path=/elsewhere' + attrs;
document.cookie = 'c_part=1; Path=/' + attrs + '; Partitioned';
`;

const WRITER_BODY = `<p data-testid="found">{JSON.stringify(found)}</p>`;
const EMPTY = '{"local":0,"dbs":"","caches":"","opfs":"","cookies":""}';

test('d. reset-storage wipes localStorage, IndexedDB, CacheStorage, OPFS and cookies on every path, in a new iframe', async ({
  page,
  context,
}) => {
  await openPlayground(page);
  const frame = buildFrame(page);
  const shellOrigin = `http://127.0.0.1:${process.env['SHELL_PORT'] ?? '4311'}`;
  const run = async () => {
    const r = await page.evaluate(
      async ({ files, manifest }) => {
        await window.__playground.setProject(files, manifest);
        return window.__playground.buildAndLoad();
      },
      { files: reactApp(WRITER_BODY, WRITER_PRELUDE), manifest: REACT_MANIFEST },
    );
    expect(r.ok).toBe(true);
  };
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
      .filter((c) => c.domain === new URL(shellOrigin).hostname)
      .map((c) => `${c.name}@${c.path}`)
      .sort();

  expect((await reset()).ok).toBe(true);
  await run();
  await expect(frame.getByTestId('found')).toHaveText(EMPTY);

  // Second load: everything the first load wrote is there (so the wipe below is meaningful).
  await run();
  await expect(frame.getByTestId('found')).toHaveText(
    '{"local":1,"dbs":"app-db","caches":"app-cache","opfs":"dir,notes.txt","cookies":"c_part,c_root,c_v1,c_v1slash"}',
  );
  expect(await sandboxCookies()).toEqual([
    'c_elsewhere@/elsewhere',
    'c_part@/',
    'c_root@/',
    'c_v1@/v1',
    'c_v1slash@/v1/',
  ]);

  // Reset: the running build is replaced by a new iframe element before the wipe.
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
  // All cookies are gone, including the one on a path the shell's document never sees.
  expect(await sandboxCookies()).toEqual([]);

  // A fresh load finds every storage area empty.
  await run();
  await expect(frame.getByTestId('found')).toHaveText(EMPTY);
});
