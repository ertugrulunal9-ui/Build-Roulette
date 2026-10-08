/**
 * What the social card of a battle (/battles/[id]/opengraph-image) says about its top build:
 * the chip above it, its title and byline, and its awards as text. Kept apart from the
 * image route so it can be tested without rendering an image.
 */
import { REMOVED_TEXT } from '../../components/moderation/Removed';
import { awardInfo, awardsOf, formatCompletion, isVoteAward, isWinner } from './format';
import type { PublicBattle, PublicBuild } from './types';

export interface OgTopBuild {
  build: PublicBuild;
  /**
   * Voted battles only. `winner`: the gold "WINNER · n VOTES" chip. `rank`: a neutral
   * "#1 · n VOTES" chip for a top build a moderator removed after RESULTS (T-028: it keeps
   * its rank and votes, not the Winner title). null: no chip.
   */
  chip: { tone: 'winner' | 'rank'; text: string } | null;
  title: string;
  byline: string;
  /** Category awards first (with their votes), then the auto-awards; none for a removed build. */
  awards: string[];
}

function votesText(n: number): string {
  return `${String(n)} ${n === 1 ? 'VOTE' : 'VOTES'}`;
}

/** The top build of the card (the first one listed: rank 1 when ranked), or null. */
export function ogTopBuild(data: PublicBattle): OgTopBuild | null {
  const top = data.builds[0];
  if (!top) return null;
  const removed = top.taken_down === true;
  const voted = data.builds.some((b) => b.votes !== null && b.votes !== undefined);
  const awards = awardsOf(data.awards, top);

  let chip: OgTopBuild['chip'] = null;
  if (voted && isWinner(top)) {
    chip = { tone: 'winner', text: `WINNER · ${votesText(top.total_votes)}` };
  } else if (voted && removed && top.final_rank !== null) {
    chip = { tone: 'rank', text: `#${String(top.final_rank)} · ${votesText(top.total_votes)}` };
  }

  return {
    build: top,
    chip,
    title: removed ? REMOVED_TEXT : (top.name ?? 'Did not finish'),
    byline: `by ${top.builder_name}${
      top.completion_ms !== null && top.name ? ` · ${formatCompletion(top.completion_ms)}` : ''
    }`,
    awards: [
      ...awards
        .filter((a) => isVoteAward(a.award))
        .map(
          (a) => `${awardInfo(a.award).title}${a.votes !== null ? ` (${String(a.votes)})` : ''}`,
        ),
      ...awards.filter((a) => !isVoteAward(a.award)).map((a) => awardInfo(a.award).title),
    ],
  };
}
