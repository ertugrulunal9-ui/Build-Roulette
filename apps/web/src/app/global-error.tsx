'use client';

/**
 * The last-resort error screen (Next.js `global-error`): a render error nothing else caught.
 * Such an error is "caught" by React, so the window's error handlers never see it; it is
 * reported here instead (T-030, a no-op without a Sentry DSN). An error with a `digest`
 * happened on the server and was reported there (Next replaces its message with the digest
 * in the browser), so only client errors are sent from here.
 */
import { useEffect } from 'react';
import { reportClientError } from '../lib/telemetry/client-errors';
import './globals.css';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (!error.digest) reportClientError(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center bg-zinc-50 px-4 font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <main
          className="flex max-w-md flex-col items-center gap-4 text-center"
          data-testid="global-error"
        >
          <h1 className="text-2xl font-black">Something broke</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The page hit an error. Your game state lives on the server, so reloading usually gets
            you back where you were.
          </p>
          {error.digest && (
            <p className="font-mono text-xs text-zinc-500">Error code {error.digest}</p>
          )}
          <button
            type="button"
            onClick={() => {
              reset();
            }}
            className="rounded-lg bg-zinc-900 px-5 py-3 text-sm font-semibold text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
