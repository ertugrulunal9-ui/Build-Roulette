/**
 * What the REVEAL reads of another player's build (supabase/README.md "Reveal and voting",
 * docs/09 §9.4): one site pack (`site.bin`, or `autosave/site.bin` when it was auto-shipped)
 * from `ephemeral-builds`. It was produced by another player's browser, so it is untrusted:
 * it only becomes a preview input when it fits the size limit and reads as a valid pack
 * (`unpackSite`, the same check the shell makes again before it serves anything). Anything
 * else counts as a build without files (its screenshot shows instead), never as a throw.
 */
import type { PreviewBuild } from '@br/runtime';
import { SITE_LIMITS, unpackSite } from '@br/site';

/** The preview input for a revealed build's pack, or null when it is missing or unusable. */
export function revealPreviewBuild(pack: Uint8Array | null): PreviewBuild | null {
  if (pack === null || pack.byteLength === 0 || pack.byteLength > SITE_LIMITS.maxPackBytes) {
    return null;
  }
  try {
    unpackSite(pack);
  } catch {
    return null;
  }
  return { site: pack };
}
