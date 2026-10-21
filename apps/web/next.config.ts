import { execFileSync } from 'node:child_process';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { REDIRECTS, SHELLS } from './src/lib/hosting/shells';

/**
 * The release that error reports and analytics events carry (T-030): `BR_RELEASE` when the
 * deploy sets it, else the commit being built, else `dev`.
 */
function release(): string {
  const fromEnv = process.env['BR_RELEASE']?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

/**
 * A static export (T-037, docs/08-free-tier.md §2): `next build` writes the whole site to
 * `out/`, which Cloudflare Pages serves as plain files (no server, no Worker). Data loads in
 * the browser. `scripts/pages-config.ts` then adds the host's own files (`out/_redirects`,
 * `out/_headers`) and checks the export.
 */
export default function config(phase: string): NextConfig {
  return {
    output: 'export',
    // Workspace packages ship TypeScript source (no build step), so Next compiles them.
    transpilePackages: ['@br/game', '@br/protocol', '@br/runtime', '@br/site', '@br/telemetry'],
    // Telemetry settings (src/lib/telemetry/config.ts), inlined like any NEXT_PUBLIC_* value.
    // An unset one becomes '' rather than a runtime `process.env` lookup, so a build without
    // a DSN or key drops the code behind it (the bundler removes `if ('')` branches).
    env: {
      NEXT_PUBLIC_BR_RELEASE: release(),
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? '',
      NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
      NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '',
      // The link import's test-only origins (src/lib/site/link-config.ts): e2e builds only.
      NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS: process.env.NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS ?? '',
    },
    // `next dev` only: the shells' rewrites (`/battles/{id}` → the `/battles` page, …) and
    // the moved paths' redirects, which the host does with `out/_redirects` in production
    // (src/lib/hosting/shells.ts). A static export applies neither itself, so the build
    // leaves them out.
    ...(phase === PHASE_DEVELOPMENT_SERVER
      ? {
          rewrites: () => Promise.resolve(SHELLS.map((s) => ({ ...s }))),
          redirects: () =>
            Promise.resolve(
              REDIRECTS.map((r) => ({
                source: r.source,
                destination: r.destination,
                permanent: true,
              })),
            ),
        }
      : {}),
    // `next dev` would otherwise write AGENTS.md and CLAUDE.md into apps/web when it detects
    // an AI coding agent. The repository keeps its agent instructions at the root.
    agentRules: false,
  };
}
