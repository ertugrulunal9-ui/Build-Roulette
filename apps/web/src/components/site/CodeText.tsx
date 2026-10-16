import { Fragment } from 'react';

/**
 * Plain text whose backtick spans are code: "run `npm run build`" renders the command in a
 * `<code>`. The text is always rendered as text (never as HTML).
 */
export function CodeText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.9em] dark:bg-white/10"
          >
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
