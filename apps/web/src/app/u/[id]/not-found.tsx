import Link from 'next/link';

/** /u/[id] for an unknown id, or a player without a finished battle (the same answer). */
export default function PlayerNotFound() {
  return (
    <main
      className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-5 px-6 py-16 text-center"
      data-testid="player-not-found"
    >
      <p className="text-6xl" aria-hidden="true">
        🔍
      </p>
      <h1 className="text-3xl font-black tracking-tight">No battles to show</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        This player has no finished battle yet, or the link is wrong. Battles show up here once
        their results are in.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white hover:bg-emerald-700"
      >
        Play a battle
      </Link>
    </main>
  );
}
