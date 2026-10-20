/**
 * The static site's dynamic paths (T-037). The app is a static export served as the static
 * assets of a Cloudflare Worker (T-043; Cloudflare Pages before): every page is a file, and a
 * path with a parameter (`/r/{code}`, `/battles/{id}`,
 * `/u/{id}`) is answered with one shared page, its "shell", through a rewrite. The shell reads
 * the parameter from the browser's URL and loads its data in the browser.
 *
 * One list, two consumers: `scripts/pages-config.ts` writes it into `out/_redirects` (rewrites,
 * status 200: the URL in the address bar stays `/battles/{id}`), and `next.config.ts`
 * turns it into rewrites for `next dev`, so the dev server behaves like the host. The same
 * goes for the few paths that moved (`REDIRECTS`).
 */

export interface Shell {
  /** The path with a parameter, in `_redirects` / Next syntax (`:name` is one path segment). */
  source: string;
  /** The shell page that answers it (an exported page: `out/{destination}.html`). */
  destination: string;
}

export const SHELLS: readonly Shell[] = [
  // A room: join, lobby, battle, rematch (components/room). T-033 made it one page.
  { source: '/r/:code', destination: '/r' },
  // A battle's permanent results (components/results/BattleView).
  { source: '/battles/:id', destination: '/battles' },
  // A player's history (components/results/PlayerHistoryView).
  { source: '/u/:id', destination: '/u' },
];

/** A path that moved: the host answers it with a redirect. */
export interface Redirect {
  source: string;
  destination: string;
  /** 301: moved for good. */
  status: 301;
}

export const REDIRECTS: readonly Redirect[] = [
  // The editor's playground became the import practice page (M6, docs/09 §9.5).
  { source: '/playground', destination: '/try', status: 301 },
];

/**
 * The `_redirects` file of the static assets: the redirects first, then one rewrite (status
 * 200, served from the destination without a redirect) per shell. Workers static assets read
 * the same format as Pages did (https://developers.cloudflare.com/workers/static-assets/redirects/).
 */
export function pagesRedirects(
  shells: readonly Shell[] = SHELLS,
  redirects: readonly Redirect[] = REDIRECTS,
): string {
  const lines = [
    ...redirects.map((r) => `${r.source} ${r.destination} ${String(r.status)}`),
    ...shells.map((s) => `${s.source} ${s.destination} 200`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The parameter of a shell path as typed (`/battles/{id}` → `{id}`, decoded), or `''` when
 * the path has none, has more segments, belongs to another page or has a broken escape.
 */
export function shellParam(prefix: string, pathname: string): string {
  if (!pathname.startsWith(`${prefix}/`)) return '';
  const rest = pathname.slice(prefix.length + 1).replace(/\/$/, '');
  if (rest === '' || rest.includes('/')) return '';
  try {
    return decodeURIComponent(rest);
  } catch {
    return '';
  }
}
