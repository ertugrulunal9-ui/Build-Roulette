/**
 * The display-only build stats sent with `ship_build` (docs/03 §3.6): non-code facts that
 * stay after DESTROY, so results can say "made with three.js" without keeping any code.
 * The server validates and caps them (`private.clean_build_stats`).
 */
import type { Workspace } from '@br/workspace';
import type { BuildStats } from './types';

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).byteLength;
}

export function buildStats(
  workspace: Workspace,
  bundle: { js: string; css: string },
  counters: { rebuilds: number; pastes: number },
): BuildStats {
  let lines = 0;
  for (const text of Object.values(workspace.files)) {
    // Binary images are stored as data: URLs; they are not code.
    if (text.startsWith('data:')) continue;
    lines += text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  return {
    files: Object.keys(workspace.files).length,
    lines,
    deps: Object.keys(workspace.manifest.dependencies).sort(),
    bundle_bytes: byteLength(bundle.js) + byteLength(bundle.css),
    rebuilds: Math.max(0, Math.floor(counters.rebuilds)),
    pastes: Math.max(0, Math.floor(counters.pastes)),
  };
}

/** `source.json`: what the capture worker reads for the import map, and what a restore needs. */
export function sourceJson(workspace: Workspace): string {
  return JSON.stringify({ files: workspace.files, manifest: workspace.manifest });
}
