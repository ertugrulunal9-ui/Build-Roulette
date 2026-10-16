import { PROTOCOL_VERSION } from '@br/protocol';

/**
 * Where the previews run: the sandbox shell, on a different site from the app (127.0.0.1 vs
 * localhost locally). `NEXT_PUBLIC_SANDBOX_SHELL_URL` is inlined at build time; the default
 * matches `pnpm --filter @br/web dev:sandbox` (scripts/sandbox-servers.ts).
 */
export interface PreviewConfig {
  /** The versioned shell (`/v2/`, protocol v2: a load carries a site pack). */
  shellUrl: string;
}

export const DEFAULT_SHELL_URL = `http://127.0.0.1:4321/v${String(PROTOCOL_VERSION)}/`;

export const previewConfig: PreviewConfig = {
  shellUrl: process.env.NEXT_PUBLIC_SANDBOX_SHELL_URL ?? DEFAULT_SHELL_URL,
};
