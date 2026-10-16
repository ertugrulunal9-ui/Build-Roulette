'use client';

/**
 * The tab title of a static page in the page's language (T-050): `/play`, `/try`,
 * `/how-it-works` and the 404 page set `title: null` in their metadata and render this
 * instead, like the static shells do (components/DocumentTitle.tsx). The exported HTML has the
 * English title; in the browser it follows the language, also after a switch.
 */
import { useT } from '../../lib/i18n/context';
import type { Messages } from '../../lib/i18n/messages/en';
import { DocumentTitle } from '../DocumentTitle';

export function PageTitle({ page }: { page: keyof Messages['titles'] }) {
  return <DocumentTitle title={useT().titles[page]} />;
}
