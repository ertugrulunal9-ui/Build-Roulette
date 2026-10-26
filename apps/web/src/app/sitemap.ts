import type { MetadataRoute } from 'next';
import { PUBLIC_PATHS, SITE_URL } from '../lib/hosting/site';

export const dynamic = 'force-static';

/** `/sitemap.xml`: the static public pages (lib/hosting/site.ts). */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({ url: `${SITE_URL}${path === '/' ? '' : path}` }));
}
