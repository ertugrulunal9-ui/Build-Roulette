'use client';

/**
 * What was imported, over the live preview (docs/09 §9.5): the site root ("dist", or "the
 * folder you dropped"), the number of files, the size and how many files were left out, and
 * "Import again" with the same two choices as the drop zone (a drop anywhere works too).
 * While an import is read, or after one failed, the bar says so; the running site stays.
 */
import { describeImportError } from '@br/site';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, rootLabel, type ImportedSite } from '../../lib/site/site';
import type { ImportState } from '../../lib/site/use-site-import';
import { IMPORT_COPY, filesText, skippedText } from './copy';
import { ImportErrorNote } from './DropZone';

export interface ImportBarProps {
  site: ImportedSite;
  state: ImportState;
  openFolder: () => void;
  openZip: () => void;
  onDismissError: () => void;
  /** Imports are closed: no "Import again". */
  disabled?: boolean;
}

const smallButton =
  'rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';

export function ImportBar({
  site,
  state,
  openFolder,
  openZip,
  onDismissError,
  disabled = false,
}: ImportBarProps) {
  const root = rootLabel(site.root);
  const error = state.status === 'error' ? describeImportError(state.error) : null;
  return (
    <div className="flex flex-col gap-2 border-b border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <p
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-zinc-700 dark:text-zinc-300"
          data-testid="import-summary"
          data-files={site.files}
          data-root={site.root}
        >
          <span aria-hidden="true">📦</span>
          <span className="font-semibold">{IMPORT_COPY.importedFrom}</span>
          {root ? (
            <code className="truncate rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">
              {root}
            </code>
          ) : (
            <span>{IMPORT_COPY.droppedFolder}</span>
          )}
          <span className="text-zinc-500">
            · {filesText(site.files)} · {formatBytes(site.bytes)}
            {site.skipped > 0 && ` · ${skippedText(site.skipped)}`}
          </span>
        </p>
        {state.status === 'reading' && (
          <span
            role="status"
            className="font-semibold text-sky-700 dark:text-sky-300"
            data-testid="import-reading"
          >
            {IMPORT_COPY.reading}
          </span>
        )}
        {!disabled && (
          <ImportAgain
            openFolder={openFolder}
            openZip={openZip}
            busy={state.status === 'reading'}
          />
        )}
      </div>
      {error && (
        <ImportErrorNote title={error.title} hint={error.hint} onDismiss={onDismissError} />
      )}
    </div>
  );
}

/** "Import again ▾" with the folder and .zip choices (Escape or a click outside closes it). */
function ImportAgain({
  openFolder,
  openZip,
  busy,
}: {
  openFolder: () => void;
  openZip: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        data-testid="import-again"
        onClick={() => {
          setOpen((o) => !o);
        }}
        className={smallButton}
      >
        {IMPORT_COPY.importAgain} ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 flex min-w-40 flex-col rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            data-testid="import-again-folder"
            onClick={choose(openFolder)}
            className="rounded px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            📁 {IMPORT_COPY.chooseFolder}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="import-again-zip"
            onClick={choose(openZip)}
            className="rounded px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            🗜 {IMPORT_COPY.chooseZip}
          </button>
        </div>
      )}
    </div>
  );
}
