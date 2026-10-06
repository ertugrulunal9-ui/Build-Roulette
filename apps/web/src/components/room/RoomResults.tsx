'use client';

/**
 * RESULTS → DESTROY for a room battle: every build ranked (rank, name, builder, time,
 * screenshot or its capture state, awards, auto-shipped / DNF badges), and the player's own
 * build in a reveal-mode preview for the last look, until DESTROY. Then the room goes back
 * to the lobby (RoomApp), where the host can start the rematch.
 */
import { isTerminalPhase } from '@br/game';
import { myBuild, type SoloState } from '../../lib/solo/controller';
import { CAPTURE_TEXT, formatCompletion, formatCountdown } from '../../lib/solo/format';
import type { BattleSnapshot, SnapshotBuild } from '../../lib/solo/types';
import { screenshotUrl } from '../../lib/supabase/config';
import { AwardBadges, ChallengeCards } from '../results/ResultPieces';
import { RevealPane } from '../solo/RevealPane';

interface RoomResultsProps {
  state: SoloState;
  remaining: number | null;
}

const MEDALS = ['🥇', '🥈', '🥉'];

const STATUS_BADGE: Partial<Record<SnapshotBuild['status'], { text: string; tone: string }>> = {
  auto_shipped: {
    text: 'Auto-shipped',
    tone: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  dnf: { text: 'DNF', tone: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  disqualified: {
    text: 'Disqualified',
    tone: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  },
};

export function RoomResults({ state, remaining }: RoomResultsProps) {
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('RoomResults needs a snapshot');
  const destroyed = isTerminalPhase(snapshot.battle.phase);
  const mine = myBuild(snapshot);
  const isPlayer = snapshot.me.is_player;
  const shipped = mine?.status === 'shipped' || mine?.status === 'auto_shipped';
  const pendingCaptures = snapshot.builds.some(
    (b) =>
      (b.status === 'shipped' || b.status === 'auto_shipped') && b.capture_status === 'pending',
  );

  const caption = destroyed
    ? state.destroy === 'animating'
      ? 'Destroying every build…'
      : 'Builds destroyed'
    : remaining !== null && remaining > 0
      ? `Last look · ${isPlayer ? 'your build self-destructs' : 'the builds self-destruct'} in ${formatCountdown(remaining)}`
      : pendingCaptures
        ? 'Last look · destroying as soon as the screenshots are done…'
        : 'Last look · destroying…';

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8"
      data-testid="results"
    >
      <header className="flex flex-col gap-3">
        <p className="text-sm font-semibold tracking-widest text-zinc-500 uppercase">
          {destroyed ? 'Destroy build' : 'Results'}
        </p>
        <h1 className="text-4xl font-black tracking-tight">{snapshot.challenge.build.text}</h1>
        <ChallengeCards challenge={snapshot.challenge} compact />
      </header>

      <div
        className={`grid gap-6 ${isPlayer ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]' : ''}`}
      >
        <section className="flex flex-col gap-3" aria-label="Ranking">
          <RankedBuilds snapshot={snapshot} />
          {!isPlayer && (
            <p className="text-sm text-zinc-500" data-testid="last-look">
              {caption}
            </p>
          )}
        </section>
        {isPlayer && (
          <section className="flex flex-col gap-3">
            <RevealPane
              build={state.reveal.build}
              status={state.reveal.status}
              destroy={state.destroy}
              caption={caption}
            />
            {mine && !shipped && (
              <p className="text-sm text-zinc-500">
                {mine.status === 'disqualified'
                  ? 'Your build was disqualified.'
                  : 'You did not ship this time. There is always the rematch.'}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function RankedBuilds({ snapshot }: { snapshot: BattleSnapshot }) {
  const builds = [...snapshot.builds].sort((a, b) => {
    const ra = a.final_rank ?? Number.POSITIVE_INFINITY;
    const rb = b.final_rank ?? Number.POSITIVE_INFINITY;
    return ra - rb;
  });
  const nameOf = (id: string) =>
    snapshot.players.find((p) => p.user_id === id)?.display_name ?? 'Someone';
  return (
    <ol className="flex flex-col gap-3">
      {builds.map((b) => {
        const shipped = b.status === 'shipped' || b.status === 'auto_shipped';
        const isMe = b.builder_id === snapshot.me.user_id;
        const badge = STATUS_BADGE[b.status];
        const hasShot =
          shipped &&
          b.screenshot_path !== null &&
          (b.capture_status === 'captured' || b.capture_status === 'fallback');
        return (
          <li
            key={b.id}
            data-testid="ranked-build"
            data-rank={b.final_rank ?? ''}
            data-status={b.status}
            data-builder={b.builder_id}
            data-capture={shipped ? b.capture_status : 'none'}
            className={`flex gap-4 rounded-2xl border bg-white p-3 shadow-sm dark:bg-zinc-900 ${
              isMe ? 'border-sky-400 dark:border-sky-700' : 'border-zinc-200 dark:border-zinc-800'
            }`}
          >
            <div className="flex w-10 shrink-0 flex-col items-center justify-center text-center">
              <span className="text-2xl" aria-hidden="true">
                {b.final_rank !== null ? (MEDALS[b.final_rank - 1] ?? '🏅') : '·'}
              </span>
              <span className="font-mono text-xs font-bold text-zinc-500">
                {b.final_rank !== null ? `#${String(b.final_rank)}` : '–'}
              </span>
            </div>
            <div className="relative aspect-[16/10] w-36 shrink-0 overflow-hidden rounded-lg bg-zinc-100 sm:w-48 dark:bg-zinc-800">
              {hasShot && b.screenshot_path ? (
                // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
                <img
                  src={screenshotUrl(b.screenshot_path)}
                  alt={`Screenshot of ${b.name ?? 'the build'}`}
                  data-testid="build-screenshot"
                  className="absolute inset-0 h-full w-full object-cover object-top"
                />
              ) : (
                <p className="absolute inset-0 grid place-items-center p-2 text-center text-[11px] text-zinc-500">
                  {shipped ? CAPTURE_TEXT[b.capture_status] : 'Nothing shipped'}
                </p>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="truncate text-lg font-black" data-testid="ranked-build-name">
                {b.name ?? (b.status === 'dnf' ? 'Did not finish' : 'Untitled')}
              </p>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                by <strong>{nameOf(b.builder_id)}</strong>
                {isMe && ' (you)'}
                {shipped && b.completion_ms !== null && (
                  <>
                    {' '}
                    ·{' '}
                    <span className="font-mono font-bold" data-testid="ranked-build-time">
                      {formatCompletion(b.completion_ms)}
                    </span>
                  </>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {badge && (
                  <span
                    data-testid="status-badge"
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badge.tone}`}
                  >
                    {badge.text}
                  </span>
                )}
                <AwardBadges awards={snapshot.awards.filter((a) => a.build_id === b.id)} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
