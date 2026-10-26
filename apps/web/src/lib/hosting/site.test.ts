import { describe, expect, it } from 'vitest';
import robots from '../../app/robots';
import sitemap from '../../app/sitemap';
import { STATIC_OG_CARD } from '../solo/og-image';
import { PUBLIC_PATHS, SITE_URL, shareMetadata } from './site';

describe('shareMetadata', () => {
  it('gives a static page a large link preview with the static card', () => {
    const tags = shareMetadata('Play solo · Build Roulette', 'Spin a challenge.');
    expect(tags.openGraph).toMatchObject({
      title: 'Play solo · Build Roulette',
      description: 'Spin a challenge.',
      images: [STATIC_OG_CARD],
    });
    expect(tags.twitter).toMatchObject({ card: 'summary_large_image', images: [STATIC_OG_CARD] });
  });
});

describe('robots and sitemap', () => {
  it('keeps crawlers out of /admin and points at the sitemap', () => {
    expect(robots()).toEqual({
      rules: { userAgent: '*', allow: '/', disallow: '/admin' },
      sitemap: `${SITE_URL}/sitemap.xml`,
    });
  });

  it('lists the static public pages, absolute, and nothing else', () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toHaveLength(PUBLIC_PATHS.length);
    expect(urls).toContain(SITE_URL);
    expect(urls).toContain(`${SITE_URL}/how-it-works`);
    expect(urls.some((u) => u.includes('/admin'))).toBe(false);
  });
});
