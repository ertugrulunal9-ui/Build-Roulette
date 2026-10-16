'use client';

import { isPackageStall } from '@br/protocol';
import type { Diagnostic } from '@br/runtime';
import { useState, type RefObject } from 'react';
import type { ConsoleEntry, SandboxSnapshot } from '../../lib/playground/sandbox';

interface PreviewPaneProps {
  hostRef: RefObject<HTMLDivElement | null>;
  snapshot: SandboxSnapshot;
  shellUrl: string;
  onRestart: () => void;
  /** Starts the bundler again after it failed to start (T-039). */
  onRetryBundler: () => void;
  onDismissErrors: () => void;
  onClearConsole: () => void;
  onOpenDiagnostic: (d: Diagnostic) => void;
}

const LEVEL_CLASS: Record<ConsoleEntry['level'], string> = {
  log: '',
  debug: 'text-zinc-500',
  info: 'text-sky-700 dark:text-sky-300',
  warn: 'bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  error: 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200',
};

function location(d: Diagnostic): string {
  if (d.file === undefined) return '';
  return `${d.file}${d.line !== undefined ? `:${String(d.line)}:${String((d.column ?? 0) + 1)}` : ''}`;
}

export function PreviewPane({
  hostRef,
  snapshot,
  shellUrl,
  onRestart,
  onRetryBundler,
  onDismissErrors,
  onClearConsole,
  onOpenDiagnostic,
}: PreviewPaneProps) {
  const [tab, setTab] = useState<'console' | 'problems'>('console');
  const diagnostics = snapshot.lastBuild?.diagnostics ?? [];
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const latestError = snapshot.runtimeErrors.at(-1);
  const crashed = snapshot.preview === 'crashed';

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium ${
      active
        ? 'border-b-2 border-sky-500 text-zinc-900 dark:text-zinc-100'
        : 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(9rem,35%)]">
      <div className="relative min-h-0 bg-white" data-testid="preview">
        {/* The SandboxController owns this element's children (the preview iframe). */}
        <div ref={hostRef} className="absolute inset-0" data-testid="preview-host" />

        {snapshot.bundler === 'booting' && (
          <div className="absolute inset-0 grid place-items-center bg-white text-sm text-zinc-500 dark:bg-zinc-950">
            Starting the bundler…
          </div>
        )}
        {snapshot.bundler === 'failed' && (
          <div
            role="alert"
            data-testid="bundler-failed"
            className="absolute inset-0 grid place-items-center bg-white p-6 text-center dark:bg-zinc-950"
          >
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p
                className="text-sm font-semibold break-words text-red-700 dark:text-red-300"
                data-testid="bundler-error"
              >
                {snapshot.bundlerError ?? "Couldn't start the bundler."}
              </p>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Your code is saved in this browser. Check your connection, then retry.
              </p>
              <button
                type="button"
                onClick={onRetryBundler}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {latestError && !crashed && (
          <div
            role="alert"
            data-testid="error-overlay"
            className="absolute inset-x-0 bottom-0 max-h-[70%] overflow-auto border-t-4 border-red-500 bg-red-50/95 p-4 text-red-900 shadow-lg dark:bg-red-950/95 dark:text-red-100"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wide uppercase">
                  {latestError.kind === 'module-load'
                    ? isPackageStall(latestError.message)
                      ? 'The build is still loading'
                      : 'The build failed to load'
                    : latestError.kind === 'unhandledrejection'
                      ? 'Unhandled promise rejection'
                      : 'Runtime error'}
                  {snapshot.runtimeErrors.length > 1 &&
                    ` (${String(snapshot.runtimeErrors.length)})`}
                </p>
                <p
                  className="mt-1 font-mono text-sm break-words whitespace-pre-wrap"
                  data-testid="error-message"
                >
                  {latestError.message}
                </p>
                {latestError.stack !== undefined && (
                  <pre className="mt-2 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap opacity-80">
                    {latestError.stack}
                  </pre>
                )}
              </div>
              <button
                type="button"
                onClick={onDismissErrors}
                className="shrink-0 rounded px-2 py-1 text-xs hover:bg-red-100 dark:hover:bg-red-900"
              >
                Dismiss
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
                    answer. Is <code>pnpm --filter @br/web dev:sandbox</code> running?
                  </>
                ) : snapshot.crash?.phase === 'loading' ? (
                  // The watchdog allows a slow start (up to 15 s, T-027) before it gives up.
                  <>
                    Your build didn’t finish starting: it stopped responding for{' '}
                    {Math.round(snapshot.crash.silentForMs / 1000)} s while it loaded, probably an
                    infinite loop in code that runs at startup. Fix the code, then restart the
                    preview.
                  </>
                ) : (
                  <>
                    Your build stopped responding for{' '}
                    {Math.round((snapshot.crash?.silentForMs ?? 0) / 1000)} s, probably an infinite
                    loop. Fix the code, then restart the preview.
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
      </div>

      <div className="flex min-h-0 flex-col border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div
          role="tablist"
          className="flex items-center border-b border-zinc-200 dark:border-zinc-800"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'console'}
            onClick={() => {
              setTab('console');
            }}
            className={tabClass(tab === 'console')}
          >
            Console{snapshot.console.length > 0 && ` (${String(snapshot.console.length)})`}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'problems'}
            onClick={() => {
              setTab('problems');
            }}
            className={tabClass(tab === 'problems')}
          >
            Problems{diagnostics.length > 0 && ` (${String(diagnostics.length)})`}
            {errorCount > 0 && (
              <span className="ml-1 inline-block size-1.5 rounded-full bg-red-500 align-middle" />
            )}
          </button>
          {tab === 'console' && (
            <button
              type="button"
              onClick={onClearConsole}
              className="ml-auto px-3 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Clear
            </button>
          )}
        </div>
        {tab === 'console' ? (
          <ol
            role="tabpanel"
            aria-label="Console"
            data-testid="console"
            className="min-h-0 flex-1 overflow-y-auto font-mono text-xs"
          >
            {snapshot.console.length === 0 && (
              <li className="px-3 py-2 text-zinc-500">
                Console output from your build shows up here.
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
        ) : (
          <ol
            role="tabpanel"
            aria-label="Problems"
            data-testid="problems"
            className="min-h-0 flex-1 overflow-y-auto text-xs"
          >
            {diagnostics.length === 0 && <li className="px-3 py-2 text-zinc-500">No problems.</li>}
            {diagnostics.map((d, i) => (
              <li key={i} className="border-b border-zinc-100 dark:border-zinc-900">
                <button
                  type="button"
                  disabled={d.file === undefined}
                  onClick={() => {
                    onOpenDiagnostic(d);
                  }}
                  className="flex w-full gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 disabled:cursor-default dark:hover:bg-zinc-900"
                >
                  <span
                    className={
                      d.severity === 'error'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }
                  >
                    {d.severity === 'error' ? '●' : '▲'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="break-words">{d.text}</span>
                    {d.file !== undefined && (
                      <span className="ml-2 font-mono text-zinc-500">{location(d)}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
