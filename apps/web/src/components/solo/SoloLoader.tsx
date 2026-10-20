'use client';

import dynamic from 'next/dynamic';
import { useT } from '../../lib/i18n/context';
import { PageTitle } from '../i18n/PageTitle';

function Loading() {
  return (
    <main className="grid h-dvh place-items-center text-sm text-zinc-500">
      {useT().solo.loadingGame}
    </main>
  );
}

/**
 * The solo game (Supabase client, the site import, the runtime, IndexedDB) only works in the
 * browser and is heavy, so it is a client-only chunk that loads with /play only.
 */
const SoloGame = dynamic(() => import('./SoloGame'), {
  ssr: false,
  loading: Loading,
});

export function SoloLoader() {
  return (
    <>
      <PageTitle page="play" />
      <SoloGame />
    </>
  );
}
