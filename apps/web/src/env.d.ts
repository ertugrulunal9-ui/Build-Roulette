declare namespace NodeJS {
  interface ProcessEnv {
    /** Sandbox shell URL for /playground (inlined at build time). */
    readonly NEXT_PUBLIC_SANDBOX_SHELL_URL?: string;
    /** esm.sh-compatible package CDN base URL for /playground (inlined at build time). */
    readonly NEXT_PUBLIC_PKG_CDN_URL?: string;
  }
}

/** `.wasm` imports are emitted as static assets (next.config.ts), so they yield a URL. */
declare module '*.wasm' {
  const url: string;
  export default url;
}
