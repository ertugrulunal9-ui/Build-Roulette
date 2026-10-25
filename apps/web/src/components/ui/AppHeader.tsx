'use client';

import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n/context';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { TRY_PATH } from '../onboarding/copy';
import { HowItWorksLink } from '../onboarding/Welcome';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={`br-brand${compact ? ' br-brand--compact' : ''}`}>
      <Image
        src="/home/brand-mark.png"
        width={128}
        height={133}
        style={{ height: 'auto' }}
        alt=""
        unoptimized
      />
      <span>Build Roulette</span>
    </Link>
  );
}

/** Presentation only: callers retain their phase, navigation and action handlers. */
export function AppHeader({
  context,
  actions,
  guide = true,
  practice = true,
  compact = false,
  className = '',
}: {
  context?: ReactNode;
  actions?: ReactNode;
  guide?: boolean;
  practice?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <header className={`br-app-header${compact ? ' br-app-header--compact' : ''} ${className}`}>
      <div className="br-app-header__identity">
        <Brand compact={compact} />
        {context && <div className="br-app-header__context">{context}</div>}
      </div>
      <div className="br-app-header__navigation">
        {guide && <HowItWorksLink newTab className="br-header-link" />}
        {practice && (
          <Link className="br-header-link" href={TRY_PATH}>
            <FolderSimpleIcon size={19} aria-hidden="true" />
            <span>{t.home.tryImport}</span>
          </Link>
        )}
        <LanguagePicker className="br-language" />
        {actions}
      </div>
    </header>
  );
}
