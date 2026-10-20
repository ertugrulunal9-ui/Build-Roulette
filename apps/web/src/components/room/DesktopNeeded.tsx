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
import { useT } from '../../lib/i18n/context';
import type { BattleSnapshot } from '../../lib/solo/types';
import { Rich } from '../i18n/Rich';
import { GUIDE_PATH } from '../onboarding/copy';

export function DesktopNeeded({
  snapshot,
  onBuildHere,
}: {
  snapshot: BattleSnapshot;
  onBuildHere: () => void;
}) {
  const t = useT();
  const words = t.desktop;
  const mine = snapshot.builds.find((b) => b.builder_id === snapshot.me.user_id) ?? null;
  const shipped = mine?.status === 'shipped';
  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border-2 border-sky-300 bg-sky-50 p-4 text-sky-950 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-50"
      data-testid="desktop-needed"
      data-build-status={mine?.status ?? 'none'}
    >
      <h2 className="text-xl font-black tracking-tight">{words.title}</h2>
      {shipped ? (
        <p className="text-sm" data-testid="phone-battle-state">
          <Rich text={words.shipped} slots={{ name: mine.name ?? words.yourBuild }} />
        </p>
      ) : (
        <p className="text-sm" data-testid="phone-battle-state">
          <Rich text={words.notShipped} />
        </p>
      )}
      <p className="text-sm">
        <Rich text={words.watchVote} />
      </p>
      <p className="text-sm" data-testid="phone-guide">
        {t.phone.guideText}{' '}
        <a
          href={GUIDE_PATH}
          target="_blank"
          rel="noopener"
          className="font-semibold underline underline-offset-2"
        >
          {t.phone.guideLink}
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> {t.common.newTab}</span>
        </a>
      </p>
      {!shipped && <p className="text-xs opacity-80">{words.seat}</p>}
      {!shipped && (
        <div>
          <button
            type="button"
            data-testid="build-anyway"
            onClick={onBuildHere}
            className="min-h-11 rounded-xl border border-sky-400 px-4 py-2 text-sm font-semibold hover:bg-sky-100 dark:hover:bg-sky-900"
          >
            {words.buildAnyway}
          </button>
        </div>
      )}
    </section>
  );
}
