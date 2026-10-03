'use client';

import type { Diagnostic } from '@br/runtime';
import {
  TEMPLATES,
  TEMPLATE_IDS,
  createFile,
  createWorkspace,
  deleteFile,
  describeWorkspaceError,
  isImagePath,
  isTemplateId,
  normalizeWorkspacePath,
  renameFile,
  workspaceUsage,
  writeFile,
  type TemplateId,
  type Workspace,
  type WorkspaceResult,
} from '@br/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { playgroundConfig } from '../../lib/playground/config';
import { SandboxController, type SandboxSnapshot } from '../../lib/playground/sandbox';
import {
  usePersistentWorkspace,
  type SaveState,
} from '../../lib/playground/use-persistent-workspace';
import { usePrefersDark } from '../../lib/playground/use-prefers-dark';
import { CodeEditor, type RevealRequest } from './CodeEditor';
import { FileTree } from './FileTree';
import { PasteImportDialog } from './PasteImportDialog';
import { PreviewPane } from './PreviewPane';

/** One single-player workspace for now; rooms get their own ids later. */
const WORKSPACE_ID = 'playground';

const noopSubscribe = () => () => undefined;
const initialSnapshot = () => SandboxController.initialSnapshot;

function defaultPath(ws: Workspace): string {
  if (Object.prototype.hasOwnProperty.call(ws.files, 'src/App.tsx')) return 'src/App.tsx';
  if (Object.prototype.hasOwnProperty.call(ws.files, ws.manifest.entry)) return ws.manifest.entry;
  return Object.keys(ws.files)[0] ?? ws.manifest.entry;
}

function buildStatus(s: SandboxSnapshot): { text: string; tone: 'muted' | 'ok' | 'error' } {
  if (s.bundler === 'booting') return { text: 'Starting bundler…', tone: 'muted' };
  if (s.bundler === 'failed') return { text: 'Bundler failed', tone: 'error' };
  if (s.building) return { text: 'Building…', tone: 'muted' };
  if (!s.lastBuild) return { text: '', tone: 'muted' };
  if (!s.lastBuild.ok) {
    const n = s.lastBuild.diagnostics.filter((d) => d.severity === 'error').length;
    return { text: `Build failed · ${String(n)} problem${n === 1 ? '' : 's'}`, tone: 'error' };
  }
  return { text: `Built in ${String(Math.round(s.lastBuild.durationMs))} ms`, tone: 'ok' };
}

const SAVE_TEXT: Record<SaveState, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
  unavailable: 'Not saved (storage blocked)',
};

const headerButton =
  'rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800';

export default function Playground() {
  const { workspace, update, saveState, notice } = usePersistentWorkspace(WORKSPACE_ID);
  const dark = usePrefersDark();
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<Workspace | null>(null);
  const [controller, setController] = useState<SandboxController | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  // The template picked in the menu; until the user picks one, the menu shows the template
  // the (possibly restored) workspace was created from.
  const [pickedTemplate, setPickedTemplate] = useState<TemplateId | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? initialSnapshot,
    initialSnapshot,
  );

  useEffect(() => {
    wsRef.current = workspace;
  }, [workspace]);

  // Start the sandbox once the workspace has been loaded from IndexedDB.
  const loaded = workspace !== null;
  useEffect(() => {
    const host = hostRef.current;
    const ws = wsRef.current;
    if (!loaded || !host || !ws) return;
    const c = new SandboxController(host, playgroundConfig);
    setController(c);
    void c.start(ws);
    return () => {
      c.dispose();
      setController(null);
    };
  }, [loaded]);

  useEffect(() => {
    if (controller && workspace) controller.sync(workspace);
  }, [controller, workspace]);

  /** Applies an edit; returns an error message for the UI, or null. */
  const apply = useCallback(
    (fn: (ws: Workspace) => WorkspaceResult): string | null => {
      const ws = wsRef.current;
      if (!ws) return 'The workspace is still loading.';
      const result = fn(ws);
      if (!result.ok) return result.errors.map(describeWorkspaceError).join(' ');
      wsRef.current = result.workspace;
      update(result.workspace);
      return null;
    },
    [update],
  );

  const onEditorChange = useCallback(
    (path: string, text: string) => {
      setEditError(apply((ws) => writeFile(ws, path, text)));
    },
    [apply],
  );

  const onOpenDiagnostic = useCallback((d: Diagnostic) => {
    if (d.file === undefined) return;
    setActivePath(d.file);
    setReveal({ path: d.file, line: d.line ?? 1, column: d.column ?? 0, key: Date.now() });
  }, []);

  const usage = useMemo(() => workspaceUsage(workspace?.files ?? {}), [workspace]);

  if (!workspace) {
    return (
      <main className="grid h-dvh place-items-center text-sm text-zinc-500">
        Loading your workspace…
      </main>
    );
  }

  const active =
    activePath !== null && Object.prototype.hasOwnProperty.call(workspace.files, activePath)
      ? activePath
      : defaultPath(workspace);
  const activeValue = workspace.files[active] ?? '';
  const showImage = isImagePath(active) && activeValue.startsWith('data:');
  const status = buildStatus(snapshot);
  // Stored workspaces are validated on load, so their template is always a known id.
  const template: TemplateId = pickedTemplate ?? workspace.manifest.template;

  return (
    <main className="flex h-dvh flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-sm font-bold tracking-tight">
          Build Roulette <span className="font-normal text-zinc-500">· Playground</span>
        </h1>
        <button
          type="button"
          onClick={() => {
            setPasteOpen(true);
          }}
          className={headerButton}
        >
          Paste import
        </button>
        <div className="flex items-center gap-1.5">
          <label htmlFor="template" className="text-xs text-zinc-500">
            Template
          </label>
          <select
            id="template"
            value={template}
            onChange={(e) => {
              if (isTemplateId(e.target.value)) setPickedTemplate(e.target.value);
            }}
            className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            {TEMPLATE_IDS.map((id) => (
              <option key={id} value={id}>
                {TEMPLATES[id].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Replace all files with the ${TEMPLATES[template].label} template? Your current files will be lost.`,
                )
              ) {
                apply(() => ({ ok: true, workspace: createWorkspace(template) }));
                setActivePath(null);
                setEditError(null);
              }
            }}
            className={headerButton}
          >
            Reset to template
          </button>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span
            data-testid="build-status"
            className={
              status.tone === 'error'
                ? 'text-red-600 dark:text-red-400'
                : status.tone === 'ok'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-zinc-500'
            }
          >
            {status.text}
          </span>
          <span data-testid="save-status" data-state={saveState} className="text-zinc-500">
            {SAVE_TEXT[saveState]}
          </span>
        </div>
      </header>

      {notice && (
        <p
          role="status"
          className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {notice}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(20rem,1fr)_minmax(24rem,1fr)] md:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-1">
        <aside className="max-h-48 min-h-0 border-b border-zinc-200 bg-white md:max-h-none md:border-r md:border-b-0 dark:border-zinc-800 dark:bg-zinc-900">
          <FileTree
            paths={Object.keys(workspace.files)}
            activePath={active}
            entry={workspace.manifest.entry}
            usage={usage}
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
              />
            )}
          </div>
        </section>

        <section className="min-h-0" aria-label="Preview">
          <PreviewPane
            hostRef={hostRef}
            snapshot={snapshot}
            shellUrl={playgroundConfig.shellUrl}
            onRestart={() => controller?.restartPreview()}
            onDismissErrors={() => controller?.dismissErrors()}
            onClearConsole={() => controller?.clearConsole()}
            onOpenDiagnostic={onOpenDiagnostic}
          />
        </section>
      </div>

      <PasteImportDialog
        open={pasteOpen}
        workspace={workspace}
        onClose={() => {
          setPasteOpen(false);
        }}
        onImport={(next, paths) => {
          apply(() => ({ ok: true, workspace: next }));
          setPasteOpen(false);
          setEditError(null);
          const first = paths[0];
          if (first !== undefined) setActivePath(first);
        }}
      />
    </main>
  );
}
