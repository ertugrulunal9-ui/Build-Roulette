import type { ImportMap } from '@br/protocol';

/** Workspace source files: normalized path (`src/App.tsx`) -> text contents. */
export type FileMap = Record<string, string>;

/**
 * Workspace manifest (docs/03 §3.3). Versions must be exact (`1.2.3`): the bundler never
 * resolves `latest` or ranges, so a build is reproducible for capture and reveal.
 */
export interface Manifest {
  /** Entry file, e.g. `src/main.tsx`. */
  entry: string;
  /** Package name -> exact version. */
  dependencies: Record<string, string>;
  template?: string;
}

export type BuildMode = 'dev' | 'production';

export interface Diagnostic {
  severity: 'error' | 'warning';
  text: string;
  /**
   * Set for problems that are not about the user's code. `bundler-init-failed`: the bundler
   * (worker or esbuild-wasm) could not start; the next build tries to start it again.
   */
  code?: 'bundler-init-failed';
  /** Workspace path, when the problem has a location. */
  file?: string;
  line?: number;
  column?: number;
  lineText?: string;
}

export interface BuildResult {
  /** True when `js` is runnable. Diagnostics may still contain warnings. */
  ok: boolean;
  js: string;
  css: string;
  importMap: ImportMap;
  diagnostics: Diagnostic[];
  /** Time spent inside the bundler (worker side), in ms. */
  durationMs: number;
}

export interface BundleInput {
  files: FileMap;
  manifest: Manifest;
  mode: BuildMode;
}

export interface WorkspaceSnapshot {
  files: FileMap;
  manifest: Manifest;
}
