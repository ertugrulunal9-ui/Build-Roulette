'use client';

/**
 * `/try` (docs/09 §9.5, §9.6): practice the import before a battle. The same drop zone and
 * live preview as the BUILD stage, without a battle, an account or an upload: the site stays
 * in this tab. The onboarding (T-049) links here; "How it works" goes to the guide.
 */
import type { ImportedSite } from '@br/site';
import { useState } from 'react';
import Link from 'next/link';
import { useT } from '../../lib/i18n/context';
import { ImportHelp } from '../onboarding/ImportHelp';
import { SiteWorkbench } from '../site/SiteWorkbench';
import { AppHeader } from '../ui/AppHeader';
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House';
import '../solo/solo-screens.css';

export default function Try() {
  const t = useT();
  const [site, setSite] = useState<ImportedSite | null>(null);
  return (
    <main className="br-try-page" data-testid="try-page">
      <AppHeader
        context={
          <>
            <span>{t.try.title}</span>
            <span className="br-try-intro">{t.try.intro}</span>
          </>
        }
        actions={
          <Link className="br-btn br-btn--secondary br-try-home" href="/">
            <HouseIcon size={17} aria-hidden="true" />
            {t.try.home}
          </Link>
        }
        guide
        practice={false}
      />
      <SiteWorkbench site={site} onImported={setSite} battleId={null} help={<ImportHelp />} />
    </main>
  );
}
