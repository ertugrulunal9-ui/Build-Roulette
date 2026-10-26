import type { Metadata } from 'next';
import { shareMetadata } from '../../lib/hosting/site';
import { SoloLoader } from '../../components/solo/SoloLoader';

const description =
  'Spin a random challenge, build it with your own AI tools against the clock, import the built site and ship it.';

export const metadata: Metadata = {
  // The tab title is SoloLoader's own `<title>`, in the page's language (T-050).
  title: null,
  description,
  ...shareMetadata('Play solo · Build Roulette', description),
};

export default function PlayPage() {
  return <SoloLoader />;
}
