/**
 * What kind of device the app runs on, for the few places where phones get a different
 * experience (docs/02 R2 and R7):
 *
 * - **Touch-primary devices** (phones, tablets: no hover, a coarse pointer) watch the REVEAL
 *   with each build's screenshot first and run it live only on a tap. Mobile browsers do not
 *   always put a cross-site iframe in its own process, so a looping build could freeze the
 *   whole tab there; one tap per build keeps that the viewer's choice.
 * - The same devices get a "building needs a desktop browser" notice instead of the editor
 *   (mobile is reveal-and-vote only in v1), with a way to build anyway (a tablet with a
 *   keyboard can).
 *
 * The media query, not the user agent: it follows what the device can do, and Playwright's
 * mobile emulation (`hasTouch`, `isMobile`) sets it like a real phone does.
 */
import { useSyncExternalStore } from 'react';

/** A device whose primary input is touch: no hover and a coarse pointer. */
export const TOUCH_PRIMARY_QUERY = '(hover: none) and (pointer: coarse)';

function mediaQuery(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(query);
}

/** Whether `query` matches now (false on the server and without `matchMedia`). */
export function matchesMedia(query: string): boolean {
  return mediaQuery(query)?.matches ?? false;
}

/** Re-renders when `query` starts or stops matching (e.g. a tablet docked to a keyboard). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = mediaQuery(query);
      if (!mql) return () => undefined;
      mql.addEventListener('change', onChange);
      return () => {
        mql.removeEventListener('change', onChange);
      };
    },
    () => matchesMedia(query),
    () => false,
  );
}

/** Phones and tablets (see the module comment). */
export function useTouchPrimary(): boolean {
  return useMediaQuery(TOUCH_PRIMARY_QUERY);
}
