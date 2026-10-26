import type { Metadata } from 'next';
import { STATIC_OG_CARD } from '../solo/og-image';

/** The app's public origin (NEXT_PUBLIC_SITE_URL), for absolute OG image, robots and sitemap URLs. */
const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? '';
export const SITE_URL = (fromEnv === '' ? 'http://localhost:3000' : fromEnv).replace(/\/+$/, '');

/** The pages a search engine may list (`/sitemap.xml`): the static ones, not a battle or a room. */
export const PUBLIC_PATHS = ['/', '/play', '/try', '/how-it-works'] as const;

/**
 * The link-preview tags of a static page: its title and description with the static card
 * (public/og-card.png), so a shared link shows a picture. /battles has its own, per battle.
 */
export function shareMetadata(
  title: string,
  description: string,
): Pick<Metadata, 'openGraph' | 'twitter'> {
  return {
    openGraph: {
      type: 'website',
      siteName: 'Build Roulette',
      title,
      description,
      images: [STATIC_OG_CARD],
    },
    twitter: { card: 'summary_large_image', title, description, images: [STATIC_OG_CARD] },
  };
}
