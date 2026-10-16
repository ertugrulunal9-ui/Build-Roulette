/**
 * Display helpers shared by the game UI and the results pages.
 *
 * Words: English by default (the link-preview Worker bundles this module, so it does not load
 * the catalogs); the pages pass their language's catalog (T-050, lib/i18n). The English words
 * here are the catalog's own (messages/en.ts imports them).
 */
import { VOTE_CATEGORIES } from '@br/game';
import type { Messages } from '../i18n/messages/en';
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

/** The English time units (messages/en.ts `units`). */
export const MINUTES_EN = (n: number) => `${String(n)} min`;
export const SECONDS_EN = (n: number) => `${String(n)} s`;

/** `15 min`, or seconds when not whole minutes (`15 dk` with the Turkish catalog). */
export function formatTimeLimit(seconds: number, m?: Pick<Messages, 'units'>): string {
  const minutes = m?.units.minutes ?? MINUTES_EN;
  const secs = m?.units.seconds ?? SECONDS_EN;
  return seconds % 60 === 0 ? minutes(seconds / 60) : secs(seconds);
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

const AUTO_AWARD_EMOJI = { speedrun: '⚡', clutch_ship: '⏱️', fastest_ship: '🏁' } as const;

/** The auto-awards in English (messages/en.ts `awards`). */
export const AUTO_AWARDS_EN = {
  speedrun: { title: 'Speedrun', text: 'Shipped using at most half the time.' },
  clutch_ship: { title: 'Clutch ship', text: 'Shipped in the last 10 seconds.' },
  fastest_ship: { title: 'Fastest ship', text: 'The first build shipped.' },
};
export const MOST_VOTES_EN = (description: string) => `Most votes: ${description}`;

type AutoAward = keyof typeof AUTO_AWARD_EMOJI;

function isAutoAward(award: AwardKind): award is AutoAward {
  return Object.prototype.hasOwnProperty.call(AUTO_AWARD_EMOJI, award);
}

/** Is this award one of the vote categories (rather than an auto-award)? */
export function isVoteAward(award: AwardKind): boolean {
  return VOTE_CATEGORIES.some((c) => c.slug === award);
}

/**
 * An award's emoji, title and explanation, in the catalog's language (default English). The
 * auto-awards (speedrun, clutch ship, fastest ship), and one per vote category: the most
 * votes in it. One winner (T-022): a tie goes to more votes in all categories, then the
 * earlier ship (VOTE_TIE_BREAKS in @br/game).
 */
export function awardInfo(
  award: AwardKind,
  m?: Pick<Messages, 'awards' | 'voteCategories'>,
): { emoji: string; title: string; text: string } {
  if (isAutoAward(award)) {
    return { emoji: AUTO_AWARD_EMOJI[award], ...(m?.awards ?? AUTO_AWARDS_EN)[award] };
  }
  const category = VOTE_CATEGORIES.find((c) => c.slug === award);
  if (category) {
    const words = m?.voteCategories[category.slug] ?? category;
    return {
      emoji: categoryEmoji(category.slug),
      title: words.label,
      text: (m?.awards.mostVotes ?? MOST_VOTES_EN)(words.description),
    };
  }
  return { emoji: '🏆', title: award.replaceAll('_', ' '), text: '' };
}

/**
 * A vote category's name in the catalog's language: the catalog's for the known categories,
 * the server's own label for any other (`snapshot.vote_categories`), else the slug.
 */
export function categoryLabel(
  slug: string,
  m?: Pick<Messages, 'voteCategories'>,
  serverLabel?: string,
): string {
  const known = VOTE_CATEGORIES.find((c) => c.slug === slug);
  if (!known) return serverLabel ?? slug;
  return m ? m.voteCategories[known.slug].label : known.label;
}

/** A vote category's one-line description (as {@link categoryLabel}). */
export function categoryDescription(
  slug: string,
  m?: Pick<Messages, 'voteCategories'>,
  serverDescription?: string,
): string {
  const known = VOTE_CATEGORIES.find((c) => c.slug === slug);
  if (!known) return serverDescription ?? '';
  return m ? m.voteCategories[known.slug].description : known.description;
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

/** A build's status for people, in English (messages/en.ts `status`). */
export const STATUS_TEXT: Record<BuildStatus, string> = {
  draft: 'Building',
  shipped: 'Shipped',
  auto_shipped: 'Auto-shipped at the deadline',
  dnf: 'Did not finish',
  disqualified: 'Disqualified',
};

/** A screenshot's state for people, in English (messages/en.ts `capture`). */
export const CAPTURE_TEXT: Record<CaptureStatus, string> = {
  pending: 'Taking the screenshot…',
  captured: 'Screenshot',
  fallback: 'Screenshot (fallback: the in-browser thumbnail)',
  failed: 'No screenshot: the capture failed',
};
