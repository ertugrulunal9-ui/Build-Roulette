/**
 * Entry of the `jobs` Edge Function bundle (T-034). `pnpm --filter @br/capture-worker
 * build:function` bundles this file with esbuild into supabase/functions/jobs/core.js
 * (committed; a unit test fails when it is stale), which the Deno entry
 * supabase/functions/jobs/index.ts imports. Nothing here may use Node APIs.
 */
export { createJobsHandler, CRON_SECRET_HEADER, type JobsHandlerOptions } from './handler';
