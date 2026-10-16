// @vitest-environment happy-dom
/**
 * The language switch (T-050): English by default (never the browser's language), a stored
 * Turkish choice, blocked storage, `<html lang>`, the early script, `/admin` staying English,
 * the picker (a labelled group of toggle buttons), a switch that re-renders in place without a
 * remount, and the locale-aware formatting.
 */
import { runInThisContext } from 'node:vm';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguagePicker } from '../../components/i18n/LanguagePicker';
import { Rich } from '../../components/i18n/Rich';
import { toastText } from '../room/controller';
import { I18nProvider, useI18n, useT } from './context';
import { formatAgo, formatBytes, formatDateTime } from './format';
import {
  LOCALE_ATTRIBUTE,
  LOCALE_READY_ATTRIBUTE,
  LOCALE_SCRIPT,
  LOCALE_STORAGE_KEY,
} from './locale';
import { en } from './messages/en';
import { tr } from './messages/tr';
import { resetLocaleForTests, setLocale } from './store';

const root = () => document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  root().lang = 'en';
  root().removeAttribute(LOCALE_ATTRIBUTE);
  root().removeAttribute(LOCALE_READY_ATTRIBUTE);
  resetLocaleForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Storage that throws on every access (a private window, blocked site data): reading
 * `window.localStorage` itself throws, as browsers do when site data is blocked.
 */
function blockStorage(): void {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
}

let mounts = 0;

/** A page part that counts its mounts and shows a word of the catalog. */
function Probe() {
  const { locale, t } = useI18n();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      mounts++;
    }
  }, []);
  return createElement('p', { 'data-testid': 'probe', 'data-locale': locale }, t.home.playSolo);
}

function page() {
  mounts = 0;
  return render(
    createElement(I18nProvider, null, createElement(LanguagePicker), createElement(Probe)),
  );
}

const probe = () => screen.getByTestId('probe');
const button = (name: RegExp) => screen.getByRole('button', { name });

describe('the language of the page', () => {
  it('is English by default, whatever the browser says', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('tr-TR');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['tr-TR', 'tr']);
    page();
    expect(probe().textContent).toBe('Play solo');
    expect(root().lang).toBe('en');
    expect(root().hasAttribute(LOCALE_READY_ATTRIBUTE)).toBe(true);
  });

  it('a stored Turkish choice shows Turkish, with <html lang="tr">', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    page();
    expect(probe().textContent).toBe('Solo oyna');
    expect(root().lang).toBe('tr');
    expect(root().getAttribute(LOCALE_ATTRIBUTE)).toBe('tr');
    expect(root().hasAttribute(LOCALE_READY_ATTRIBUTE)).toBe(true);
  });

  it('an unknown stored value is English', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'de');
    page();
    expect(probe().textContent).toBe('Play solo');
  });

  it('switching re-renders at once, remembers the choice and remounts nothing', () => {
    page();
    fireEvent.click(button(/Türkçe/));
    expect(probe().textContent).toBe('Solo oyna');
    expect(root().lang).toBe('tr');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('tr');
    fireEvent.click(button(/English/));
    expect(probe().textContent).toBe('Play solo');
    expect(root().lang).toBe('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(mounts).toBe(1);
  });

  it('blocked storage: English, and the switch still works for this page view', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    blockStorage();
    page();
    expect(probe().textContent).toBe('Play solo');
    fireEvent.click(button(/Türkçe/));
    expect(probe().textContent).toBe('Solo oyna');
    expect(root().lang).toBe('tr');
  });

  it('follows a switch made in another tab', () => {
    page();
    act(() => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
      window.dispatchEvent(
        new StorageEvent('storage', { key: LOCALE_STORAGE_KEY, newValue: 'tr' }),
      );
    });
    expect(probe().textContent).toBe('Solo oyna');
  });

  it('/admin stays English, whatever was picked', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    window.history.replaceState(null, '', '/admin');
    render(createElement(I18nProvider, null, createElement(Probe)));
    expect(probe().textContent).toBe('Play solo');
    expect(root().lang).toBe('en');
  });

  it('without a provider (a lone component): English', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    render(createElement(Probe));
    expect(probe().textContent).toBe('Play solo');
  });

  it('a fixed language (tests, the error page)', () => {
    render(createElement(I18nProvider, { locale: 'tr' }, createElement(Probe)));
    expect(probe().textContent).toBe('Solo oyna');
  });
});

describe('the picker', () => {
  it('is a labelled group of two toggle buttons, the current one pressed', () => {
    page();
    const group = screen.getByRole('group', { name: 'Language' });
    const buttons = group.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(button(/English/).getAttribute('aria-pressed')).toBe('true');
    expect(button(/Türkçe/).getAttribute('aria-pressed')).toBe('false');
    expect(button(/Türkçe/).getAttribute('lang')).toBe('tr');
    expect(button(/Türkçe/).textContent).toBe('TR');
    fireEvent.click(button(/Türkçe/));
    expect(screen.getByRole('group', { name: 'Dil' })).toBeTruthy();
    expect(button(/Türkçe/).getAttribute('aria-pressed')).toBe('true');
    expect(button(/English/).getAttribute('aria-pressed')).toBe('false');
  });

  it('works from the keyboard: native buttons, in the Tab order', () => {
    page();
    const tr = button(/Türkçe/);
    expect(tr.tagName).toBe('BUTTON');
    expect(tr.getAttribute('type')).toBe('button');
    expect(tr.tabIndex).toBe(0);
    tr.focus();
    expect(document.activeElement).toBe(tr);
  });
});

describe('the early script (root layout)', () => {
  // As the browser runs it: a classic script in the page's global scope.
  const run = () => {
    runInThisContext(LOCALE_SCRIPT);
  };

  it('marks <html> for a stored Turkish choice, before React', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    run();
    expect(root().lang).toBe('tr');
    expect(root().getAttribute(LOCALE_ATTRIBUTE)).toBe('tr');
  });

  it('does nothing for English, on /admin, or with blocked storage', () => {
    run();
    expect(root().hasAttribute(LOCALE_ATTRIBUTE)).toBe(false);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    window.history.replaceState(null, '', '/admin/sign-in');
    run();
    expect(root().hasAttribute(LOCALE_ATTRIBUTE)).toBe(false);
    window.history.replaceState(null, '', '/');
    blockStorage();
    expect(run).not.toThrow();
    expect(root().hasAttribute(LOCALE_ATTRIBUTE)).toBe(false);
  });
});

describe('formatting in the language', () => {
  it('sizes: English as before, Turkish with a decimal comma', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(340 * 1024)).toBe('340 KB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB');
    expect(formatBytes(1.25 * 1024 * 1024, 'tr')).toBe('1,3 MB');
    expect(formatBytes(2048 * 1024, 'en')).toBe('2.0 MB');
    expect(formatBytes(-1)).toBe('');
  });

  it('relative times and dates', () => {
    expect(formatAgo(12_000, 'en')).toMatch(/12/);
    expect(formatAgo(12_000, 'tr')).toMatch(/12.*önce/);
    expect(formatAgo(3 * 60_000, 'tr')).toMatch(/3 dk\.? önce/);
    expect(formatAgo(2 * 3_600_000, 'en')).toMatch(/2 hr/);
    const at = '2026-10-16T14:03:00Z';
    expect(formatDateTime(at, 'en')).toBe('Oct 16, 2026, 2:03 PM UTC');
    expect(formatDateTime(at, 'tr')).toBe('16 Eki 2026 14:03 UTC');
  });

  it('toasts in either language, from the same data', () => {
    const ship = {
      kind: 'ship',
      you: false,
      who: 'Bob',
      name: 'Snack Overflow',
      completionMs: 192_000,
    } as const;
    expect(toastText(ship)).toBe('🚀 Bob shipped “Snack Overflow” at 3:12');
    expect(toastText(ship, tr)).toBe('🚀 Bob “Snack Overflow” projesini teslim etti (3:12)');
    const joined = { kind: 'member', change: 'joined', name: null, spectator: true } as const;
    expect(toastText(joined, en)).toBe('Someone joined to watch.');
    expect(toastText(joined, tr)).toBe('Biri izlemeye geldi.');
  });
});

describe('Rich', () => {
  function Sentence() {
    const t = useT();
    return createElement(
      'p',
      { 'data-testid': 'rich' },
      createElement(Rich, {
        text: t.lobby.waitingBattle,
        slots: { host: createElement('strong', null, '**Ada**'), ready: '2' },
      }),
    );
  }

  it('puts the slots where each language wants them, bold and code included', () => {
    render(createElement(I18nProvider, { locale: 'en' }, createElement(Sentence)));
    expect(screen.getByTestId('rich').textContent).toBe(
      'Waiting for **Ada** to start the battle… (2 ready)',
    );
    cleanup();
    render(createElement(I18nProvider, { locale: 'tr' }, createElement(Sentence)));
    expect(screen.getByTestId('rich').textContent).toBe(
      '**Ada** kapışmayı başlatacak, bekleniyor… (2 hazır)',
    );
    cleanup();
    render(createElement(Rich, { text: 'Run **`npm run build`** now' }));
    expect(document.querySelector('strong code')?.textContent).toBe('npm run build');
  });
});

describe('setLocale', () => {
  it('writes the choice even when it is the current one', () => {
    setLocale('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });
});
