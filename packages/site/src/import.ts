/**
 * Importing a built site (docs/09 §9.2): from whatever the player dropped (a `dist/` folder,
 * a whole project folder, loose files, a .zip) to a site pack.
 *
 * Two steps, so a dropped project folder never has its node_modules read:
 * 1. `planSite(entries)` works on paths and sizes only: it normalizes the paths, skips junk,
 *    finds the site root and applies the limits.
 * 2. `importSite(source)` reads `index.html` (and `package.json` when the root is not an
 *    output folder) to recognize source code that was not built, then reads the site's
 *    files and packs them.
 */
import { contentTypeOf } from './content-types';
import { SITE_LIMITS } from './limits';
import { SITE_ENTRY, SitePackError, packSite, type SiteFile } from './pack';
import { baseName, dirOf, normalizeInputPath } from './paths';

/** One file of the drop, as the browser or the zip reports it. */
export interface ImportEntry {
  path: string;
  size: number;
}

/** What the player dropped. `read` takes an `ImportEntry.path` exactly as listed. */
export interface ImportSource {
  entries: readonly ImportEntry[];
  read(path: string): Promise<Uint8Array>;
}

export type ImportErrorCode =
  /** Nothing usable was dropped. */
  | 'empty'
  /** No `index.html` anywhere. */
  | 'no-index'
  /** Source code of a project that needs a build (`npm run build`). */
  | 'not-built'
  /** A Next.js project without a static export. */
  | 'nextjs-not-exported'
  | 'too-many-files'
  | 'too-large'
  | 'path-too-long'
  /** The .zip could not be read. */
  | 'bad-zip'
  /** A folder with more entries than `SITE_LIMITS.maxListedEntries`. */
  | 'too-many-entries'
  /** The browser could not read a file. */
  | 'read-failed';

export interface ImportError {
  code: ImportErrorCode;
  /** A file name or a number that makes the message concrete. */
  detail?: string;
}

export class ImportFailure extends Error {
  override readonly name = 'ImportFailure';
  constructor(readonly error: ImportError) {
    super(error.code + (error.detail === undefined ? '' : `: ${error.detail}`));
  }
}

export interface PlannedFile {
  /** The path in the drop (`ImportEntry.path`). */
  source: string;
  /** The path inside the site. */
  path: string;
  size: number;
}

export interface SitePlan {
  /** The site root inside the drop, normalized, with a trailing `/` (`''`, `dist/`). */
  root: string;
  /** Whether the root is a known build output folder (`dist/`, `build/`, `out/`, …). */
  outputFolder: boolean;
  files: PlannedFile[];
  /** Sum of the files' sizes. */
  bytes: number;
  /** Files of the drop that are not part of the site (outside the root, or junk). */
  skipped: number;
  /** `package.json` files (drop paths) in the root or above it, when it is no output folder. */
  projectFiles: string[];
}

export type PlanResult = { ok: true; plan: SitePlan } | { ok: false; error: ImportError };

export interface ImportedSite {
  pack: Uint8Array<ArrayBuffer>;
  root: string;
  files: number;
  /** Sum of the files' sizes (without the pack header). */
  bytes: number;
  skipped: number;
}

export type ImportResult = { ok: true; site: ImportedSite } | { ok: false; error: ImportError };

/** Folders build tools write a static site to, in order of preference. */
const OUTPUT_FOLDERS = ['dist', 'build', 'out', '_site', '.output/public', 'www'] as const;
/** Folders skipped wherever they are. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '__MACOSX']);
/** Files skipped wherever they are. */
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
/** Script sources that only a dev server or a bundler understands. */
const SOURCE_SCRIPT_RE = /\.(?:tsx?|mts|cts|jsx|vue|svelte)(?:[?#].*)?$/i;

function outputRank(root: string): number {
  for (let i = 0; i < OUTPUT_FOLDERS.length; i++) {
    const name = OUTPUT_FOLDERS[i] ?? '';
    if (root === `${name}/` || root.endsWith(`/${name}/`)) return i;
  }
  return -1;
}

function depth(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length - 1;
}

/** Hidden segments in a folder above the site root: only `.output` (Nuxt) is allowed. */
function rootAllowed(dir: string): boolean {
  return dir
    .split('/')
    .filter((s) => s !== '')
    .every((s) => !s.startsWith('.') || s === '.output');
}

/** Files inside the site that are not served: hidden files and folders, source maps, junk. */
function keepInSite(relative: string): boolean {
  if (relative.endsWith('.map')) return false;
  if (SKIPPED_FILES.has(baseName(relative))) return false;
  return relative.split('/').every((s) => !s.startsWith('.') || s === '.well-known');
}

/** Step 1 (paths and sizes only). See the file comment. */
export function planSite(entries: readonly ImportEntry[]): PlanResult {
  const usable: { source: string; path: string; size: number }[] = [];
  let skipped = 0;
  let nextProject = false;
  for (const e of entries) {
    const path = normalizeInputPath(e.path);
    if (path === null) {
      skipped++;
      continue;
    }
    const segments = path.split('/');
    if (segments.some((s) => SKIPPED_FOLDERS.has(s))) {
      skipped++;
      continue;
    }
    if (segments.includes('.next')) nextProject = true;
    usable.push({ source: e.path, path, size: e.size });
  }
  if (usable.length === 0) return { ok: false, error: { code: 'empty' } };

  const candidates = usable
    .filter((f) => baseName(f.path) === SITE_ENTRY && rootAllowed(dirOf(f.path)))
    .map((f) => dirOf(f.path));
  const byPreference = (a: string, b: string): number => {
    const ra = outputRank(a);
    const rb = outputRank(b);
    if (ra >= 0 !== rb >= 0) return ra >= 0 ? -1 : 1;
    if (depth(a) !== depth(b)) return depth(a) - depth(b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const root = candidates.sort(byPreference)[0];
  if (root === undefined) {
    if (nextProject) return { ok: false, error: { code: 'nextjs-not-exported' } };
    if (usable.some((f) => baseName(f.path) === 'package.json')) {
      return { ok: false, error: { code: 'not-built' } };
    }
    return { ok: false, error: { code: 'no-index' } };
  }
  const outputFolder = outputRank(root) >= 0;
  if (nextProject && !outputFolder) {
    return { ok: false, error: { code: 'nextjs-not-exported' } };
  }

  const files: PlannedFile[] = [];
  let bytes = 0;
  for (const f of usable) {
    if (!f.path.startsWith(root)) {
      skipped++;
      continue;
    }
    const relative = f.path.slice(root.length);
    if (!keepInSite(relative)) {
      skipped++;
      continue;
    }
    if (relative.length > SITE_LIMITS.maxPathChars) {
      return { ok: false, error: { code: 'path-too-long', detail: relative } };
    }
    files.push({ source: f.source, path: relative, size: f.size });
    bytes += f.size;
  }
  if (files.length > SITE_LIMITS.maxFiles) {
    return { ok: false, error: { code: 'too-many-files', detail: String(files.length) } };
  }
  if (bytes > SITE_LIMITS.maxPackBytes) {
    return { ok: false, error: { code: 'too-large', detail: String(bytes) } };
  }

  // A project's package.json in the root or a folder above it: when the root is not an output
  // folder, a `build` script there means the player dropped source code.
  const projectFiles = outputFolder
    ? []
    : usable
        .filter((f) => baseName(f.path) === 'package.json' && root.startsWith(dirOf(f.path)))
        .map((f) => f.source);
  return { ok: true, plan: { root, outputFolder, files, bytes, skipped, projectFiles } };
}

/**
 * Whether an `index.html` is a project's unbuilt entry page: a script that points at
 * TypeScript, JSX, Vue or Svelte source (Vite's `/src/main.tsx`), or Create React App's
 * `%PUBLIC_URL%` placeholder.
 */
export function isUnbuiltIndexHtml(html: string): boolean {
  if (html.includes('%PUBLIC_URL%')) return true;
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    const src = m[1] ?? '';
    if (/^(?:[a-z]+:)?\/\//i.test(src)) continue;
    if (SOURCE_SCRIPT_RE.test(src)) return true;
  }
  for (const m of html.matchAll(/\bimport\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)) {
    if (SOURCE_SCRIPT_RE.test(m[1] ?? '')) return true;
  }
  return false;
}

/** Whether a package.json declares a `build` script. False for anything unreadable. */
export function hasBuildScript(packageJson: string): boolean {
  try {
    const pkg = JSON.parse(packageJson) as { scripts?: Record<string, unknown> } | null;
    return typeof pkg?.scripts?.['build'] === 'string';
  } catch {
    return false;
  }
}

const decoder = new TextDecoder();

/** Step 2: reads, checks and packs. Never throws; read errors become `read-failed`. */
export async function importSite(source: ImportSource): Promise<ImportResult> {
  const planned = planSite(source.entries);
  if (!planned.ok) return planned;
  const { plan } = planned;
  try {
    const index = plan.files.find((f) => f.path === SITE_ENTRY);
    if (index && isUnbuiltIndexHtml(decoder.decode(await read(source, index.source)))) {
      return { ok: false, error: { code: 'not-built' } };
    }
    for (const p of plan.projectFiles) {
      if (hasBuildScript(decoder.decode(await read(source, p)))) {
        return { ok: false, error: { code: 'not-built' } };
      }
    }
    const files: SiteFile[] = [];
    for (const f of plan.files) {
      files.push({
        path: f.path,
        type: contentTypeOf(f.path),
        bytes: await read(source, f.source),
      });
    }
    let pack: Uint8Array<ArrayBuffer>;
    try {
      pack = packSite(files);
    } catch (e) {
      if (e instanceof SitePackError && e.message.includes('too large')) {
        const bytes = files.reduce((n, f) => n + f.bytes.byteLength, 0);
        return { ok: false, error: { code: 'too-large', detail: String(bytes) } };
      }
      throw e;
    }
    return {
      ok: true,
      site: {
        pack,
        root: plan.root,
        files: files.length,
        bytes: files.reduce((n, f) => n + f.bytes.byteLength, 0),
        skipped: plan.skipped,
      },
    };
  } catch (e) {
    if (e instanceof ImportFailure) return { ok: false, error: e.error };
    return { ok: false, error: { code: 'read-failed', detail: errorText(e) } };
  }
}

async function read(source: ImportSource, path: string): Promise<Uint8Array> {
  try {
    return await source.read(path);
  } catch (e) {
    if (e instanceof ImportFailure) throw e;
    throw new ImportFailure({ code: 'read-failed', detail: path });
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What to tell the player: a short title and what to do next. Plain text; the UI may style
 * the `code` spans (backticks) itself.
 */
export function describeImportError(e: ImportError): { title: string; hint: string } {
  switch (e.code) {
    case 'empty':
      return {
        title: 'Nothing to import',
        hint: 'Drop the folder your build wrote (usually `dist`), or a .zip of it.',
      };
    case 'no-index':
      return {
        title: 'No index.html found',
        hint: 'A site needs an `index.html`. Drop the folder your build wrote (usually `dist`), not a single file.',
      };
    case 'not-built':
      return {
        title: 'This is source code, not the built site',
        hint: 'Build it first: run `npm run build` in your project (or ask your AI tool to build it), then drop the `dist` folder it creates.',
      };
    case 'nextjs-not-exported':
      return {
        title: 'Next.js needs a static export',
        hint: "Set `output: 'export'` in next.config, run `npm run build`, then drop the `out` folder.",
      };
    case 'too-many-files':
      return {
        title: 'Too many files',
        hint: `A site can have at most ${SITE_LIMITS.maxFiles} files${e.detail ? ` (this one has ${e.detail})` : ''}. Drop only the built site, without node_modules or source folders.`,
      };
    case 'too-large': {
      const size = e.detail === undefined ? '' : ` (this one is ${megabytes(Number(e.detail))})`;
      return {
        title: 'The site is too large',
        hint: `A site can be at most ${megabytes(SITE_LIMITS.maxPackBytes)}${size}. Shrink big images, videos or fonts and build again.`,
      };
    }
    case 'path-too-long':
      return {
        title: 'A file path is too long',
        hint: `Paths inside the site can be at most ${SITE_LIMITS.maxPathChars} characters${e.detail ? `: ${e.detail.slice(0, 60)}…` : '.'}`,
      };
    case 'bad-zip':
      return {
        title: "That .zip couldn't be read",
        hint: 'Zip the built folder again (a plain .zip, not .rar or .7z), or drop the folder itself.',
      };
    case 'too-many-entries':
      return {
        title: 'That folder is far too big',
        hint: 'Drop only your built site (usually the `dist` folder), not a whole drive or workspace.',
      };
    case 'read-failed':
      return {
        title: "Some files couldn't be read",
        hint: 'Try again, or zip the built folder and drop the .zip.',
      };
  }
}
