/**
 * Whether this build offers "paste the link of your published site" (docs/10), and the
 * test-only origins its link check accepts.
 *
 * - The link field needs Supabase (the `import-url` function and a session): a build with an
 *   empty `NEXT_PUBLIC_SUPABASE_URL` hides it.
 * - `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS` (comma-separated exact origins, e.g.
 *   `http://host.docker.internal:4330`) is set only by the e2e build of the solo stack suite
 *   (`test:e2e:solo`) and by `dev:solo` when `IMPORT_URL_TEST_HOSTS` is set:
 *   the local fixture server the function copies from. The function honors the same hosts
 *   (`IMPORT_URL_TEST_HOSTS`) only on a local stack. `scripts/pages-config.ts` refuses a build
 *   with it unless Supabase is local, and a build without it that still contains the test host.
 */
import { supabaseConfig } from '../supabase/config';

/** `a, b` → exact origins; anything that is not an http(s) origin is dropped. */
export function parseTestOrigins(value: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (value ?? '').split(/[\s,]+/)) {
    if (part === '') continue;
    try {
      const u = new URL(part);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !out.includes(u.origin)) {
        out.push(u.origin);
      }
    } catch {
      // not an origin
    }
  }
  return out;
}

/** Inlined at build time (next.config.ts: '' when unset). */
export const linkTestOrigins: readonly string[] = parseTestOrigins(
  process.env.NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS,
);

/** The link field is shown (Supabase is configured in this build). */
export const linkImportAvailable: boolean = supabaseConfig.url !== '';
