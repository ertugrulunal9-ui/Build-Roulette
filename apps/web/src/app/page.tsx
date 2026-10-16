import { HAPPY_PATH_PHASES, PHASE_LABELS } from '@br/game';
import Link from 'next/link';
import { HomeActions } from '../components/home/HomeActions';
import { GUIDE_PATH, HOME_COPY, TRY_PATH } from '../components/onboarding/copy';
import { PILL, StepCards } from '../components/onboarding/Steps';
import { HowItWorksButton, Welcome } from '../components/onboarding/Welcome';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col items-center gap-16 px-4 py-14 text-center sm:px-6 sm:py-20">
      <section className="flex w-full max-w-3xl flex-col items-center gap-8">
        <header className="flex flex-col gap-4">
          <h1 className="text-5xl font-black tracking-tight sm:text-6xl">{HOME_COPY.title}</h1>
          <p className="text-lg text-zinc-600 sm:text-xl dark:text-zinc-400" data-testid="pitch">
            {HOME_COPY.pitch}
          </p>
        </header>

        <HomeActions />

        <div className="flex flex-wrap justify-center gap-2">
          <HowItWorksButton />
          <Link href={TRY_PATH} className={PILL} data-testid="home-try">
            <span aria-hidden="true">📦</span> {HOME_COPY.tryImport}
          </Link>
        </div>

        <p className="max-w-md text-sm text-zinc-500">{HOME_COPY.roomsAndSolo}</p>
      </section>

      <section
        className="flex w-full flex-col items-center gap-6"
        aria-labelledby="home-steps-title"
        data-testid="home-steps"
      >
        <h2 id="home-steps-title" className="text-3xl font-black tracking-tight">
          {HOME_COPY.stepsTitle}
        </h2>
        <StepCards label={HOME_COPY.stepsTitle} />
        <ol
          aria-label={HOME_COPY.phasesLabel}
          className="flex flex-wrap items-center justify-center gap-x-2 gap-y-3 font-mono text-xs font-semibold tracking-wider"
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
        <Link
          href={GUIDE_PATH}
          className="text-sm font-semibold underline underline-offset-2"
          data-testid="home-guide"
        >
          {HOME_COPY.guide} →
        </Link>
      </section>

      <p className="text-lg font-semibold text-zinc-600 dark:text-zinc-400">{HOME_COPY.tagline}</p>

      <Welcome />
    </main>
  );
}
