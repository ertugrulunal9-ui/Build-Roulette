import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { NextConfig } from 'next';

// The playground serves `esbuild.wasm` from this app's own `esbuild-wasm` dependency, while
// the bundler worker runs the JS API from @br/runtime's. esbuild refuses to start when the
// two versions differ, so fail the build early instead of shipping a broken playground.
const require = createRequire(import.meta.url);
const webEsbuild = (require('esbuild-wasm/package.json') as { version: string }).version;
const runtimePkg = JSON.parse(
  readFileSync(new URL('../../packages/runtime/package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };
if (runtimePkg.dependencies['esbuild-wasm'] !== webEsbuild) {
  throw new Error(
    `esbuild-wasm version mismatch: apps/web has ${webEsbuild}, @br/runtime pins ${String(runtimePkg.dependencies['esbuild-wasm'])}. Keep them identical.`,
  );
}

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

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source (no build step), so Next compiles them.
  transpilePackages: ['@br/game', '@br/protocol', '@br/runtime', '@br/telemetry', '@br/workspace'],
  // Telemetry settings (src/lib/telemetry/config.ts), inlined like any NEXT_PUBLIC_* value.
  // An unset one becomes '' rather than a runtime `process.env` lookup, so a build without
  // a DSN or key drops the code behind it (the bundler removes `if ('')` branches).
  env: {
    NEXT_PUBLIC_BR_RELEASE: release(),
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? '',
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '',
  },
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into apps/web when it detects an
  // AI coding agent. The repository keeps its agent instructions at the root.
  agentRules: false,
  experimental: {
    // `'use cache'` + `cacheLife`/`cacheTag` without Cache Components (T-026): the permanent
    // pages cache their data for as long as it can't change, and their ISR copies inherit
    // that lifetime (lib/cache/policy.ts). Next 16 marks this flag deprecated in favour of
    // `cacheComponents`, which would turn every route into a partial prerender; see DEPLOY.md.
    useCache: true,
  },
  turbopack: {
    rules: {
      // The playground imports `esbuild-wasm/esbuild.wasm` for its URL: emit it as a
      // content-hashed static asset (long-lived cache) instead of compiling it as a module.
      '*.wasm': { type: 'asset' },
    },
  },
};

export default nextConfig;
