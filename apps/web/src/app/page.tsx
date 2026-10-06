import { HAPPY_PATH_PHASES, PHASE_LABELS } from '@br/game';
import { HomeActions } from '../components/home/HomeActions';

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

      <HomeActions />

      <p className="max-w-md text-sm text-zinc-500">
        Create a room and send the link to up to 7 friends (and 20 spectators), or race the clock on
        your own. No account needed.
      </p>
    </main>
  );
}
