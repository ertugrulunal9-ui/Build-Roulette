import type { Metadata } from 'next';
import { SoloLoader } from '../../components/solo/SoloLoader';

export const metadata: Metadata = {
  title: 'Play solo',
  description:
    'Spin a random challenge, build it with your own AI tools against the clock, import the built site and ship it.',
};

export default function PlayPage() {
  return <SoloLoader />;
}
