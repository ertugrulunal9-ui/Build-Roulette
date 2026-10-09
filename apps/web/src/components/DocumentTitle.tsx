import { documentTitle } from '../lib/solo/battle-meta';

/**
 * The tab title of a static shell (T-037), which knows its subject only in the browser:
 * React 19 renders a `<title>` anywhere into the document head and updates it in place. The
 * shell pages set `title: null` in their metadata, so this is the document's only `<title>`
 * (Next's metadata title would otherwise be committed after a `document.title` write and win).
 * The exported HTML carries the first value, e.g. "Battle results · Build Roulette".
 */
export function DocumentTitle({ title }: { title: string }) {
  return <title>{documentTitle(title)}</title>;
}
