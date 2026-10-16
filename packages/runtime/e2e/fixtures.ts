/**
 * Fixture sites for the e2e tests: text files that the playground packs with `packSite`
 * (`@br/site`) and loads as a protocol v2 `load`.
 */
import type { SiteSpec } from '../playground/main';

export type { SiteSpec };

/** An HTML document with `head` and `body` markup. */
export function html(opts: { title?: string; head?: string; body?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${opts.title ?? 'Fixture'}</title>
    ${opts.head ?? ''}
  </head>
  <body>
    ${opts.body ?? '<div id="root"></div>'}
  </body>
</html>
`;
}

/**
 * A one-module site, as a bundler emits it: `index.html` loads `/assets/app.js` (a module
 * script, so top-level `await` works) and `<div id="root">`. `js` runs at the module's top
 * level; `extra` adds files.
 */
export function moduleSite(js: string, extra: SiteSpec = {}): SiteSpec {
  return {
    'index.html': html({ head: '<script type="module" src="/assets/app.js"></script>' }),
    'assets/app.js': `const root = document.getElementById('root');\n${js}\n`,
    ...extra,
  };
}

/** A site whose module renders `markup` into `#root` (after running `prelude`). */
export function markupSite(markup: string, prelude = ''): SiteSpec {
  return moduleSite(`${prelude}\nroot.innerHTML = ${JSON.stringify(markup)};`);
}

/**
 * The Vite-like site of e2e (a): an entry module and a stylesheet under `/assets/` with
 * hashed names, a lazily imported chunk, an image at the root, `fetch('/data.json')` and a
 * module worker that fetches too. Every outcome is written into `#out` as JSON.
 */
export function viteLikeSite(label: string): SiteSpec {
  return {
    'index.html': html({
      title: label,
      head: `<script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css" />`,
      body: `<div id="root"><h1 class="title" data-testid="title">${label}</h1><img data-testid="logo" src="/logo.svg" alt="logo" /><pre data-testid="out"></pre></div>`,
    }),
    'assets/index-abc.css': `.title { color: rgb(255, 0, 128); }\nbody { margin: 0; }\n`,
    'assets/index-abc.js': `const out = {};
const show = () => { document.querySelector('[data-testid="out"]').textContent = JSON.stringify(out); };
const settle = (key, p) => p.then((v) => { out[key] = v; show(); }, (e) => { out[key] = 'error: ' + e; show(); });
settle('lazy', import('./chunk-x.js').then((m) => m.answer()));
settle('data', fetch('/data.json').then((r) => r.json()).then((d) => d.label));
settle('worker', new Promise((resolve, reject) => {
  const w = new Worker('/assets/worker.js', { type: 'module' });
  w.onmessage = (e) => resolve(e.data);
  w.onerror = (e) => reject(new Error(e.message || 'worker error'));
}));
const img = document.querySelector('[data-testid="logo"]');
settle('image', img.decode().then(() => img.naturalWidth + 'x' + img.naturalHeight));
console.log('vite-like site started', location.pathname);
`,
    'assets/chunk-x.js': `export function answer() { return 'chunk ok'; }\n`,
    'assets/worker.js': `import { WORD } from './worker-dep.js';
const data = await (await fetch('/data.json')).json();
postMessage(WORD + ' ' + data.label);
`,
    'assets/worker-dep.js': `export const WORD = 'worker';\n`,
    'logo.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#f08"/></svg>\n`,
    'data.json': `{ "label": "${label} data" }\n`,
  };
}
