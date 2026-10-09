import type { Metadata } from 'next';
import { BattleView } from '../../components/results/BattleView';
import { STATIC_OG_CARD } from '../../lib/solo/og-image';

/**
 * A battle's permanent results, `/battles/{id}` (T-037): one exported page for every battle.
 * Cloudflare Pages rewrites `/battles/{id}` here (`out/_redirects`, src/lib/hosting/shells.ts)
 * and the browser reads the id from the URL and loads `get_public_battle` (BattleView).
 *
 * The meta tags below are the same for every battle: the shell's defaults. A crawler does not
 * run the page's script, so the link-preview Pages Function (T-038,
 * lib/hosting/preview-worker.ts) replaces them and the title with each battle's own at the
 * edge; when it cannot (Supabase slow or down), these stay: the static card
 * (public/og-card.png) and this text.
 */

const title = 'Battle results';
const description =
  'The permanent results of a Build Roulette battle: the challenge, the ranked builds, the votes and the awards.';

export const metadata: Metadata = {
  // The tab title is BattleView's own `<title>` (components/DocumentTitle.tsx).
  title: null,
  description,
  openGraph: { title, description, type: 'article', images: [STATIC_OG_CARD] },
  twitter: { card: 'summary_large_image', title, description, images: [STATIC_OG_CARD] },
};

export default function BattlePage() {
  return <BattleView />;
}
