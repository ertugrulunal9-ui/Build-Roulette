'use client';

import dynamic from 'next/dynamic';

/**
 * The solo game (Supabase client, CodeMirror, the runtime, IndexedDB) only works in the
 * browser and is heavy, so it is a client-only chunk that loads with /play only.
 */
const SoloGame = dynamic(() => import('./SoloGame'), {
  ssr: false,
  loading: () => (
    <main className="grid h-dvh place-items-center text-sm text-zinc-500">Loading the game…</main>
  ),
});

export function SoloLoader() {
  return <SoloGame />;
}
