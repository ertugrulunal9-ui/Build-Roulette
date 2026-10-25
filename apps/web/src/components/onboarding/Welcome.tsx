'use client';

/**
 * The welcome screen (T-049, docs/09 §9.6): a full-screen dialog with the four steps of a
 * battle, shown by itself on the first visit to a player-facing entry point and again from
 * "How it works".
 *
 * Where it may show is decided by who mounts {@link Welcome}: the home page, `/play` before a
 * battle (the name entry) and a room's lobby. Never during SPIN / BUILD / REVEAL / VOTE (the
 * lobby unmounts, and the welcome with it), and never on `/battles/*`, `/u/*`, `/admin` or
 * `/try`.
 *
 * Accessible: a modal `<dialog>` (the rest of the page is inert), labelled by its title and
 * step, focus kept inside (Tab wraps), Esc and "Skip" close it, focus returns to where it was.
 */
import Link from 'next/link';
import { LightbulbIcon } from '@phosphor-icons/react/dist/csr/Lightbulb';
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import {
  closeWelcome,
  dropWelcomeRequest,
  isWelcomeOpen,
  openWelcome,
  subscribeWelcome,
  welcomeStatus,
  type WelcomeStatus,
} from '../../lib/onboarding/welcome';
import { useT } from '../../lib/i18n/context';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { Rich } from '../i18n/Rich';
import { CodeText } from '../site/CodeText';
import { GUIDE_PATH, STEP_IDS, TRY_PATH } from './copy';
import { PILL, StepArt } from './Steps';
import './onboarding.css';

/** Whether the welcome shows now (false on the server: the page HTML never has it). */
export function useWelcomeOpen(): boolean {
  return useSyncExternalStore(subscribeWelcome, isWelcomeOpen, () => false);
}

/** This browser's welcome status (`done` on the server, so nothing flashes). */
export function useWelcomeStatus(): WelcomeStatus {
  return useSyncExternalStore(subscribeWelcome, welcomeStatus, () => 'done');
}

export interface WelcomeProps {
  /**
   * Open "Practice first" and "Read the full guide" in a new tab (a room's lobby: leaving the
   * page would leave the room).
   */
  newTab?: boolean;
}

/** Mount where the welcome may show: it opens by itself on the first visit. */
export function Welcome({ newTab = false }: WelcomeProps) {
  const open = useWelcomeOpen();
  // A "How it works" request does not outlive the page part that hosts the welcome.
  useEffect(() => dropWelcomeRequest, []);
  if (!open) return null;
  return <WelcomeDialog newTab={newTab} onClose={closeWelcome} />;
}

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true',
  );
}

export function WelcomeDialog({
  newTab = false,
  onClose,
}: {
  newTab?: boolean;
  /** `finished`: closed on the last step. */
  onClose: (finished: boolean) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0);
  const step = STEP_IDS[index] ?? STEP_IDS[0];
  const words = t.steps[step];
  const last = index === STEP_IDS.length - 1;
  const total = STEP_IDS.length;

  // Open as a modal (the page behind is inert) and give focus back when it goes.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    }
    return () => {
      if (d.open) d.close();
      before?.focus();
    };
  }, []);

  // Focus follows the step: the main button of each step (Next, or "Let's play").
  useEffect(() => {
    primaryRef.current?.focus();
  }, [index]);

  const close = (finished: boolean) => {
    onClose(finished);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
      return;
    }
    if (e.key === 'ArrowRight' && !last && !(e.target instanceof HTMLInputElement)) {
      setIndex((i) => Math.min(i + 1, total - 1));
      return;
    }
    if (e.key === 'ArrowLeft' && index > 0) {
      setIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = focusables(ref.current);
    const first = items[0];
    const end = items[items.length - 1];
    if (!first || !end) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current.contains(active))) {
      e.preventDefault();
      end.focus();
    } else if (!e.shiftKey && (active === end || !ref.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const linkProps = newTab ? { target: '_blank', rel: 'noopener' } : {};
  const button =
    'min-h-11 rounded-xl px-5 py-2.5 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500';

  return (
    <dialog
      ref={ref}
      data-testid="welcome"
      data-step={step}
      aria-labelledby="welcome-title welcome-step-title"
      aria-describedby="welcome-step-text"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      onKeyDown={onKeyDown}
      className="br-welcome fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto overscroll-contain p-0 backdrop:bg-zinc-950/70"
    >
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-4 py-4 sm:px-6 sm:py-8">
        <div className="flex items-center justify-between gap-3">
          <p
            id="welcome-title"
            className="text-xs font-black tracking-widest text-zinc-500 uppercase"
          >
            {/* The name stays English, also in capitals: `lang` keeps "BUILD" from becoming "BUİLD". */}
            <Rich text={t.welcome.title} slots={{ brand: <span lang="en">Build Roulette</span> }} />
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="welcome-skip"
              onClick={() => {
                close(false);
              }}
              className="min-h-11 rounded-lg px-3 text-sm font-semibold text-zinc-600 hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {t.welcome.skip}
            </button>
            {/* A first visit opens the welcome by itself: the language is one tap away. */}
            <LanguagePicker />
          </div>
        </div>

        <section
          className="flex flex-1 flex-col items-center justify-center gap-6 py-6 text-center"
          aria-live="polite"
        >
          <div className="br-welcome__art w-full rounded-3xl border border-zinc-200 bg-white px-4 py-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <StepArt id={step} />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-bold text-zinc-500" data-testid="welcome-step-count">
              {t.welcome.stepOf(index + 1, total)}
            </p>
            <h2
              id="welcome-step-title"
              className="br-welcome__title text-3xl font-black tracking-tight sm:text-4xl"
              data-testid="welcome-step-title"
            >
              <span aria-hidden="true" className="br-welcome__step-number">
                {String(index + 1).padStart(2, '0')}{' '}
              </span>
              {words.title}
            </h2>
            <p
              id="welcome-step-text"
              className="mx-auto max-w-md text-base text-zinc-600 sm:text-lg dark:text-zinc-300"
            >
              <CodeText text={words.text} />
            </p>
          </div>
        </section>

        <div className="flex flex-col gap-4">
          <ol className="flex justify-center gap-1" aria-label={t.welcome.steps}>
            {STEP_IDS.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  aria-label={t.welcome.goToStep(i + 1)}
                  aria-current={i === index ? 'step' : undefined}
                  data-testid="welcome-dot"
                  onClick={() => {
                    setIndex(i);
                  }}
                  className="grid size-8 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-sky-500"
                >
                  <span
                    className={`block h-2.5 rounded-full ${
                      i === index
                        ? 'w-6 bg-zinc-900 dark:bg-zinc-100'
                        : 'w-2.5 bg-zinc-300 dark:bg-zinc-700'
                    }`}
                  />
                </button>
              </li>
            ))}
          </ol>

          {last ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                data-testid="welcome-back"
                onClick={() => {
                  setIndex(index - 1);
                }}
                className={`${button} border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800`}
              >
                {t.welcome.back}
              </button>
              <Link
                href={TRY_PATH}
                data-testid="welcome-practice"
                onClick={() => {
                  close(true);
                }}
                {...linkProps}
                className={`${button} border-2 border-zinc-900 text-center hover:bg-zinc-100 dark:border-zinc-100 dark:hover:bg-zinc-800`}
              >
                {t.welcome.practice}
                {newTab && <span className="sr-only"> {t.common.newTab}</span>}
              </Link>
              <button
                type="button"
                ref={primaryRef}
                data-testid="welcome-play"
                onClick={() => {
                  close(true);
                }}
                className={`br-welcome__action ${button} hover:brightness-95`}
              >
                {t.welcome.play}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="welcome-back"
                disabled={index === 0}
                onClick={() => {
                  setIndex(index - 1);
                }}
                className={`${button} flex-1 border border-zinc-300 hover:bg-zinc-100 disabled:invisible sm:flex-none dark:border-zinc-700 dark:hover:bg-zinc-800`}
              >
                {t.welcome.back}
              </button>
              <button
                type="button"
                ref={primaryRef}
                data-testid="welcome-next"
                onClick={() => {
                  setIndex(index + 1);
                }}
                className={`${button} flex-1 bg-zinc-900 text-white hover:bg-zinc-700 sm:ml-auto sm:flex-none dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white`}
              >
                {t.welcome.next} →
              </button>
            </div>
          )}

          <p className="text-center">
            <Link
              href={GUIDE_PATH}
              data-testid="welcome-guide"
              onClick={() => {
                close(false);
              }}
              {...linkProps}
              className="text-sm font-semibold text-zinc-600 underline underline-offset-2 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {t.welcome.guide}
              {newTab && <span className="sr-only"> {t.common.newTab}</span>}
            </Link>
          </p>
        </div>
      </div>
    </dialog>
  );
}

/** "How it works" where the welcome is mounted: opens it again. */
export function HowItWorksButton({ className = PILL }: { className?: string }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="how-it-works"
      aria-haspopup="dialog"
      onClick={openWelcome}
      className={className}
    >
      <LightbulbIcon aria-hidden="true" size={16} weight="duotone" /> {t.common.howItWorks}
    </button>
  );
}

/**
 * "How it works" as a link to the guide (`/try`, and the BUILD stage header, where it opens
 * in a new tab so a running battle is not left).
 */
export function HowItWorksLink({
  newTab = false,
  className = PILL,
}: {
  newTab?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <a
      href={GUIDE_PATH}
      data-testid="how-it-works"
      {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}
      className={className}
    >
      <LightbulbIcon aria-hidden="true" size={16} weight="duotone" /> {t.common.howItWorks}
      {newTab && (
        <>
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> {t.common.newTab}</span>
        </>
      )}
    </a>
  );
}
