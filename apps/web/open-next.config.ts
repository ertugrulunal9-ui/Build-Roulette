import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

/**
 * OpenNext adapter config for Cloudflare Workers (`pnpm --filter @br/web cf:build`).
 *
 * Today every route is either prerendered at build time (`/`, `/playground`) or rendered on
 * each request (`/r/[code]`, `/battles/[id]`). The static-assets cache serves the prerendered
 * HTML from Workers static assets instead of rendering it again on every request. It is
 * read-only, so it cannot hold ISR pages: when `/battles/[id]` gets `revalidate`, switch to
 * the R2 incremental cache plus a revalidation queue (see DEPLOY.md, "Caching").
 */
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  // Answer prerendered pages from the cache before loading the Next server (~7 ms instead of
  // ~50 ms locally). Must be turned off if we ever use Partial Prerendering.
  enableCacheInterception: true,
});
