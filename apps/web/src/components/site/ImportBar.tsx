'use client';

/**
 * What was imported, over the live preview (docs/09 §9.5): the site root ("dist", "the
 * folder you dropped", or "Copied from my-app.lovable.app" for a link, docs/10), the number
 * of files, the size and how many files were left out, and "Import again" with the same
 * choices as the drop zone (a drop anywhere works too): a folder, a .zip, "Copy again from
 * <host>" (the last link, one click) and "Paste a link…" (a link row under the bar).
 * While an import is read or copied, or after one failed, the bar says so; the running site
 * stays.
 */
import { useEffect, useRef, useState } from 'react';
import { useI18n, useT } from '../../lib/i18n/context';
import { isLinkRoot, linkHost } from '../../lib/site/link-import';
import { formatBytes, rootLabel, type ImportedSite } from '../../lib/site/site';
import type { ImportState } from '../../lib/site/use-site-import';
import { ImportErrorNote, importErrorText, type LinkControls } from './DropZone';
import { LinkForm } from './LinkForm';

export interface ImportBarProps {
  site: ImportedSite;
  state: ImportState;
  openFolder: () => void;
  openZip: () => void;
  onDismissError: () => void;
  /** Imports are closed: no "Import again". */
  disabled?: boolean;
  /** The link import (docs/10); absent: folder and .zip only. */
  link?: LinkControls | null;
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
  link,
}: ImportBarProps) {
  const { locale, t } = useI18n();
  const words = t.importUi;
  const copiedHost = isLinkRoot(site.root) ? linkHost(site.root) : null;
  const root = copiedHost === null ? rootLabel(site.root) : null;
  const error = state.status === 'error' ? importErrorText(state, t) : null;
  const copying = state.status === 'reading' && state.via === 'link';
  // The link row belongs to the site it was opened over: a new import closes it.
  const [rowSite, setRowSite] = useState<ImportedSite | null>(null);
  const rowOpen = Boolean(link) && !disabled && rowSite === site;
  const again = link ? (link.lastLink ?? (copiedHost !== null ? site.root : null)) : null;
  const errorNote = error && (
    <ImportErrorNote title={error.title} hint={error.hint} onDismiss={onDismissError} />
  );
  const linkErrorInRow = rowOpen && state.status === 'error' && state.via === 'link';
  return (
    <div className="flex flex-col gap-2 border-b border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <p
          className="min-w-0 text-zinc-700 dark:text-zinc-300"
          data-testid="import-summary"
          data-files={site.files}
          data-root={site.root}
        >
          <span aria-hidden="true">{copiedHost !== null ? '🔗 ' : '📦 '}</span>
          <span className="font-semibold">
            {copiedHost !== null ? words.copiedFrom : words.importedFrom}
          </span>{' '}
          {copiedHost !== null ? (
            <code
              className="rounded bg-zinc-100 px-1 font-mono break-all dark:bg-zinc-800"
              data-testid="import-copied-from"
            >
              {copiedHost}
            </code>
          ) : root ? (
            <code className="rounded bg-zinc-100 px-1 font-mono break-all dark:bg-zinc-800">
              {root}
            </code>
          ) : (
            <span>{words.droppedFolder}</span>
          )}{' '}
          <span className="text-zinc-500">
            · {t.units.files(site.files)} · {formatBytes(site.bytes, locale)}
            {site.skipped > 0 && ` · ${words.skipped(site.skipped)}`}
          </span>
        </p>
        {state.status === 'reading' && !copying && (
          <span
            role="status"
            className="font-semibold text-sky-700 dark:text-sky-300"
            data-testid="import-reading"
          >
            {words.reading}
          </span>
        )}
        {copying && !rowOpen && (
          <span className="flex items-center gap-2">
            <span
              role="status"
              className="font-semibold text-sky-700 dark:text-sky-300"
              data-testid="link-copying"
            >
              {words.linkCopying}
            </span>
            <button
              type="button"
              onClick={link?.onCancel}
              data-testid="link-cancel"
              className={smallButton}
            >
              {words.linkCancel}
            </button>
          </span>
        )}
        {!disabled && (
          <ImportAgain
            openFolder={openFolder}
            openZip={openZip}
            busy={state.status === 'reading'}
            copyAgain={
              link && again !== null
                ? {
                    host: linkHost(again) ?? again,
                    run: () => {
                      link.onSubmit(again);
                    },
                  }
                : null
            }
            pasteLink={
              link
                ? () => {
                    setRowSite(site);
                  }
                : null
            }
          />
        )}
      </div>
      {link && rowOpen && (
        <div className="pb-1" data-testid="link-row">
          <LinkForm
            compact
            autoFocus
            initial={again}
            onSubmit={link.onSubmit}
            onCancel={link.onCancel}
            copying={copying}
            disabled={state.status === 'reading' && !copying}
            error={linkErrorInRow ? errorNote : null}
          />
        </div>
      )}
      {!linkErrorInRow && errorNote}
    </div>
  );
}

/**
 * "Import again ▾" with the folder and .zip choices, and with the link import "Copy again
 * from <host>" and "Paste a link…" (Escape or a click outside closes it).
 */
function ImportAgain({
  openFolder,
  openZip,
  busy,
  copyAgain,
  pasteLink,
}: {
  openFolder: () => void;
  openZip: () => void;
  busy: boolean;
  copyAgain: { host: string; run: () => void } | null;
  pasteLink: (() => void) | null;
}) {
  const words = useT().importUi;
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
        {words.importAgain} ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 flex w-max max-w-[calc(100vw-2rem)] min-w-40 flex-col rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            data-testid="import-again-folder"
            onClick={choose(openFolder)}
            className="rounded px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            📁 {words.chooseFolder}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="import-again-zip"
            onClick={choose(openZip)}
            className="rounded px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            🗜 {words.chooseZip}
          </button>
          {copyAgain && (
            <button
              type="button"
              role="menuitem"
              data-testid="import-again-link"
              onClick={choose(copyAgain.run)}
              className="rounded px-3 py-2 text-left text-sm [overflow-wrap:anywhere] hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              🔁 {words.copyAgainFrom(copyAgain.host)}
            </button>
          )}
          {pasteLink && (
            <button
              type="button"
              role="menuitem"
              data-testid="import-again-paste"
              onClick={choose(pasteLink)}
              className="rounded px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              🔗 {words.pasteLink}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
