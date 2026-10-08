declare namespace NodeJS {
  interface ProcessEnv {
    /** Sandbox shell URL for /playground and /play (inlined at build time). */
    readonly NEXT_PUBLIC_SANDBOX_SHELL_URL?: string;
    /** esm.sh-compatible package CDN base URL (inlined at build time). */
    readonly NEXT_PUBLIC_PKG_CDN_URL?: string;
    /** Supabase project URL. Default: the local stack, http://127.0.0.1:54321. */
    readonly NEXT_PUBLIC_SUPABASE_URL?: string;
    /** Supabase anon key (JWT). Default: the local stack's demo anon key. */
    readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
    /** Alternative to the anon key: a publishable key (`sb_publishable_…`). */
    readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
    /**
     * Cloudflare Turnstile site key (T-024). When set, anonymous sign-ups send a Turnstile
     * token (Supabase Auth must have Turnstile enabled with the matching secret). Unset
     * locally: no widget, no token.
     */
    readonly NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
    /** The app's public origin, for absolute OG image URLs (`metadataBase`). */
    readonly NEXT_PUBLIC_SITE_URL?: string;
    /**
     * Sentry DSN for browser error reporting (T-030; also the server's fallback). Unset: no
     * error reporting, nothing loaded. See src/lib/telemetry/config.ts.
     */
    readonly NEXT_PUBLIC_SENTRY_DSN?: string;
    /** Sentry environment name (default `production`). */
    readonly NEXT_PUBLIC_SENTRY_ENVIRONMENT?: string;
    /** PostHog project API key (T-030). Unset: no product analytics. */
    readonly NEXT_PUBLIC_POSTHOG_KEY?: string;
    /** PostHog ingest host (default https://eu.i.posthog.com). */
    readonly NEXT_PUBLIC_POSTHOG_HOST?: string;
    /** The release (set by next.config.ts from `BR_RELEASE` or the commit). */
    readonly NEXT_PUBLIC_BR_RELEASE?: string;
  }
}

/** `.wasm` imports are emitted as static assets (next.config.ts), so they yield a URL. */
declare module '*.wasm' {
  const url: string;
  export default url;
}
