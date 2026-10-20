/**
 * The UI language (T-050, docs/09 §9.7): English by default, Turkish when the player picks it.
 * Never chosen from the browser's language: English stays until the player switches. The
 * choice is remembered per browser in localStorage (`br:locale`); every access is guarded,
 * so blocked storage means English after a reload (the switch still works for the page).
 *
 * The admin pages (`/admin`) are always English, whatever the player picked.
 */

export const LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** The localStorage key of the player's choice. */
export const LOCALE_STORAGE_KEY = 'br:locale';

/** The `<html>` attribute the early script sets before the page's script runs. */
export const LOCALE_ATTRIBUTE = 'data-locale';
/** Set on `<html>` once the page shows the stored language (the CSS stops hiding it). */
export const LOCALE_READY_ATTRIBUTE = 'data-locale-ready';

/** The BCP 47 tag for `Intl` (numbers, dates, relative times). */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-US', tr: 'tr-TR' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Pages that stay English (the moderators' admin). */
export function isEnglishOnlyPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

/** The stored choice, or null (none, unknown or storage blocked). */
export function readStoredLocale(
  storage: () => Storage = () => window.localStorage,
): Locale | null {
  try {
    const v = storage().getItem(LOCALE_STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remembers the choice; false when storage is blocked (the choice then lasts the page view). */
export function writeStoredLocale(
  locale: Locale,
  storage: () => Storage = () => window.localStorage,
): boolean {
  try {
    storage().setItem(LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}

/**
 * The inline script in the root layout's `<head>`: it runs before the page paints and, for a
 * stored Turkish choice (outside `/admin`), sets `<html lang="tr" data-locale="tr">`. The CSS
 * then keeps the prerendered (English) page hidden until React shows it in Turkish, or for
 * at most 1.5 s (globals.css). The static site's CSP lists its SHA-256 like every inline
 * script of the export (lib/hosting/pages-config.ts), so it must stay a constant string.
 */
export const LOCALE_SCRIPT = `(function(){try{var l=window.localStorage.getItem(${JSON.stringify(
  LOCALE_STORAGE_KEY,
)});var p=window.location.pathname;if(l==="tr"&&p!=="/admin"&&p.indexOf("/admin/")!==0){var d=document.documentElement;d.lang=l;d.setAttribute(${JSON.stringify(
  LOCALE_ATTRIBUTE,
)},l);}}catch(e){}})();`;
