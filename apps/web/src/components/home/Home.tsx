'use client';

/**
 * The landing page (prerendered in English; in the browser it follows the page's language,
 * T-050): the pitch, the three ways in, "How it works" and "Try an import", the four steps of
 * a battle, the phases, and the welcome screen on a first visit.
 */
import { HAPPY_PATH_PHASES } from '@br/game';
import Link from 'next/link';
import { useT } from '../../lib/i18n/context';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { GUIDE_PATH, TRY_PATH } from '../onboarding/copy';
import { PILL, StepCards } from '../onboarding/Steps';
import { HowItWorksButton, Welcome } from '../onboarding/Welcome';
import { HomeActions } from './HomeActions';

export function Home() {
  const t = useT();
  const home = t.home;
  return (
    <main className="relative mx-auto flex min-h-dvh max-w-6xl flex-col items-center gap-16 px-4 py-14 text-center sm:px-6 sm:py-20">
      <div className="absolute top-3 right-4 sm:top-5 sm:right-6">
        <LanguagePicker />
      </div>
      <section className="flex w-full max-w-3xl flex-col items-center gap-8">
        <header className="flex flex-col gap-4">
          <h1 className="text-5xl font-black tracking-tight sm:text-6xl">{home.title}</h1>
          <p className="text-lg text-zinc-600 sm:text-xl dark:text-zinc-400" data-testid="pitch">
            {home.pitch}
          </p>
        </header>

        <HomeActions />

        <div className="flex flex-wrap justify-center gap-2">
          <HowItWorksButton />
          <Link href={TRY_PATH} className={PILL} data-testid="home-try">
            <span aria-hidden="true">📦</span> {home.tryImport}
          </Link>
        </div>

        <p className="max-w-md text-sm text-zinc-500">{home.roomsAndSolo}</p>
      </section>

      <section
        className="flex w-full flex-col items-center gap-6"
        aria-labelledby="home-steps-title"
        data-testid="home-steps"
      >
        <h2 id="home-steps-title" className="text-3xl font-black tracking-tight">
          {home.stepsTitle}
        </h2>
        <StepCards label={home.stepsTitle} />
        <ol
          aria-label={home.phasesLabel}
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
                {t.phases[phase]}
              </span>
            </li>
          ))}
        </ol>
        <Link
          href={GUIDE_PATH}
          className="text-sm font-semibold underline underline-offset-2"
          data-testid="home-guide"
        >
          {home.guide} →
        </Link>
      </section>

      <p className="text-lg font-semibold text-zinc-600 dark:text-zinc-400">{home.tagline}</p>

      <Welcome />
    </main>
  );
}
