/**
 * Dependency trees. For each requested `name@version` we resolve its dependency tree from
 * packuments (semver, npm's "latest if it satisfies, else highest match" rule) and lay it out
 * on disk as a regular npm-style `node_modules` tree, so esbuild resolves imports exactly as
 * it would in a project (package `exports`, `browser`, `module`, nested versions).
 *
 *   <cacheDir>/trees/v1/<name>@<version>/
 *     tree.json                         resolved tree (locations, versions, peers)
 *     node_modules/<name>/...           the requested package
 *     node_modules/<dep>/...            hoisted dependencies
 *     node_modules/<a>/node_modules/<b> nested on version conflicts
 *
 * Layout rules (a simplified npm v7 algorithm):
 * - A dependency already visible from the dependent (its own node_modules, then each
 *   ancestor's, then the top level) is reused when its version satisfies the range.
 * - Otherwise a new copy is placed at the top level when the name is free there, or in the
 *   dependent's own node_modules on a conflict (which only the dependent and its subtree see).
 * - `peerDependencies` are never installed. The bundler satisfies a peer from the tree when
 *   some package already provides it, and otherwise emits a CDN URL for it (one shared copy).
 * - Optional dependencies are skipped when they fail to resolve or are platform-specific
 *   (`os`/`cpu`), since the browser is the target.
 * - Install scripts are never run (we only extract tarballs).
 *
 * Package files are hard links into the store (no symlinks anywhere in the cache).
 */
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { treeKey, type CacheIndex } from './disk-cache';
import { CdnError, errorMessage } from './errors';
import { SingleFlight, throwIfAborted } from './limiter';
import { encodeNameForPath, validatePackageName } from './names';
import type { Denylist, Limits } from './policy';
import {
  pickVersion,
  type Packument,
  type PackumentVersion,
  type RegistryClient,
} from './registry';
import type { PackageStore } from './store';
import { diskSize, renameIntoPlace } from './tar';

export const TREE_FORMAT = 'v1';

export interface TreeNode {
  /** Install names from the top-level node_modules, e.g. ['a'] or ['a', 'b']. */
  path: string[];
  /** Install name (differs from `realName` for `npm:` aliases). */
  name: string;
  realName: string;
  version: string;
  peers: Record<string, string>;
  optionalPeers: string[];
}

export interface ResolvedTree {
  format: string;
  root: { name: string; version: string };
  nodes: TreeNode[];
}

export type GetPackument = (name: string, signal?: AbortSignal) => Promise<Packument>;

/** `['a', '@s/b']` -> `node_modules/a/node_modules/@s/b` */
export function locationOf(nodePath: readonly string[]): string {
  return nodePath.map((n) => `node_modules/${n}`).join('/');
}

/**
 * Location of the package that contains `relFile` (a path relative to the tree root), or
 * null when the file is not inside a package.
 */
export function packageLocationOf(relFile: string): string | null {
  const segs = relFile.split(/[\\/]/);
  let end = -1;
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] !== 'node_modules') continue;
    const first = segs[i + 1] ?? '';
    const width = first.startsWith('@') ? 2 : 1;
    if (i + width >= segs.length) break;
    end = i + width;
    i = end;
  }
  return end === -1 ? null : segs.slice(0, end + 1).join('/');
}

type DepSpec = { ok: true; realName: string; range: string } | { ok: false; reason: string };

/** Interprets a dependency spec: semver ranges, dist-tags and `npm:` aliases. */
export function parseDepSpec(name: string, spec: string): DepSpec {
  // The install name becomes a directory under node_modules: it must be a valid name too
  // (an alias key like "../../x" would otherwise escape the tree).
  if (validatePackageName(name, { legacy: true }) !== null) {
    return { ok: false, reason: `invalid dependency name ${JSON.stringify(name)}` };
  }
  let realName = name;
  let range = spec.trim();
  if (range.startsWith('npm:')) {
    const target = range.slice(4);
    const at = target.indexOf('@', 1);
    realName = at === -1 ? target : target.slice(0, at);
    range = at === -1 ? '*' : target.slice(at + 1);
    const err = validatePackageName(realName, { legacy: true });
    if (err !== null) return { ok: false, reason: `invalid alias target "${realName}"` };
  }
  if (range === '' || range === 'latest') return { ok: true, realName, range: range || '*' };
  if (semver.validRange(range) !== null) return { ok: true, realName, range };
  if (/^[a-z][\w.-]*$/i.test(range)) return { ok: true, realName, range }; // dist-tag
  return {
    ok: false,
    reason: `unsupported dependency spec "${spec}" (git/file/url specs are not served)`,
  };
}

interface Dep {
  name: string;
  spec: string;
  optional: boolean;
}

function collectDeps(meta: PackumentVersion): Dep[] {
  const deps = new Map<string, Dep>();
  for (const [name, spec] of Object.entries(meta.dependencies ?? {})) {
    deps.set(name, { name, spec, optional: false });
  }
  // optionalDependencies override dependencies of the same name (npm behavior).
  for (const [name, spec] of Object.entries(meta.optionalDependencies ?? {})) {
    deps.set(name, { name, spec, optional: true });
  }
  return [...deps.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface ResolveTreeOptions {
  maxDependencies: number;
  denylist: Denylist;
  signal?: AbortSignal | undefined;
}

/**
 * A failure that says nothing about the dependency itself (overload, timeout, cancellation,
 * registry or network trouble). An optional dependency is only skipped for a definite answer
 * (404, invalid, unsupported), never for these, or a transient error would be baked into a
 * cached tree.
 */
function isTransient(e: unknown): boolean {
  return !(e instanceof CdnError) || e.status >= 500 || e.status === 499;
}

export interface ResolvedTreeWithMeta {
  tree: ResolvedTree;
  /** Location -> packument version, for installing. */
  metas: Map<string, PackumentVersion>;
}

/** Resolves the dependency tree of `root` (breadth-first, deterministic). Pure apart from `getPackument`. */
export async function resolveTree(
  root: PackumentVersion,
  getPackument: GetPackument,
  opts: ResolveTreeOptions,
): Promise<ResolvedTreeWithMeta> {
  const byLocation = new Map<string, TreeNode>();
  const metas = new Map<string, PackumentVersion>();
  const rootNode = makeNode([root.name], root.name, root);
  byLocation.set(locationOf(rootNode.path), rootNode);
  metas.set(locationOf(rootNode.path), root);
  const queue: TreeNode[] = [rootNode];

  const findVisible = (from: readonly string[], name: string): TreeNode | undefined => {
    for (let depth = from.length; depth >= 0; depth--) {
      const hit = byLocation.get(locationOf([...from.slice(0, depth), name]));
      if (hit) return hit;
    }
    return undefined;
  };

  const { signal } = opts;
  while (queue.length > 0) {
    throwIfAborted(signal);
    const node = queue.shift();
    if (!node) break;
    const meta = metas.get(locationOf(node.path));
    if (!meta) continue;
    const via = `${node.realName}@${node.version}`;
    const deps = collectDeps(meta);
    const parsed = deps.map((d) => ({ dep: d, spec: parseDepSpec(d.name, d.spec) }));
    // Warm the packument cache for this level in parallel; errors surface below.
    await Promise.all(
      parsed.map(({ spec }) =>
        spec.ok ? getPackument(spec.realName, signal).catch(() => null) : Promise.resolve(null),
      ),
    );
    throwIfAborted(signal);
    for (const { dep, spec } of parsed) {
      if (!spec.ok) {
        if (dep.optional) continue;
        throw new CdnError(
          422,
          'unsupported',
          `${dep.name} (dependency of ${via}): ${spec.reason}`,
        );
      }
      const visible = findVisible(node.path, dep.name);
      if (
        visible?.realName === spec.realName &&
        // A dist-tag dependency ("next") is satisfied by whatever copy is already visible.
        (semver.validRange(spec.range) === null || semver.satisfies(visible.version, spec.range))
      ) {
        continue;
      }
      let pack: Packument;
      try {
        pack = await getPackument(spec.realName, signal);
      } catch (e) {
        if (dep.optional && !isTransient(e)) continue;
        if (e instanceof CdnError && e.status === 404) {
          throw new CdnError(404, 'unknown-package', `${e.message} (dependency of ${via})`);
        }
        throw e;
      }
      const version = pickVersion(pack, spec.range);
      const depMeta = version === null ? undefined : pack.versions[version];
      if (version === null || !depMeta) {
        if (dep.optional) continue;
        throw new CdnError(
          404,
          'unknown-version',
          `no version of ${spec.realName} matches "${spec.range}" (dependency of ${via})`,
        );
      }
      if (dep.optional && ((depMeta.os?.length ?? 0) > 0 || (depMeta.cpu?.length ?? 0) > 0)) {
        continue;
      }
      opts.denylist.assertAllowed(spec.realName, version, via);
      const placePath = visible ? [...node.path, dep.name] : [dep.name];
      const child = makeNode(placePath, dep.name, depMeta);
      byLocation.set(locationOf(placePath), child);
      metas.set(locationOf(placePath), depMeta);
      if (byLocation.size > opts.maxDependencies) {
        throw new CdnError(
          413,
          'too-many-dependencies',
          `${root.name}@${root.version} needs more than ${opts.maxDependencies.toString()} packages`,
        );
      }
      queue.push(child);
    }
  }

  return {
    tree: {
      format: TREE_FORMAT,
      root: { name: root.name, version: root.version },
      nodes: [...byLocation.values()],
    },
    metas,
  };
}

function makeNode(nodePath: string[], installName: string, meta: PackumentVersion): TreeNode {
  const peers = meta.peerDependencies ?? {};
  const optionalPeers = Object.entries(meta.peerDependenciesMeta ?? {})
    .filter(([, m]) => m.optional === true)
    .map(([n]) => n)
    .sort();
  return {
    path: nodePath,
    name: installName,
    realName: meta.name,
    version: meta.version,
    peers: { ...peers },
    optionalPeers,
  };
}

/**
 * Hard-links (or copies) a store directory into the tree. Only files and directories.
 * Returns the estimated disk usage it added (directories, and files that had to be copied).
 */
async function linkDir(src: string, dst: string): Promise<number> {
  let bytes = diskSize(0);
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      bytes += await linkDir(s, d);
    } else if (entry.isFile()) {
      try {
        await link(s, d);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'EEXIST') continue;
        if (code === 'EXDEV' || code === 'EPERM' || code === 'EMLINK') {
          await copyFile(s, d);
          bytes += diskSize((await stat(d)).size);
        } else throw e;
      }
    }
  }
  return bytes;
}

/**
 * Runs `fn` over `items` with at most `limit` at a time. On the first failure no new item
 * starts and the others are cancelled through the signal they get.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (t: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const local = new AbortController();
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !combined.aborted) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T, combined);
      } catch (e) {
        local.abort(e);
        throw e;
      }
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    // Wait for the cancelled siblings so nothing outlives the call.
    await Promise.allSettled(workers);
  }
  throwIfAborted(signal);
  return out;
}

export interface InstalledTree {
  dir: string;
  tree: ResolvedTree;
  nodeByLocation: Map<string, TreeNode>;
  rootLocation: string;
}

export interface TreeManagerOptions {
  cacheDir: string;
  registry: RegistryClient;
  store: PackageStore;
  limits: Limits;
  denylist: Denylist;
  index: CacheIndex;
}

function indexTree(dir: string, tree: ResolvedTree): InstalledTree {
  const nodeByLocation = new Map<string, TreeNode>();
  for (const n of tree.nodes) nodeByLocation.set(locationOf(n.path), n);
  return { dir, tree, nodeByLocation, rootLocation: locationOf([tree.root.name]) };
}

export class TreeManager {
  readonly root: string;
  private readonly opts: TreeManagerOptions;
  private readonly flights = new SingleFlight<InstalledTree>();
  readonly stats = { installed: 0 };

  constructor(opts: TreeManagerOptions) {
    this.opts = opts;
    this.root = path.resolve(opts.cacheDir, 'trees', TREE_FORMAT);
  }

  dirFor(name: string, version: string): string {
    return path.join(this.root, `${encodeNameForPath(name)}@${version}`);
  }

  /** Cache key of the tree (lease it while the tree is in use). */
  keyFor(name: string, version: string): string {
    return treeKey(TREE_FORMAT, name, version);
  }

  get inflight(): number {
    return this.flights.size;
  }

  /**
   * Resolves, downloads and lays out the tree if needed. The caller must hold a lease on
   * `keyFor(meta.name, meta.version)` while it uses the tree.
   */
  async ensure(meta: PackumentVersion, signal?: AbortSignal): Promise<InstalledTree> {
    const key = this.keyFor(meta.name, meta.version);
    const dir = this.dirFor(meta.name, meta.version);
    await this.opts.index.settled(key);
    const treeFile = path.join(dir, 'tree.json');
    if (existsSync(treeFile)) {
      this.opts.index.touch(key);
      return indexTree(dir, JSON.parse(await readFile(treeFile, 'utf8')) as ResolvedTree);
    }
    return this.flights.run(key, (s) => this.install(meta, dir, key, s), signal);
  }

  private async install(
    meta: PackumentVersion,
    dir: string,
    key: string,
    signal: AbortSignal,
  ): Promise<InstalledTree> {
    const { tree, metas } = await resolveTree(
      meta,
      (n, s) => this.opts.registry.getPackument(n, s),
      { maxDependencies: this.opts.limits.maxDependencies, denylist: this.opts.denylist, signal },
    );
    // Download + extract every package (shared store), then link them into a temp tree.
    const nodes = [...tree.nodes].sort((a, b) => a.path.length - b.path.length);
    const depKeys = [...new Set(nodes.map((n) => this.opts.store.keyFor(n.realName, n.version)))];
    // The store entries must survive until the tree's links exist.
    const release = this.opts.index.leaseAll(depKeys);
    try {
      const storeDirs = await mapLimit(nodes, 8, signal, (n, s) => {
        const m = metas.get(locationOf(n.path));
        if (!m) throw new Error(`missing metadata for ${n.realName}`);
        const parent = n.path.length > 1 ? n.path[n.path.length - 2] : meta.name;
        return this.opts.store.ensure(m, n === nodes[0] ? undefined : parent, s);
      });
      await mkdir(this.root, { recursive: true });
      const tmp = `${dir}.tmp-${process.pid.toString()}-${Math.random().toString(36).slice(2)}`;
      let bytes = diskSize(0);
      try {
        for (const [i, n] of nodes.entries()) {
          throwIfAborted(signal);
          const target = path.join(tmp, locationOf(n.path));
          // A parent's tarball may bundle this dependency already (bundleDependencies): keep it.
          const storeDir = storeDirs[i];
          if (storeDir === undefined || existsSync(target)) continue;
          bytes += await linkDir(storeDir, target);
        }
        const json = JSON.stringify(tree, null, 1);
        await writeFile(path.join(tmp, 'tree.json'), json);
        bytes += diskSize(Buffer.byteLength(json));
      } catch (e) {
        await rm(tmp, { recursive: true, force: true });
        if (signal.aborted) throw e;
        throw new CdnError(
          500,
          'build-failed',
          `could not lay out dependency tree: ${errorMessage(e)}`,
        );
      }
      await renameIntoPlace(tmp, dir);
      this.opts.index.record(key, bytes, depKeys);
    } finally {
      release();
    }
    this.stats.installed++;
    return indexTree(dir, tree);
  }
}
