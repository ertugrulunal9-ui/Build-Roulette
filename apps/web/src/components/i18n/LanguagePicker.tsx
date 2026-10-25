'use client';

/**
 * The English / Turkish switch (T-050): a labelled group of two toggle buttons ("EN", "TR",
 * each named in its own language), the current one `aria-pressed`. A click (or Enter / Space)
 * switches the page at once: no reload, no navigation, nothing remounts, so it is safe in the
 * middle of a battle. The choice is remembered per browser (lib/i18n/store.ts).
 *
 * Every player-facing page has one in its header or footer (README "Languages").
 */
import { useI18n } from '../../lib/i18n/context';
import { LOCALES, type Locale } from '../../lib/i18n/locale';

/** Each language by its own name (the same in every language). */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe' };
const SHORT: Record<Locale, string> = { en: 'EN', tr: 'TR' };

export function LanguagePicker({
  tone = 'page',
  className = '',
}: {
  /** `dark`: on a dark header (the REVEAL). */
  tone?: 'page' | 'dark';
  className?: string;
}) {
  const { locale, t, setLocale } = useI18n();
  const frame =
    tone === 'dark'
      ? 'border-zinc-700 bg-zinc-900'
      : 'border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900';
  const on =
    tone === 'dark'
      ? 'bg-zinc-100 text-zinc-900'
      : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';
  const off =
    tone === 'dark'
      ? 'text-zinc-400 hover:text-zinc-100'
      : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100';
  return (
    <div
      role="group"
      aria-label={t.language.label}
      data-testid="language-picker"
      data-locale={locale}
      className={`br-language inline-flex shrink-0 items-center gap-0.5 rounded-full border p-0.5 text-xs font-bold ${frame} ${className}`}
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-label={`${LOCALE_NAMES[l]} (${SHORT[l]})`}
          title={LOCALE_NAMES[l]}
          aria-pressed={l === locale}
          data-testid={`locale-${l}`}
          onClick={() => {
            setLocale(l);
          }}
          className={`min-h-7 min-w-8 rounded-full px-2 py-0.5 tracking-wide focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500 ${
            l === locale ? on : off
          }`}
        >
          {SHORT[l]}
        </button>
      ))}
    </div>
  );
}
