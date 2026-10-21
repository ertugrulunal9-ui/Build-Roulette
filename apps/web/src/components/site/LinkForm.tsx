'use client';

/**
 * "…or paste the link of your published site" (docs/10 §10.1): a URL field and **Import**
 * (Enter submits), with the hosts it works for (the full list on demand). While the site is
 * copied the field and the button wait and "Copying your site…" has **Cancel**; a link error
 * shows right under the field (it describes the field: `aria-describedby`, `aria-invalid`).
 *
 * The link is checked and copied by `useSiteImport` (`fromLink`); this form only collects it.
 * Shared by the drop zone and the "Paste a link…" row of the import bar.
 */
import { IMPORT_URL_HOSTS } from '@br/site';
import { useId, useState, type ReactNode } from 'react';
import { useT } from '../../lib/i18n/context';

export interface LinkFormProps {
  /** The link starts as this (the last one imported here). */
  initial?: string | null;
  onSubmit: (link: string) => void;
  onCancel: () => void;
  /** A link is being copied. */
  copying: boolean;
  /** Another import is running, or imports are closed. */
  disabled?: boolean;
  /** Why the last link failed (an `ImportErrorNote`), shown under the field. */
  error?: ReactNode;
  autoFocus?: boolean;
  /** The bar's smaller version. */
  compact?: boolean;
}

const control =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50';

export function LinkForm({
  initial,
  onSubmit,
  onCancel,
  copying,
  disabled = false,
  error,
  autoFocus = false,
  compact = false,
}: LinkFormProps) {
  const words = useT().importUi;
  const id = useId();
  const [value, setValue] = useState(initial ?? '');
  const [hostsOpen, setHostsOpen] = useState(false);
  const busy = copying || disabled;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const hostsId = `${id}-hosts`;
  return (
    <form
      noValidate
      data-testid="link-form"
      data-state={copying ? 'copying' : error ? 'error' : 'idle'}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit(value);
      }}
      className={`flex w-full flex-col gap-2 text-left ${compact ? '' : 'max-w-xl'}`}
    >
      <label
        htmlFor={`${id}-url`}
        className={`font-semibold text-zinc-800 dark:text-zinc-200 ${compact ? 'text-xs' : 'text-sm'}`}
      >
        {words.linkLabel}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${id}-url`}
          type="url"
          name="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          autoCapitalize="none"
          autoFocus={autoFocus}
          placeholder={words.linkPlaceholder}
          value={value}
          onChange={(e) => {
            setValue(e.currentTarget.value);
          }}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${hintId}` : hintId}
          data-testid="link-input"
          className={`min-w-0 flex-1 basis-40 rounded-xl border border-zinc-300 bg-white px-3 font-mono text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 ${
            error ? 'border-red-400 dark:border-red-700' : ''
          } ${compact ? 'min-h-9 py-1.5 text-xs' : 'min-h-11 py-2 text-sm'} ${control}`}
        />
        <button
          type="submit"
          disabled={busy}
          data-testid="link-import"
          className={`shrink-0 rounded-xl bg-sky-600 font-bold text-white shadow-sm hover:bg-sky-500 dark:bg-sky-500 dark:text-sky-950 dark:hover:bg-sky-400 ${
            compact ? 'min-h-9 px-3 py-1.5 text-xs' : 'min-h-11 px-5 py-2.5 text-sm'
          } ${control}`}
        >
          🔗 {words.linkImport}
        </button>
      </div>
      {copying && (
        <div className="flex flex-wrap items-center gap-3">
          <p
            role="status"
            className="text-sm font-semibold text-sky-700 dark:text-sky-300"
            data-testid="link-copying"
          >
            <span aria-hidden="true">⏳ </span>
            {words.linkCopying}
          </p>
          <button
            type="button"
            onClick={onCancel}
            data-testid="link-cancel"
            className={`rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 ${control}`}
          >
            {words.linkCancel}
          </button>
        </div>
      )}
      {error && !copying && <div id={errorId}>{error}</div>}
      <div id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">
        <span>{words.linkHint}</span>{' '}
        <button
          type="button"
          aria-expanded={hostsOpen}
          aria-controls={hostsId}
          onClick={() => {
            setHostsOpen((o) => !o);
          }}
          data-testid="link-hosts-toggle"
          className={`rounded font-semibold text-zinc-700 underline underline-offset-2 dark:text-zinc-300 ${control}`}
        >
          {hostsOpen ? words.linkHostsHide : words.linkHostsShow}
        </button>
        <div id={hostsId} hidden={!hostsOpen} data-testid="link-hosts" className="mt-1.5">
          <p className="font-semibold">{words.linkHostsTitle}</p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {IMPORT_URL_HOSTS.map((h) => (
              <li key={h}>
                <code className="rounded bg-zinc-100 px-1 font-mono text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  *.{h}
                </code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </form>
  );
}
