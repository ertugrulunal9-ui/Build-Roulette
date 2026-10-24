/**
 * Entry of the `import-url` Edge Function bundle (T-051). `pnpm --filter @br/site
 * build:function` bundles this file with esbuild into supabase/functions/import-url/core.js
 * (committed; a unit test fails when it is stale), which the Deno entry
 * supabase/functions/import-url/index.ts imports. Nothing here may use Node APIs.
 */
export {
  createImportUrlHandler,
  isLocalSupabase,
  statusOf,
  testOrigins,
  type ImportUrlErrorBody,
  type ImportUrlErrorCode,
  type ImportUrlHandlerOptions,
} from './handler';
