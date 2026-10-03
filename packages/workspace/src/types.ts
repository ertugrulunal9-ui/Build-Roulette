/** Workspace source files: normalized path (`src/App.tsx`) -> text contents. */
export type FileMap = Record<string, string>;

export type TemplateId = 'react-ts' | 'vanilla-ts';

/**
 * Workspace manifest (docs/03 §3.3). Structurally compatible with `@br/runtime`'s `Manifest`
 * (this package does not depend on the runtime). Versions are exact: the bundler never
 * resolves ranges or `latest`.
 */
export interface Manifest {
  template: TemplateId;
  /** Entry file, e.g. `src/main.tsx`. */
  entry: string;
  /** Package name -> exact version. */
  dependencies: Record<string, string>;
  tailwind: boolean;
}

export interface Workspace {
  files: FileMap;
  manifest: Manifest;
}
