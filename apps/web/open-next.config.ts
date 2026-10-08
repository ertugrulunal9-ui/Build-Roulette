import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';
import d1NextTagCache from '@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache';

/**
 * OpenNext adapter config for Cloudflare Workers (`pnpm --filter @br/web cf:build`).
 *
 * Caching (T-026, DEPLOY.md "Caching"):
 * - **Incremental cache: R2** (`NEXT_INC_CACHE_R2_BUCKET`). It holds the prerendered pages
 *   (`/`, `/play`, `/playground`, copied there at deploy), the ISR copies of `/battles/[id]`
 *   and its OG image, and the `'use cache'` entries (the battle and history data). Keys are
 *   per build id, so a deploy starts from a cold cache.
 * - **Tag cache: D1** (`NEXT_TAG_CACHE_D1`, "next mode": one row per revalidated tag). A
 *   takedown's `updateTag('battle:{id}')` writes there; every cached read checks it, so the
 *   next request after a takedown renders a fresh copy in every region.
 * - **Revalidation queue: Durable Object** (`NEXT_CACHE_DO_QUEUE`, class `DOQueueHandler`).
 *   A copy past its `revalidate` time is served once more and regenerated in the background
 *   by the queue, which calls this Worker through `WORKER_SELF_REFERENCE`.
 *
 * `cf:preview` emulates all three locally (Miniflare: `.wrangler/state`).
 */
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: d1NextTagCache,
  queue: doQueue,
  // Answer cached pages from the cache before loading the Next server (~7 ms instead of
  // ~50 ms locally); it checks the tag cache first. Must be turned off if we ever use
  // Partial Prerendering.
  enableCacheInterception: true,
});
