import type { Metadata } from 'next';
import { PlaygroundLoader } from '../../components/playground/PlaygroundLoader';

export const metadata: Metadata = {
  title: 'Playground',
  description: 'Build something in the browser: an editor, a live preview and a console.',
};

export default function PlaygroundPage() {
  return <PlaygroundLoader />;
}
