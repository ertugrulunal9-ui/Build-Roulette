import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/hosting/site';

export const dynamic = 'force-static';

/** `/robots.txt`: everything but the moderation pages, and where the sitemap is. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/admin' },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
