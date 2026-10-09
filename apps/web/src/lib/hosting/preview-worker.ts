/**
 * The link-preview Function (T-038, docs/08-free-tier.md §3): a Cloudflare Pages
 * advanced-mode worker, `out/_worker.js`, bundled by scripts/preview-worker.ts at build time.
 * `out/_routes.json` limits it to `/battles/*`; every other path stays a plain static file
 * (no Worker invocation, nothing counted against Workers Free's 100,000 requests a day).
 *
 * What it does per request is preview-handler.ts; this file adds the runtime: Pages' assets,
 * `get_public_battle` over PostgREST, Cloudflare's `HTMLRewriter` (streaming, native), the
 * settings baked in at build time, and the last safety net: anything that throws gets what
 * Pages would serve without the Function.
 *
 * Settings come from the build, like the bundles: the Supabase URL and anon key are the
 * `NEXT_PUBLIC_*` values the build inlines (lib/supabase/config.ts), `NEXT_PUBLIC_SITE_URL` is
 * the canonical origin (else the request's), and the headers are `_headers`' `/*` rule.
 * Nothing to set on Pages.
 *
 * A Worker module may only export handlers: everything else lives in the other modules.
 */
import { fetchPublicBattle } from '../solo/public-battle';
import { supabaseConfig } from '../supabase/config';
import { REPLACED_HEAD_ELEMENTS } from './battle-preview';
import { SUPABASE_TIMEOUT_MS, handlePreview, type PreviewDeps } from './preview-handler';

/** The security headers of `_headers`' `/*` rule and the site's origin, baked in at build time. */
declare const __BR_PREVIEW__: { headers: Record<string, string>; siteUrl: string | null };

/** The bits of Cloudflare's `HTMLRewriter` used here (a global in workerd). */
interface RewriterElement {
  remove(): void;
  append(content: string, options: { html: boolean }): void;
}
declare class HTMLRewriter {
  on(selector: string, handlers: { element(element: RewriterElement): void }): HTMLRewriter;
  transform(response: Response): Response;
}

interface PagesEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Drops the shell's title and social tags and appends the battle's to `<head>`. */
function injectHead(shell: Response, html: string): Response {
  return new HTMLRewriter()
    .on(REPLACED_HEAD_ELEMENTS.join(', '), {
      element(e) {
        e.remove();
      },
    })
    .on('head', {
      element(e) {
        e.append(html, { html: true });
      },
    })
    .transform(shell);
}

const worker = {
  async fetch(request: Request, env: PagesEnv): Promise<Response> {
    const deps: PreviewDeps = {
      assets: (r) => env.ASSETS.fetch(r),
      loadBattle: (id, signal) => fetchPublicBattle(id, supabaseConfig, { signal }),
      inject: injectHead,
      headers: __BR_PREVIEW__.headers,
      siteUrl: __BR_PREVIEW__.siteUrl,
      timeoutMs: SUPABASE_TIMEOUT_MS,
      warn: (m) => {
        console.warn(m);
      },
    };
    try {
      return await handlePreview(request, deps);
    } catch {
      // Never break the page: what Pages serves without the Function.
      return env.ASSETS.fetch(request);
    }
  },
};

export default worker;
