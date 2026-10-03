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

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source (no build step), so Next compiles them.
  transpilePackages: ['@br/game', '@br/protocol', '@br/runtime', '@br/workspace'],
  poweredByHeader: false,
  turbopack: {
    rules: {
      // The playground imports `esbuild-wasm/esbuild.wasm` for its URL: emit it as a
      // content-hashed static asset (long-lived cache) instead of compiling it as a module.
      '*.wasm': { type: 'asset' },
    },
  },
};

export default nextConfig;
