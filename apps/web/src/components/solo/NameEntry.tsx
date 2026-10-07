'use client';

import Link from 'next/link';
import { useState } from 'react';
import { describeError, type GameError } from '../../lib/solo/errors';
import { randomDisplayName } from '../../lib/solo/names';

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

/** One input with a random fun default name, and the Spin button. */
export function NameEntry({ busy, error, onSpin }: NameEntryProps) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <header className="flex flex-col gap-3">
        <Link href="/" className="text-sm font-semibold text-zinc-500 hover:underline">
          Build Roulette
        </Link>
        <h1 className="text-4xl font-black tracking-tight sm:text-5xl">Solo battle</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Spin a random BUILD, RULE and STYLE, then race the clock. Ship before time runs out.
        </p>
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
          Your name
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
            title="Another random name"
            aria-label="Another random name"
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
          {busy ? 'Spinning up…' : 'Spin'}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {describeError(error)}
            {error.details &&
              !['battle_in_progress', 'name_not_allowed', 'rate_limited'].includes(error.code) && (
                <span className="block text-xs opacity-75">{error.details}</span>
              )}
          </p>
        )}
      </form>
      <p className="text-xs text-zinc-500">
        No account needed. Your build is deleted when the battle ends; the results stay.
      </p>
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
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-black tracking-tight">You have a battle running</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Only one solo battle can run at a time. Jump back in before the clock runs out.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onResume}
          className="rounded-lg bg-zinc-900 px-5 py-3 font-bold text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Resume battle
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-zinc-300 px-5 py-3 font-semibold dark:border-zinc-700"
        >
          Back
        </button>
      </div>
    </main>
  );
}
