/**
 * The social image of a battle (`og:image`, `twitter:image` of /battles/[id]), chosen without
 * rendering anything at request time.
 *
 * T-033: the old card was drawn per battle by `next/og` (satori + resvg) in the Worker, about
 * 300 ms of CPU per render (docs/08-free-tier.md §1), thirty times the Workers Free limit. Now
 * the page points at an image that already exists:
 *
 * - the rank-1 build's screenshot, as the capture worker stored it in the public
 *   `screenshots` bucket (served by Supabase Storage, not by the Worker);
 * - otherwise the static card `/og-card.png` (public/, served as a static asset): no builds,
 *   no screenshot, or a rank-1 build a moderator removed after RESULTS. T-028: a removed
 *   build's screenshot never appears, and the next build is not promoted in its place.
 *
 * The challenge and the result stay in `og:title` / `og:description` (the page's metadata).
 */
import { screenshotUrl, supabaseConfig, type SupabaseConfig } from '../supabase/config';
import type { PublicBattle } from './types';

export interface OgImage {
  url: string;
  width?: number;
  height?: number;
  alt: string;
  type?: string;
}

/** public/og-card.png (scripts/og-card.ts draws it). */
export const STATIC_OG_CARD: OgImage = {
  url: '/og-card.png',
  width: 1200,
  height: 630,
  alt: 'Build Roulette: builds are temporary, results are permanent',
  type: 'image/png',
};

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** The capture worker's screenshot (1280×800) and the client fallback thumbnail (640×400). */
const SIZES: Partial<Record<string, { width: number; height: number }>> = {
  captured: { width: 1280, height: 800 },
  fallback: { width: 640, height: 400 },
};

/** The image a share of this battle shows (see the top of this file). */
export function battleOgImage(
  data: PublicBattle,
  config: SupabaseConfig = supabaseConfig,
): OgImage {
  const top = data.builds[0];
  if (!top || top.taken_down === true || !top.screenshot_path) return STATIC_OG_CARD;
  const ext = /\.([a-z0-9]+)$/i.exec(top.screenshot_path)?.[1]?.toLowerCase() ?? '';
  return {
    url: screenshotUrl(top.screenshot_path, config),
    ...SIZES[top.capture_status],
    alt: `Screenshot of ${top.name ?? 'the top build'} by ${top.builder_name}`,
    ...(TYPES[ext] ? { type: TYPES[ext] } : {}),
  };
}
