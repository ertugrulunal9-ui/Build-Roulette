/**
 * The loading and "could not load" screens of the static shells (/battles/{id}, /u/{id}),
 * which read their data in the browser (T-037).
 */

export function LoadingView({ text, testId }: { text: string; testId: string }) {
  return (
    <main
      className="grid min-h-dvh place-items-center px-6 text-sm text-zinc-500"
      data-testid={testId}
      aria-busy="true"
    >
      {text}
    </main>
  );
}

export function LoadErrorView({
  text,
  testId,
  onRetry,
}: {
  text: string;
  testId: string;
  onRetry: () => void;
}) {
  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center"
      data-testid={testId}
    >
      <h1 className="text-2xl font-black">Could not load this page</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{text}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg bg-zinc-900 px-5 py-3 text-sm font-semibold text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Try again
      </button>
    </main>
  );
}
