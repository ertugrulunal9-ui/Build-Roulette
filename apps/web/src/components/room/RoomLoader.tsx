'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { roomCodeFromPath } from '../../lib/room/path';
import { DocumentTitle } from '../DocumentTitle';

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
 * `/r/{code}`: every room shares one exported page (app/r/page.tsx, reached through the
 * host's rewrite, src/lib/hosting/shells.ts), so the code comes from the browser's URL. The
 * exported HTML (and the hydration render) show the loading screen; the room starts once the
 * page runs in the browser (T-033, T-037).
 */
export function RoomLoader() {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const code = hydrated ? roomCodeFromPath(pathname) : null;

  // The tab title (the page's metadata has none: components/DocumentTitle.tsx).
  const title = <DocumentTitle title={code ? `Room ${code.toUpperCase().slice(0, 12)}` : 'Room'} />;

  if (code === null) {
    return (
      <>
        {title}
        <Loading />
      </>
    );
  }
  if (code === '') {
    return (
      <>
        {title}
        <main className="grid h-dvh place-items-center p-6 text-center">
          <p className="flex flex-col gap-3 text-sm text-zinc-500">
            This link has no room code.
            <Link href="/" className="font-semibold text-zinc-900 underline dark:text-zinc-100">
              Create or join a room
            </Link>
          </p>
        </main>
      </>
    );
  }
  // A new room (a client-side navigation from one /r/{code} to another) starts afresh, as it
  // did when every code was its own page.
  return (
    <>
      {title}
      <RoomApp key={code} code={code} />
    </>
  );
}
