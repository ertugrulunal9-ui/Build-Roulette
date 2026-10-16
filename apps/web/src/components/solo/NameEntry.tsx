'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useT } from '../../lib/i18n/context';
import { describeError, type GameError } from '../../lib/solo/errors';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { randomDisplayName } from '../../lib/solo/names';
import { HowItWorksButton, Welcome } from '../onboarding/Welcome';

const NAME_KEY = 'br:display-name';

function initialName(): string {
  try {
    const saved = window.localStorage.getItem(NAME_KEY);
    if (saved && saved.trim().length > 0) return saved.slice(0, 24);
  } catch {
    // storage blocked
  }
  return randomDisplayName();
}

interface NameEntryProps {
  busy: boolean;
  error: GameError | null;
  onSpin: (name: string) => void;
}

/**
 * One input with a random fun default name, and the Spin button. Before a battle, so the
 * welcome screen (T-049) may show here on the first visit, and "How it works" reopens it.
 */
export function NameEntry({ busy, error, onSpin }: NameEntryProps) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <header className="flex flex-col gap-3">
        <Link href="/" className="text-sm font-semibold text-zinc-500 hover:underline">
          Build Roulette
        </Link>
        <h1 className="text-4xl font-black tracking-tight sm:text-5xl">{t.solo.title}</h1>
        <p className="text-zinc-600 dark:text-zinc-400">{t.solo.intro}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <HowItWorksButton />
          <LanguagePicker />
        </div>
      </header>

      <form
        className="flex w-full flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length === 0 || busy) return;
          try {
            window.localStorage.setItem(NAME_KEY, trimmed);
          } catch {
            // storage blocked
          }
          onSpin(trimmed);
        }}
      >
        <label htmlFor="display-name" className="text-left text-sm font-semibold">
          {t.common.yourName}
        </label>
        <div className="flex gap-2">
          <input
            id="display-name"
            data-testid="display-name"
            value={name}
            maxLength={24}
            autoComplete="nickname"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-3 text-lg dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="button"
            title={t.common.anotherName}
            aria-label={t.common.anotherName}
            onClick={() => {
              setName(randomDisplayName());
            }}
            className="rounded-lg border border-zinc-300 px-3 text-xl hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            🎲
          </button>
        </div>
        <button
          type="submit"
          disabled={busy || trimmed.length === 0}
          className="rounded-lg bg-zinc-900 px-5 py-4 text-lg font-black tracking-wide text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? t.solo.spinningUp : t.solo.spin}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {describeError(error, t)}
            {error.details &&
              !['battle_in_progress', 'name_not_allowed', 'rate_limited'].includes(error.code) && (
                <span className="block text-xs opacity-75">{error.details}</span>
              )}
          </p>
        )}
      </form>
      <p className="text-xs text-zinc-500">{t.solo.footer}</p>
      <Welcome />
    </main>
  );
}

export function ResumeOffer({
  onResume,
  onCancel,
}: {
  onResume: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-black tracking-tight">{t.solo.resumeTitle}</h1>
      <p className="text-zinc-600 dark:text-zinc-400">{t.solo.resumeText}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onResume}
          className="rounded-lg bg-zinc-900 px-5 py-3 font-bold text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          {t.solo.resume}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-zinc-300 px-5 py-3 font-semibold dark:border-zinc-700"
        >
          {t.solo.back}
        </button>
      </div>
      <LanguagePicker />
    </main>
  );
}
