'use client';

/**
 * The big import target of the BUILD stage and `/try` before anything is imported (docs/09
 * §9.5): "Drop your built site here", the two pickers, what is going on (reading, or why the
 * last import failed and what to do), the three steps, and a slot for the "How do I import?"
 * help (T-049, onboarding).
 *
 * The drop itself is handled for the whole page (usePageDrop); this box only shows it.
 */
import { describeImportError } from '@br/site';
import type { ReactNode } from 'react';
import type { ImportState } from '../../lib/site/use-site-import';
import { CodeText } from './CodeText';
import { IMPORT_COPY } from './copy';

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
  /**
   * The "How do I import?" help, next to the steps. Filled by the onboarding (T-049); empty
   * until then.
   */
  help?: ReactNode;
}

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
}: DropZoneProps) {
  const reading = state.status === 'reading';
  const error = state.status === 'error' ? describeImportError(state.error) : null;
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-6 overflow-y-auto p-4 sm:p-8"
      data-testid="import-panel"
    >
      <section
        aria-label="Import your built site"
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
            {restoring && !reading ? IMPORT_COPY.restoring : IMPORT_COPY.dropTitle}
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            <CodeText text={IMPORT_COPY.dropSub} />
          </p>
        </div>

        {reading ? (
          <p
            role="status"
            className="text-sm font-semibold text-sky-700 dark:text-sky-300"
            data-testid="import-reading"
          >
            {IMPORT_COPY.reading}
          </p>
        ) : disabled ? (
          <p className="text-sm font-semibold text-zinc-500" data-testid="import-locked">
            {IMPORT_COPY.locked}
          </p>
        ) : (
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={openFolder}
              data-testid="choose-folder"
              className={`${button} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white`}
            >
              📁 {IMPORT_COPY.chooseFolder}
            </button>
            <button
              type="button"
              onClick={openZip}
              data-testid="choose-zip"
              className={`${button} border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800`}
            >
              🗜 {IMPORT_COPY.chooseZip}
            </button>
          </div>
        )}

        {error && !reading && (
          <ImportErrorNote title={error.title} hint={error.hint} onDismiss={onDismissError} />
        )}
      </section>

      <div className="flex w-full max-w-2xl flex-col gap-4 sm:flex-row sm:items-start">
        <section className="flex-1" aria-label={IMPORT_COPY.stepsTitle}>
          <h3 className="mb-2 text-xs font-black tracking-widest text-zinc-500 uppercase">
            {IMPORT_COPY.stepsTitle}
          </h3>
          <ol className="flex flex-col gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            {IMPORT_COPY.steps.map((step, i) => (
              <li key={step} className="flex gap-2">
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
        {/* T-049 fills this with the collapsible "How do I import?" help. */}
        {help !== undefined && (
          <div className="flex-1" data-testid="import-help-slot">
            {help}
          </div>
        )}
      </div>
    </div>
  );
}

/** Why the last import failed and what to do next (`describeImportError`). */
export function ImportErrorNote({
  title,
  hint,
  onDismiss,
}: {
  title: string;
  hint: string;
  onDismiss: () => void;
}) {
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
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-2 py-1 text-xs font-semibold hover:bg-red-100 dark:hover:bg-red-900"
      >
        {IMPORT_COPY.dismiss}
      </button>
    </div>
  );
}
