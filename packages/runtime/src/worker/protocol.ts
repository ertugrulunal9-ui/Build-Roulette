/**
 * Typed messages between the main thread (BundlerClient) and the bundler worker.
 * Both ends are our own same-origin code, so these are TS types only (no zod).
 */
import type { BuildResult, BundleInput } from '../types';

export type WorkerRequest =
  | { type: 'init'; wasmUrl: string }
  | { type: 'build'; id: number; input: BundleInput; cdnBaseUrl: string };

/**
 * How far a bundler start got: `worker` until the worker script runs (it has sent nothing
 * yet), `download` while esbuild.wasm comes in, `compile` from its last byte until
 * esbuild-wasm is ready.
 */
export type InitStage = 'worker' | 'download' | 'compile';

export type WorkerResponse =
  /**
   * The start moved on: the worker runs and sent the wasm request, the response started,
   * bytes arrived (at most one message per 250 ms), or the download is complete. `loaded`
   * counts the wasm bytes so far. The client's stall timer starts over on each one.
   */
  | { type: 'init-progress'; stage: Exclude<InitStage, 'worker'>; loaded: number }
  | { type: 'init-done'; wasmInitMs: number }
  | { type: 'init-error'; message: string }
  | { type: 'build-result'; id: number; result: BuildResult };
