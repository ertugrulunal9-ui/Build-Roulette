/**
 * How a build taken down by a moderator looks (T-024): no name, no screenshot, this label
 * instead. Server and client components both use it (no 'use client').
 */

/** The label of a build whose name and screenshot a moderator removed (T-024). */
export const REMOVED_TEXT = 'Removed by moderators';

/** The image slot of a removed build. */
export function RemovedCard({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-testid="removed-build"
      className="absolute inset-0 grid place-items-center bg-zinc-200 p-2 text-center dark:bg-zinc-800"
    >
      <p
        className={`${compact ? 'text-[11px]' : 'text-sm'} font-semibold text-zinc-600 dark:text-zinc-300`}
      >
        <span aria-hidden="true">🚫 </span>
        {REMOVED_TEXT}
      </p>
    </div>
  );
}
