// Supabase Edge Function `jobs` (T-034): screenshots and deletes without an always-on
// server. pg_cron calls it every minute through pg_net when a job is due
// (supabase/migrations/20261009120000_jobs_function.sql); each run claims capture, destroy
// and takedown jobs and processes them, rendering through Cloudflare Browser Rendering's
// REST API within a daily budget.
//
// The code is apps/capture-worker/src/edge (shared with the self-hosted worker and tested
// there), bundled into ./core.js by `pnpm --filter @br/capture-worker build:function`.
// Secrets and deploy: apps/web/DEPLOY.md "Screenshots and jobs (Edge Function)".
import { createJobsHandler } from './core.js';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const handler = createJobsHandler({
  env: Deno.env.toObject(),
  // Answer pg_net at once (202) and keep running until the run is over (background task).
  waitUntil:
    typeof EdgeRuntime === 'undefined'
      ? undefined
      : (promise: Promise<unknown>) => {
          EdgeRuntime.waitUntil(promise);
        },
  runtime: `deno ${Deno.version.deno}`,
});

Deno.serve(handler);
