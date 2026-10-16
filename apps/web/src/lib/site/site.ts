/**
 * An imported site on the app side (docs/09 §9.2, §9.5): the site pack (`@br/site`) plus what
 * the import found, for the "what was imported" bar and the build stats.
 */
import { siteBytes, unpackSite, type ImportedSite } from '@br/site';

export type { ImportedSite } from '@br/site';

/**
 * A site read back from a pack alone (the remote autosave after a reload on another device):
 * its files are counted again; the folder it came from is not known any more (`root` is `''`).
 * Null when the bytes are not a valid site pack.
 */
export function siteFromPack(pack: Uint8Array<ArrayBuffer>): ImportedSite | null {
  try {
    const files = unpackSite(pack);
    return { pack, root: '', files: files.size, bytes: siteBytes(files), skipped: 0 };
  } catch {
    return null;
  }
}

/** `1.2 MB`, `340 KB`, `512 B`, in the page's language (`1,2 MB` in Turkish). */
export { formatBytes } from '../i18n/format';

/** `dist` for `dist/`, `my-app/dist` for `my-app/dist/`, null for the dropped folder itself. */
export function rootLabel(root: string): string | null {
  const trimmed = root.replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}
