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
    /** The app's public origin, for absolute OG image URLs (`metadataBase`). */
    readonly NEXT_PUBLIC_SITE_URL?: string;
  }
}

/** `.wasm` imports are emitted as static assets (next.config.ts), so they yield a URL. */
declare module '*.wasm' {
  const url: string;
  export default url;
}
