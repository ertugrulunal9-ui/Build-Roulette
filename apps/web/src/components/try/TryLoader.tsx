'use client';

import dynamic from 'next/dynamic';

/**
 * `/try` (the import, the runtime) only works in the browser, so it is a client-only chunk
 * that loads with this route and never with others.
 */
const Try = dynamic(() => import('./Try'), {
  ssr: false,
  loading: () => (
    <main className="grid h-dvh place-items-center text-sm text-zinc-500">Loading…</main>
  ),
});

export function TryLoader() {
  return <Try />;
}
