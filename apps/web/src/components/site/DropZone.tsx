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
import { FileZipIcon } from '@phosphor-icons/react/dist/csr/FileZip';
import { FolderOpenIcon } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { HourglassIcon } from '@phosphor-icons/react/dist/csr/Hourglass';
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

const button = 'br-btn';

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
    <div className="br-drop-panel" data-testid="import-panel">
      <section
        aria-label={words.panelLabel}
        aria-busy={reading}
        data-testid="drop-zone"
        data-state={
          disabled ? 'disabled' : dragging ? 'dragging' : reading ? 'reading' : state.status
        }
        className={`br-drop-card${dragging ? ' is-dragging' : ''}${error ? ' has-error' : ''}`}
      >
        <span className="br-drop-icon" aria-hidden="true">
          {reading ? <HourglassIcon size={32} /> : <FolderOpenIcon size={36} />}
        </span>
        <div className="br-drop-card__heading">
          <h2 data-testid="drop-title">
            {restoring && !reading ? words.restoring : words.dropTitle}
          </h2>
          <p>
            <CodeText text={words.dropSub} />
          </p>
        </div>

        {readingFiles ? (
          <p role="status" className="br-import-reading" data-testid="import-reading">
            {words.reading}
          </p>
        ) : disabled ? (
          <p className="br-import-locked" data-testid="import-locked">
            {words.locked}
          </p>
        ) : (
          <div className="br-drop-actions">
            <button
              type="button"
              onClick={openFolder}
              disabled={copying}
              data-testid="choose-folder"
              className={`${button} br-btn--primary`}
            >
              <FolderOpenIcon size={18} aria-hidden="true" /> {words.chooseFolder}
            </button>
            <button
              type="button"
              onClick={openZip}
              disabled={copying}
              data-testid="choose-zip"
              className={`${button} br-btn--secondary`}
            >
              <FileZipIcon size={18} aria-hidden="true" /> {words.chooseZip}
            </button>
          </div>
        )}

        {link && showLink && (
          <div className="br-drop-link">
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

      <div className="br-drop-details">
        <section className="br-drop-steps" aria-label={words.stepsTitle}>
          <h3>{words.stepsTitle}</h3>
          <ol>
            {words.steps.map((step, i) => (
              <li key={i}>
                <span>{i + 1}</span>
                <span>
                  <CodeText text={step} />
                </span>
              </li>
            ))}
          </ol>
        </section>
        {help !== undefined && (
          <div className="br-drop-help" data-testid="import-help-slot">
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
    <div role="alert" data-testid="import-error" className="br-import-error">
      <div className="min-w-0 flex-1">
        <p className="font-bold" data-testid="import-error-title">
          {title}
        </p>
        <p className="br-import-error__hint" data-testid="import-error-hint">
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
