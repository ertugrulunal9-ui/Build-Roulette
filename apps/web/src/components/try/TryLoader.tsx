'use client';

import dynamic from 'next/dynamic';
import { useT } from '../../lib/i18n/context';
import { PageTitle } from '../i18n/PageTitle';

function Loading() {
  return (
    <main className="grid h-dvh place-items-center text-sm text-zinc-500">
      {useT().common.loading}
    </main>
  );
}

/**
 * `/try` (the import, the runtime) only works in the browser, so it is a client-only chunk
 * that loads with this route and never with others.
 */
const Try = dynamic(() => import('./Try'), {
  ssr: false,
  loading: Loading,
});

export function TryLoader() {
  return (
    <>
      <PageTitle page="try" />
      <Try />
    </>
  );
}
