'use client';

import dynamic from 'next/dynamic';

/**
 * The room (Supabase client and Realtime, CodeMirror, the runtime, IndexedDB) only works in
 * the browser and is heavy, so it is a client-only chunk that loads with /r/[code] only.
 */
const RoomApp = dynamic(() => import('./RoomApp'), {
  ssr: false,
  loading: () => (
    <main className="grid h-dvh place-items-center text-sm text-zinc-500">Loading the room…</main>
  ),
});

export function RoomLoader({ code }: { code: string }) {
  return <RoomApp code={code} />;
}
