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
import { LinkSimpleIcon } from '@phosphor-icons/react/dist/csr/LinkSimple';
import { HourglassIcon } from '@phosphor-icons/react/dist/csr/Hourglass';
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

const control = 'br-link-control';

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
      className={`br-link-form${compact ? ' is-compact' : ''}`}
    >
      <label htmlFor={`${id}-url`} className="br-link-form__label">
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
          className={`br-link-input${error ? ' has-error' : ''} ${control}`}
        />
        <button
          type="submit"
          disabled={busy}
          data-testid="link-import"
          className={`br-btn br-btn--primary br-link-submit ${control}`}
        >
          <LinkSimpleIcon size={17} aria-hidden="true" /> {words.linkImport}
        </button>
      </div>
      {copying && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="br-import-reading" data-testid="link-copying">
            <HourglassIcon size={16} aria-hidden="true" /> {words.linkCopying}
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
