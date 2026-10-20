import type { Metadata } from 'next';
import { NotFoundView } from '../components/NotFoundView';
import { PageTitle } from '../components/i18n/PageTitle';

/** The exported `404.html`: Cloudflare Pages serves it, with a 404, for every unknown path. */
export const metadata: Metadata = {
  // The tab title is PageTitle's `<title>`, in the page's language (T-050).
  title: null,
  robots: { index: false },
};

export default function NotFound() {
  return (
    <>
      <PageTitle page="notFound" />
      <NotFoundView />
    </>
  );
}
