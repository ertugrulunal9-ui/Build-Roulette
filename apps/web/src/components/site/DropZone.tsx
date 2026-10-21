'use client';

/**
 * The big import target of the BUILD stage and `/try` before anything is imported (docs/09
 * §9.5): "Drop your built site here", the two pickers, "…or paste the link of your published
 * site" (docs/10, when the page offers it), what is going on (reading, copying, or why the
 * last import failed and what to do), the three steps, and a slot for the "How do I import?"
 * help (T-049, onboarding).
 *
 * The drop itself is handled for the whole page (usePageDrop); this box only shows it.
 */
import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n/context';
import type { Messages } from '../../lib/i18n/messages/en';
import type { ImportErrorState, ImportState } from '../../lib/site/use-site-import';
import { GUIDE_PATH } from '../onboarding/copy';
import { IMPORT_HELP_ID, openImportHelp } from '../onboarding/ImportHelp';
import { CodeText } from './CodeText';
import { LinkForm } from './LinkForm';

/**
 * Why an import failed and what to do, in the page's language: the catalogs' `importErrors`
 * for a folder or a .zip (T-050; the English is `describeImportError` from `@br/site`), and
 * `linkErrors` for a link (docs/10).
 */
export function importErrorText(s: ImportErrorState, m: Messages): { title: string; hint: string } {
  return s.via === 'link'
    ? m.linkErrors[s.error.code](s.error.detail)
    : m.importErrors[s.error.code](s.error.detail);
}

/** The link field's part of the import (docs/10): null when the page does not offer it. */
export interface LinkControls {
  onSubmit: (link: string) => void;
  onCancel: () => void;
  /** The last link imported here (prefilled). */
  lastLink: string | null;
}

export interface DropZoneProps {
  state: ImportState;
  openFolder: () => void;
  openZip: () => void;
  onDismissError: () => void;
  /** Files are being dragged over the page. */
  dragging?: boolean;
  /** Imports are closed (time is up, shipped): the box says so. */
  disabled?: boolean;
  /** Shown instead of the title while an earlier import is being brought back. */
  restoring?: boolean;
  /** The "How do I import?" help next to the steps (onboarding, T-049: `ImportHelp`). */
  help?: ReactNode;
  /** "…or paste the link of your published site"; absent: no link field. */
  link?: LinkControls | null;
}

const fixLink = 'mt-1 inline-block text-sm font-semibold underline underline-offset-2';

const button =
  'min-h-11 rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50';

export function DropZone({
  state,
  openFolder,
  openZip,
  onDismissError,
  dragging = false,
  disabled = false,
  restoring = false,
  help,
  link,
}: DropZoneProps) {
  const t = useT();
  const words = t.importUi;
  const reading = state.status === 'reading';
  const copying = reading && state.via === 'link';
  const readingFiles = reading && !copying;
  const error = state.status === 'error' ? importErrorText(state, t) : null;
  const showLink = Boolean(link) && !disabled;
  // A link's error shows under the field it is about.
  const linkError = showLink && state.status === 'error' && state.via === 'link';
  const errorNote = error && (
    <ImportErrorNote
      title={error.title}
      hint={error.hint}
      onDismiss={onDismissError}
      inPageHelp={help !== undefined}
    />
  );
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center-safe gap-6 overflow-y-auto p-4 sm:p-8"
      data-testid="import-panel"
    >
      <section
        aria-label={words.panelLabel}
        aria-busy={reading}
        data-testid="drop-zone"
        data-state={
          disabled ? 'disabled' : dragging ? 'dragging' : reading ? 'reading' : state.status
        }
        className={`flex w-full max-w-2xl flex-col items-center gap-4 rounded-3xl border-4 border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? 'border-sky-500 bg-sky-50 dark:border-sky-400 dark:bg-sky-950/60'
            : error
              ? 'border-red-300 bg-white dark:border-red-800 dark:bg-zinc-900'
              : 'border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900'
        }`}
      >
        <p aria-hidden="true" className="text-5xl">
          {reading ? '⏳' : '📦'}
        </p>
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-black tracking-tight sm:text-3xl" data-testid="drop-title">
            {restoring && !reading ? words.restoring : words.dropTitle}
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            <CodeText text={words.dropSub} />
          </p>
        </div>

        {readingFiles ? (
          <p
            role="status"
            className="text-sm font-semibold text-sky-700 dark:text-sky-300"
            data-testid="import-reading"
          >
            {words.reading}
          </p>
        ) : disabled ? (
          <p className="text-sm font-semibold text-zinc-500" data-testid="import-locked">
            {words.locked}
          </p>
        ) : (
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={openFolder}
              disabled={copying}
              data-testid="choose-folder"
              className={`${button} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white`}
            >
              📁 {words.chooseFolder}
            </button>
            <button
              type="button"
              onClick={openZip}
              disabled={copying}
              data-testid="choose-zip"
              className={`${button} border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800`}
            >
              🗜 {words.chooseZip}
            </button>
          </div>
        )}

        {link && showLink && (
          <div className="flex w-full flex-col items-center gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <LinkForm
              initial={link.lastLink}
              onSubmit={link.onSubmit}
              onCancel={link.onCancel}
              copying={copying}
              disabled={readingFiles}
              error={linkError ? errorNote : null}
            />
          </div>
        )}

        {error && !reading && !linkError && errorNote}
      </section>

      <div className="flex w-full max-w-2xl flex-col gap-4 sm:flex-row sm:items-start">
        <section className="flex-1" aria-label={words.stepsTitle}>
          <h3 className="mb-2 text-xs font-black tracking-widest text-zinc-500 uppercase">
            {words.stepsTitle}
          </h3>
          <ol className="flex flex-col gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            {words.steps.map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-zinc-200 text-xs font-black dark:bg-zinc-800">
                  {i + 1}
                </span>
                <span>
                  <CodeText text={step} />
                </span>
              </li>
            ))}
          </ol>
        </section>
        {help !== undefined && (
          <div className="flex-1" data-testid="import-help-slot">
            {help}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Why the last import failed and what to do next (`describeImportError`), with "How do I fix
 * this?": it opens the page's "How do I import?" help, or (none on the page, e.g. over a
 * running preview) the guide's troubleshooting in a new tab.
 */
export function ImportErrorNote({
  title,
  hint,
  onDismiss,
  inPageHelp = false,
}: {
  title: string;
  hint: string;
  onDismiss: () => void;
  /** The page shows the "How do I import?" help (`ImportHelp`) next to this note. */
  inPageHelp?: boolean;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      data-testid="import-error"
      className="flex w-full items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-left text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100"
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold" data-testid="import-error-title">
          {title}
        </p>
        <p className="text-sm" data-testid="import-error-hint">
          <CodeText text={hint} />
        </p>
        {inPageHelp ? (
          <a
            href={`#${IMPORT_HELP_ID}`}
            data-testid="import-error-fix"
            onClick={(e) => {
              if (openImportHelp()) e.preventDefault();
            }}
            className={fixLink}
          >
            {t.importHelp.howToFix}
          </a>
        ) : (
          <a
            href={`${GUIDE_PATH}#troubleshooting`}
            target="_blank"
            rel="noopener"
            data-testid="import-error-fix"
            className={fixLink}
          >
            {t.importHelp.howToFix} <span aria-hidden="true">↗</span>
            <span className="sr-only"> {t.common.newTab}</span>
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-2 py-1 text-xs font-semibold hover:bg-red-100 dark:hover:bg-red-900"
      >
        {t.common.dismiss}
      </button>
    </div>
  );
}
