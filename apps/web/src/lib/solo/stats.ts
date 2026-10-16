/**
 * The display-only build stats sent with `ship_build` (docs/03 §3.6, docs/09 §9.2): non-code
 * facts that stay after DESTROY. Import mode reports `files` (in the site), `bundle_bytes`
 * (the site pack's size) and `imports` (how many imports the player made). The server
 * validates and caps them (`private.clean_build_stats`), and still accepts the editor's older
 * keys (`lines`, `deps`, `rebuilds`, `pastes`), which builds from before M6 keep.
 */
import { formatBytes } from '../i18n/format';
import type { Locale } from '../i18n/locale';
import { en, type Messages } from '../i18n/messages/en';
import type { ImportedSite } from '../site/site';
import type { BuildStats } from './types';

export function siteStats(site: ImportedSite, imports: number): BuildStats {
  return {
    files: Math.max(0, Math.floor(site.files)),
    bundle_bytes: site.pack.byteLength,
    imports: Math.max(1, Math.floor(imports)),
  };
}

/**
 * The stats as short phrases for the results (`12 files`, `340 KB`, `imported 3 times`), only
 * what the row has, in the page's language (default English). An editor build from before M6
 * shows its lines and packages instead.
 */
export function statsPhrases(
  stats: BuildStats | null | undefined,
  m: Messages = en,
  locale: Locale = 'en',
): string[] {
  if (!stats) return [];
  const out: string[] = [];
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  const files = num(stats.files);
  const bytes = num(stats.bundle_bytes);
  const imports = num(stats.imports);
  const lines = num(stats.lines);
  if (files !== null) out.push(m.stats.files(files));
  if (imports !== null) {
    if (bytes !== null) out.push(formatBytes(bytes, locale));
    out.push(m.stats.imported(imports));
    return out;
  }
  // An editor build (before M6): lines of code and the packages it used.
  if (lines !== null) out.push(m.stats.lines(lines));
  const deps = Array.isArray(stats.deps) ? stats.deps.filter((d) => typeof d === 'string') : [];
  if (deps.length > 0) out.push(m.stats.madeWith(deps.join(', ')));
  return out;
}
