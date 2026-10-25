'use client';

import dynamic from 'next/dynamic';
import { useT } from '../../lib/i18n/context';
import { PageTitle } from '../i18n/PageTitle';
import '../solo/solo-screens.css';

function Loading() {
  return (
    <main className="br-app-loading">
      <div className="br-app-loading__card">
        <span aria-hidden="true" className="br-loading-dot" />
        {useT().common.loading}
      </div>
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
