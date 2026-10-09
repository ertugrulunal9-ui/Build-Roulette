/**
 * What the REVEAL reads of another player's build (supabase/README.md "Reveal and voting"):
 * `bundle.js`, `bundle.css` and `manifest.json` from `ephemeral-builds`. Everything in them
 * was produced by another player's browser, so it is untrusted: the manifest is parsed
 * defensively (size cap, shape, string values only), only exact pins of valid package names
 * become import map entries (`buildImportMap`: every one is a URL on the configured CDN, which
 * the bundle could import directly anyway, T-040), and the result is validated against the
 * bridge's own schema before it reaches a preview. Anything unusable degrades to an empty
 * import map (the build then shows its own load error in the sandbox), never to a throw.
 */
import { ImportMapSchema, type ImportMap } from '@br/protocol';
import { buildImportMap, type PreviewBuild } from '@br/runtime';

/** A real manifest is ~100 bytes; anything this big is not one. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DEPENDENCIES = 200;

/**
 * The pinned dependencies of an uploaded `manifest.json` (`{dependencies: {name: version}}`),
 * or `{}` when it is missing, too large, not JSON or not that shape. Non-string values are
 * dropped.
 */
export function parseRevealManifest(text: string | null): Record<string, string> {
  if (text === null || text.length > MAX_MANIFEST_BYTES) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const deps = (parsed as { dependencies?: unknown }).dependencies;
  if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version !== 'string') continue;
    if (++n > MAX_DEPENDENCIES) break;
    out[name] = version;
  }
  return out;
}

/** The import map for a revealed build, validated like any bridge message (or empty). */
export function revealImportMap(manifestText: string | null, cdnBaseUrl: string): ImportMap {
  const map = buildImportMap(parseRevealManifest(manifestText), cdnBaseUrl);
  const checked = ImportMapSchema.safeParse(map);
  return checked.success ? checked.data : { imports: {} };
}

/** The preview input for a revealed build, or null when it has no bundle. */
export function revealPreviewBuild(
  files: { js: string | null; css: string | null; manifest: string | null },
  cdnBaseUrl: string,
): PreviewBuild | null {
  if (files.js === null) return null;
  return {
    js: files.js,
    css: files.css ?? '',
    importMap: revealImportMap(files.manifest, cdnBaseUrl),
  };
}
