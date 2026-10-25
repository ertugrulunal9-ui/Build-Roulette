'use client';

/**
 * RESULTS → DESTROY. Left: the permanent result (screenshot from the capture worker, the
 * completion time, the auto-awards, the challenge). Right: the last look at the live build
 * until DESTROY, then the destroy moment, and links to the permanent page and a new game.
 */
import { useI18n } from '../../lib/i18n/context';
import { myBuild, type SoloController, type SoloState } from '../../lib/solo/controller';
import { awardsOf, formatCompletion, formatCountdown } from '../../lib/solo/format';
import { statsPhrases } from '../../lib/solo/stats';
import { screenshotUrl } from '../../lib/supabase/config';
import { Rich } from '../i18n/Rich';
import { AwardBadges, ChallengeCards } from '../results/ResultPieces';
import { AppHeader } from '../ui/AppHeader';
import { PhaseTrack } from '../ui/PhaseTrack';
import { RevealPane } from './RevealPane';
import './solo-screens.css';

interface ResultsStageProps {
  controller: SoloController;
  state: SoloState;
  remaining: number | null;
}

export function ResultsStage({ controller, state, remaining }: ResultsStageProps) {
  const { locale, t } = useI18n();
  const r = t.results;
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error('ResultsStage needs a snapshot');
  const battle = snapshot.battle;
  const mine = myBuild(snapshot);
  // None once a moderator removed the build (T-028).
  const awards = mine ? awardsOf(snapshot.awards, mine) : [];
  const name = snapshot.players.find((p) => p.user_id === mine?.builder_id)?.display_name ?? '';
  const shipped = mine?.status === 'shipped' || mine?.status === 'auto_shipped';
  const destroyed = battle.phase === 'destroyed' || battle.phase === 'abandoned';
  const capture = mine?.capture_status ?? 'pending';

  const caption = destroyed
    ? state.destroy === 'animating'
      ? r.destroying
      : r.destroyed
    : remaining !== null && remaining > 0
      ? r.lastLookIn(formatCountdown(remaining))
      : capture === 'pending' && shipped
        ? r.lastLookCapture
        : r.lastLookDestroying;
  const stats = statsPhrases(mine?.stats, t, locale);
  const statusText = <span data-testid="build-status-text">{t.status[mine?.status ?? 'dnf']}</span>;

  return (
    <main className="br-page br-results-page" data-testid="results">
      <AppHeader context={destroyed ? r.eyebrowDestroy : r.eyebrowResults} />
      <div className="br-results-content">
        <PhaseTrack phase={battle.phase} />
        <header className="br-results-heading">
          <div>
            <p className="br-eyebrow">{destroyed ? r.eyebrowDestroy : r.eyebrowResults}</p>
            <h1 className="br-display" data-testid="result-title">
              {mine?.name ?? (mine?.status === 'dnf' ? t.common.didNotFinish : r.yourBuild)}
            </h1>
            <p className="br-results-byline">
              {mine?.completion_ms !== null && mine?.completion_ms !== undefined && shipped ? (
                <Rich
                  text={r.byStatusTime}
                  slots={{
                    name,
                    status: statusText,
                    time: (
                      <span className="br-results-time" data-testid="completion-time">
                        {formatCompletion(mine.completion_ms)}
                      </span>
                    ),
                  }}
                />
              ) : (
                <Rich text={r.byStatus} slots={{ name, status: statusText }} />
              )}
            </p>
          </div>
          <AwardBadges awards={awards} />
        </header>

        <div className="br-results-grid">
          <section className="br-results-left">
            <figure className="br-results-screenshot">
              <div className="br-results-screenshot__frame">
                {shipped &&
                mine.screenshot_path &&
                (capture === 'captured' || capture === 'fallback') ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
                  <img
                    src={screenshotUrl(mine.screenshot_path)}
                    alt={t.common.screenshotOf(mine.name ?? t.common.theBuild)}
                    data-testid="screenshot"
                    data-capture={capture}
                    className="br-results-screenshot__image"
                  />
                ) : (
                  <p
                    className="br-results-screenshot__placeholder"
                    data-testid="screenshot-placeholder"
                    data-capture={shipped ? capture : 'none'}
                  >
                    {shipped ? t.capture[capture] : r.noShot}
                  </p>
                )}
              </div>
              <figcaption>{shipped ? t.capture[capture] : t.common.didNotFinish}</figcaption>
            </figure>
            <ChallengeCards challenge={snapshot.challenge} />
            {stats.length > 0 && (
              <p className="br-results-stats" data-testid="build-stats">
                {stats.join(' · ')}
              </p>
            )}
          </section>

          <section className="br-results-right">
            <RevealPane
              battleId={battle.id}
              build={state.reveal.build}
              status={state.reveal.status}
              destroy={state.destroy}
              caption={caption}
            />
            {state.destroy === 'done' && (
              <div className="br-results-actions-card">
                <p data-testid="source-status">
                  {state.sourceDestroyed ? r.sourceDeleted : r.sourceDeleting}
                </p>
                <div className="br-results-actions">
                  <a
                    href={`/battles/${battle.id}`}
                    data-testid="permanent-link"
                    className="br-btn br-btn--primary"
                  >
                    {r.permanent}
                  </a>
                  <a
                    href={`/u/${snapshot.me.user_id}`}
                    data-testid="my-history-link"
                    className="br-btn br-btn--secondary"
                  >
                    {t.common.myHistory}
                  </a>
                  <button
                    type="button"
                    data-testid="play-again"
                    onClick={() => {
                      controller.playAgain();
                    }}
                    className="br-btn br-btn--secondary"
                  >
                    {r.playAgain}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
