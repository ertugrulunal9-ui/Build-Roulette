'use client';

/**
 * A roster player on a phone (or a tablet) during SPIN / BUILD / SHIP. Mobile is reveal and
 * vote only in v1 (docs/02 R7): the editor needs a keyboard and a bigger screen. So the
 * phone shows the spectator view (the countdown and everyone's progress) with this notice
 * and the player's battle state:
 *
 * - **No hand-over to a computer:** a player is an anonymous user per browser, so the same
 *   room opened on a computer is a *different* player (a spectator once the battle runs).
 *   Account linking (planned, docs/06 M6) is what would let one person move devices.
 * - **What happens:** nothing is built or autosaved on the phone (the editor never mounts,
 *   so the battle's autosave loop has no workspace), so the server has nothing to auto-ship:
 *   at the deadline the build is DNF. A build already shipped stays shipped.
 * - **What the phone is good for:** watching the reveal and voting (a DNF player still
 *   votes: `is_voter` does not depend on the build).
 * - **Escape hatch:** "Build on this device anyway" (a tablet with a keyboard can).
 */
import type { BattleSnapshot } from '../../lib/solo/types';

export function DesktopNeeded({
  snapshot,
  onBuildHere,
}: {
  snapshot: BattleSnapshot;
  onBuildHere: () => void;
}) {
  const mine = snapshot.builds.find((b) => b.builder_id === snapshot.me.user_id) ?? null;
  const shipped = mine?.status === 'shipped';
  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border-2 border-sky-300 bg-sky-50 p-4 text-sky-950 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-50"
      data-testid="desktop-needed"
      data-build-status={mine?.status ?? 'none'}
    >
      <h2 className="text-xl font-black tracking-tight">💻 Building needs a desktop browser</h2>
      {shipped ? (
        <p className="text-sm" data-testid="phone-battle-state">
          You shipped <strong>“{mine.name ?? 'your build'}”</strong>. It is locked in: watch the
          others build here, then the reveal and the vote.
        </p>
      ) : (
        <p className="text-sm" data-testid="phone-battle-state">
          You are a <strong>player</strong> in this battle, but the editor needs a keyboard and a
          bigger screen, so this phone does not build or autosave anything. Unless you build and
          ship here, your build ends as <strong>DNF</strong> (did not finish) at the deadline.
        </p>
      )}
      <p className="text-sm">
        You still <strong>watch the reveal and vote</strong> from this phone, like everyone else.
      </p>
      {!shipped && (
        <p className="text-xs opacity-80">
          Opening the room on a computer does not move your seat there: each browser is its own
          anonymous player, and a battle that already started only takes spectators.
        </p>
      )}
      {!shipped && (
        <div>
          <button
            type="button"
            data-testid="build-anyway"
            onClick={onBuildHere}
            className="min-h-11 rounded-xl border border-sky-400 px-4 py-2 text-sm font-semibold hover:bg-sky-100 dark:hover:bg-sky-900"
          >
            Build on this device anyway
          </button>
        </div>
      )}
    </section>
  );
}
