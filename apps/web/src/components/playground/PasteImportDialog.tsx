'use client';

import {
  describePasteWarning,
  describeWorkspaceError,
  importFiles,
  parsePasteImport,
  type ImportMode,
  type Workspace,
} from '@br/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';

interface PasteImportDialogProps {
  open: boolean;
  workspace: Workspace;
  onClose: () => void;
  /** `mode: 'replace'` means `next` is a whole new project (see `WorkspaceSession.replace`). */
  onImport: (next: Workspace, importedPaths: string[], mode: ImportMode) => void;
}

const PLACEHOLDER = `Paste a multi-file answer from an AI chat, for example:

**src/App.tsx**
\`\`\`tsx
export function App() { ... }
\`\`\`

or files separated by markers:

// file: src/App.tsx
...
/* file: src/styles.css */
...`;

export function PasteImportDialog({ open, workspace, onClose, onImport }: PasteImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ImportMode>('merge');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const parsed = useMemo(
    () => parsePasteImport(text, { existingFiles: workspace.files }),
    [text, workspace.files],
  );
  const count = parsed.parsed.length;
  const outcome = useMemo(
    () => (count > 0 ? importFiles(workspace, parsed.files, mode) : null),
    [count, workspace, parsed.files, mode],
  );

  const submit = () => {
    if (!outcome?.ok) return;
    onImport(
      outcome.workspace,
      parsed.parsed.map((p) => p.path),
      mode,
    );
    setText('');
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="paste-import-title"
      className="m-auto w-[min(56rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <form
        method="dialog"
        className="flex max-h-[85dvh] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 id="paste-import-title" className="text-base font-semibold">
            Paste import
          </h2>
          <p className="text-sm text-zinc-500">
            Turn one pasted blob into files. File names come from <code>{'// file: path'}</code>{' '}
            markers or from the line above each code block.
          </p>
        </header>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <textarea
            aria-label="Pasted text"
            data-testid="paste-input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            className="h-80 w-full resize-y rounded-lg border border-zinc-300 bg-zinc-50 p-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <section aria-label="Parsed files" className="flex min-w-0 flex-col gap-3 text-sm">
            <h3 className="font-medium">
              {count === 0 ? 'No files found yet' : `${count} file${count === 1 ? '' : 's'} found`}
            </h3>
            {count > 0 && (
              <ul className="flex flex-col gap-1" data-testid="paste-parsed">
                {parsed.parsed.map((f) => {
                  const exists = Object.prototype.hasOwnProperty.call(workspace.files, f.path);
                  return (
                    <li key={f.path} className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-mono text-xs" title={f.path}>
                        {f.path}
                        {f.remappedFrom !== undefined && (
                          <span className="text-zinc-500"> (from {f.remappedFrom})</span>
                        )}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 text-[11px] ${
                          exists
                            ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
                            : 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                        }`}
                      >
                        {exists ? 'replace' : 'new'} · {f.lines} lines
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {parsed.warnings.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs text-amber-800 dark:text-amber-300">
                {parsed.warnings.map((w, i) => (
                  <li key={i}>{describePasteWarning(w)}</li>
                ))}
              </ul>
            )}
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">Existing files</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="paste-mode"
                  checked={mode === 'merge'}
                  onChange={() => {
                    setMode('merge');
                  }}
                />
                Keep them, replace files with the same name
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="paste-mode"
                  checked={mode === 'replace'}
                  onChange={() => {
                    setMode('replace');
                  }}
                />
                Delete them, keep only the pasted files
              </label>
            </fieldset>
            {outcome && !outcome.ok && (
              <ul
                role="alert"
                className="flex flex-col gap-1 text-xs text-red-700 dark:text-red-300"
              >
                {outcome.errors.map((e, i) => (
                  <li key={i}>{describeWorkspaceError(e)}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!outcome?.ok}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {count > 0 ? `Import ${count} file${count === 1 ? '' : 's'}` : 'Import'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
