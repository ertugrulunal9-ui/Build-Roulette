import type { Metadata } from 'next';
import { TryLoader } from '../../components/try/TryLoader';

export const metadata: Metadata = {
  // The tab title is TryLoader's own `<title>`, in the page's language (T-050).
  title: null,
  description:
    'Practice for a battle: drop the site you built with your own AI tools and see it run. No account, nothing uploaded.',
};

export default function TryPage() {
  return <TryLoader />;
}
