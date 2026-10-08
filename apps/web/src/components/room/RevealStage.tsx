'use client';

/**
 * REVEAL: the room watches the final builds one at a time, on the server's timeline
 * (docs/04 §4.11). Everyone (players and spectators) sees the same spotlight: the build at
 * `reveal_index`, "Build k of n", its name, its builder and the slot's countdown.
 *
 * - **One live build:** only the spotlighted build runs, in a fresh preview iframe in
 *   **reveal** mode (no popups, modals or clipboard; docs/03 §3.9), whose sandbox storage is
 *   wiped before the bundle loads. A new spotlight is a new iframe.
 * - **Chrome:** the frame is labelled as a user-made build; nothing inside it can act for
 *   the app (shell messages are display-only).
 * - **Skip / stopped:** "Skip this build" lives outside the iframe, so it works even when
 *   the build hangs; it stops the build in this tab only and shows its screenshot (or
 *   thumbnail). The watchdog's crash states show the same fallback: "this build froze" (no
 *   pong for 5 s) or "this build couldn't start" (the sandbox never answered), and so does a
 *   build whose packages can't load while the package CDN is down (T-032).
 * - **Phones and tablets** (touch-primary, `useTouchPrimary`): each build shows its
 *   screenshot or thumbnail first, with a big "Tap to run live" button (docs/02 R2: mobile
 *   browsers isolate cross-site frames less, so running someone's build is the viewer's
 *   choice, one tap away). The host's buttons sit in a bar fixed to the bottom of the
 *   screen there, so they are always in reach.
 * - **Host:** "Next build" and "Skip to vote" (compare-and-set on the battle version; a
 *   stale click does nothing). They follow the crown when the host changes.
 * - **Strip:** every build in reveal order; revealed ones with their thumbnail.
 * - **Report** (T-024): next to Skip, for other players' builds; the dialog also offers
 *   "hide it for me" (= Skip). A build a moderator removed shows "Removed by moderators"
 *   and never runs (the server skips its slot; this covers the moment before the next
 *   phase event arrives).
 */
import { PreviewHandle, type PreviewBuild, type PreviewCrash } from '@br/runtime';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTouchPrimary } from '../../lib/device';
import { playgroundConfig } from '../../lib/playground/config';
import type { PreviewHealth } from '../../lib/telemetry/sandbox-health';
import {
  spotlightBuild,
  type RevealVoteController,
  type RevealVoteState,
} from '../../lib/room/reveal-vote';
import type { SoloController, SoloState } from '../../lib/solo/controller';
import { describeError } from '../../lib/solo/errors';
import type { BattleSnapshot, RevealBuild, SnapshotBuild } from '../../lib/solo/types';
import { screenshotUrl } from '../../lib/supabase/config';
import { REMOVED_TEXT, RemovedCard } from '../moderation/Removed';
import { ReportButton } from '../moderation/ReportButton';
import { ChallengeCards } from '../results/ResultPieces';
import { Countdown } from '../solo/Countdown';
import { Avatar } from './pieces';

/** Reveal slots and the vote are short: amber only in their last 15 s. */
export const SHORT_PHASE_LOW_MS = 15_000;

/**
 * The still image of a build: the capture worker's screenshot once it is in, otherwise the
 * client thumbnail taken at ship time (an object URL), otherwise nothing.
 */
export function buildImage(build: SnapshotBuild | undefined, thumb: string | null): string | null {
  const captured = build?.capture_status === 'captured' || build?.capture_status === 'fallback';
  if (captured && build.screenshot_path) return screenshotUrl(build.screenshot_path);
  return thumb;
}

/** What the spotlight shows in this tab. */
export type SpotlightView =
  | 'removed'
  | 'skipped'
  | 'frozen'
  | 'no_start'
  | 'no_packages'
  | 'still'
  | 'live'
  | 'loading'
  | 'unavailable';

/**
 * The spotlight's content for this viewer: a build removed by a moderator never runs; then
 * a local stop (skip, freeze, failed start) wins; then a touch device shows the still image
 * until the viewer taps "run live"; then the bundle's state decides.
 */
export function spotlightView(
  showState: RevealVoteState,
  buildId: string | null,
  {
    stillFirst,
    tapped,
    removed = false,
  }: { stillFirst: boolean; tapped: readonly string[]; removed?: boolean },
): SpotlightView {
  if (buildId === null) return 'loading';
  if (removed) return 'removed';
  if (showState.skipped.includes(buildId)) return 'skipped';
  if (showState.frozen.includes(buildId)) return 'frozen';
  if (showState.failedToStart.includes(buildId)) return 'no_start';
  if (showState.noPackages.includes(buildId)) return 'no_packages';
  if (stillFirst && !tapped.includes(buildId)) return 'still';
  const bundle = showState.bundles[buildId];
  if (bundle?.status === 'ready') return 'live';
  if (bundle?.status === 'missing' || bundle?.status === 'error') return 'unavailable';
  return 'loading';
}

/** Why this tab stopped running the spotlight (each shows the still image instead). */
export type StoppedView = 'skipped' | 'frozen' | 'no_start' | 'no_packages';

export function isStopped(view: SpotlightView): view is StoppedView {
  return view === 'skipped' || view === 'frozen' || view === 'no_start' || view === 'no_packages';
}

/** The fallback of a build this tab stopped running, by why it stopped. */
export const STOPPED: Record<StoppedView, { testId: string; text: string }> = {
  skipped: {
    testId: 'build-skipped',
    text: 'You skipped this build. It keeps going for everyone else.',
  },
  frozen: {
    testId: 'build-froze',
    text: 'This build froze, so it was stopped on your screen. Everyone else keeps watching.',
  },
  no_start: {
    testId: 'build-no-start',
    text: 'This build couldn’t start on your screen (its sandbox never answered). Everyone else keeps watching.',
  },
  // T-032: with the package CDN down, a package this browser never loaded can't load.
  no_packages: {
    testId: 'build-no-packages',
    text: 'This build’s packages couldn’t load on your screen (the package server isn’t answering), so here is its screenshot. Everyone else keeps watching.',
  },
};

interface RevealStageProps {
  battle: SoloController;
  battleState: SoloState;
  show: RevealVoteController;
  showState: RevealVoteState;
  code: string;
  headerActions: ReactNode;
}

export function RevealStage({
  battle,
  battleState,
  show,
  showState,
  code,
  headerActions,
}: RevealStageProps) {
  const snapshot = battleState.snapshot;
  if (!snapshot) throw new Error('RevealStage needs a snapshot');
  const order = snapshot.battle.reveal_order ?? [];
  const index = snapshot.battle.reveal_index ?? 0;
  const buildId = order[index] ?? null;
  const total = order.length;
  const spot = spotlightBuild(snapshot, showState.builds);
  const fallback = buildId ? snapshot.builds.find((b) => b.id === buildId) : undefined;
  const builderId = spot?.builder_id ?? fallback?.builder_id ?? '';
  const builderName =
    spot?.builder_name ??
    snapshot.players.find((p) => p.user_id === builderId)?.display_name ??
    'Someone';
  const removed = spot?.taken_down === true || fallback?.taken_down === true;
  // An auto-shipped autosave has no name.
  const name = removed ? REMOVED_TEXT : (spot?.name ?? fallback?.name ?? `${builderName}'s build`);
  const autoShipped = (spot?.status ?? fallback?.status) === 'auto_shipped';
  const mine = builderId === snapshot.me.user_id;
  const bundle = buildId ? showState.bundles[buildId] : undefined;
  const stillFirst = useTouchPrimary();
  // Builds this viewer chose to run live (a touch device starts each one as a still image).
  const [tapped, setTapped] = useState<readonly string[]>([]);
  const view = spotlightView(showState, buildId, { stillFirst, tapped, removed });
  const stopped = isStopped(view);
  const image = buildImage(fallback, buildId ? (showState.thumbs[buildId] ?? null) : null);
  const isHost = snapshot.me.is_host === true;
  const hostName = snapshot.players.find(
    (p) => p.user_id === snapshot.battle.host_id,
  )?.display_name;

  return (
    <main
      className={`flex min-h-dvh flex-col bg-zinc-950 text-zinc-100 ${isHost ? 'pb-40 lg:pb-0' : ''}`}
      data-testid="reveal-stage"
      data-index={index}
      data-build={buildId ?? ''}
      data-view={view}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-bold tracking-tight">
          Build Roulette <span className="font-normal text-zinc-400">· Room {code}</span>
        </h1>
        <span className="rounded-full bg-fuchsia-600 px-2.5 py-0.5 text-xs font-black tracking-widest text-white uppercase">
          🎬 Reveal
        </span>
        {!snapshot.me.is_player && (
          <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-black tracking-widest text-zinc-300 uppercase">
            👀 Spectating
          </span>
        )}
        {headerActions}
        <div className="ml-auto rounded-lg ring-1 ring-zinc-700">
          <Countdown
            getRemaining={() => battle.remainingMs()}
            label="This build"
            lowMs={SHORT_PHASE_LOW_MS}
          />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-5 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="flex min-w-0 flex-col gap-3" aria-label="Spotlight">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <p
                className="text-xs font-black tracking-[0.3em] text-fuchsia-400 uppercase"
                data-testid="reveal-position"
              >
                Build {index + 1} of {total}
              </p>
              <h2
                className="truncate text-3xl font-black tracking-tight sm:text-4xl"
                data-testid="reveal-title"
              >
                {name}
              </h2>
              <p
                className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-400"
                data-testid="reveal-builder"
              >
                {builderId && <Avatar userId={builderId} name={builderName} size="sm" />}
                by <strong className="text-zinc-100">{builderName}</strong>
                {mine && <span className="text-fuchsia-300">(that is you!)</span>}
                {autoShipped && (
                  <span
                    className="rounded-full bg-amber-900/70 px-2 py-0.5 text-xs font-bold text-amber-200"
                    title="Not shipped by hand: the last autosave shipped at the deadline"
                  >
                    Auto-shipped
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* The user-made build, in its labelled chrome. */}
          <div className="flex min-h-[20rem] flex-1 flex-col overflow-hidden rounded-2xl border-2 border-dashed border-amber-400/70 bg-zinc-900 shadow-2xl sm:min-h-[26rem]">
            <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs">
              <span
                className="font-black tracking-widest text-amber-300 uppercase"
                data-testid="user-build-label"
              >
                ⚠ User-made build
              </span>
              <span className="hidden text-amber-100/80 sm:inline">
                by {builderName} · runs in a sandbox, cannot see your account. Nothing in it can act
                for Build Roulette.
              </span>
              <div className="ml-auto flex gap-2">
                {buildId && !mine && !removed && (
                  <ReportButton
                    buildId={buildId}
                    buildLabel={`${(spot?.name ?? fallback?.name) ? `“${name}”` : 'A build'} by ${builderName}`}
                    tone="dark"
                    onHide={
                      stopped
                        ? undefined
                        : () => {
                            show.skip(buildId);
                          }
                    }
                  />
                )}
                {view === 'removed' ? null : stopped ? (
                  <button
                    type="button"
                    data-testid="watch-build"
                    onClick={() => {
                      if (buildId) show.watch(buildId);
                    }}
                    className="min-h-9 rounded-md border border-amber-300/60 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-400/20"
                  >
                    ▶ Run it again
                  </button>
                ) : view === 'still' ? (
                  <span className="py-1 font-semibold text-amber-100/80" data-testid="still-label">
                    Screenshot · not running
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid="skip-build"
                    disabled={!buildId}
                    onClick={() => {
                      if (buildId) show.skip(buildId);
                    }}
                    title="Stop running this build on your screen (the room keeps going)"
                    className="min-h-9 rounded-md bg-amber-300 px-2.5 py-1 font-bold text-amber-950 hover:bg-amber-200"
                  >
                    ⏭ Skip this build
                  </button>
                )}
              </div>
            </div>
            <div className="relative min-h-0 flex-1 bg-white">
              {view === 'removed' ? (
                <RemovedCard />
              ) : isStopped(view) ? (
                <StillImage
                  image={image}
                  name={name}
                  testId={STOPPED[view].testId}
                  message={STOPPED[view].text}
                />
              ) : view === 'still' ? (
                <StillImage image={image} name={name} testId="reveal-still" dim={false}>
                  <button
                    type="button"
                    data-testid="tap-to-run"
                    onClick={() => {
                      if (buildId) setTapped((t) => (t.includes(buildId) ? t : [...t, buildId]));
                    }}
                    className="absolute inset-x-4 bottom-4 min-h-14 rounded-2xl bg-fuchsia-500 px-5 py-3 text-lg font-black text-white shadow-xl hover:bg-fuchsia-400 sm:inset-x-auto sm:right-4"
                  >
                    ▶ Tap to run live
                  </button>
                </StillImage>
              ) : view === 'live' && bundle?.status === 'ready' && buildId ? (
                <LiveBuild
                  key={buildId}
                  buildId={buildId}
                  build={bundle.build}
                  title={`${name} by ${builderName} (user-made build)`}
                  health={show.previewHealth}
                  onCrash={(id, crash) => {
                    show.previewCrashed(id, crash);
                  }}
                  onPackagesFailed={(id) => {
                    show.packagesFailed(id);
                  }}
                />
              ) : view === 'unavailable' ? (
                <StillImage
                  image={image}
                  name={name}
                  testId="build-unavailable"
                  message={
                    bundle?.status === 'error'
                      ? `This build could not be loaded. ${describeError(bundle.error)}`
                      : 'This build has nothing to run.'
                  }
                />
              ) : (
                <p
                  className="absolute inset-0 grid place-items-center bg-zinc-900 text-sm text-zinc-400"
                  data-testid="build-loading"
                >
                  {showState.buildsError
                    ? `Loading the builds… (${describeError(showState.buildsError)})`
                    : 'Loading the build…'}
                </p>
              )}
            </div>
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <HostPanel
            isHost={isHost}
            hostName={hostName ?? 'The host'}
            last={index >= total - 1}
            show={show}
            showState={showState}
          />
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-2 text-xs font-black tracking-widest text-zinc-400 uppercase">
              The challenge
            </h2>
            <ChallengeCards challenge={snapshot.challenge} compact stacked />
          </section>
          <p className="text-xs text-zinc-500">
            Watch closely: when the reveal ends, every player votes for the best build in four
            categories (never their own).
          </p>
        </aside>
      </div>

      <RevealStrip snapshot={snapshot} showState={showState} index={index} />
    </main>
  );
}

// ─── The live build ───────────────────────────────────────────────────────────────────

/**
 * One fresh preview per build (the parent keys it by build id): a new iframe in reveal
 * mode, the sandbox origin's storage wiped first, then the bundle. Unmounting disposes it,
 * which removes the iframe and stops everything the build runs. Its watchdog stats count
 * for the battle's preview health (T-031) while it runs.
 */
function LiveBuild({
  buildId,
  build,
  title,
  health,
  onCrash,
  onPackagesFailed,
}: {
  buildId: string;
  build: PreviewBuild;
  title: string;
  health: PreviewHealth;
  /** The watchdog stopped the build: it froze, or it never started. */
  onCrash: (buildId: string, crash: PreviewCrash) => void;
  /** Its code or packages could not load (the shell's `module-load` error, T-032). */
  onPackagesFailed: (buildId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onCrashRef = useRef(onCrash);
  const onPackagesFailedRef = useRef(onPackagesFailed);
  const titleRef = useRef(title);
  const healthRef = useRef(health);
  useEffect(() => {
    onCrashRef.current = onCrash;
    onPackagesFailedRef.current = onPackagesFailed;
    titleRef.current = title;
    healthRef.current = health;
  }, [onCrash, onPackagesFailed, title, health]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const iframe = host.ownerDocument.createElement('iframe');
    iframe.title = titleRef.current;
    iframe.dataset['testid'] = 'reveal-live-frame';
    iframe.dataset['build'] = buildId;
    iframe.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    host.replaceChildren(iframe);
    const preview = new PreviewHandle(iframe, {
      shellUrl: playgroundConfig.shellUrl,
      mode: 'reveal',
    });
    const stopFollowing = healthRef.current.follow(preview);
    const offCrash = preview.on('crash', (crash) => {
      onCrashRef.current(buildId, crash);
    });
    // A package that can't load (or still hasn't after 8 s) while the package CDN is down:
    // the screenshot is more use to the room than a blank frame (T-032).
    const offError = preview.on('error', (m) => {
      if (m.kind === 'module-load') onPackagesFailedRef.current(buildId);
    });
    // Wipe what an earlier build left on the sandbox origin, in a fresh iframe; the load
    // waits for the new shell, which handles the wipe first.
    void preview.resetStorage(10_000).catch(() => undefined);
    preview.load(build, 'reveal');
    return () => {
      offCrash();
      offError();
      preview.dispose();
      stopFollowing();
    };
    // A new build (or bundle) is a new preview; a new title alone is not.
  }, [buildId, build]);

  return <div ref={hostRef} className="absolute inset-0" data-testid="reveal-live" />;
}

/** The build's still image (or a placeholder card), with an optional message or button. */
function StillImage({
  image,
  name,
  message,
  testId,
  dim = true,
  children,
}: {
  image: string | null;
  name: string;
  message?: string;
  testId: string;
  /** Dimmed behind a message (a stopped build); full strength for the touch still view. */
  dim?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="absolute inset-0 bg-zinc-900" data-testid={testId}>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a Storage URL or an object URL
        <img
          src={image}
          alt={`Screenshot of ${name}`}
          className={`absolute inset-0 h-full w-full object-contain ${dim ? 'opacity-60' : ''}`}
          data-testid="fallback-thumb"
        />
      ) : (
        <PlaceholderCard name={name} />
      )}
      {message && (
        <p className="absolute inset-x-4 bottom-4 rounded-xl bg-black/80 px-4 py-3 text-center text-sm font-semibold text-white">
          {message}
        </p>
      )}
      {children}
    </div>
  );
}

export function PlaceholderCard({ name }: { name: string }) {
  return (
    <div
      className="absolute inset-0 grid place-items-center bg-gradient-to-br from-fuchsia-900 via-zinc-900 to-sky-900 p-4 text-center"
      data-testid="placeholder-card"
    >
      <div>
        <p className="text-3xl" aria-hidden="true">
          🎰
        </p>
        <p className="mt-1 line-clamp-2 text-sm font-black text-white">{name}</p>
      </div>
    </div>
  );
}

// ─── Host controls ────────────────────────────────────────────────────────────────────

function HostPanel({
  isHost,
  hostName,
  last,
  show,
  showState,
}: {
  isHost: boolean;
  hostName: string;
  last: boolean;
  show: RevealVoteController;
  showState: RevealVoteState;
}) {
  if (!isHost) {
    return (
      <p
        className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400"
        data-testid="reveal-host-note"
      >
        👑 <strong className="text-zinc-200">{hostName}</strong> can move to the next build or skip
        to the vote. Otherwise each build gets its full slot.
      </p>
    );
  }
  const pending = showState.host.pending;
  // Below `lg` the panel is a bar fixed to the bottom of the screen (always in reach on a
  // phone); the page leaves room for it (RevealStage's bottom padding).
  return (
    <section
      className="fixed inset-x-0 bottom-0 z-20 flex flex-col gap-2 border-t border-fuchsia-700 bg-zinc-950/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:static lg:rounded-2xl lg:border lg:bg-fuchsia-950/40 lg:p-4"
      data-testid="reveal-host-controls"
    >
      <h2 className="text-xs font-black tracking-widest text-fuchsia-300 uppercase">
        👑 You host the reveal
      </h2>
      <div className="flex gap-2 lg:flex-col">
        <button
          type="button"
          data-testid="reveal-next"
          disabled={pending !== null}
          onClick={() => {
            void show.next();
          }}
          className="min-h-12 flex-1 rounded-xl bg-fuchsia-500 px-4 py-3 font-black text-white hover:bg-fuchsia-400 disabled:opacity-50"
        >
          {pending === 'next' ? 'Moving on…' : last ? 'Next: start the vote ▶' : 'Next build ▶'}
        </button>
        <button
          type="button"
          data-testid="skip-to-vote"
          disabled={pending !== null}
          onClick={() => {
            void show.skipToVote();
          }}
          className="min-h-12 flex-1 rounded-xl border border-fuchsia-400/60 px-4 py-2 text-sm font-bold text-fuchsia-100 hover:bg-fuchsia-900/60 disabled:opacity-50"
        >
          {pending === 'skip' ? 'Skipping…' : '⏭ Skip to the vote'}
        </button>
      </div>
      {showState.host.error && (
        <p role="alert" className="text-xs text-red-300" data-testid="host-error">
          {describeError(showState.host.error)}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              show.dismissHostError();
            }}
          >
            OK
          </button>
        </p>
      )}
    </section>
  );
}

// ─── The strip ────────────────────────────────────────────────────────────────────────

function RevealStrip({
  snapshot,
  showState,
  index,
}: {
  snapshot: BattleSnapshot;
  showState: RevealVoteState;
  index: number;
}) {
  const order = snapshot.battle.reveal_order ?? [];
  const byId = new Map<string, RevealBuild>((showState.builds ?? []).map((b) => [b.build_id, b]));
  return (
    <nav
      aria-label="Every build of the reveal"
      className="border-t border-zinc-800 bg-zinc-900/60 px-4 py-3"
    >
      <ol className="mx-auto flex max-w-7xl gap-3 overflow-x-auto" data-testid="reveal-strip">
        {order.map((id, i) => {
          const b = byId.get(id);
          const state = i < index ? 'revealed' : i === index ? 'current' : 'upcoming';
          const image = buildImage(
            snapshot.builds.find((x) => x.id === id),
            showState.thumbs[id] ?? null,
          );
          const removed =
            b?.taken_down === true || snapshot.builds.find((x) => x.id === id)?.taken_down === true;
          const label = removed
            ? REMOVED_TEXT
            : (b?.name ?? `${b?.builder_name ?? 'Someone'}'s build`);
          return (
            <li
              key={id}
              data-testid="reveal-strip-item"
              data-build={id}
              data-state={state}
              aria-current={state === 'current' ? 'true' : undefined}
              className={`w-32 shrink-0 overflow-hidden rounded-xl border-2 sm:w-40 ${
                state === 'current'
                  ? 'border-fuchsia-500 shadow-[0_0_0_3px_rgba(217,70,239,0.3)]'
                  : 'border-zinc-800'
              } ${state === 'upcoming' ? 'opacity-60' : ''}`}
            >
              <div className="relative aspect-[16/10] bg-zinc-800">
                {removed ? (
                  <RemovedCard compact />
                ) : state === 'upcoming' ? (
                  <p className="absolute inset-0 grid place-items-center text-2xl font-black text-zinc-500">
                    ?
                  </p>
                ) : image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a Storage URL or an object URL
                  <img
                    src={image}
                    alt={`Thumbnail of ${label}`}
                    className="absolute inset-0 h-full w-full object-cover object-top"
                    data-testid="strip-thumb"
                  />
                ) : (
                  <PlaceholderCard name={label} />
                )}
              </div>
              <p className="truncate px-2 py-1 text-xs font-semibold">
                <span className="text-zinc-500">{i + 1}.</span>{' '}
                {state === 'upcoming' ? 'Coming up' : label}
                {state !== 'upcoming' && b && (
                  <span className="text-zinc-500"> · {b.builder_name}</span>
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
