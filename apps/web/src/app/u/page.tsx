import type { Metadata } from 'next';
import { PlayerHistoryView } from '../../components/results/PlayerHistoryView';

/**
 * A player's history, `/u/{id}` (T-037): one exported page for every player. Cloudflare
 * Pages rewrites `/u/{id}` here (`out/_redirects`, src/lib/hosting/shells.ts) and the browser
 * reads the id and the page cursor from the URL and loads `get_player_history`
 * (PlayerHistoryView). The tab title is set there; these tags are the same for every player.
 */

const title = 'Player history';
const description = 'A player’s finished Build Roulette battles: ranks, awards and screenshots.';

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description, type: 'profile' },
  twitter: { card: 'summary', title, description },
};

export default function PlayerPage() {
  return <PlayerHistoryView />;
}
