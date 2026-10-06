'use client';

import {
  createFile,
  deleteFile,
  isImagePath,
  normalizeWorkspacePath,
  renameFile,
  workspaceUsage,
  writeFile,
} from '@br/workspace';
import { useCallback, useMemo, type ReactNode } from 'react';
import { playgroundConfig } from '../../lib/playground/config';
import { defaultPath, type WorkspaceSession } from '../../lib/playground/use-workspace-session';
import { CodeEditor } from './CodeEditor';
import { FileTree } from './FileTree';
import { PreviewPane } from './PreviewPane';

interface WorkspacePanesProps {
  session: WorkspaceSession;
  dark: boolean;
  /** Drawn over the preview (e.g. "Time's up"). */
  previewOverlay?: ReactNode;
}

/**
 * The three panes of an editing session: file tree, CodeMirror editor and the live preview
 * with its console. Used by `/playground` and the BUILD phase of `/play`.
 */
export function WorkspacePanes({ session, dark, previewOverlay }: WorkspacePanesProps) {
  const {
    workspace,
    apply,
    activePath,
    setActivePath,
    editError,
    setEditError,
    reveal,
    controller,
    snapshot,
    hostRef,
    openDiagnostic,
    readOnly,
  } = session;

  const onEditorChange = useCallback(
    (path: string, text: string) => {
      setEditError(apply((ws) => writeFile(ws, path, text)));
    },
    [apply, setEditError],
  );

  const usage = useMemo(() => workspaceUsage(workspace?.files ?? {}), [workspace]);
  if (!workspace) return null;

  const active =
    activePath !== null && Object.prototype.hasOwnProperty.call(workspace.files, activePath)
      ? activePath
      : defaultPath(workspace);
  const activeValue = workspace.files[active] ?? '';
  const showImage = isImagePath(active) && activeValue.startsWith('data:');

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(20rem,1fr)_minmax(24rem,1fr)] md:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-1">
      <aside className="max-h-48 min-h-0 border-b border-zinc-200 bg-white md:max-h-none md:border-r md:border-b-0 dark:border-zinc-800 dark:bg-zinc-900">
        <FileTree
          paths={Object.keys(workspace.files)}
          activePath={active}
          entry={workspace.manifest.entry}
          usage={usage}
          readOnly={readOnly}
          onOpen={setActivePath}
          onCreate={(path) => {
            const err = apply((ws) => createFile(ws, path));
            const n = normalizeWorkspacePath(path);
            if (err === null && n.ok) setActivePath(n.path);
            return err;
          }}
          onRename={(from, to) => {
            const err = apply((ws) => renameFile(ws, from, to));
            const n = normalizeWorkspacePath(to);
            if (err === null && n.ok && active === from) setActivePath(n.path);
            return err;
          }}
          onDelete={(path) => apply((ws) => deleteFile(ws, path))}
        />
      </aside>

      <section
        className="flex min-h-0 flex-col border-b border-zinc-200 md:border-r md:border-b-0 dark:border-zinc-800"
        aria-label="Editor"
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
          <span className="truncate font-mono text-xs" data-testid="active-file">
            {active}
          </span>
          {readOnly && (
            <span className="ml-auto rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-600 uppercase dark:bg-zinc-800 dark:text-zinc-300">
              Locked
            </span>
          )}
        </div>
        {editError && (
          <p
            role="alert"
            className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          >
            {editError}
          </p>
        )}
        <div className="min-h-0 flex-1">
          {showImage ? (
            <div className="grid h-full place-items-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the workspace, not an optimizable asset */}
              <img src={activeValue} alt={active} className="max-h-full max-w-full" />
            </div>
          ) : (
            <CodeEditor
              path={active}
              value={activeValue}
              dark={dark}
              onChange={onEditorChange}
              reveal={reveal}
              readOnly={readOnly}
            />
          )}
        </div>
      </section>

      <section className="relative min-h-0" aria-label="Preview">
        <PreviewPane
          hostRef={hostRef}
          snapshot={snapshot}
          shellUrl={playgroundConfig.shellUrl}
          onRestart={() => controller?.restartPreview()}
          onDismissErrors={() => controller?.dismissErrors()}
          onClearConsole={() => controller?.clearConsole()}
          onOpenDiagnostic={openDiagnostic}
        />
        {previewOverlay}
      </section>
    </div>
  );
}
