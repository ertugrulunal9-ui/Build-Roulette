import { describe, expect, it } from 'vitest';
import {
  describeImportError,
  hasBuildScript,
  importSite,
  isUnbuiltIndexHtml,
  planSite,
  type ImportErrorCode,
  type ImportSource,
} from './import';
import type { CopyErrorCode, UrlImportErrorCode } from './copy';
import { SITE_LIMITS } from './limits';
import { unpackSite } from './pack';

const enc = new TextEncoder();
const BUILT_INDEX =
  '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>';
const VITE_SOURCE_INDEX =
  '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';

/** An in-memory drop: path → text. Records which paths were read. */
function source(files: Record<string, string>): ImportSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    entries: Object.entries(files).map(([path, text]) => ({
      path,
      size: enc.encode(text).byteLength,
    })),
    read: (path) => {
      reads.push(path);
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`no ${path}`))
        : Promise.resolve(enc.encode(text));
    },
  };
}

function planError(entries: Record<string, string>): ImportErrorCode | null {
  const r = planSite(source(entries).entries);
  return r.ok ? null : r.error.code;
}

describe('planSite', () => {
  it('takes a dropped dist folder as the site', () => {
    const r = planSite(
      source({
        'dist/index.html': BUILT_INDEX,
        'dist/assets/index-abc.js': 'x',
        'dist/vite.svg': '<svg/>',
      }).entries,
    );
    expect(r.ok && r.plan.root).toBe('dist/');
    expect(r.ok && r.plan.files.map((f) => f.path).sort()).toEqual([
      'assets/index-abc.js',
      'index.html',
      'vite.svg',
    ]);
  });

  it('prefers the build output over the project root in a whole project folder', () => {
    const r = planSite(
      source({
        'my-app/index.html': VITE_SOURCE_INDEX,
        'my-app/package.json': '{"scripts":{"build":"vite build"}}',
        'my-app/src/main.tsx': 'x',
        'my-app/node_modules/react/index.js': 'x',
        'my-app/.git/HEAD': 'x',
        'my-app/dist/index.html': BUILT_INDEX,
        'my-app/dist/assets/index-abc.js': 'x',
      }).entries,
    );
    expect(r.ok && r.plan.root).toBe('my-app/dist/');
    expect(r.ok && r.plan.outputFolder).toBe(true);
    expect(r.ok && r.plan.projectFiles).toEqual([]);
    expect(r.ok && r.plan.files).toHaveLength(2);
    expect(r.ok && r.plan.skipped).toBe(5);
  });

  it('prefers build/ over public/ (Create React App) and knows the other output folders', () => {
    const cra = planSite(
      source({ 'public/index.html': '%PUBLIC_URL%', 'build/index.html': BUILT_INDEX }).entries,
    );
    expect(cra.ok && cra.plan.root).toBe('build/');
    for (const dir of ['out', '_site', '.output/public', 'www']) {
      const r = planSite(source({ [`${dir}/index.html`]: BUILT_INDEX, 'index.html': 'x' }).entries);
      expect(r.ok && r.plan.root).toBe(`${dir}/`);
    }
  });

  it('takes a plain HTML project at the root, and the shallowest index.html', () => {
    const r = planSite(
      source({ 'index.html': '<h1>hi</h1>', 'game.js': 'x', 'levels/index.html': 'x' }).entries,
    );
    expect(r.ok && r.plan.root).toBe('');
    expect(r.ok && r.plan.files.map((f) => f.path).sort()).toEqual([
      'game.js',
      'index.html',
      'levels/index.html',
    ]);
    expect(r.ok && r.plan.outputFolder).toBe(false);
  });

  it('lists package.json files at or above a non-output root for the build check', () => {
    const r = planSite(
      source({
        'app/package.json': '{}',
        'app/web/index.html': 'x',
        'app/web/package.json': '{}',
        'app/other/package.json': '{}',
      }).entries,
    );
    expect(r.ok && r.plan.projectFiles.sort()).toEqual([
      'app/package.json',
      'app/web/package.json',
    ]);
  });

  it('skips hidden files, source maps and junk inside the site, but keeps .well-known', () => {
    const r = planSite(
      source({
        'dist/index.html': BUILT_INDEX,
        'dist/assets/a.js.map': '{}',
        'dist/.DS_Store': 'x',
        'dist/Thumbs.db': 'x',
        'dist/.env': 'SECRET=1',
        'dist/.well-known/security.txt': 'x',
        '__MACOSX/dist/._index.html': 'x',
      }).entries,
    );
    expect(r.ok && r.plan.files.map((f) => f.path).sort()).toEqual([
      '.well-known/security.txt',
      'index.html',
    ]);
  });

  it('normalizes Windows and absolute paths, and drops paths that escape', () => {
    const r = planSite([
      { path: 'dist\\index.html', size: 1 },
      { path: '/dist/app.js', size: 1 },
      { path: './dist/b.js', size: 1 },
      { path: 'dist/../../etc/passwd', size: 1 },
    ]);
    expect(r.ok && r.plan.files.map((f) => f.path).sort()).toEqual([
      'app.js',
      'b.js',
      'index.html',
    ]);
    expect(r.ok && r.plan.skipped).toBe(1);
  });

  it('explains what is missing', () => {
    expect(planError({})).toBe('empty');
    expect(planError({ 'node_modules/x/index.html': 'x' })).toBe('empty');
    expect(planError({ 'readme.md': 'x', 'app.js': 'x' })).toBe('no-index');
    expect(planError({ 'package.json': '{}', 'src/App.tsx': 'x' })).toBe('not-built');
    expect(planError({ 'package.json': '{}', '.next/build-manifest.json': '{}' })).toBe(
      'nextjs-not-exported',
    );
    expect(planError({ '.next/server/app/index.html': 'x', 'public/index.html': 'x' })).toBe(
      'nextjs-not-exported',
    );
    expect(planError({ '.next/x': 'x', 'out/index.html': BUILT_INDEX })).toBeNull();
    // A hidden folder is no site root.
    expect(planError({ '.cache/index.html': 'x' })).toBe('no-index');
  });

  it('applies the limits', () => {
    const many: Record<string, string> = { 'index.html': 'x' };
    for (let i = 0; i < SITE_LIMITS.maxFiles; i++) many[`a/${i}.js`] = '';
    expect(planError(many)).toBe('too-many-files');
    const big = planSite([
      { path: 'index.html', size: 10 },
      { path: 'video.mp4', size: SITE_LIMITS.maxPackBytes },
    ]);
    expect(!big.ok && big.error).toEqual({
      code: 'too-large',
      detail: String(SITE_LIMITS.maxPackBytes + 10),
    });
    expect(
      planError({ 'index.html': 'x', [`${'a'.repeat(SITE_LIMITS.maxPathChars)}.js`]: 'x' }),
    ).toBe('path-too-long');
  });
});

describe('isUnbuiltIndexHtml / hasBuildScript', () => {
  it('recognizes source entry pages', () => {
    expect(isUnbuiltIndexHtml(VITE_SOURCE_INDEX)).toBe(true);
    expect(isUnbuiltIndexHtml('<script type="module" src="./src/main.ts?x=1"></script>')).toBe(
      true,
    );
    expect(isUnbuiltIndexHtml("<script src='/src/main.jsx'></script>")).toBe(true);
    expect(isUnbuiltIndexHtml('<script type="module">import "/src/main.vue"</script>')).toBe(true);
    expect(isUnbuiltIndexHtml('<link href="%PUBLIC_URL%/favicon.ico">')).toBe(true);
  });

  it('accepts built and plain pages', () => {
    expect(isUnbuiltIndexHtml(BUILT_INDEX)).toBe(false);
    expect(isUnbuiltIndexHtml('<script src="game.js"></script><h1>hi</h1>')).toBe(false);
    expect(isUnbuiltIndexHtml('<script src="https://cdn.example.com/lib.ts"></script>')).toBe(
      false,
    );
    expect(isUnbuiltIndexHtml('<script type="importmap">{}</script>')).toBe(false);
  });

  it('reads build scripts', () => {
    expect(hasBuildScript('{"scripts":{"build":"vite build"}}')).toBe(true);
    expect(hasBuildScript('{"scripts":{"start":"serve"}}')).toBe(false);
    expect(hasBuildScript('{"scripts":{"build":1}}')).toBe(false);
    expect(hasBuildScript('null')).toBe(false);
    expect(hasBuildScript('{oops')).toBe(false);
  });
});

describe('importSite', () => {
  it('packs the site and reads nothing outside it', async () => {
    const src = source({
      'my-app/index.html': VITE_SOURCE_INDEX,
      'my-app/package.json': '{"scripts":{"build":"vite build"}}',
      'my-app/src/main.tsx': 'x',
      'my-app/dist/index.html': BUILT_INDEX,
      'my-app/dist/assets/index-abc.js': 'console.log(1)',
    });
    const r = await importSite(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.site.root).toBe('my-app/dist/');
    expect(r.site.files).toBe(2);
    expect(r.site.skipped).toBe(3);
    expect(src.reads.sort()).toEqual(
      [
        'my-app/dist/assets/index-abc.js',
        'my-app/dist/index.html',
        'my-app/dist/index.html',
      ].sort(),
    );
    const files = unpackSite(r.site.pack);
    expect(files.get('index.html')?.type).toBe('text/html; charset=utf-8');
    expect(files.get('assets/index-abc.js')?.type).toBe('text/javascript; charset=utf-8');
    expect(r.site.bytes).toBe(enc.encode(BUILT_INDEX).byteLength + 14);
  });

  it('says "build it first" for an unbuilt Vite project and a project with a build script', async () => {
    const vite = await importSite(source({ 'index.html': VITE_SOURCE_INDEX, 'src/main.tsx': 'x' }));
    expect(!vite.ok && vite.error.code).toBe('not-built');
    const withScript = await importSite(
      source({ 'index.html': '<h1>x</h1>', 'package.json': '{"scripts":{"build":"tsc"}}' }),
    );
    expect(!withScript.ok && withScript.error.code).toBe('not-built');
    const plain = await importSite(
      source({ 'index.html': '<h1>x</h1>', 'package.json': '{"scripts":{"start":"serve ."}}' }),
    );
    expect(plain.ok).toBe(true);
  });

  it('reports a file the browser could not read', async () => {
    const src = source({ 'index.html': BUILT_INDEX });
    const r = await importSite({ ...src, entries: [...src.entries, { path: 'gone.js', size: 1 }] });
    expect(!r.ok && r.error).toEqual({ code: 'read-failed', detail: 'gone.js' });
  });

  it('reports a site whose real size is over the limit', async () => {
    const r = await importSite({
      entries: [
        { path: 'index.html', size: 1 },
        { path: 'big.bin', size: 1 },
      ],
      read: (p) =>
        Promise.resolve(
          p === 'index.html' ? enc.encode('<h1>x</h1>') : new Uint8Array(SITE_LIMITS.maxPackBytes),
        ),
    });
    expect(!r.ok && r.error.code).toBe('too-large');
  });
});

describe('describeImportError', () => {
  it('has a title and a hint for every code', () => {
    const codes: ImportErrorCode[] = [
      'empty',
      'no-index',
      'not-built',
      'nextjs-not-exported',
      'too-many-files',
      'too-large',
      'path-too-long',
      'bad-zip',
      'too-many-entries',
      'read-failed',
    ];
    for (const code of codes) {
      const d = describeImportError({ code, detail: '7340032' });
      expect(d.title.length).toBeGreaterThan(5);
      expect(d.hint.length).toBeGreaterThan(10);
    }
    expect(describeImportError({ code: 'too-large', detail: '7340032' }).hint).toContain('7.0 MB');
    expect(describeImportError({ code: 'not-built' }).hint).toContain('npm run build');
  });

  it('has a title and a hint for every error of a copied link (copySite, import-url)', () => {
    const codes: (UrlImportErrorCode | CopyErrorCode)[] = [
      'url-invalid',
      'url-host-not-allowed',
      'url-unreachable',
      'url-not-html',
      'url-private',
      'url-timeout',
      'rate-limited',
      'too-many-files',
      'too-large',
    ];
    const titles = new Set<string>();
    for (const code of codes) {
      const d = describeImportError({ code });
      expect(d.title.length, code).toBeGreaterThan(5);
      expect(d.hint.length, code).toBeGreaterThan(10);
      titles.add(d.title);
    }
    expect(titles.size).toBe(codes.length);
    expect(describeImportError({ code: 'url-host-not-allowed' }).hint).toContain('*.lovable.app');
    expect(describeImportError({ code: 'url-private' }).title).toBe('That site is private');
    expect(describeImportError({ code: 'url-not-html' }).title).toBe("That link isn't a web page");
    expect(describeImportError({ code: 'url-unreachable', detail: '404' }).hint).toContain('(404)');
    expect(describeImportError({ code: 'rate-limited', detail: '45' }).hint).toMatch(
      /^Wait 45 seconds/,
    );
    expect(describeImportError({ code: 'rate-limited', detail: '541' }).hint).toMatch(
      /^Wait 10 minutes/,
    );
    expect(describeImportError({ code: 'rate-limited' }).hint).toMatch(/^Wait a few minutes/);
    expect(describeImportError({ code: 'too-many-files', detail: 'more than 300' }).hint).toContain(
      'this one has more than 300',
    );
  });
});
