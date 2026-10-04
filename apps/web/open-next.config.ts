import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext adapter config for Cloudflare Workers (`pnpm --filter @br/web cf:build`).
 *
 * No incremental cache yet: every route today is either static (prerendered at build time
 * and served from Workers static assets) or rendered per request. When `/battles/[id]` gets
 * ISR, add the R2 incremental cache here and the matching bucket in wrangler.jsonc
 * (see DEPLOY.md, "Caching").
 */
export default defineCloudflareConfig({});
