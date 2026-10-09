import type { ReactNode } from 'react';

/**
 * The plain "not found" screen: the exported `404.html` (app/not-found.tsx, which Pages
 * serves with a 404 for any unknown path) and the client-side answer of the shells and
 * `/admin` when there is nothing to show (T-037: those pages are static files, so the status
 * is 200 there; the screen is the same). `children` adds a line under the heading.
 */
export function NotFoundView({
  testId = 'not-found',
  children,
}: {
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <main
      className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-4 px-6 py-16 text-center"
      data-testid={testId}
    >
      <p className="font-mono text-5xl font-black text-zinc-300 dark:text-zinc-700">404</p>
      <h1 className="text-xl font-semibold">This page could not be found.</h1>
      {children}
      <a href="/" className="text-sm font-semibold text-zinc-500 underline">
        Build Roulette
      </a>
    </main>
  );
}
