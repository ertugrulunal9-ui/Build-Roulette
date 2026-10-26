import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '../lib/i18n/context';
import { LOCALE_SCRIPT } from '../lib/i18n/locale';
import { SITE_URL, shareMetadata } from '../lib/hosting/site';

import './globals.css';

const description =
  'A multiplayer party game for vibe coders. Spin a challenge, build, ship, reveal, vote. Builds are temporary. Results are permanent.';

export const metadata: Metadata = {
  // OG image URLs are absolute (NEXT_PUBLIC_SITE_URL).
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Build Roulette',
    template: '%s · Build Roulette',
  },
  description,
  // The home page's link preview; the other pages set their own (lib/hosting/site.ts).
  ...shareMetadata('Build Roulette', description),
};

/**
 * Every page is prerendered in English (T-050). The inline script sets `<html lang="tr">`
 * before the first paint when the player picked Turkish (lib/i18n/locale.ts; the CSP lists its
 * hash), and `suppressHydrationWarning` lets `<html>` keep it through hydration.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_SCRIPT }} />
      </head>
      <body className="br-app-body min-h-dvh antialiased">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
