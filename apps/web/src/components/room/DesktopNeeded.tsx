'use client';

/**
 * A roster player on a phone (or a tablet) during SPIN / BUILD / SHIP. Building happens on a
 * computer (docs/09): the player builds the site with their own AI tools, runs its build and
 * imports the built folder here. A phone has neither, so it shows the spectator view (the
 * countdown and everyone's progress) with this notice and the player's battle state:
 *
 * - **No hand-over to a computer:** a player is an anonymous user per browser, so the same
 *   room opened on a computer is a *different* player (a spectator once the battle runs).
 *   Account linking (planned) is what would let one person move devices.
 * - **What happens:** nothing is imported or autosaved on the phone, so the server has
 *   nothing to auto-ship: at the deadline the build is DNF. A build already shipped stays
 *   shipped.
 * - **What the phone is good for:** watching the reveal and voting (a DNF player still
 *   votes: `is_voter` does not depend on the build).
 * - **Escape hatch:** "Import on this device anyway" (a tablet that has the built site, e.g.
 *   as a .zip in its files, can).
 * - **Next time:** a link to the guide (`/how-it-works`, a new tab: the battle keeps running).
 */
import type { BattleSnapshot } from '../../lib/solo/types';
import { GUIDE_PATH, NEW_TAB, PHONE_COPY } from '../onboarding/copy';

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
      <h2 className="text-xl font-black tracking-tight">💻 Building needs a computer</h2>
      {shipped ? (
        <p className="text-sm" data-testid="phone-battle-state">
          You shipped <strong>“{mine.name ?? 'your build'}”</strong>. It is locked in: watch the
          others build here, then the reveal and the vote.
        </p>
      ) : (
        <p className="text-sm" data-testid="phone-battle-state">
          You are a <strong>player</strong> in this battle, but you build on a computer: with your
          own AI tool, then you import the built site. This phone does not import or autosave
          anything, so unless you import and ship here, your build ends as <strong>DNF</strong> (did
          not finish) at the deadline.
        </p>
      )}
      <p className="text-sm">
        You still <strong>watch the reveal and vote</strong> from this phone, like everyone else.
      </p>
      <p className="text-sm" data-testid="phone-guide">
        {PHONE_COPY.guideText}{' '}
        <a
          href={GUIDE_PATH}
          target="_blank"
          rel="noopener"
          className="font-semibold underline underline-offset-2"
        >
          {PHONE_COPY.guideLink}
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> {NEW_TAB}</span>
        </a>
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
            Import on this device anyway
          </button>
        </div>
      )}
    </section>
  );
}
