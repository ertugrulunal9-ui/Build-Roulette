/**
 * "How do I import?" (T-049, docs/09 §9.6): a collapsible help next to the drop zone of the
 * BUILD stage and `/try` (DropZone's `help` slot), closed by default: the key steps, where
 * the build ends up, a tip for web builders and the full guide (new tab, so a running battle
 * is not left). An import error's "How do I fix this?" opens it (`openImportHelp`).
 */
import { CodeText } from '../site/CodeText';
import { GUIDE_PATH, IMPORT_HELP_COPY, NEW_TAB } from './copy';

/** The `<details>` element's id (one drop zone per page). */
export const IMPORT_HELP_ID = 'import-help';

/**
 * Opens the help on this page and moves focus to it. False when the page has none (the bar
 * over a running preview): the caller then follows its link to the guide.
 */
export function openImportHelp(doc: Document = document): boolean {
  const el = doc.getElementById(IMPORT_HELP_ID);
  if (!(el instanceof HTMLDetailsElement)) return false;
  el.open = true;
  const summary = el.querySelector('summary');
  summary?.focus();
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  return true;
}

export function ImportHelp() {
  return (
    <details
      id={IMPORT_HELP_ID}
      data-testid="import-help"
      className="group rounded-xl border border-zinc-200 bg-white text-left text-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 py-2 font-bold focus-visible:outline-2 focus-visible:outline-sky-500 [&::-webkit-details-marker]:hidden">
        <span>
          <span aria-hidden="true">🛟 </span>
          {IMPORT_HELP_COPY.summary}
        </span>
        <span
          aria-hidden="true"
          className="text-zinc-400 transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-zinc-200 px-3 py-3 text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          {IMPORT_HELP_COPY.steps.map((s) => (
            <li key={s}>
              <CodeText text={s} />
            </li>
          ))}
        </ol>
        <div>
          <p className="font-semibold text-zinc-900 dark:text-zinc-100">
            {IMPORT_HELP_COPY.whereTitle}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5" data-testid="import-help-where">
            {IMPORT_HELP_COPY.where.map((w) => (
              <li key={w}>
                <CodeText text={w} />
              </li>
            ))}
          </ul>
        </div>
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-amber-950 dark:bg-amber-950/50 dark:text-amber-100">
          <span className="font-semibold">{IMPORT_HELP_COPY.webBuildersTitle}</span>{' '}
          <CodeText text={IMPORT_HELP_COPY.webBuilders} />
        </p>
        <a
          href={GUIDE_PATH}
          target="_blank"
          rel="noopener"
          data-testid="import-help-guide"
          className="font-semibold underline underline-offset-2"
        >
          {IMPORT_HELP_COPY.guide} <span aria-hidden="true">↗</span>
          <span className="sr-only"> {NEW_TAB}</span>
        </a>
      </div>
    </details>
  );
}
