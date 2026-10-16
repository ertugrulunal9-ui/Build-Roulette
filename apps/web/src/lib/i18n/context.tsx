'use client';

/**
 * The language of the page, for React (T-050): `I18nProvider` (in the root layout) follows the
 * player's choice (store.ts) and gives every component its catalog through `useT()`; switching
 * re-renders in place: no navigation, no remount (a running battle, its preview iframe and its
 * controllers keep going).
 *
 * Hydration: the static export is prerendered in English, so the first (hydrating) render is
 * English too (`useSyncExternalStore`'s server snapshot), then React re-renders with the stored
 * language. Meanwhile the early script (locale.ts `LOCALE_SCRIPT`) and globals.css keep a
 * Turkish page hidden, until this provider marks `<html>` ready.
 *
 * Without a provider (unit tests of a single component) everything is English.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { DEFAULT_LOCALE, LOCALE_ATTRIBUTE, LOCALE_READY_ATTRIBUTE, type Locale } from './locale';
import { en, type Messages } from './messages/en';
import { tr } from './messages/tr';
import { pageLocale, setLocale, subscribeLocale } from './store';

export const MESSAGES: Record<Locale, Messages> = { en, tr };

export interface I18n {
  locale: Locale;
  t: Messages;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18n>({ locale: DEFAULT_LOCALE, t: en, setLocale });

const serverLocale = (): Locale => DEFAULT_LOCALE;

export function I18nProvider({
  children,
  locale: fixed,
}: {
  children?: ReactNode;
  /** A fixed language instead of the player's choice (tests). */
  locale?: Locale;
}) {
  const followed = useSyncExternalStore(subscribeLocale, pageLocale, serverLocale);
  const locale = fixed ?? followed;

  // `<html lang>` follows the language, and the page shows once it is the stored one (the
  // hydration render is English: nothing changes on `<html>` until the stored one is in).
  useLayoutEffect(() => {
    if (fixed === undefined && locale !== pageLocale()) return;
    const root = document.documentElement;
    root.lang = locale;
    root.setAttribute(LOCALE_ATTRIBUTE, locale);
    root.setAttribute(LOCALE_READY_ATTRIBUTE, '');
  }, [locale, fixed]);

  const value = useMemo<I18n>(() => ({ locale, t: MESSAGES[locale], setLocale }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The language, its catalog and the switch. */
export function useI18n(): I18n {
  return useContext(I18nContext);
}

/** The catalog of the page's language. */
export function useT(): Messages {
  return useContext(I18nContext).t;
}
