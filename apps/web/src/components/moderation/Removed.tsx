'use client';

/**
 * How a build taken down by a moderator looks (T-024): no name, no screenshot, this label
 * instead, in the page's language (T-050: the catalogs' `moderation.removed`).
 */
import { useT } from '../../lib/i18n/context';
import { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
import './moderation.css';

/** The image slot of a removed build. */
export function RemovedCard({ compact = false }: { compact?: boolean }) {
  const t = useT();
  return (
    <div
      data-testid="removed-build"
      className="br-removed absolute inset-0 grid place-items-center bg-zinc-200 p-2 text-center dark:bg-zinc-800"
    >
      <p
        className={`${compact ? 'text-[11px]' : 'text-sm'} font-semibold text-zinc-600 dark:text-zinc-300`}
      >
        <ProhibitIcon
          aria-hidden="true"
          className="mr-1 inline-block align-text-bottom"
          size={16}
          weight="fill"
        />
        {t.moderation.removed}
      </p>
    </div>
  );
}
