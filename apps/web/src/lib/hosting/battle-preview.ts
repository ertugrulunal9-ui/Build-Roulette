/**
 * Per-battle link previews (T-038, docs/08-free-tier.md §3): what the Pages Function on
 * `/battles/*` (preview-worker.ts) writes into the shell's `<head>` for a crawler, as pure
 * functions (unit-tested in Node; the Function only adds the I/O and `HTMLRewriter`).
 *
 * `/battles/{id}` is one static shell for every battle (T-037). Crawlers do not run its
 * script, so without the Function every battle would share the shell's generic tags and the
 * static card. The Function replaces the shell's title and social tags with the battle's own:
 *
 * - the title and `og:title`: the rank-1 build and its builder ("Free Gift Card by Mallory"),
 *   or the challenge when rank 1 was removed (battle-meta.ts, the same text as the tab title);
 * - `og:description`: the winner, unless it was removed (T-028: nobody else is named in its
 *   place), and the challenge (BUILD / RULE / STYLE, the time limit);
 * - `og:image` (T-033's rule, og-image.ts): the rank-1 screenshot, or the static card when
 *   rank 1 has none or was removed; the next build is never promoted;
 * - `og:url` and `<link rel=canonical>`: the battle's URL on the site's origin;
 * - `twitter:card` (a large image) and its title, description and image.
 *
 * An unknown battle, one that is not public yet, or a malformed id gets "Battle not found"
 * and `noindex` (with a 404 status: preview-worker.ts).
 *
 * Names, build names and challenge texts are user or deck data: every value is HTML-escaped
 * here, and the head is inserted as HTML that this module wrote, so nothing from the data can
 * open a tag or end an attribute.
 */
import { BATTLE_NOT_FOUND_TITLE, battleMeta, documentTitle } from '../solo/battle-meta';
import { STATIC_OG_CARD, type OgImage } from '../solo/og-image';
import { isBattleId } from '../solo/public-battle';
import type { PublicBattle } from '../solo/types';

/** What a request to the Function is about. */
export type PreviewTarget =
  /** Not a battle page (`/battles`, `/battles/x/y`): served as if the Function did not exist. */
  | { kind: 'other' }
  /** `/battles/{segment}` whose segment cannot be a battle id: 404, Supabase is not asked. */
  | { kind: 'malformed' }
  /** `/battles/{uuid}` (any case; the id is lower-cased like the page does). */
  | { kind: 'battle'; id: string };

/** `/battles/{one segment}` (a trailing slash allowed, like the shell's own parsing). */
export function previewTarget(pathname: string): PreviewTarget {
  const m = /^\/battles\/([^/]+)\/?$/.exec(pathname);
  const segment = m?.[1];
  if (segment === undefined) return { kind: 'other' };
  let id: string;
  try {
    id = decodeURIComponent(segment).toLowerCase();
  } catch {
    return { kind: 'malformed' };
  }
  return isBattleId(id) ? { kind: 'battle', id } : { kind: 'malformed' };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text made safe for an HTML attribute value (quoted) or element content. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** The head of one answer of the Function. */
export interface PreviewHead {
  /** 200 for a public battle, 404 for an unknown, not-yet-public or malformed id. */
  status: 200 | 404;
  /** `<title>`, as the page itself sets it ("… · Build Roulette"). */
  documentTitle: string;
  /** `og:title`, `twitter:title`. */
  title: string;
  description: string;
  /** The social image, with an absolute URL. */
  image: OgImage;
  /** The battle's canonical URL (`og:url`, `<link rel=canonical>`); null for a 404. */
  url: string | null;
  /** `<meta name="robots" content="noindex">` (the 404s). */
  noindex: boolean;
}

/** What the not-found screen says (components/results/BattleView.tsx). */
export const NOT_FOUND_DESCRIPTION = 'No battle has this link, or its results are not in yet.';

/**
 * The head for a battle's page: `data` from `get_public_battle`, or null when the battle does
 * not exist, is not public yet, or the id is malformed. `origin` is the site's public origin
 * (`NEXT_PUBLIC_SITE_URL`, else the request's), for absolute URLs.
 */
export function battlePreview(
  data: PublicBattle | null,
  { id, origin }: { id: string | null; origin: string },
): PreviewHead {
  const absolute = (image: OgImage): OgImage => ({
    ...image,
    url: new URL(image.url, origin).href,
  });
  if (!data || !id) {
    return {
      status: 404,
      documentTitle: documentTitle(BATTLE_NOT_FOUND_TITLE),
      title: BATTLE_NOT_FOUND_TITLE,
      description: NOT_FOUND_DESCRIPTION,
      image: absolute(STATIC_OG_CARD),
      url: null,
      noindex: true,
    };
  }
  const meta = battleMeta(data);
  return {
    status: 200,
    documentTitle: documentTitle(meta.title),
    title: meta.title,
    description: meta.description,
    image: absolute(meta.image),
    url: new URL(`/battles/${id}`, origin).href,
    noindex: false,
  };
}

/**
 * The shell's own elements that the head replaces (Next's metadata of app/battles/page.tsx
 * and the tab title): removed, then the new ones are appended to `<head>`.
 */
export const REPLACED_HEAD_ELEMENTS = [
  'title',
  'meta[name="description"]',
  'meta[name="robots"]',
  'meta[property^="og:"]',
  'meta[name^="twitter:"]',
  'link[rel="canonical"]',
] as const;

/** The tags of a head, as HTML (every value escaped). */
export function previewHeadHtml(head: PreviewHead): string {
  const meta = (attr: 'name' | 'property', key: string, value: string | number | undefined) =>
    value === undefined || value === ''
      ? ''
      : `<meta ${attr}="${key}" content="${escapeHtml(String(value))}"/>`;
  const { image } = head;
  return [
    `<title>${escapeHtml(head.documentTitle)}</title>`,
    meta('name', 'description', head.description),
    head.noindex ? meta('name', 'robots', 'noindex') : '',
    head.url ? `<link rel="canonical" href="${escapeHtml(head.url)}"/>` : '',
    meta('property', 'og:site_name', 'Build Roulette'),
    meta('property', 'og:type', 'article'),
    meta('property', 'og:url', head.url ?? undefined),
    meta('property', 'og:title', head.title),
    meta('property', 'og:description', head.description),
    meta('property', 'og:image', image.url),
    meta('property', 'og:image:type', image.type),
    meta('property', 'og:image:width', image.width),
    meta('property', 'og:image:height', image.height),
    meta('property', 'og:image:alt', image.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', head.title),
    meta('name', 'twitter:description', head.description),
    meta('name', 'twitter:image', image.url),
    meta('name', 'twitter:image:alt', image.alt),
  ].join('');
}
