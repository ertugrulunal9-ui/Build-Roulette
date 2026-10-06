import type { Metadata } from 'next';
import type { ReactNode } from 'react';

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

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-zinc-50 font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        {children}
      </body>
    </html>
  );
}
