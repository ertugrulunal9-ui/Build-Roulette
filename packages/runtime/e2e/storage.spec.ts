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
