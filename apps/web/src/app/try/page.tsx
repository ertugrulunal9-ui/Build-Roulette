import type { Metadata } from 'next';
import { shareMetadata } from '../../lib/hosting/site';
import { TryLoader } from '../../components/try/TryLoader';

const description =
  'Practice for a battle: drop the site you built with your own AI tools and see it run. No account, nothing uploaded.';

export const metadata: Metadata = {
  // The tab title is TryLoader's own `<title>`, in the page's language (T-050).
  title: null,
  description,
  ...shareMetadata('Try an import · Build Roulette', description),
};

export default function TryPage() {
  return <TryLoader />;
}
