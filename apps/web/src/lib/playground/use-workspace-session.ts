'use client';

/**
 * One editing session: a persistent workspace (IndexedDB), the sandbox (bundler worker +
 * preview iframe) mirroring it, and the editor UI state. Shared by `/playground` and the
 * BUILD phase of `/play`, which render it with `<WorkspacePanes>`.
 */
import type { Diagnostic } from '@br/runtime';
import { describeWorkspaceError, type Workspace, type WorkspaceResult } from '@br/workspace';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type { RevealRequest } from '../../components/playground/CodeEditor';
import { playgroundConfig, type PlaygroundConfig } from './config';
import { SandboxController, type SandboxSnapshot } from './sandbox';
import {
  usePersistentWorkspace,
  type PersistentWorkspaceOptions,
  type SaveState,
} from './use-persistent-workspace';

const noopSubscribe = () => () => undefined;
const initialSnapshot = () => SandboxController.initialSnapshot;

export interface WorkspaceSession {
  workspace: Workspace | null;
  /** The latest workspace, also between renders (for callbacks, not for rendering). */
  getWorkspace: () => Workspace | null;
  saveState: SaveState;
  notice: string | null;
  /** The element the SandboxController puts the preview iframe into. */
  hostRef: RefObject<HTMLDivElement | null>;
  controller: SandboxController | null;
  snapshot: SandboxSnapshot;
  /** Applies an edit; returns an error message for the UI, or null. Refused while read-only. */
  apply: (fn: (ws: Workspace) => WorkspaceResult) => string | null;
  /**
   * Replaces the whole project (reset to a template, paste-import in replace mode): the old
   * preview goes away at once and the new files build immediately, as one build and one
   * load (`SandboxController.replace`). Returns an error message, or null.
   */
  replace: (next: Workspace) => string | null;
  activePath: string | null;
  setActivePath: (path: string | null) => void;
  editError: string | null;
  setEditError: (error: string | null) => void;
  reveal: RevealRequest | null;
  openDiagnostic: (d: Diagnostic) => void;
  /** Counts a paste-import (the `pastes` stat). */
  countPaste: () => void;
  /** Paste-imports so far. */
  pasteCount: () => number;
  readOnly: boolean;
}

export function useWorkspaceSession(
  workspaceId: string,
  opts: PersistentWorkspaceOptions & { readOnly?: boolean; config?: PlaygroundConfig } = {},
): WorkspaceSession {
  const { workspace, update, saveState, notice } = usePersistentWorkspace(workspaceId, opts);
  const config = opts.config ?? playgroundConfig;
  const readOnly = opts.readOnly ?? false;
  const hostRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  const readOnlyRef = useRef(readOnly);
  const pastes = useRef(0);
  const [controller, setController] = useState<SandboxController | null>(null);
  /** The controller, also between renders (for callbacks). */
  const controllerRef = useRef<SandboxController | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? initialSnapshot,
    initialSnapshot,
  );

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  // Start the sandbox once the workspace has been loaded.
  const loaded = workspace !== null;
  useEffect(() => {
    const host = hostRef.current;
    const ws = workspaceRef.current;
    if (!loaded || !host || !ws) return;
    const c = new SandboxController(host, config);
    controllerRef.current = c;
    setController(c);
    void c.start(ws);
    return () => {
      c.dispose();
      if (controllerRef.current === c) controllerRef.current = null;
      setController(null);
    };
    // The config is fixed for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => {
    if (controller && workspace) controller.sync(workspace);
  }, [controller, workspace]);

  const apply = useCallback(
    (fn: (ws: Workspace) => WorkspaceResult): string | null => {
      if (readOnlyRef.current) return 'The build is locked.';
      const ws = workspaceRef.current;
      if (!ws) return 'The workspace is still loading.';
      const result = fn(ws);
      if (!result.ok) return result.errors.map(describeWorkspaceError).join(' ');
      workspaceRef.current = result.workspace;
      update(result.workspace);
      return null;
    },
    [update],
  );

  const replace = useCallback(
    (next: Workspace): string | null => {
      if (readOnlyRef.current) return 'The build is locked.';
      if (!workspaceRef.current) return 'The workspace is still loading.';
      workspaceRef.current = next;
      // Right now, in the event handler, not in the sync effect after the next render: the
      // old project's preview must not take a click in between. The effect's sync() then
      // finds the controller already up to date.
      controllerRef.current?.replace(next);
      update(next);
      return null;
    },
    [update],
  );

  const openDiagnostic = useCallback((d: Diagnostic) => {
    if (d.file === undefined) return;
    setActivePath(d.file);
    setReveal({ path: d.file, line: d.line ?? 1, column: d.column ?? 0, key: Date.now() });
  }, []);

  const getWorkspace = useCallback(() => workspaceRef.current, []);
  const countPaste = useCallback(() => {
    pastes.current += 1;
  }, []);
  const pasteCount = useCallback(() => pastes.current, []);

  return {
    workspace,
    getWorkspace,
    saveState,
    notice,
    hostRef,
    controller,
    snapshot,
    apply,
    replace,
    activePath,
    setActivePath,
    editError,
    setEditError,
    reveal,
    openDiagnostic,
    countPaste,
    pasteCount,
    readOnly,
  };
}

/** The file to show first: `src/App.tsx`, else the entry, else the first file. */
export function defaultPath(ws: Workspace): string {
  if (Object.prototype.hasOwnProperty.call(ws.files, 'src/App.tsx')) return 'src/App.tsx';
  if (Object.prototype.hasOwnProperty.call(ws.files, ws.manifest.entry)) return ws.manifest.entry;
  return Object.keys(ws.files)[0] ?? ws.manifest.entry;
}

export function buildStatus(s: SandboxSnapshot): { text: string; tone: 'muted' | 'ok' | 'error' } {
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
