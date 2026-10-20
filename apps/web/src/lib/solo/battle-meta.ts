/**
 * The title, description and social image of a battle's results page, from its public data.
 * The page sets the title in the browser (T-037: /battles/{id} is a static shell); the same
 * text is what a link preview shows (T-038's Pages Function writes it into the shell's `og:*`
 * tags at the edge: lib/hosting/battle-preview.ts). A build a moderator removed is never named
 * (T-028), and nobody is named the winner in its place.
 */
import type { Messages } from '../i18n/messages/en';
import { formatTimeLimit, isWinner } from './format';
import { battleOgImage, type OgImage } from './og-image';
import type { PublicBattle } from './types';

export interface BattleMeta {
  title: string;
  description: string;
  image: OgImage;
}

/** The tab title when the battle does not exist (or is not public yet). */
export const BATTLE_NOT_FOUND_TITLE = 'Battle not found';

/** The English title words (messages/en.ts `battlePage` uses them). */
export const BATTLE_TITLE_EN = {
  titleBy: (name: string, builder: string) => `${name} by ${builder}`,
  titleChallenge: (challenge: string) => `${challenge} · Battle results`,
};

/**
 * The page title: "{rank-1 build} by {builder}", or "{challenge} · Battle results" when rank 1
 * has no name or was removed. In the page's language for the tab (T-050: pass the catalog);
 * link previews keep English (the default; the Worker does not load the catalogs).
 */
export function battleTitle(
  data: PublicBattle,
  words: Pick<Messages['battlePage'], 'titleBy' | 'titleChallenge'> = BATTLE_TITLE_EN,
): string {
  const top = data.builds[0];
  // A removed build has no name (get_public_battle drops it), so it falls through to the
  // challenge.
  return top?.name && top.taken_down !== true
    ? words.titleBy(top.name, top.builder_name)
    : words.titleChallenge(data.challenge.build.text);
}

export function battleMeta(data: PublicBattle): BattleMeta {
  const title = battleTitle(data);
  // The winner as the page shows it (the Winner banner): rank 1 and not removed. A removed
  // rank-1 build leaves the battle without a winner; the runner-up is not promoted.
  const winner = data.builds.find(isWinner);
  const challenge = `BUILD: ${data.challenge.build.text} · RULE: ${data.challenge.rule.text} · STYLE: ${data.challenge.style.text} · ${formatTimeLimit(data.challenge.time_limit_seconds)}`;
  const description = winner?.name
    ? `Winner: ${winner.name} by ${winner.builder_name}. ${challenge}`
    : challenge;
  return { title, description, image: battleOgImage(data) };
}

/** `document.title` for a page title (the root layout's template, applied in the browser). */
export function documentTitle(title: string): string {
  return `${title} · Build Roulette`;
}
