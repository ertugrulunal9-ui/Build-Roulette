import type { Metadata } from 'next';
import { Guide } from '../../components/onboarding/Guide';

/**
 * The description stays English (static); the tab title is the guide's own `<title>`, in the
 * page's language (T-050).
 */
export const metadata: Metadata = {
  title: null,
  description:
    'How to play Build Roulette: spin a challenge, build it with your own AI tools, run the build, drop the dist folder into the game, ship, reveal and vote. Tool guides, limits and troubleshooting.',
};

/** `/how-it-works`: the full guide (T-049). A static page; the welcome screen links here. */
export default function HowItWorksPage() {
  return <Guide />;
}
