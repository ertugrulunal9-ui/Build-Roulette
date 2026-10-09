'use client';

/**
 * The browser's URL, for the static shells (T-037): `null` while the page is prerendered and
 * during hydration (the exported HTML knows only the shell's own path, `/battles`), then the
 * real `window.location` (`/battles/{id}?…`). Rendering from it after hydration keeps the
 * hydration render identical to the HTML. Back/forward within the page (`popstate`) updates
 * it; links between shells are plain `<a>` navigations, so a new page reads it afresh.
 */
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
  };
}

const href = () => window.location.href;
const none = () => null;

export function useBrowserUrl(): URL | null {
  const current = useSyncExternalStore(subscribe, href, none);
  return current === null ? null : new URL(current);
}
