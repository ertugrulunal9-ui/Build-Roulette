export type { FileMap, Manifest, TemplateId, Workspace } from './types';
export {
  MAX_PATH_DEPTH,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
  basename,
  describePathError,
  dirname,
  extname,
  normalizeWorkspacePath,
  type PathErrorReason,
  type PathResult,
} from './paths';
export {
  BINARY_IMAGE_EXTENSIONS,
  LIMITS,
  byteLength,
  describeWorkspaceError,
  imageByteSize,
  isImagePath,
  totalBytes,
  validateFileContents,
  validateFiles,
  validateWorkspace,
  workspaceUsage,
  type WorkspaceError,
  type WorkspaceResult,
  type WorkspaceUsage,
} from './limits';
export {
  ENTRY_CANDIDATES,
  createFile,
  deleteFile,
  guessEntry,
  importFiles,
  renameFile,
  writeFile,
  type ImportMode,
} from './operations';
export {
  DEFAULT_TEMPLATE,
  REACT_VERSION,
  TEMPLATES,
  TEMPLATE_IDS,
  createWorkspace,
  isTemplateId,
  type Template,
} from './templates';
export {
  WORKSPACE_DB_NAME,
  createAutosaver,
  openWorkspaceStore,
  parseStoredWorkspace,
  type Autosaver,
  type AutosaverOptions,
  type LoadResult,
  type OpenStoreOptions,
  type StoredWorkspace,
  type WorkspaceStore,
  type WorkspaceSummary,
} from './persistence';
export {
  describePasteWarning,
  filenameFromProseLine,
  looksLikeFilePath,
  parsePasteImport,
  type PasteFileSource,
  type PasteImportOptions,
  type PasteImportResult,
  type PasteWarning,
  type PastedFile,
} from './paste-import';
export {
  detectBareImports,
  importSpecifiers,
  missingDependencies,
  packageNameOf,
  type BareImport,
} from './bare-imports';
