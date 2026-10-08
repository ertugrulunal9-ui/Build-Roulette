/** Display helpers shared by the game UI and the results pages. */
import { VOTE_CATEGORIES } from '@br/game';
import type { AwardKind, BuildStatus, CaptureStatus } from './types';

/** `m:ss` for countdowns, rounded up so "0:00" only shows at zero. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}

/** `m:ss.s` for completion times. */
export function formatCompletion(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${String(m)}:${String(s).padStart(2, '0')}.${String(tenths % 10)}`;
}

export function formatTimeLimit(seconds: number): string {
  return seconds % 60 === 0 ? `${String(seconds / 60)} min` : `${String(seconds)} s`;
}

/** An icon per vote category (`award` of a vote award is the category slug). */
export const CATEGORY_EMOJI: Record<string, string> = {
  overall: '🏆',
  rule: '📜',
  style: '🎨',
  chaos: '🌀',
};

export function categoryEmoji(slug: string): string {
  return CATEGORY_EMOJI[slug] ?? '🗳️';
}

export const AWARD_INFO: Record<string, { emoji: string; title: string; text: string }> = {
  speedrun: { emoji: '⚡', title: 'Speedrun', text: 'Shipped using at most half the time.' },
  clutch_ship: { emoji: '⏱️', title: 'Clutch ship', text: 'Shipped in the last 10 seconds.' },
  fastest_ship: { emoji: '🏁', title: 'Fastest ship', text: 'The first build shipped.' },
  // One per vote category: the most votes in it. One winner (T-022): a tie goes to more votes
  // in all categories, then the earlier ship (VOTE_TIE_BREAKS in @br/game).
  ...Object.fromEntries(
    VOTE_CATEGORIES.map((c) => [
      c.slug,
      { emoji: categoryEmoji(c.slug), title: c.label, text: `Most votes: ${c.description}` },
    ]),
  ),
};

/** Is this award one of the vote categories (rather than an auto-award)? */
export function isVoteAward(award: AwardKind): boolean {
  return VOTE_CATEGORIES.some((c) => c.slug === award);
}

export function awardInfo(award: AwardKind): { emoji: string; title: string; text: string } {
  return AWARD_INFO[award] ?? { emoji: '🏆', title: award.replaceAll('_', ' '), text: '' };
}

// ─── Builds removed by moderators after RESULTS (T-028) ──────────────────────────────
// User decision 2026-10-08: a build taken down after RESULTS keeps its rank (results are
// permanent, nothing is re-ranked) but loses the Winner highlight and all its awards on
// every surface. Nothing is reassigned: when the rank-1 build is removed, no build is "the
// winner". Its vote counts stay (they are the result its rank comes from). The server
// already leaves the awards out (supabase/README.md "Takedown"); these helpers make the
// clients agree with it, also on an answer from an older server.

/** A build as far as the results highlights care. */
interface RankedBuildLike {
  final_rank: number | null;
  /** T-024: removed by moderators. */
  taken_down?: boolean;
}

/** The Winner highlight (banner, gold ring, OG chip): rank 1, unless it was removed. */
export function isWinner(build: RankedBuildLike): boolean {
  return build.final_rank === 1 && build.taken_down !== true;
}

/** The awards a build shows: its own, and none once it was removed. */
export function awardsOf<A extends { build_id: string }>(
  awards: readonly A[],
  build: { id: string; taken_down?: boolean },
): A[] {
  return build.taken_down === true ? [] : awards.filter((a) => a.build_id === build.id);
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** The medal next to a rank: a dot without a rank, and for a removed build. */
export function rankMedal(build: RankedBuildLike): string {
  if (build.final_rank === null || build.taken_down === true) return '·';
  return MEDALS[build.final_rank - 1] ?? '🏅';
}

export const STATUS_TEXT: Record<BuildStatus, string> = {
  draft: 'Building',
  shipped: 'Shipped',
  auto_shipped: 'Auto-shipped at the deadline',
  dnf: 'Did not finish',
  disqualified: 'Disqualified',
};

export const CAPTURE_TEXT: Record<CaptureStatus, string> = {
  pending: 'Taking the screenshot…',
  captured: 'Screenshot',
  fallback: 'Screenshot (fallback: the in-browser thumbnail)',
  failed: 'No screenshot: the capture failed',
};
