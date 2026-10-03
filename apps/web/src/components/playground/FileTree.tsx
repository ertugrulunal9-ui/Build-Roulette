'use client';

import { LIMITS, basename, dirname, type WorkspaceUsage } from '@br/workspace';
import { useState, type KeyboardEvent, type ReactNode } from 'react';

interface FileTreeProps {
  paths: readonly string[];
  activePath: string;
  entry: string;
  usage: WorkspaceUsage;
  onOpen: (path: string) => void;
  /** Return an error message to keep the input open, or null on success. */
  onCreate: (path: string) => string | null;
  onRename: (from: string, to: string) => string | null;
  onDelete: (path: string) => string | null;
}

type Editing = { kind: 'create' } | { kind: 'rename'; path: string } | null;

/** Sorts files folder by folder (`src/a.ts` before `src/components/b.ts`). */
function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const da = dirname(a);
    const db = dirname(b);
    if (da !== db) return da < db ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function PathInput({
  initial,
  label,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
      }}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        // Select the base name without the extension, like editors do.
        const dot = e.target.value.lastIndexOf('.');
        const slash = e.target.value.lastIndexOf('/');
        e.target.setSelectionRange(slash + 1, dot > slash ? dot : e.target.value.length);
      }}
      className="w-full rounded border border-sky-500 bg-white px-1.5 py-0.5 font-mono text-xs outline-none dark:bg-zinc-900"
    />
  );
}

export function FileTree({
  paths,
  activePath,
  entry,
  usage,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: FileTreeProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const sorted = sortPaths(paths);
  const full = usage.files >= LIMITS.maxFiles;

  const submit = (fn: () => string | null) => {
    const err = fn();
    setError(err);
    if (err === null) setEditing(null);
  };

  const rows: ReactNode[] = [];
  let lastDir: string | null = null;
  for (const path of sorted) {
    const dir = dirname(path);
    const depth = dir === '' ? 0 : dir.split('/').length;
    if (dir !== lastDir && dir !== '') {
      rows.push(
        <li
          key={`dir:${dir}`}
          className="truncate px-2 pt-2 pb-0.5 font-mono text-[11px] text-zinc-500"
          style={{ paddingLeft: `${8 + (depth - 1) * 12}px` }}
        >
          {dir}/
        </li>,
      );
    }
    lastDir = dir;
    const active = path === activePath;
    if (editing?.kind === 'rename' && editing.path === path) {
      rows.push(
        <li key={path} className="px-2 py-0.5">
          <PathInput
            initial={path}
            label={`New path for ${path}`}
            onSubmit={(to) => {
              submit(() => onRename(path, to));
            }}
            onCancel={() => {
              setEditing(null);
              setError(null);
            }}
          />
        </li>,
      );
      continue;
    }
    rows.push(
      <li key={path} className="group relative" data-testid="file-item" data-path={path}>
        <button
          type="button"
          onClick={() => {
            onOpen(path);
          }}
          onDoubleClick={() => {
            setEditing({ kind: 'rename', path });
            setError(null);
          }}
          aria-current={active ? 'true' : undefined}
          title={path}
          className={`block w-full truncate py-1 pr-14 text-left font-mono text-xs ${
            active
              ? 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100'
              : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          {basename(path)}
          {path === entry && <span className="ml-1.5 text-[10px] text-zinc-500">entry</span>}
        </button>
        <span className="absolute top-0.5 right-1 flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            aria-label={`Rename ${path}`}
            title="Rename"
            onClick={() => {
              setEditing({ kind: 'rename', path });
              setError(null);
            }}
            className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
          >
            ✎
          </button>
          <button
            type="button"
            aria-label={`Delete ${path}`}
            title={path === entry ? 'The entry file cannot be deleted' : 'Delete'}
            disabled={path === entry}
            onClick={() => {
              if (window.confirm(`Delete ${path}?`)) setError(onDelete(path));
            }}
            className="rounded px-1 text-xs text-zinc-500 hover:bg-red-100 hover:text-red-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-red-950 dark:hover:text-red-300"
          >
            ✕
          </button>
        </span>
      </li>,
    );
  }

  const kb = (b: number) => Math.ceil(b / 1024);

  return (
    <nav aria-label="Files" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Files</span>
        <button
          type="button"
          onClick={() => {
            setEditing({ kind: 'create' });
            setError(null);
          }}
          disabled={full}
          title={full ? `The workspace is limited to ${LIMITS.maxFiles} files` : 'New file'}
          className="rounded px-1.5 text-sm text-zinc-600 hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          + New
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {editing?.kind === 'create' && (
          <li className="px-2 py-0.5">
            <PathInput
              initial="src/NewFile.tsx"
              label="New file path"
              onSubmit={(p) => {
                submit(() => onCreate(p));
              }}
              onCancel={() => {
                setEditing(null);
                setError(null);
              }}
            />
          </li>
        )}
        {rows}
      </ul>
      {error && (
        <p
          role="alert"
          className="border-t border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}
      <p
        className="border-t border-zinc-200 px-2 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800"
        data-testid="workspace-usage"
      >
        {usage.files}/{LIMITS.maxFiles} files · {kb(usage.bytes)}/{kb(LIMITS.maxTotalBytes)} KB
      </p>
    </nav>
  );
}
