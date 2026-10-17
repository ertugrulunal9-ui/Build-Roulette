import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '../lib/i18n/context';
import { LOCALE_SCRIPT } from '../lib/i18n/locale';

import './globals.css';

/** The app's public origin, so OG image URLs are absolute (NEXT_PUBLIC_SITE_URL). */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Build Roulette',
    template: '%s · Build Roulette',
  },
  description:
    'A multiplayer party game for vibe coders. Spin a challenge, build, ship, reveal, vote. Builds are temporary. Results are permanent.',
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
      <body className="min-h-dvh bg-zinc-50 font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
