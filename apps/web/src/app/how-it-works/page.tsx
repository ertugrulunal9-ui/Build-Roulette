import type { Metadata } from 'next';
import { GUIDE_COPY } from '../../components/onboarding/copy';
import { Guide } from '../../components/onboarding/Guide';

export const metadata: Metadata = {
  title: GUIDE_COPY.metaTitle,
  description: GUIDE_COPY.metaDescription,
};

/** `/how-it-works`: the full guide (T-049). A static page; the welcome screen links here. */
export default function HowItWorksPage() {
  return <Guide />;
}
