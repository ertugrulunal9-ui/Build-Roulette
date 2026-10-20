import { Fragment, type ReactNode } from 'react';

/**
 * A catalog sentence with a little markup (T-050), so each language can put the parts where
 * its grammar wants them:
 *
 * - `{slot}`: filled with `slots.slot`, a React node (a player's name, a time). Slot values are
 *   never parsed, so a name with `**` or backticks shows as typed.
 * - `**bold**` → `<strong>` (it may hold slots: `**{name}**`).
 * - `` `code` `` → `<code>`.
 *
 * The text is always rendered as text, never as HTML.
 */
export function Rich({
  text,
  slots = {},
  strongClass,
}: {
  text: string;
  slots?: Readonly<Record<string, ReactNode>>;
  /** Classes of the `**bold**` parts. */
  strongClass?: string;
}) {
  return <>{parse(text, slots, strongClass)}</>;
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\{\w+\})/g;

function parse(
  text: string,
  slots: Readonly<Record<string, ReactNode>>,
  strongClass: string | undefined,
): ReactNode[] {
  return text
    .split(TOKEN)
    .filter((part) => part !== '')
    .map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return (
          <strong key={i} className={strongClass}>
            {parse(part.slice(2, -2), slots, strongClass)}
          </strong>
        );
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code
            key={i}
            className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.9em] dark:bg-white/10"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      const slot = /^\{(\w+)\}$/.exec(part)?.[1];
      if (slot !== undefined && Object.prototype.hasOwnProperty.call(slots, slot)) {
        return <Fragment key={i}>{slots[slot]}</Fragment>;
      }
      return <Fragment key={i}>{part}</Fragment>;
    });
}
