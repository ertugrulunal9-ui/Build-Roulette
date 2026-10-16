/**
 * The shell's `module-load` runtime errors (protocol v2, docs/09 §9.3) come in two kinds:
 *
 * - the **site could not be served** at all (a browser without service workers, e.g. a
 *   private Firefox window; a pack the shell could not read; the site worker not starting):
 *   nothing of the site runs;
 * - **one file failed**: a `<script src>` or stylesheet of the site that did not load
 *   (`Failed to load /assets/x.js`, a 404 from the site worker or an unreachable CDN). The
 *   site still runs, as it would on any static host.
 *
 * The REVEAL shows the screenshot instead of a site that cannot run here; a missing file only
 * goes to the player's Problems list.
 */
import type { RuntimeErrorMessage } from '@br/protocol';

/** The shell's wording for one failed script or stylesheet (apps/sandbox-shell shell.ts). */
const FILE_FAILED = 'Failed to load ';

/** A `module-load` error about one of the site's files (the site itself runs). */
export function isFileLoadError(m: RuntimeErrorMessage): boolean {
  return m.kind === 'module-load' && m.message.startsWith(FILE_FAILED);
}

/** A `module-load` error that means the site could not be served at all. */
export function isSiteLoadFailure(m: RuntimeErrorMessage): boolean {
  return m.kind === 'module-load' && !m.message.startsWith(FILE_FAILED);
}
