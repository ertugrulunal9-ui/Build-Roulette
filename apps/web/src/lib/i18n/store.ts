/**
 * The player's language for this page (T-050): read once from localStorage, kept in memory
 * (so a blocked storage still lets the switch work for the page view), written back on every
 * change and followed across tabs (`storage` events). React reads it through
 * `useSyncExternalStore` (I18nProvider), with English as the server snapshot: the static
 * export is prerendered in English, and the stored language takes over right after hydration.
 */
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isEnglishOnlyPath,
  isLocale,
  readStoredLocale,
  writeStoredLocale,
  type Locale,
} from './locale';

let current: Locale | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent): void {
  if (e.key !== LOCALE_STORAGE_KEY) return;
  const next = isLocale(e.newValue) ? e.newValue : DEFAULT_LOCALE;
  if (next === current) return;
  current = next;
  emit();
}

/** The player's choice (English until they pick Turkish; English when storage is blocked). */
export function chosenLocale(): Locale {
  current ??=
    typeof window === 'undefined' ? DEFAULT_LOCALE : (readStoredLocale() ?? DEFAULT_LOCALE);
  return current;
}

/** The language this page shows: the choice, except on the English-only pages (`/admin`). */
export function pageLocale(): Locale {
  if (typeof window !== 'undefined' && isEnglishOnlyPath(window.location.pathname)) {
    return DEFAULT_LOCALE;
  }
  return chosenLocale();
}

export function setLocale(locale: Locale): void {
  writeStoredLocale(locale);
  if (locale === chosenLocale()) return;
  current = locale;
  emit();
}

export function subscribeLocale(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

/** Tests: forget the cached choice (the next read goes to storage again). */
export function resetLocaleForTests(): void {
  current = null;
  emit();
}
