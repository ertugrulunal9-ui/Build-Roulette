'use client';

import {
  TEMPLATES,
  TEMPLATE_IDS,
  createWorkspace,
  isTemplateId,
  type TemplateId,
} from '@br/workspace';
import { useState } from 'react';
import type { SaveState } from '../../lib/playground/use-persistent-workspace';
import { usePrefersDark } from '../../lib/playground/use-prefers-dark';
import { buildStatus, useWorkspaceSession } from '../../lib/playground/use-workspace-session';
import { BuildStatusText } from './BuildStatusText';
import { PasteImportDialog } from './PasteImportDialog';
import { WorkspacePanes } from './WorkspacePanes';

/** One single-player workspace for now; rooms get their own ids later. */
const WORKSPACE_ID = 'playground';

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
  const session = useWorkspaceSession(WORKSPACE_ID);
  const { workspace, saveState, notice, snapshot, apply, setActivePath, setEditError } = session;
  const dark = usePrefersDark();
  const [pasteOpen, setPasteOpen] = useState(false);
  // The template picked in the menu; until the user picks one, the menu shows the template
  // the (possibly restored) workspace was created from.
  const [pickedTemplate, setPickedTemplate] = useState<TemplateId | null>(null);

  if (!workspace) {
    return (
      <main className="grid h-dvh place-items-center text-sm text-zinc-500">
        Loading your workspace…
      </main>
    );
  }

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
          <BuildStatusText status={buildStatus(snapshot)} />
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

      <WorkspacePanes session={session} dark={dark} />

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
