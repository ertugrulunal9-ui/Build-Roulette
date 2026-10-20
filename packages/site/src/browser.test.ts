import { strToU8, zipSync as zipRaw } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_ZIP_BYTES, fromZip, importDrop, importFiles } from './browser';
import { unpackSite } from './pack';

/** fflate's output, copied into an ArrayBuffer-backed array (what `File` takes). */
const zipSync = (files: Parameters<typeof zipRaw>[0]) => new Uint8Array(zipRaw(files));

const BUILT_INDEX = '<!doctype html><script type="module" src="/assets/a.js"></script>';

function fileAt(path: string, text: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

/** A fake FileSystemEntry tree; records which folders were opened. */
function tree(files: Record<string, string>, opened: string[] = []): FileSystemEntry[] {
  interface Dir {
    children: Map<string, Dir | string>;
  }
  const root: Dir = { children: new Map() };
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.children.get(p);
      if (next === undefined || typeof next === 'string') {
        next = { children: new Map() };
        d.children.set(p, next);
      }
      d = next;
    }
    d.children.set(parts.at(-1) ?? '', text);
  }
  const entry = (name: string, fullPath: string, node: Dir | string): FileSystemEntry => {
    if (typeof node === 'string') {
      return {
        isFile: true,
        isDirectory: false,
        name,
        fullPath,
        file: (ok: (f: File) => void) => {
          ok(new File([node], name));
        },
      } as unknown as FileSystemEntry;
    }
    return {
      isFile: false,
      isDirectory: true,
      name,
      fullPath,
      createReader: () => {
        opened.push(fullPath);
        const all = [...node.children].map(([n, c]) => entry(n, `${fullPath}/${n}`, c));
        return {
          // Small batches, like browsers that return ~100 entries per call; [] means done.
          readEntries: (ok: (b: FileSystemEntry[]) => void) => {
            setTimeout(() => {
              ok(all.splice(0, 2));
            }, 0);
          },
        };
      },
    } as unknown as FileSystemEntry;
  };
  return [...root.children].map(([n, c]) => entry(n, `/${n}`, c));
}

function fakeDrop(entries: FileSystemEntry[]): DataTransfer {
  return {
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e, getAsFile: () => null })),
    files: [],
  } as unknown as DataTransfer;
}

describe('importFiles', () => {
  it('imports a folder picked with webkitdirectory', async () => {
    const r = await importFiles([
      fileAt('dist/index.html', BUILT_INDEX),
      fileAt('dist/assets/a.js', 'x'),
    ]);
    expect(r.ok && r.site.root).toBe('dist/');
    expect(r.ok && [...unpackSite(r.site.pack).keys()]).toEqual(['assets/a.js', 'index.html']);
  });

  it('imports a picked .zip of a project folder, inflating only the site', async () => {
    const zip = zipSync({
      'my-app/package.json': strToU8('{"scripts":{"build":"vite build"}}'),
      'my-app/node_modules/big/index.js': strToU8('x'.repeat(1000)),
      'my-app/dist/index.html': strToU8(BUILT_INDEX),
      'my-app/dist/assets/a.js': strToU8('console.log(1)'),
    });
    const r = await importFiles([new File([zip], 'site.zip', { type: 'application/zip' })]);
    expect(r.ok && r.site.root).toBe('my-app/dist/');
    expect(r.ok && r.site.files).toBe(2);
  });

  it('reports a broken or oversized zip', async () => {
    const bad = await importFiles([new File([new Uint8Array([1, 2, 3])], 'x.zip')]);
    expect(!bad.ok && bad.error.code).toBe('bad-zip');
    const huge = { size: MAX_ZIP_BYTES + 1, arrayBuffer: () => Promise.reject(new Error('read')) };
    await expect(fromZip(huge as unknown as Blob)).rejects.toMatchObject({
      error: { code: 'too-large' },
    });
  });

  it('says "build it first" for a zipped source project', async () => {
    const zip = zipSync({
      'index.html': strToU8('<script type="module" src="/src/main.tsx"></script>'),
      'src/main.tsx': strToU8('x'),
    });
    const r = await importFiles([new File([zip], 'p.zip')]);
    expect(!r.ok && r.error.code).toBe('not-built');
  });
});

describe('importDrop', () => {
  it('walks a dropped project folder without opening node_modules or .git', async () => {
    const opened: string[] = [];
    const r = await importDrop(
      fakeDrop(
        tree(
          {
            'my-app/package.json': '{"scripts":{"build":"vite build"}}',
            'my-app/index.html': '<script type="module" src="/src/main.tsx"></script>',
            'my-app/src/main.tsx': 'x',
            'my-app/node_modules/react/index.js': 'x',
            'my-app/.git/HEAD': 'x',
            'my-app/dist/index.html': BUILT_INDEX,
            'my-app/dist/assets/a.js': 'x',
            'my-app/dist/assets/b.js': 'y',
          },
          opened,
        ),
      ),
    );
    expect(r.ok && r.site.root).toBe('my-app/dist/');
    expect(r.ok && r.site.files).toBe(3);
    expect(opened.some((p) => p.includes('node_modules') || p.includes('.git'))).toBe(false);
  });

  it('imports a dropped .zip', async () => {
    const zip = zipSync({ 'index.html': strToU8('<h1>hi</h1>') });
    const entry = {
      isFile: true,
      isDirectory: false,
      name: 'site.zip',
      fullPath: '/site.zip',
      file: (ok: (f: File) => void) => {
        ok(new File([zip], 'site.zip'));
      },
    } as unknown as FileSystemEntry;
    const r = await importDrop(fakeDrop([entry]));
    expect(r.ok && r.site.files).toBe(1);
  });

  it('says what is wrong with a drop that holds no site', async () => {
    const r = await importDrop(fakeDrop(tree({ 'notes/readme.md': 'x' })));
    expect(!r.ok && r.error.code).toBe('no-index');
  });
});
