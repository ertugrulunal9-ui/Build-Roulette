import { HAPPY_PATH_PHASES, PHASE_LABELS } from '@br/game';

const buttonClass =
  'rounded-lg px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-10 px-6 py-16 text-center">
      <header className="flex flex-col gap-4">
        <h1 className="text-5xl font-black tracking-tight sm:text-6xl">Build Roulette</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Builds are temporary. Results are permanent.
        </p>
      </header>

      <ol
        aria-label="How a battle works"
        className="flex flex-wrap items-center justify-center gap-x-2 gap-y-3 font-mono text-xs font-semibold tracking-wider sm:text-sm"
      >
        {HAPPY_PATH_PHASES.map((phase, index) => (
          <li key={phase} className="flex items-center gap-2">
            {index > 0 && (
              <span aria-hidden="true" className="text-zinc-400 dark:text-zinc-600">
                →
              </span>
            )}
            <span className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700">
              {PHASE_LABELS[phase]}
            </span>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled
          className={`${buttonClass} bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900`}
        >
          Create room
        </button>
        <button
          type="button"
          disabled
          className={`${buttonClass} border border-zinc-300 dark:border-zinc-700`}
        >
          Join with code
        </button>
      </div>
      <p className="text-sm text-zinc-500">Rooms are coming soon.</p>
    </main>
  );
}
