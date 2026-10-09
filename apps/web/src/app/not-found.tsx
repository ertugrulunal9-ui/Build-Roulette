import type { Metadata } from 'next';
import { NotFoundView } from '../components/NotFoundView';

/** The exported `404.html`: Cloudflare Pages serves it, with a 404, for every unknown path. */
export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false },
};

export default function NotFound() {
  return <NotFoundView />;
}
