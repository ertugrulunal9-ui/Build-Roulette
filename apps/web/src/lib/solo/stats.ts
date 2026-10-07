/**
 * The display-only build stats sent with `ship_build` (docs/03 §3.6): non-code facts that
 * stay after DESTROY, so results can say "made with three.js" without keeping any code.
 * The server validates and caps them (`private.clean_build_stats`).
 */
import { isTemplateId, validateWorkspace, type Workspace } from '@br/workspace';
import type { BuildStats } from './types';

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).byteLength;
}

/** Lines of code in the workspace (images, stored as data: URLs, are not code). */
export function countLines(files: Readonly<Record<string, string>>): number {
  let lines = 0;
  for (const text of Object.values(files)) {
    if (text.startsWith('data:')) continue;
    lines += text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  return lines;
}

export function buildStats(
  workspace: Workspace,
  bundle: { js: string; css: string },
  counters: { rebuilds: number; pastes: number },
): BuildStats {
  return {
    files: Object.keys(workspace.files).length,
    lines: countLines(workspace.files),
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

/**
 * `manifest.json`: only the pinned dependencies (`{dependencies: {name: version}}`). Other
 * members read it during REVEAL to build the import map, so it carries no source code
 * (supabase/README.md "Reveal and voting").
 */
export function manifestJson(workspace: Workspace): string {
  return JSON.stringify({ dependencies: { ...workspace.manifest.dependencies } });
}

/** Parses an uploaded `source.json` back into a valid workspace, or null. */
export function parseSourceJson(text: string): Workspace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { files, manifest } = parsed as { files?: unknown; manifest?: unknown };
  if (typeof files !== 'object' || files === null) return null;
  if (typeof manifest !== 'object' || manifest === null) return null;
  const m = manifest as Record<string, unknown>;
  const template = m['template'];
  const entry = m['entry'];
  const deps = m['dependencies'];
  if (!isTemplateId(template) || typeof entry !== 'string') return null;
  if (typeof deps !== 'object' || deps === null) return null;
  const isStrings = (o: object) => Object.values(o).every((v) => typeof v === 'string');
  if (!isStrings(files) || !isStrings(deps)) return null;
  const ws: Workspace = {
    files: { ...(files as Record<string, string>) },
    manifest: {
      template,
      entry,
      dependencies: { ...(deps as Record<string, string>) },
      tailwind: m['tailwind'] === true,
    },
  };
  return validateWorkspace(ws).length === 0 ? ws : null;
}
