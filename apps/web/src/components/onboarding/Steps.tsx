'use client';

/**
 * The four steps of a battle (spin, build your way, build & drop, ship / reveal / vote), each
 * with a small picture made of markup: the welcome screen shows one at a time, the home page
 * and the guide show all four as cards. Their words are the page language's (T-050).
 */
import { useT } from '../../lib/i18n/context';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { CodeIcon } from '@phosphor-icons/react/dist/csr/Code';
import { PackageIcon } from '@phosphor-icons/react/dist/csr/Package';
import { RocketLaunchIcon } from '@phosphor-icons/react/dist/csr/RocketLaunch';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { ListChecksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { TrophyIcon } from '@phosphor-icons/react/dist/csr/Trophy';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { formatTimeLimit } from '../../lib/solo/format';
import { cardClass } from '../results/ResultPieces';
import { CodeText } from '../site/CodeText';
import { STEP_IDS, STEP_SAMPLES, type StepId } from './copy';

/** A small rounded link or button ("How it works", "Try an import"). */
export const PILL =
  'inline-flex min-h-9 items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-zinc-700 dark:hover:bg-zinc-800';

/** The picture of a step. Decorative: the step's text says everything. */
export function StepArt({ id, size = 'large' }: { id: StepId; size?: 'large' | 'small' }) {
  const large = size === 'large';
  return (
    <div
      aria-hidden="true"
      data-art={id}
      className={`br-guide__step-illustration flex w-full items-center justify-center select-none ${large ? 'min-h-40' : 'min-h-36'}`}
    >
      {id === 'spin' && <SpinArt large={large} />}
      {id === 'build' && <BuildArt large={large} />}
      {id === 'drop' && <DropArt large={large} />}
      {id === 'ship' && <ShipArt large={large} />}
    </div>
  );
}

function SpinArt({ large }: { large: boolean }) {
  const t = useT();
  const samples = {
    build: t.home.sampleBuild,
    rule: t.home.sampleRule,
    style: t.home.sampleStyle,
  };
  const cards = (['build', 'rule', 'style'] as const).map((k, i) => (
    <div
      key={k}
      className={`flex flex-col justify-between rounded-lg border-l-4 shadow-sm ${cardClass(k)} ${
        large ? 'h-24 w-24 p-2' : 'h-18 w-18 p-1.5'
      } ${['-rotate-6', 'translate-y-1', 'rotate-6'][i] ?? ''}`}
    >
      <span
        className={`font-black tracking-widest opacity-70 ${large ? 'text-[10px]' : 'text-[8px]'}`}
      >
        {t.cards[k]}
      </span>
      <span className={`leading-tight font-semibold ${large ? 'text-xs' : 'text-[10px]'}`}>
        {samples[k]}
      </span>
    </div>
  ));
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-end gap-1.5">{cards}</div>
      <span
        className={`rounded-full bg-zinc-900 px-3 py-1 font-mono font-bold text-white dark:bg-zinc-100 dark:text-zinc-900 ${
          large ? 'text-xs' : 'text-[10px]'
        }`}
      >
        <ClockIcon aria-hidden="true" /> {t.stepArt.timeLabel} ·{' '}
        {formatTimeLimit(STEP_SAMPLES.exampleMinutes * 60, t)}
      </span>
    </div>
  );
}

function BuildArt({ large }: { large: boolean }) {
  const tools = STEP_SAMPLES.tools;
  return (
    <div className="flex flex-col items-center gap-3">
      <p
        className={`grid place-items-center rounded-full bg-[#e2e8ff] text-[#2850ff] ${large ? 'size-20' : 'size-14'}`}
      >
        <CodeIcon aria-hidden="true" size={large ? 42 : 30} weight="duotone" />
      </p>
      <ul className="flex max-w-72 flex-wrap justify-center gap-1.5">
        {tools.map((t) => (
          <li
            key={t}
            className={`rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 ${
              large ? 'text-xs' : 'text-[10px]'
            }`}
          >
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DropArt({ large }: { large: boolean }) {
  const t = useT();
  return (
    <div className={`flex w-full flex-col items-center gap-2 ${large ? 'max-w-64' : 'max-w-44'}`}>
      <div
        className={`w-full rounded-lg bg-zinc-900 text-left font-mono text-zinc-100 shadow-sm dark:bg-black ${
          large ? 'px-3 py-2 text-xs' : 'px-2 py-1.5 text-[10px]'
        }`}
      >
        <p>
          <span className="text-emerald-400">$</span> {STEP_SAMPLES.terminalCommand}
        </p>
        <p className="text-emerald-300">{t.stepArt.terminalResult}</p>
      </div>
      <ArrowDownIcon aria-hidden="true" className="text-[#2850ff]" size={20} />
      <div
        className={`flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-sky-400 bg-sky-50 font-bold text-sky-900 dark:border-sky-600 dark:bg-sky-950/60 dark:text-sky-100 ${
          large ? 'px-3 py-3 text-sm' : 'px-2 py-2 text-[11px]'
        }`}
      >
        <PackageIcon aria-hidden="true" size={18} /> <CodeText text={t.stepArt.dropTarget} />
      </div>
    </div>
  );
}

function ShipArt({ large }: { large: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3">
      <ol className="flex items-center gap-1">
        {STEP_SAMPLES.endFlow.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1">
            {i > 0 && <span className="text-zinc-400 dark:text-zinc-600">→</span>}
            <span className="flex flex-col items-center gap-0.5">
              <span
                className={`grid place-items-center rounded-full bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700 ${
                  large ? 'size-12 text-2xl' : 'size-9 text-lg'
                }`}
              >
                {s.key === 'ship' ? (
                  <RocketLaunchIcon aria-hidden="true" weight="duotone" />
                ) : s.key === 'reveal' ? (
                  <EyeIcon aria-hidden="true" weight="duotone" />
                ) : s.key === 'vote' ? (
                  <ListChecksIcon aria-hidden="true" weight="duotone" />
                ) : (
                  <TrophyIcon aria-hidden="true" weight="duotone" />
                )}
              </span>
              <span
                className={`font-bold text-zinc-600 dark:text-zinc-400 ${large ? 'text-[11px]' : 'text-[9px]'}`}
              >
                {t.stepArt[s.key]}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <span
        className={`rounded-full bg-emerald-100 px-3 py-0.5 font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200 ${
          large ? 'text-xs' : 'text-[10px]'
        }`}
      >
        {t.stepArt.endNote}
      </span>
    </div>
  );
}

/** One step as a card (home, guide). */
export function StepCard({ step, index }: { step: StepId; index: number }) {
  const words = useT().steps[step];
  return (
    <li
      className="br-guide__step-card flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      data-testid="step-card"
      data-step={step}
    >
      <div className="br-guide__step-art rounded-xl bg-zinc-50 py-3 dark:bg-zinc-950/60">
        <StepArt id={step} size="small" />
      </div>
      <h3 className="flex items-center gap-2 text-lg font-black tracking-tight">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-zinc-900 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
          {index + 1}
        </span>
        {words.title}
      </h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        <CodeText text={words.text} />
      </p>
    </li>
  );
}

/** The four steps as cards. */
export function StepCards({ label }: { label: string }) {
  return (
    <ol
      aria-label={label}
      className="br-guide__step-cards grid w-full max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2"
      data-testid="step-cards"
    >
      {STEP_IDS.map((step, i) => (
        <StepCard key={step} step={step} index={i} />
      ))}
    </ol>
  );
}
