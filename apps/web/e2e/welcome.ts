/**
 * The welcome screen (T-049) opens by itself on a first visit, over the page. Every e2e suite
 * starts its browser contexts with it already seen (`use.storageState` in each Playwright
 * config: `browser.newContext()` in a test gets it too), so it never gets in the way of a
 * test; the onboarding spec clears it for the tests of the welcome itself (`FIRST_VISIT`).
 */
import { WELCOME_KEY } from '../src/lib/onboarding/welcome';

interface StorageState {
  cookies: [];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

/** A context whose app origin has seen the welcome (to the end). */
export function welcomeSeen(origin: string): StorageState {
  return {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: WELCOME_KEY, value: 'done' }] }],
  };
}

/** A first visit: nothing stored. */
export const FIRST_VISIT: StorageState = { cookies: [], origins: [] };
