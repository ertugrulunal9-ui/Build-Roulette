/**
 * Numbers, sizes, dates and relative times in the page's language (`Intl`, T-050). The
 * English output matches what the app showed before the switch existed (the e2e checks it):
 * `340 KB`, `1.2 MB`; Turkish writes `1,2 MB`.
 */
import { INTL_LOCALE, type Locale } from './locale';

const cache = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: Locale, digits: number): Intl.NumberFormat {
  const key = `${locale}:${String(digits)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(INTL_LOCALE[locale], {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    });
    cache.set(key, f);
  }
  return f;
}

/** `1.2 MB`, `340 KB`, `512 B` (decimal-ish, rounded for a person, not a disk). */
export function formatBytes(bytes: number, locale: Locale = 'en'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${numberFormat(locale, 0).format(Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) {
    return `${numberFormat(locale, 0).format(Math.max(1, Math.round(bytes / 1024)))} KB`;
  }
  return `${numberFormat(locale, 1).format(bytes / (1024 * 1024))} MB`;
}

/** A moment in UTC, e.g. `Oct 16, 2026, 2:03 PM UTC` / `16 Eki 2026 14:03 UTC`. */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const text = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `${text} UTC`;
}

/** The time of day on this device (`Saved 14:03:12`). */
export function formatClockTime(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleTimeString(INTL_LOCALE[locale]);
}

/** "12 sec. ago", "3 min. ago", "2 hr. ago" / "12 sn. önce", "3 dk. önce", "2 sa. önce". */
export function formatAgo(ms: number, locale: Locale): string {
  const rtf = new Intl.RelativeTimeFormat(INTL_LOCALE[locale], { style: 'short' });
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return rtf.format(-s, 'second');
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, 'minute');
  return rtf.format(-Math.round(m / 60), 'hour');
}
