/**
 * Fixture sites for the e2e suites (import mode, docs/09): what a player's own tools would
 * produce, built in the test and imported the ways a player does.
 *
 * - `viteSite`: a Vite-like `dist/`: `index.html` loading `/assets/index-<hash>.js` (a module
 *   that renders the page) and `/assets/index-<hash>.css` (the background), root-relative
 *   like Vite's default `base`.
 * - `plainSite`: a one-file plain HTML site (no build at all).
 * - `sourceProject`: a project that was not built (`package.json` with a `build` script and
 *   Vite's unbuilt `index.html`): the import refuses it.
 *
 * Imports: `importFolder` picks a folder on disk through the folder input (`webkitdirectory`,
 * the files keep their relative paths), `importZip` a .zip through the .zip input, and
 * `dropFiles` dispatches a real drop event with a synthetic `DataTransfer` on the page.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { buildFrame } from './helpers';

/** A site's files: path → text. */
export type SiteFiles = Record<string, string>;

export interface SiteOptions {
  /** More markup inside `<main>` (plain HTML). */
  extraHtml?: string;
  /** More JavaScript, run after the page is rendered (in the site's module). */
  extraJs?: string;
}

/** A short stable hash of a text, like a bundler's file names. */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

/**
 * A Vite-like build: `<h1 class="e2e-title">` with `title` on a full-page `background`
 * (from the stylesheet), rendered by the entry module into `#root`.
 */
export function viteSite(title: string, background: string, opts: SiteOptions = {}): SiteFiles {
  const css = `body { margin: 0; }
main { min-height: 100vh; display: grid; place-content: center; background: ${background}; color: white; font-family: sans-serif; }
`;
  const js = `const root = document.getElementById('root');
root.innerHTML = ${JSON.stringify(`<main class="e2e-main"><h1 class="e2e-title">${title}</h1>${opts.extraHtml ?? ''}</main>`)};
${opts.extraJs ?? ''}
`;
  const jsName = `assets/index-${hash(js)}.js`;
  const cssName = `assets/index-${hash(css)}.css`;
  return {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <script type="module" crossorigin src="/${jsName}"></script>
    <link rel="stylesheet" crossorigin href="/${cssName}">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
    [jsName]: js,
    [cssName]: css,
    'vite.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n',
  };
}

/** A one-file plain HTML site (nothing to build). */
export function plainSite(title: string, background: string): SiteFiles {
  return {
    'index.html': `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0}main{min-height:100vh;display:grid;place-content:center;background:${background};color:white}</style>
</head><body><main><h1 class="e2e-title">${title}</h1></main></body></html>
`,
  };
}

/** A project that was never built: what a player drops by mistake. */
export function sourceProject(): SiteFiles {
  return {
    'package.json': JSON.stringify({
      name: 'my-app',
      private: true,
      scripts: { dev: 'vite', build: 'vite build' },
    }),
    'index.html':
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    'src/main.tsx': "import { createRoot } from 'react-dom/client';\ncreateRoot(document.body);\n",
  };
}

/**
 * Writes a project folder to disk: `files` under `<project>/<sub>` (default `dist`, as a
 * build writes it), plus a `package.json` and a source file at the project root, so a pick
 * of the whole project folder works too. Returns `{project, dist}` paths.
 */
export function writeProject(
  files: SiteFiles,
  { sub = 'dist', name = 'my-app' }: { sub?: string; name?: string } = {},
): { project: string; dist: string } {
  const project = join(mkdtempSync(join(tmpdir(), 'br-site-')), name);
  const dist = sub === '' ? project : join(project, sub);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const [path, text] of Object.entries(files)) write(join(dist, path), text);
  if (sub !== '') {
    write(
      join(project, 'package.json'),
      JSON.stringify({ name, private: true, scripts: { build: 'vite build' } }),
    );
    write(join(project, 'src', 'main.ts'), "console.log('source, not served');\n");
  }
  return { project, dist };
}

/** A .zip of `files` (under `prefix`, e.g. `dist/`). */
export function zipFiles(files: SiteFiles, prefix = ''): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[`${prefix}${path}`] = strToU8(text);
  return Buffer.from(zipSync(entries));
}

/** Picks `dir` with the folder input (as "Choose folder" does). */
export async function importFolder(page: Page, dir: string): Promise<void> {
  await page.getByTestId('import-folder-input').setInputFiles(dir);
}

/** Picks a .zip of `files` with the .zip input (as "Choose .zip" does). */
export async function importZip(page: Page, files: SiteFiles, name = 'site.zip'): Promise<void> {
  await page.getByTestId('import-zip-input').setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: zipFiles(files),
  });
}

/**
 * Drops files on the page like a drag from the desktop: `dragenter` and `dragover` (the
 * full-screen overlay shows), then `drop`, each with the same synthetic `DataTransfer`. A
 * synthetic `DataTransfer` cannot carry folders, so this drops loose files (a one-file site,
 * or one .zip).
 */
export async function dropFiles(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
  target = '[data-testid=site-workbench]',
): Promise<void> {
  const payload = files.map((f) => ({
    name: f.name,
    type: f.mimeType,
    data: f.buffer.toString('base64'),
  }));
  const dataTransfer = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    return dt;
  }, payload);
  await page.dispatchEvent(target, 'dragenter', { dataTransfer });
  await page.dispatchEvent(target, 'dragover', { dataTransfer });
  await expect(page.getByTestId('drop-overlay')).toBeVisible();
  await page.dispatchEvent('[data-testid=drop-overlay]', 'drop', { dataTransfer });
  await expect(page.getByTestId('drop-overlay')).toBeHidden();
}

/**
 * Imports a Vite-like site with `title` on `background` (a fresh project folder, picked with
 * the folder input) and waits until the preview shows it. Returns the project folder.
 */
export async function importApp(
  page: Page,
  title: string,
  background: string,
  { waitForPreview = true, ...opts }: SiteOptions & { waitForPreview?: boolean } = {},
): Promise<string> {
  const { dist } = writeProject(viteSite(title, background, opts));
  await importFolder(page, dist);
  if (waitForPreview) {
    await expect(buildFrame(page).locator('h1.e2e-title')).toHaveText(title, { timeout: 30_000 });
  }
  return dist;
}

/**
 * A button that hangs the site's main thread for good, shortly after the click (so the click
 * itself is acknowledged first and the test driver does not wait on a hung frame).
 */
export const FREEZE_BUTTON: SiteOptions = {
  extraHtml: '<button class="e2e-freeze">Freeze</button>',
  extraJs:
    "document.querySelector('.e2e-freeze').addEventListener('click', () => { setTimeout(() => { for (;;) {} }, 300); });",
};
