/**
 * The link-preview Worker (T-038, docs/08-free-tier.md §3; a Pages Function until T-043): the
 * web app's Worker module, `dist/worker.js`, bundled by scripts/preview-worker.ts at build
 * time and deployed with the static export as its assets (apps/web/wrangler.jsonc).
 * `run_worker_first: ["/battles/*"]` limits it to `/battles/*`; every other path stays a
 * plain static file (no Worker invocation, nothing counted against Workers Free's 100,000
 * requests a day).
 *
 * What it does per request is preview-handler.ts; this file adds the runtime: the static
 * assets (`env.ASSETS`, which apply `_redirects` and `_headers` to what they answer),
 * `get_public_battle` over PostgREST, Cloudflare's `HTMLRewriter` (streaming, native), the
 * settings baked in at build time, and the last safety net: anything that throws gets what the
 * assets serve without the Worker.
 *
 * Settings come from the build, like the bundles: the Supabase URL and anon key are the
 * `NEXT_PUBLIC_*` values the build inlines (lib/supabase/config.ts), `NEXT_PUBLIC_SITE_URL` is
 * the canonical origin (else the request's), and the headers are `_headers`' `/*` rule.
 * Nothing to set on the Worker.
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

interface Env {
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
      // Never break the page: what the assets serve without the Worker (the shell, through
      // the `_redirects` rewrite).
      return env.ASSETS.fetch(request);
    }
  },
};

export default worker;
