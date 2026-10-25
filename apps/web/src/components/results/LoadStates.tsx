'use client';

/**
 * The loading and "could not load" screens of the static shells (/battles/{id}, /u/{id}),
 * which read their data in the browser (T-037).
 */
import { useT } from '../../lib/i18n/context';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { AppHeader } from '../ui/AppHeader';

export function LoadingView({ text, testId }: { text: string; testId: string }) {
  return (
    <div className="br-public-shell min-h-dvh">
      <AppHeader className="br-public-header" />
      <main
        className="br-load-state br-loading-state grid min-h-[70dvh] place-items-center px-6 text-sm"
        data-testid={testId}
        aria-busy="true"
      >
        <div className="br-load-state__message">
          <CircleNotchIcon className="br-loading-spinner" size={26} aria-hidden="true" />
          <span>{text}</span>
        </div>
      </main>
    </div>
  );
}

export function LoadErrorView({
  text,
  testId,
  onRetry,
}: {
  text: string;
  testId: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="br-public-shell min-h-dvh">
      <AppHeader className="br-public-header" />
      <main
        className="br-load-state br-load-error mx-auto flex min-h-[70dvh] max-w-lg flex-col items-center justify-center gap-4 px-6 text-center"
        data-testid={testId}
      >
        <WarningCircleIcon size={42} weight="duotone" aria-hidden="true" />
        <h1 className="text-3xl font-black">{t.loadStates.title}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{text}</p>
        <button
          type="button"
          onClick={onRetry}
          className="br-primary-action rounded-lg px-5 py-3 text-sm font-semibold"
        >
          {t.common.tryAgain}
        </button>
      </main>
    </div>
  );
}
