'use client';

/**
 * The live preview of an imported site (PreviewController owns the iframe in `hostRef`), with
 * what the site reported in a small collapsible panel underneath: **Problems** (its runtime
 * errors, and files that failed to load) and its **Console**. Two things show over the
 * preview itself: a site the sandbox could not serve at all (site-errors.ts), and a watchdog
 * crash, with Restart.
 */
import { useState, type ReactNode, type RefObject } from 'react';
import type { ConsoleEntry, PreviewSnapshot } from '../../lib/preview/preview-controller';
import { isSiteLoadFailure } from '../../lib/preview/site-errors';
import { IMPORT_COPY } from './copy';

interface PreviewPaneProps {
  hostRef: RefObject<HTMLDivElement | null>;
  snapshot: PreviewSnapshot;
  shellUrl: string;
  onRestart: () => void;
  onDismissErrors: () => void;
  onClearConsole: () => void;
  /** Drawn over the preview (e.g. the drop zone before the first import, "Time's up"). */
  children?: ReactNode;
  /** Hide the Problems / Console panel (nothing imported yet). */
  hidePanel?: boolean;
}

const LEVEL_CLASS: Record<ConsoleEntry['level'], string> = {
  log: '',
  debug: 'text-zinc-500',
  info: 'text-sky-700 dark:text-sky-300',
  warn: 'bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  error: 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200',
};

export function PreviewPane({
  hostRef,
  snapshot,
  shellUrl,
  onRestart,
  onDismissErrors,
  onClearConsole,
  children,
  hidePanel = false,
}: PreviewPaneProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'problems' | 'console'>('problems');
  const crashed = snapshot.preview === 'crashed';
  const errors = snapshot.runtimeErrors;
  const loadFailure = errors.findLast(isSiteLoadFailure);

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium ${
      active
        ? 'border-b-2 border-sky-500 text-zinc-900 dark:text-zinc-100'
        : 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1 bg-white" data-testid="preview">
        {/* The PreviewController owns this element's children (the preview iframe). */}
        <div ref={hostRef} className="absolute inset-0" data-testid="preview-host" />

        {loadFailure && !crashed && (
          <div
            role="alert"
            data-testid="error-overlay"
            className="absolute inset-x-0 bottom-0 max-h-[70%] overflow-auto border-t-4 border-red-500 bg-red-50/95 p-4 text-red-900 shadow-lg dark:bg-red-950/95 dark:text-red-100"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wide uppercase">
                  Your site could not be loaded
                </p>
                <p
                  className="mt-1 font-mono text-sm break-words whitespace-pre-wrap"
                  data-testid="error-message"
                >
                  {loadFailure.message}
                </p>
              </div>
              <button
                type="button"
                onClick={onDismissErrors}
                className="shrink-0 rounded px-2 py-1 text-xs hover:bg-red-100 dark:hover:bg-red-900"
              >
                {IMPORT_COPY.dismiss}
              </button>
            </div>
          </div>
        )}

        {crashed && (
          <div
            role="alert"
            data-testid="preview-crashed"
            data-reason={snapshot.crash?.reason}
            data-silent-ms={snapshot.crash ? Math.round(snapshot.crash.silentForMs) : undefined}
            data-phase={snapshot.crash?.phase}
            className="absolute inset-0 grid place-items-center bg-zinc-100 p-6 text-center dark:bg-zinc-900"
          >
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="text-base font-semibold">
                {snapshot.crash?.reason === 'handshake-timeout'
                  ? 'The preview could not start'
                  : 'The preview crashed'}
              </p>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {snapshot.crash?.reason === 'handshake-timeout' ? (
                  <>
                    The sandbox shell at <code className="break-all">{shellUrl}</code> did not
                    answer. Check your connection, then restart the preview.
                  </>
                ) : snapshot.crash?.phase === 'loading' ? (
                  // The watchdog allows a slow start (up to 15 s, T-027) before it gives up.
                  <>
                    Your site didn’t finish starting: it stopped responding for{' '}
                    {Math.round(snapshot.crash.silentForMs / 1000)} s while it loaded, probably an
                    infinite loop in code that runs at startup. Fix it, build again and import it,
                    or restart the preview.
                  </>
                ) : (
                  <>
                    Your site stopped responding for{' '}
                    {Math.round((snapshot.crash?.silentForMs ?? 0) / 1000)} s, probably an infinite
                    loop. Fix it, build again and import it, or restart the preview.
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={onRestart}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Restart preview
              </button>
            </div>
          </div>
        )}
        {children}
      </div>

      {!hidePanel && (
        <div
          className="flex shrink-0 flex-col border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          data-testid="problems-panel"
          data-open={open ? 'true' : 'false'}
        >
          <div className="flex items-center">
            <button
              type="button"
              aria-expanded={open}
              aria-controls="preview-problems"
              data-testid="problems-toggle"
              onClick={() => {
                setOpen((o) => !o);
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
              <span>
                {IMPORT_COPY.problems}
                {errors.length > 0 && (
                  <span className="ml-1 text-red-600 dark:text-red-400" data-testid="problem-count">
                    ({errors.length})
                  </span>
                )}
              </span>
              <span className="text-zinc-400">·</span>
              <span>
                {IMPORT_COPY.console}
                {snapshot.console.length > 0 && ` (${String(snapshot.console.length)})`}
              </span>
            </button>
          </div>
          {open && (
            <div id="preview-problems" className="flex h-44 min-h-0 flex-col">
              <div
                role="tablist"
                className="flex items-center border-y border-zinc-200 dark:border-zinc-800"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'problems'}
                  onClick={() => {
                    setTab('problems');
                  }}
                  className={tabClass(tab === 'problems')}
                >
                  {IMPORT_COPY.problems}
                  {errors.length > 0 && ` (${String(errors.length)})`}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'console'}
                  onClick={() => {
                    setTab('console');
                  }}
                  className={tabClass(tab === 'console')}
                >
                  {IMPORT_COPY.console}
                  {snapshot.console.length > 0 && ` (${String(snapshot.console.length)})`}
                </button>
                <button
                  type="button"
                  onClick={tab === 'console' ? onClearConsole : onDismissErrors}
                  className="ml-auto px-3 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                >
                  {IMPORT_COPY.clear}
                </button>
              </div>
              {tab === 'problems' ? (
                <ol
                  role="tabpanel"
                  aria-label={IMPORT_COPY.problems}
                  data-testid="problems"
                  className="min-h-0 flex-1 overflow-y-auto font-mono text-xs"
                >
                  {errors.length === 0 && (
                    <li className="px-3 py-2 font-sans text-zinc-500">{IMPORT_COPY.noProblems}</li>
                  )}
                  {errors.map((e, i) => (
                    <li
                      key={i}
                      data-kind={e.kind ?? 'error'}
                      className="border-b border-zinc-100 bg-red-50 px-3 py-1 break-words whitespace-pre-wrap text-red-800 dark:border-zinc-900 dark:bg-red-950/60 dark:text-red-200"
                    >
                      {e.message}
                    </li>
                  ))}
                </ol>
              ) : (
                <ol
                  role="tabpanel"
                  aria-label={IMPORT_COPY.console}
                  data-testid="console"
                  className="min-h-0 flex-1 overflow-y-auto font-mono text-xs"
                >
                  {snapshot.console.length === 0 && (
                    <li className="px-3 py-2 font-sans text-zinc-500">
                      {IMPORT_COPY.consoleEmpty}
                    </li>
                  )}
                  {snapshot.console.map((entry) => (
                    <li
                      key={entry.id}
                      data-level={entry.level}
                      className={`border-b border-zinc-100 px-3 py-1 break-words whitespace-pre-wrap dark:border-zinc-900 ${LEVEL_CLASS[entry.level]}`}
                    >
                      {entry.text}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
