import { PROTOCOL_VERSION } from '@br/protocol';

/**
 * Sandbox endpoints for /playground. `NEXT_PUBLIC_*` values are inlined at build time; the
 * defaults match `pnpm --filter @br/web dev:sandbox` (scripts/sandbox-servers.ts).
 */
export interface PlaygroundConfig {
  /** Sandbox shell, on a different site from the app (127.0.0.1 vs localhost locally). */
  shellUrl: string;
  /** esm.sh-compatible package CDN. */
  cdnBaseUrl: string;
}

export const DEFAULT_SHELL_URL = `http://127.0.0.1:4321/v${String(PROTOCOL_VERSION)}/`;
export const DEFAULT_CDN_URL = 'http://localhost:4322';

export const playgroundConfig: PlaygroundConfig = {
  shellUrl: process.env.NEXT_PUBLIC_SANDBOX_SHELL_URL ?? DEFAULT_SHELL_URL,
  cdnBaseUrl: process.env.NEXT_PUBLIC_PKG_CDN_URL ?? DEFAULT_CDN_URL,
};
