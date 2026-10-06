/**
 * Supabase settings for the web app. `NEXT_PUBLIC_*` values are inlined at build time (and
 * read on the server at request time too).
 *
 * Only public values live here: the project URL and the anon (or publishable) key, which
 * the browser needs anyway. Row-level security and the RPC guards protect the data; the web
 * app never holds the service-role key.
 *
 * The defaults are the local stack's (`supabase start`): `http://127.0.0.1:54321` and the
 * Supabase CLI's well-known demo anon key. Override both for any other environment.
 */

export const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

/** The Supabase CLI's fixed demo anon key (local stack only; it signs nothing real). */
export const LOCAL_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

export interface SupabaseConfig {
  url: string;
  /** The anon key (JWT) or a publishable key (`sb_publishable_…`). */
  anonKey: string;
}

export const supabaseConfig: SupabaseConfig = {
  url: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? LOCAL_SUPABASE_URL).replace(/\/+$/, ''),
  anonKey:
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    LOCAL_SUPABASE_ANON_KEY,
};

export const SCREENSHOTS_BUCKET = 'screenshots';
export const EPHEMERAL_BUCKET = 'ephemeral-builds';

/** Public URL of a screenshot (`{battle}/{build}.webp` in the public `screenshots` bucket). */
export function screenshotUrl(path: string, config: SupabaseConfig = supabaseConfig): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${config.url}/storage/v1/object/public/${SCREENSHOTS_BUCKET}/${encoded}`;
}
