/**
 * Disk quota and LRU eviction for the cache directory.
 *
 * Entries (keys are paths relative to the cache dir, with `/`):
 *   store/<name>/<version>     an extracted package
 *   trees/v1/<name>@<version>  a dependency tree of hard links into the store
 *   bundles/<xx>/<sha256>      a bundled module (`.js` + `.json`)
 *
 * Accounting: bytes are estimated disk usage (files rounded up to 4 KiB blocks, plus a block
 * per directory). A tree's files are hard links into the store, so a tree only counts its own
 * directories, `tree.json` and files it had to copy; the linked data is counted once, in the
 * store. Because those links keep the data alive, evicting a store entry also evicts every
 * tree that contains it (otherwise no space would be freed), and that tree's bundles stay
 * (bundles are self-contained).
 *
 * Eviction: when the total goes over the quota, the least recently used store and bundle
 * entries are removed until the total is under `lowWaterRatio * quota`. An entry that is
 * leased (an in-flight build is using the tree, a raw file is being opened, a tree is being
 * laid out from a store entry) is never evicted, and neither is a store entry whose trees are
 * leased. Callers take the lease *before* checking that the entry exists and wait for
 * `settled(key)`, so an entry that was picked for eviction is re-created, never half-used.
 *
 * Crash safety: a store or tree directory is renamed into `trash/` (atomic) before it is
 * deleted, so its live path either holds the complete entry or nothing. A bundle's `.json`
 * (whose presence means "complete") is unlinked before its `.js`. Leftovers (`trash/`, stale
 * `.tmp-*` directories and downloads, bundle `.js` files without `.json`) are removed at
 * startup.
 *
 * Access times live in memory and are persisted in `cache-index.json` (written atomically,
 * at most once per flush interval and only when something changed by more than the touch
 * resolution), together with entry sizes, which never change after creation. This costs no
 * syscall per cache hit (unlike updating mtimes) and does not depend on filesystem atime
 * (often `noatime`/`relatime`). A crash loses at most one flush interval of recency, which
 * only changes the eviction order, never correctness. At startup the index is reconciled
 * with the directory listing: unknown entries are measured (mtime as access time) and
 * vanished ones dropped. Keys from the index file are only ever used for lookups; every path
 * that is deleted comes from the directory listing.
 *
 * One process owns a cache directory (eviction state is in memory).
 */
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { encodeNameForPath } from './names';
import { diskSize } from './tar';

export const INDEX_FILE = 'cache-index.json';
const INDEX_VERSION = 1;
const DIR_BYTES = 4096;
/** Temporary files and directories older than this are leftovers from a crash. */
const STALE_TMP_MS = 10 * 60 * 1000;

export type EntryKind = 'store' | 'trees' | 'bundles';

interface Entry {
  bytes: number;
  /** Last access, ms since epoch. */
  at: number;
  /** Store keys a tree links to. */
  deps?: string[];
}

export function storeKey(name: string, version: string): string {
  return `store/${encodeNameForPath(name)}/${version}`;
}

export function treeKey(format: string, name: string, version: string): string {
  return `trees/${format}/${encodeNameForPath(name)}@${version}`;
}

export function bundleKey(hash: string): string {
  return `bundles/${hash.slice(0, 2)}/${hash}`;
}

export interface CacheIndexOptions {
  /** The cache directory. */
  root: string;
  /** Disk quota in bytes; 0 disables eviction. */
  quotaBytes: number;
  /** Evict down to this fraction of the quota. Default 0.9. */
  lowWaterRatio?: number;
  /** How often a changed index is written. Default 60 s. */
  flushIntervalMs?: number;
  /** Access-time changes smaller than this do not make the index dirty. Default 60 s. */
  touchResolutionMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function isTmpName(name: string): boolean {
  return name.includes('.tmp-');
}

async function dirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Estimated disk usage of a directory tree. With `sharedLinks`, files that have other hard
 * links (the store's copy) are not counted.
 */
async function measureDir(dir: string, sharedLinks: boolean): Promise<number> {
  let total = DIR_BYTES;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await measureDir(p, sharedLinks);
    } else if (e.isFile()) {
      const st = await lstat(p);
      if (!sharedLinks || st.nlink <= 1) total += diskSize(st.size);
    }
  }
  return total;
}

export class CacheIndex {
  readonly root: string;
  readonly quotaBytes: number;
  private readonly lowWater: number;
  private readonly flushIntervalMs: number;
  private readonly touchResolutionMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly entries = new Map<string, Entry>();
  /** store key -> tree keys that link to it */
  private readonly dependents = new Map<string, Set<string>>();
  private readonly leases = new Map<string, number>();
  private readonly evicting = new Map<string, Promise<void>>();
  private total = 0;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private requested = 0;
  private closed = false;
  readonly counters = {
    evictionRuns: 0,
    evictedEntries: 0,
    evictedBytes: 0,
    evictionErrors: 0,
    /** Candidates skipped because they (or a tree linking them) were leased. */
    skippedLeased: 0,
    indexWrites: 0,
  };

  constructor(opts: CacheIndexOptions) {
    this.root = path.resolve(opts.root);
    this.quotaBytes = opts.quotaBytes;
    this.lowWater = Math.floor(opts.quotaBytes * (opts.lowWaterRatio ?? 0.9));
    this.flushIntervalMs = opts.flushIntervalMs ?? 60_000;
    this.touchResolutionMs = opts.touchResolutionMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.log =
      opts.log ??
      (() => {
        // Logging is opt-in.
      });
  }

  /** Absolute path of an entry (for bundles, without the `.js`/`.json` extension). */
  pathOf(key: string): string {
    return path.join(this.root, ...key.split('/'));
  }

  private kindOf(key: string): EntryKind {
    return key.slice(0, key.indexOf('/')) as EntryKind;
  }

  get bytes(): number {
    return this.total;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Protects `key` from eviction until the returned function is called (idempotent). */
  lease(key: string): () => void {
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.leases.get(key) ?? 1) - 1;
      if (n <= 0) this.leases.delete(key);
      else this.leases.set(key, n);
    };
  }

  /** Leases several keys at once; the returned function releases them all. */
  leaseAll(keys: Iterable<string>): () => void {
    const releases = [...keys].map((k) => this.lease(k));
    return () => {
      for (const r of releases) r();
    };
  }

  isLeased(key: string): boolean {
    return (this.leases.get(key) ?? 0) > 0;
  }

  /** Resolves once no eviction of `key` is in progress (immediately in the usual case). */
  async settled(key: string): Promise<void> {
    await this.evicting.get(key);
  }

  /** A new (complete) entry on disk. */
  record(key: string, bytes: number, deps?: readonly string[]): void {
    this.removeEntry(key);
    const entry: Entry = { bytes, at: this.now() };
    if (deps && deps.length > 0) {
      entry.deps = [...deps];
      for (const d of deps) {
        let set = this.dependents.get(d);
        if (!set) {
          set = new Set();
          this.dependents.set(d, set);
        }
        set.add(key);
      }
    }
    this.entries.set(key, entry);
    this.total += bytes;
    this.markDirty();
    this.scheduleEviction();
  }

  /** The entry was used (a tree also refreshes the store entries it links to). */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const now = this.now();
    if (now - entry.at >= this.touchResolutionMs) this.markDirty();
    entry.at = Math.max(entry.at, now);
    for (const d of entry.deps ?? []) this.touch(d);
  }

  /** The entry is gone from disk (e.g. found incomplete). */
  forget(key: string): void {
    if (this.removeEntry(key)) this.markDirty();
  }

  private removeEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.total -= entry.bytes;
    for (const d of entry.deps ?? []) this.dependents.get(d)?.delete(key);
    return entry;
  }

  stats() {
    const entries = { store: 0, trees: 0, bundles: 0 };
    for (const key of this.entries.keys()) entries[this.kindOf(key)]++;
    return {
      bytes: this.total,
      quotaBytes: this.quotaBytes,
      entries,
      leased: this.leases.size,
      evicting: this.evicting.size,
      ...this.counters,
    };
  }

  // ---------------------------------------------------------------- eviction

  private scheduleEviction(): void {
    if (this.quotaBytes <= 0 || this.total <= this.quotaBytes || this.closed) return;
    void this.evictIfNeeded();
  }

  /** Runs eviction if the cache is over quota (one run at a time; never rejects). */
  evictIfNeeded(): Promise<void> {
    if (this.quotaBytes <= 0 || this.total <= this.quotaBytes)
      return this.running ?? Promise.resolve();
    if (this.running) {
      this.requested++;
      return this.running;
    }
    const run = (async () => {
      for (;;) {
        const seen = this.requested;
        await this.evictOnce();
        // Entries recorded during the run asked for another pass.
        if (this.requested === seen || this.total <= this.quotaBytes) break;
      }
    })()
      .catch((e: unknown) => {
        this.counters.evictionErrors++;
        this.log(`cache eviction failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.running = null;
      });
    this.running = run;
    return run;
  }

  private async evictOnce(): Promise<void> {
    this.counters.evictionRuns++;
    const candidates = [...this.entries.entries()]
      .filter(([key]) => this.kindOf(key) !== 'trees')
      .sort((a, b) => a[1].at - b[1].at)
      .map(([key]) => key);
    for (const key of candidates) {
      if (this.total <= this.lowWater) break;
      if (!this.entries.has(key)) continue;
      // Trees hold hard links into the store entry: they go first, together with it.
      const group = [...(this.dependents.get(key) ?? []), key];
      if (group.some((k) => this.isLeased(k) || this.evicting.has(k))) {
        this.counters.skippedLeased++;
        continue;
      }
      // Synchronously take the entries out of the index and mark them as being evicted, so
      // nobody can start using them between the decision and the deletion.
      const marks = group.map((k) => {
        const d = deferred();
        this.evicting.set(k, d.promise);
        const entry = this.removeEntry(k);
        this.counters.evictedBytes += entry?.bytes ?? 0;
        return { key: k, d };
      });
      this.markDirty();
      for (const { key: k, d } of marks) {
        try {
          await this.deleteFromDisk(k);
          this.counters.evictedEntries++;
        } catch (e) {
          this.counters.evictionErrors++;
          this.log(`cache eviction of ${k} failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          this.evicting.delete(k);
          d.resolve();
        }
      }
    }
  }

  private async deleteFromDisk(key: string): Promise<void> {
    const abs = this.pathOf(key);
    if (this.kindOf(key) === 'bundles') {
      // The .json marks a complete entry: remove it first.
      await unlink(`${abs}.json`).catch(ignoreMissing);
      await unlink(`${abs}.js`).catch(ignoreMissing);
      return;
    }
    const trash = path.join(this.root, 'trash');
    await mkdir(trash, { recursive: true });
    const moved = path.join(
      trash,
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      await rename(abs, moved);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return;
      throw e;
    }
    await rm(moved, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ persistence

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((e: unknown) => {
        this.log(`cache index write failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  /** Writes the index file if it changed (atomically: temp file + rename). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const out: Record<string, [number, number] | [number, number, string[]]> = {};
    for (const [key, e] of this.entries)
      out[key] = e.deps ? [e.bytes, e.at, e.deps] : [e.bytes, e.at];
    const file = path.join(this.root, INDEX_FILE);
    const tmp = `${file}.tmp-${process.pid.toString()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(this.root, { recursive: true });
    await writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, entries: out }));
    await rename(tmp, file);
    this.counters.indexWrites++;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.running;
    await this.flush();
  }

  private async loadIndexFile(): Promise<Map<string, Entry>> {
    const out = new Map<string, Entry>();
    try {
      const raw = JSON.parse(await readFile(path.join(this.root, INDEX_FILE), 'utf8')) as {
        version?: unknown;
        entries?: Record<string, unknown>;
      };
      if (raw.version !== INDEX_VERSION || typeof raw.entries !== 'object') return out;
      for (const [key, v] of Object.entries(raw.entries)) {
        if (!Array.isArray(v)) continue;
        const [bytes, at, deps] = v as unknown[];
        if (typeof bytes !== 'number' || typeof at !== 'number') continue;
        const entry: Entry = { bytes, at };
        if (Array.isArray(deps))
          entry.deps = deps.filter((d): d is string => typeof d === 'string');
        out.set(key, entry);
      }
    } catch {
      // Missing or corrupt: rebuilt from the directory listing.
    }
    return out;
  }

  /**
   * Loads the index, reconciles it with what is on disk, removes crash leftovers and evicts
   * if over quota. Call once before serving.
   */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const known = await this.loadIndexFile();
    const now = this.now();
    const stale: string[] = [path.join(this.root, 'trash')];
    const isStale = async (p: string) => {
      try {
        return now - (await stat(p)).mtimeMs > STALE_TMP_MS;
      } catch {
        return false;
      }
    };
    const consider = async (p: string) => {
      if (await isStale(p)) stale.push(p);
    };

    const found: { key: string; abs: string }[] = [];
    const storeRoot = path.join(this.root, 'store');
    for (const name of await dirNames(storeRoot)) {
      for (const version of await dirNames(path.join(storeRoot, name))) {
        const abs = path.join(storeRoot, name, version);
        if (isTmpName(version)) await consider(abs);
        else found.push({ key: `store/${name}/${version}`, abs });
      }
    }
    const treesRoot = path.join(this.root, 'trees');
    for (const format of await dirNames(treesRoot)) {
      for (const dir of await dirNames(path.join(treesRoot, format))) {
        const abs = path.join(treesRoot, format, dir);
        if (isTmpName(dir)) await consider(abs);
        else found.push({ key: `trees/${format}/${dir}`, abs });
      }
    }
    const bundlesRoot = path.join(this.root, 'bundles');
    for (const shard of await dirNames(bundlesRoot)) {
      let files: string[];
      try {
        files = await readdir(path.join(bundlesRoot, shard));
      } catch {
        continue;
      }
      const names = new Set(files);
      for (const f of files) {
        const abs = path.join(bundlesRoot, shard, f);
        if (isTmpName(f)) await consider(abs);
        else if (f.endsWith('.json'))
          found.push({ key: `bundles/${shard}/${f.slice(0, -5)}`, abs: abs.slice(0, -5) });
        // A .js without its .json: an interrupted write or eviction.
        else if (f.endsWith('.js') && !names.has(`${f.slice(0, -3)}.json`)) await consider(abs);
      }
    }
    const downloads = path.join(this.root, 'tmp');
    for (const f of await readdir(downloads).catch(() => [] as string[])) {
      await consider(path.join(downloads, f));
    }

    // Store and bundle entries first, so trees can check that their store entries exist.
    const order = (k: string) => (k.startsWith('trees/') ? 1 : 0);
    found.sort((a, b) => order(a.key) - order(b.key));
    let measured = 0;
    for (const { key, abs } of found) {
      const kind = this.kindOf(key);
      let entry = known.get(key);
      if (!entry) {
        measured++;
        entry = { bytes: 0, at: now };
        try {
          if (kind === 'bundles') {
            const [js, meta] = await Promise.all([stat(`${abs}.js`), stat(`${abs}.json`)]);
            entry.bytes = diskSize(js.size) + diskSize(meta.size);
            entry.at = meta.mtimeMs;
          } else {
            entry.at = (await stat(abs)).mtimeMs;
            entry.bytes = await measureDir(abs, kind === 'trees');
          }
          if (kind === 'trees') entry.deps = await treeDeps(abs);
        } catch {
          continue;
        }
      }
      if (kind === 'trees' && (entry.deps ?? []).some((d) => !this.entries.has(d))) {
        // Its store entries are gone (crash during eviction, manual deletion): rebuild later.
        stale.push(abs);
        continue;
      }
      this.entries.set(key, { ...entry });
      this.total += entry.bytes;
      for (const d of entry.deps ?? []) {
        let set = this.dependents.get(d);
        if (!set) {
          set = new Set();
          this.dependents.set(d, set);
        }
        set.add(key);
      }
    }
    for (const p of stale) await rm(p, { recursive: true, force: true });
    this.log(
      `cache: ${this.entries.size.toString()} entries, ${(this.total / 1048576).toFixed(0)} MB (${measured.toString()} measured, ${(stale.length - 1).toString()} leftovers removed)`,
    );
    this.dirty = true;
    await this.flush();
    await this.evictIfNeeded();
  }
}

function ignoreMissing(e: unknown): void {
  if ((e as { code?: string }).code !== 'ENOENT') throw e;
}

/** Store keys of the packages in a tree directory (from its tree.json). */
async function treeDeps(treeDir: string): Promise<string[]> {
  const file = path.join(treeDir, 'tree.json');
  if (!existsSync(file)) return [];
  const tree = JSON.parse(await readFile(file, 'utf8')) as {
    nodes?: { realName?: unknown; version?: unknown }[];
  };
  const out = new Set<string>();
  for (const n of tree.nodes ?? []) {
    if (typeof n.realName === 'string' && typeof n.version === 'string') {
      out.add(storeKey(n.realName, n.version));
    }
  }
  return [...out];
}
