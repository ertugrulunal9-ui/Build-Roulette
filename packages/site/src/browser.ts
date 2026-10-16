/**
 * Browser adapters for `importSite` (docs/09 §9.2): a drop (`DataTransfer`), a file input
 * (`<input type="file" webkitdirectory>` or a picked .zip) and a .zip blob.
 *
 * Folders are walked without descending into node_modules, .git or __MACOSX, and a .zip is
 * listed first and only the site's files are inflated, so dropping a whole project folder or
 * zipping one with its dependencies stays cheap.
 */
import { unzip, type UnzipFileInfo } from 'fflate';
import {
  ImportFailure,
  importSite,
  planSite,
  type ImportEntry,
  type ImportResult,
  type ImportSource,
} from './import';
import { SITE_LIMITS } from './limits';

const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '__MACOSX']);
/** Largest .zip read at all (a zipped project with node_modules is far larger). */
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;

function isZip(file: { name: string; type: string }): boolean {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip';
}

function failed(e: unknown): ImportResult {
  if (e instanceof ImportFailure) return { ok: false, error: e.error };
  return {
    ok: false,
    error: { code: 'read-failed', detail: e instanceof Error ? e.message : String(e) },
  };
}

/**
 * Imports what a file input gave: files from a folder picker (`webkitRelativePath`), loose
 * files, or one .zip.
 */
export async function importFiles(files: readonly File[]): Promise<ImportResult> {
  try {
    const [first] = files;
    if (files.length === 1 && first && isZip(first)) return await importSite(await fromZip(first));
    return await importSite(fromFiles(files));
  } catch (e) {
    return failed(e);
  }
}

/**
 * Imports a drop. Call it from the `drop` handler itself: the drop's items are only readable
 * during the event, and this function takes them before its first `await`.
 */
export function importDrop(dataTransfer: DataTransfer): Promise<ImportResult> {
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) {
      entries.push(entry);
    } else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }
  if (entries.length === 0 && looseFiles.length === 0) {
    looseFiles.push(...Array.from(dataTransfer.files));
  }
  return (async () => {
    try {
      if (entries.length === 0) return await importFiles(looseFiles);
      const [only] = entries;
      if (entries.length === 1 && only?.isFile && /\.zip$/i.test(only.name)) {
        return await importSite(await fromZip(await fileOf(only as FileSystemFileEntry)));
      }
      return await importSite(await fromEntries(entries));
    } catch (e) {
      return failed(e);
    }
  })();
}

/** A source over `File`s; the path is `webkitRelativePath` when there is one. */
export function fromFiles(files: readonly File[]): ImportSource {
  const byPath = new Map<string, File>();
  for (const f of files) byPath.set(f.webkitRelativePath || f.name, f);
  return {
    entries: [...byPath].map(([path, f]) => ({ path, size: f.size })),
    read: async (path) => {
      const f = byPath.get(path);
      if (!f) throw new ImportFailure({ code: 'read-failed', detail: path });
      return new Uint8Array(await f.arrayBuffer());
    },
  };
}

/** A source over dropped `FileSystemEntry`s (folders are walked). */
export async function fromEntries(roots: readonly FileSystemEntry[]): Promise<ImportSource> {
  const byPath = new Map<string, FileSystemFileEntry>();
  const sizes = new Map<string, number>();
  let listed = 0;
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (++listed > SITE_LIMITS.maxListedEntries) {
      throw new ImportFailure({ code: 'too-many-entries' });
    }
    if (entry.isDirectory) {
      if (SKIPPED_FOLDERS.has(entry.name)) return;
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child);
      return;
    }
    if (entry.isFile) byPath.set(entry.fullPath, entry as FileSystemFileEntry);
  };
  for (const root of roots) await walk(root);
  // Sizes come from the File objects, but only for files that may be part of the site: a
  // project folder's source files are listed by path first and never opened.
  const candidates = planSite([...byPath.keys()].map((path) => ({ path, size: 0 })));
  const wanted = candidates.ok
    ? new Set([...candidates.plan.files.map((f) => f.source), ...candidates.plan.projectFiles])
    : new Set<string>();
  const files = new Map<string, File>();
  for (const [path, entry] of byPath) {
    if (!wanted.has(path)) {
      sizes.set(path, 0);
      continue;
    }
    const f = await fileOf(entry);
    files.set(path, f);
    sizes.set(path, f.size);
  }
  return {
    entries: [...sizes].map(([path, size]) => ({ path, size })),
    read: async (path) => {
      const entry = byPath.get(path);
      const f = files.get(path) ?? (entry ? await fileOf(entry) : null);
      if (!f) throw new ImportFailure({ code: 'read-failed', detail: path });
      return new Uint8Array(await f.arrayBuffer());
    },
  };
}

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // `readEntries` returns at most ~100 entries per call; an empty batch means done.
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(out);
          return;
        }
        out.push(...batch);
        if (out.length > SITE_LIMITS.maxListedEntries) {
          reject(new ImportFailure({ code: 'too-many-entries' }));
          return;
        }
        next();
      }, reject);
    };
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function unzipAsync(
  data: Uint8Array,
  filter: (f: UnzipFileInfo) => boolean,
): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, { filter }, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
}

/**
 * A source over a .zip: listed first (nothing inflated), then only the files `importSite`
 * may read are inflated.
 */
export async function fromZip(zip: Blob): Promise<ImportSource> {
  if (zip.size > MAX_ZIP_BYTES) {
    throw new ImportFailure({ code: 'too-large', detail: String(zip.size) });
  }
  const data = new Uint8Array(await zip.arrayBuffer());
  const entries: ImportEntry[] = [];
  try {
    await unzipAsync(data, (f) => {
      if (entries.length >= SITE_LIMITS.maxListedEntries) {
        throw new ImportFailure({ code: 'too-many-entries' });
      }
      if (!f.name.endsWith('/')) entries.push({ path: f.name, size: f.originalSize });
      return false;
    });
  } catch (e) {
    if (e instanceof ImportFailure) throw e;
    throw new ImportFailure({ code: 'bad-zip' });
  }
  const planned = planSite(entries);
  const wanted = planned.ok
    ? new Set([...planned.plan.files.map((f) => f.source), ...planned.plan.projectFiles])
    : new Set<string>();
  let inflated: Record<string, Uint8Array> = {};
  if (wanted.size > 0) {
    try {
      inflated = await unzipAsync(data, (f) => wanted.has(f.name));
    } catch {
      throw new ImportFailure({ code: 'bad-zip' });
    }
  }
  return {
    entries,
    read: (path) => {
      const bytes = inflated[path];
      if (!bytes) return Promise.reject(new ImportFailure({ code: 'read-failed', detail: path }));
      return Promise.resolve(bytes);
    },
  };
}
