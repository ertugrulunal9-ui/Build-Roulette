import type { Metadata } from 'next';
import { SoloLoader } from '../../components/solo/SoloLoader';

export const metadata: Metadata = {
  title: 'Play solo',
  description: 'Spin a random challenge, build it in your browser against the clock, and ship it.',
};

export default function PlayPage() {
  return <SoloLoader />;
}
