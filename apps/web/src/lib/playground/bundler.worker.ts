// Bundler Web Worker entry for Next.js: Turbopack bundles this file (and esbuild-wasm's JS
// API) as a separate module-worker chunk because of the `new Worker(new URL(...))` pattern
// in sandbox.ts.
import '@br/runtime/worker';
