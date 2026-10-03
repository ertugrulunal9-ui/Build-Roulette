/**
 * Typed messages between the main thread (BundlerClient) and the bundler worker.
 * Both ends are our own same-origin code, so these are TS types only (no zod).
 */
import type { BuildResult, BundleInput } from '../types';

export type WorkerRequest =
  | { type: 'init'; wasmUrl: string }
  | { type: 'build'; id: number; input: BundleInput; cdnBaseUrl: string };

export type WorkerResponse =
  | { type: 'init-done'; wasmInitMs: number }
  | { type: 'init-error'; message: string }
  | { type: 'build-result'; id: number; result: BuildResult };
