import type { Page } from '@playwright/test';

/**
 * Content-Security-Policy violations of the app's own pages (T-037: the static site sends a
 * strict CSP from `out/_headers`, src/lib/hosting/pages-config.ts). Chromium reports each one
 * as a console error ("Refused to … because it violates the following Content Security
 * Policy directive …"). The sandbox shell has its own, stricter policy, and a build may break
 * it on purpose: its frames (another origin) are left out.
 */
export function watchCsp(page: Page, sandboxOrigin = 'http://127.0.0.1:4321'): string[] {
  const seen: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' || !/Content Security Policy/i.test(m.text())) return;
    if (m.location().url.startsWith(sandboxOrigin)) return;
    seen.push(`${m.location().url}: ${m.text()}`);
  });
  return seen;
}
