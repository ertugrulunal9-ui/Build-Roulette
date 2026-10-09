'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { roomCodeFromPath } from '../../lib/room/path';

function Loading() {
  return (
    <main className="grid h-dvh place-items-center text-sm text-zinc-500">Loading the room…</main>
  );
}

/**
 * The room (Supabase client and Realtime, CodeMirror, the runtime, IndexedDB) only works in
 * the browser and is heavy, so it is a client-only chunk that loads with /r/[code] only.
 */
const RoomApp = dynamic(() => import('./RoomApp'), { ssr: false, loading: Loading });

const noSubscription = () => () => undefined;

/**
 * `/r/{code}`: every room shares one prerendered page (app/r/page.tsx, reached through a
 * rewrite in next.config.ts), so the code comes from the browser's URL. The server (and the
 * hydration render) show the loading screen; the room starts once the page runs in the
 * browser. T-033: the page is answered from the cache instead of rendered per request.
 */
export function RoomLoader() {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const code = hydrated ? roomCodeFromPath(pathname) : null;

  useEffect(() => {
    if (code) document.title = `Room ${code.toUpperCase().slice(0, 12)} · Build Roulette`;
  }, [code]);

  if (code === null) return <Loading />;
  if (code === '') {
    return (
      <main className="grid h-dvh place-items-center p-6 text-center">
        <p className="flex flex-col gap-3 text-sm text-zinc-500">
          This link has no room code.
          <Link href="/" className="font-semibold text-zinc-900 underline dark:text-zinc-100">
            Create or join a room
          </Link>
        </p>
      </main>
    );
  }
  // A new room (a client-side navigation from one /r/{code} to another) starts afresh, as it
  // did when every code was its own page.
  return <RoomApp key={code} code={code} />;
}
