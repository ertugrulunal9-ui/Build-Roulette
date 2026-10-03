'use client';

import dynamic from 'next/dynamic';

/**
 * The playground (CodeMirror, the runtime, IndexedDB) only works in the browser and is
 * heavy, so it is a client-only chunk that loads with this route and never with others.
 */
const Playground = dynamic(() => import('./Playground'), {
  ssr: false,
  loading: () => (
    <main className="grid h-dvh place-items-center text-sm text-zinc-500">
      Loading the playground…
    </main>
  ),
});

export function PlaygroundLoader() {
  return <Playground />;
}
