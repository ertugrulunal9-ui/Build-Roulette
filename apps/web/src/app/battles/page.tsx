import type { Metadata } from 'next';
import { BattleView } from '../../components/results/BattleView';
import { STATIC_OG_CARD } from '../../lib/solo/og-image';

/**
 * A battle's permanent results, `/battles/{id}` (T-037): one exported page for every battle.
 * Cloudflare Pages rewrites `/battles/{id}` here (`out/_redirects`, src/lib/hosting/shells.ts)
 * and the browser reads the id from the URL and loads `get_public_battle` (BattleView).
 *
 * The meta tags below are the same for every battle: a crawler does not run the page's
 * script, so link previews show the static card (public/og-card.png) and this text until a
 * Pages Function writes each battle's own tags (T-038, with lib/solo/battle-meta.ts).
 */

const title = 'Battle results';
const description =
  'The permanent results of a Build Roulette battle: the challenge, the ranked builds, the votes and the awards.';

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description, type: 'article', images: [STATIC_OG_CARD] },
  twitter: { card: 'summary_large_image', title, description, images: [STATIC_OG_CARD] },
};

export default function BattlePage() {
  return <BattleView />;
}
