// Supabase Edge Function `import-url` (T-051, docs/10 §10.3): copies a player's published site
// (a link on an allowed static host such as *.lovable.app) into a site pack, for the app's
// "paste the link of your published site" import. POST {"url": "..."} with the user's session
// (Authorization: Bearer <access token>); answers the pack (application/octet-stream) or a JSON
// error {code, detail?}. The full contract is at the top of the handler.
//
// The code is packages/site/src/import-url (with the copier, tested there), bundled into
// ./core.js by `pnpm --filter @br/site build:function`.
// Environment: SUPABASE_URL and SUPABASE_ANON_KEY (set by Supabase), APP_ORIGINS (a function
// secret, set by scripts/deploy). IMPORT_URL_TEST_HOSTS is honored only when SUPABASE_URL is a
// local stack (supabase/README.md "Import from a link").
import { createImportUrlHandler } from './core.js';

const handler = createImportUrlHandler({
  env: Deno.env.toObject(),
  runtime: `deno ${Deno.version.deno}`,
});

Deno.serve(handler);
