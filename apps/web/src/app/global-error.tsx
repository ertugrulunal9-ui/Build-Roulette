'use client';

/**
 * The last-resort error screen (Next.js `global-error`): a render error nothing else caught.
 * Such an error is "caught" by React, so the window's error handlers never see it; it is
 * reported here instead (T-030, a no-op without a Sentry DSN). Every error is the browser's:
 * the app is a static site (T-037), there is no server render to fail.
 *
 * It replaces the root layout, so it has its own language provider (T-050).
 */
import { useEffect } from 'react';
import { I18nProvider, useI18n } from '../lib/i18n/context';
import { reportClientError } from '../lib/telemetry/error-sink';
import './globals.css';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <I18nProvider>
      <ErrorPage reset={reset} />
    </I18nProvider>
  );
}

function ErrorPage({ reset }: { reset: () => void }) {
  const { locale, t } = useI18n();
  return (
    <html lang={locale}>
      <body className="grid min-h-dvh place-items-center bg-zinc-50 px-4 font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <main
          className="flex max-w-md flex-col items-center gap-4 text-center"
          data-testid="global-error"
        >
          <h1 className="text-2xl font-black">{t.globalError.title}</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.globalError.text}</p>
          <button
            type="button"
            onClick={() => {
              reset();
            }}
            className="rounded-lg bg-zinc-900 px-5 py-3 text-sm font-semibold text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {t.common.tryAgain}
          </button>
        </main>
      </body>
    </html>
  );
}
