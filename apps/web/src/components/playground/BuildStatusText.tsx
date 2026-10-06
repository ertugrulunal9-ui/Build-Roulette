import type { buildStatus } from '../../lib/playground/use-workspace-session';

/** "Built in 120 ms" / "Build failed · 2 problems" next to the editor. */
export function BuildStatusText({ status }: { status: ReturnType<typeof buildStatus> }) {
  return (
    <span
      data-testid="build-status"
      className={
        status.tone === 'error'
          ? 'text-red-600 dark:text-red-400'
          : status.tone === 'ok'
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-zinc-500'
      }
    >
      {status.text}
    </span>
  );
}
