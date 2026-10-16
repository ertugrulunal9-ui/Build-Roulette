'use client';

/**
 * `/try` (docs/09 §9.5, §9.6): practice the import before a battle. The same drop zone and
 * live preview as the BUILD stage, without a battle, an account or an upload: the site stays
 * in this tab. The onboarding (T-049) links here; "How it works" goes to the guide.
 */
import type { ImportedSite } from '@br/site';
import Link from 'next/link';
import { useState } from 'react';
import { ImportHelp } from '../onboarding/ImportHelp';
import { HowItWorksLink } from '../onboarding/Welcome';
import { SiteWorkbench } from '../site/SiteWorkbench';

export const TRY_COPY = {
  title: 'Try an import',
  intro:
    'Practice before a battle: drop a site you built and see it run. Nothing is uploaded; it stays in this tab.',
  home: 'Home',
} as const;

export default function Try() {
  const [site, setSite] = useState<ImportedSite | null>(null);
  return (
    <main className="flex h-dvh flex-col bg-zinc-50 dark:bg-zinc-950" data-testid="try-page">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-sm font-bold tracking-tight">
          Build Roulette <span className="font-normal text-zinc-500">· {TRY_COPY.title}</span>
        </h1>
        <p className="text-xs text-zinc-500">{TRY_COPY.intro}</p>
        <HowItWorksLink className="ml-auto rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" />
        <Link
          href="/"
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {TRY_COPY.home}
        </Link>
      </header>
      <SiteWorkbench site={site} onImported={setSite} battleId={null} help={<ImportHelp />} />
    </main>
  );
}
