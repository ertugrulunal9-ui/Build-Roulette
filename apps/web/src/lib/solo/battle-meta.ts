/**
 * The title, description and social image of a battle's results page, from its public data.
 * The page sets the title in the browser (T-037: /battles/{id} is a static shell); the same
 * text is what a link preview should show (T-038 writes it into the shell's `og:*` tags at
 * the edge). A build a moderator removed is never named (T-028).
 */
import { formatTimeLimit } from './format';
import { battleOgImage, type OgImage } from './og-image';
import type { PublicBattle } from './types';

export interface BattleMeta {
  title: string;
  description: string;
  image: OgImage;
}

/** The tab title when the battle does not exist (or is not public yet). */
export const BATTLE_NOT_FOUND_TITLE = 'Battle not found';

export function battleMeta(data: PublicBattle): BattleMeta {
  const top = data.builds[0];
  // A removed build has no name (get_public_battle drops it), so it falls through to the
  // challenge.
  const title =
    top?.name && top.taken_down !== true
      ? `${top.name} by ${top.builder_name}`
      : `${data.challenge.build.text} · Battle results`;
  const description = `BUILD: ${data.challenge.build.text} · RULE: ${data.challenge.rule.text} · STYLE: ${data.challenge.style.text} · ${formatTimeLimit(data.challenge.time_limit_seconds)}`;
  return { title, description, image: battleOgImage(data) };
}

/** `document.title` for a page title (the root layout's template, applied in the browser). */
export function documentTitle(title: string): string {
  return `${title} · Build Roulette`;
}
