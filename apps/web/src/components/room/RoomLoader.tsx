'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { useT } from '../../lib/i18n/context';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { roomCodeFromPath } from '../../lib/room/path';
import { DocumentTitle } from '../DocumentTitle';
import { AppHeader } from '../ui/AppHeader';
import './room-results.css';

function Loading() {
  const t = useT();
  return (
    <div className="br-room-loader min-h-dvh">
      <AppHeader className="br-public-header" />
      <main className="br-room-loader__body" aria-busy="true">
        <CircleNotchIcon className="br-loading-spinner" size={28} aria-hidden="true" />
        <span>{t.room.loading}</span>
      </main>
    </div>
  );
}

/**
 * The room (Supabase client and Realtime, the site import, the runtime, IndexedDB) only works
 * in the browser and is heavy, so it is a client-only chunk that loads with /r/[code] only.
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
  const t = useT();
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const code = hydrated ? roomCodeFromPath(pathname) : null;

  // The tab title (the page's metadata has none: components/DocumentTitle.tsx).
  const title = (
    <DocumentTitle
      title={code ? t.common.roomCode(code.toUpperCase().slice(0, 12)) : t.room.title}
    />
  );

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
        <div className="br-room-loader min-h-dvh">
          <AppHeader className="br-public-header" />
          <main className="br-room-loader__empty">
            <div className="flex flex-col items-center gap-4">
              <p className="flex flex-col gap-3 text-sm">
                {t.room.noCode}
                <Link href="/" className="br-primary-link font-semibold">
                  {t.room.createOrJoin}
                </Link>
              </p>
            </div>
          </main>
        </div>
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
