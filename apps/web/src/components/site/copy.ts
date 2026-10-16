/**
 * The words of the import UI (the BUILD stage and `/try`), in one place so the English /
 * Turkish switch (T-050) can take them over. Backticks mark code (`CodeText` renders them as
 * `<code>`), like `describeImportError` from `@br/site`.
 */
export const IMPORT_COPY = {
  dropTitle: 'Drop your built site here',
  dropSub: 'the `dist` folder (or your whole project folder) or a .zip',
  chooseFolder: 'Choose folder',
  chooseZip: 'Choose .zip',
  /** Over the whole page while files are dragged over it. */
  dropOverlay: 'Drop to import your site',
  reading: 'Reading files…',
  restoring: 'Bringing back your last import…',
  stepsTitle: 'In three steps',
  steps: [
    'Build it with your own AI tool on your computer.',
    'Run its build (`npm run build`) — plain HTML needs none.',
    'Drop the `dist` folder here.',
  ],
  importAgain: 'Import again',
  importedFrom: 'Imported',
  droppedFolder: 'the folder you dropped',
  dismiss: 'Dismiss',
  /** No more imports (time is up, shipped). */
  locked: 'Imports are closed for this build.',
  problems: 'Problems',
  console: 'Console',
  noProblems: 'No problems.',
  consoleEmpty: 'Console output from your site shows up here.',
  clear: 'Clear',
} as const;

/** `3 files`, `1 file`. */
export function filesText(n: number): string {
  return `${String(n)} ${n === 1 ? 'file' : 'files'}`;
}

/** `2 skipped` (files of the drop that are not part of the site). */
export function skippedText(n: number): string {
  return `${String(n)} skipped`;
}
