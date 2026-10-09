/**
 * The title and description of a player's history page, from its data (T-037: /u/{id} is a
 * static shell, so the browser sets the tab title). Only wins that were not removed by a
 * moderator count (T-028).
 */
import { isWinner } from '../solo/format';
import type { PlayerHistory } from './player-history';

export const PLAYER_NOT_FOUND_TITLE = 'Player not found';

export function playerMeta(data: PlayerHistory & { player: { display_name: string } }): {
  title: string;
  description: string;
} {
  const { player } = data;
  const wins = data.battles.filter((b) => isWinner(b.build)).length;
  const title = `${player.display_name}'s battles`;
  const latest = data.battles[0];
  const description = latest
    ? `${player.display_name} on Build Roulette: ${latest.challenge.build.text}${
        latest.build.name ? `, “${latest.build.name}”` : ''
      }${wins > 0 ? ` · ${String(wins)} ${wins === 1 ? 'win' : 'wins'} on this page` : ''}.`
    : `${player.display_name} on Build Roulette.`;
  return { title, description };
}
