import type { APIRequestContext } from '@playwright/test';

/**
 * A link-preview crawler's view of a page (T-038): what Slack, Discord, X or Facebook read
 * when someone shares a link. They fetch the HTML once and do not run its script, so this is
 * a plain request (no browser) and a parse of the `<head>`.
 */
export interface CrawlerView {
  status: number;
  headers: Record<string, string>;
  html: string;
  /** `<title>` texts (one expected). */
  titles: string[];
  /** Every `<meta property|name content>`, by key, in document order (one value expected). */
  meta: Record<string, string[]>;
  canonical: string[];
  ms: number;
}

/** A link-preview crawler's User-Agent (the Function answers every client the same way). */
export const CRAWLER_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (e) => ENTITIES[e] ?? e);

/** The head of a page as a crawler sees it. */
export function parseHead(html: string): Pick<CrawlerView, 'titles' | 'meta' | 'canonical'> {
  const end = html.indexOf('</head>');
  const head = end === -1 ? html : html.slice(0, end);
  const titles = [...head.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => decode(m[1] ?? ''));
  const meta: Record<string, string[]> = {};
  for (const m of head.matchAll(
    /<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"\s*\/?>/g,
  )) {
    const key = m[1] ?? '';
    (meta[key] ??= []).push(decode(m[2] ?? ''));
  }
  const canonical = [...head.matchAll(/<link rel="canonical" href="([^"]*)"\s*\/?>/g)].map((m) =>
    decode(m[1] ?? ''),
  );
  return { titles, meta, canonical };
}

/** Fetches `path` like a link-preview crawler. */
export async function crawl(request: APIRequestContext, path: string): Promise<CrawlerView> {
  const started = Date.now();
  const res = await request.get(path, {
    headers: { 'user-agent': CRAWLER_UA, accept: 'text/html' },
    maxRedirects: 0,
  });
  const html = await res.text();
  return {
    status: res.status(),
    headers: res.headers(),
    html,
    ms: Date.now() - started,
    ...parseHead(html),
  };
}

/** The one value of a meta key (fails on none or several: the head must not repeat a tag). */
export function one(view: CrawlerView, key: string): string {
  const values = view.meta[key] ?? [];
  if (values.length !== 1) {
    throw new Error(`${key}: expected one value, got ${JSON.stringify(values)}`);
  }
  return values[0] ?? '';
}
