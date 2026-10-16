'use client';

/**
 * The main area of the BUILD stage and of `/try` (docs/09 §9.5): before the first import a
 * large drop zone, afterwards the live preview of the imported site under a bar that says
 * what was imported, with "Import again". Files dropped anywhere on the page are imported
 * too, with a full-screen overlay while they are dragged.
 *
 * The site itself is the caller's (`site`, `onImported`): the battle's controller (autosave,
 * ship) on the BUILD stage, plain component state on `/try`. This component owns the preview
 * (PreviewController, attached at once so the sandbox is ready by the first import) and loads
 * every new `site` into it.
 */
import type { ImportedSite } from '@br/site';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { previewConfig } from '../../lib/preview/config';
import { PreviewController } from '../../lib/preview/preview-controller';
import { useSiteImport, type ImportVia } from '../../lib/site/use-site-import';
import { PreviewHealth } from '../../lib/telemetry/sandbox-health';
import { IMPORT_COPY } from './copy';
import { DropZone } from './DropZone';
import { ImportBar } from './ImportBar';
import { PreviewPane } from './PreviewPane';
import { useFilePickers } from './use-file-pickers';
import { usePageDrop } from './use-page-drop';

const noopSubscribe = () => () => undefined;
const initialSnapshot = () => PreviewController.initialSnapshot;

export interface SiteWorkbenchProps {
  /** The imported site (what the preview runs), or null before the first import. */
  site: ImportedSite | null;
  /** A good import. */
  onImported: (site: ImportedSite, via: ImportVia) => void;
  /** The battle (analytics and the preview's watchdog telemetry); null on `/try`. */
  battleId: string | null;
  /** Imports are closed (time is up, shipped, not a player). */
  locked?: boolean;
  /** An earlier import is being brought back (a reload during BUILD). */
  restoring?: boolean;
  /** Drawn over the whole area (e.g. "Time's up"). */
  overlay?: ReactNode;
  /** The live preview, for the ship thumbnail (null when it goes). */
  onPreview?: (preview: PreviewController | null) => void;
  /** The "How do I import?" help next to the drop zone's steps (T-049). */
  help?: ReactNode;
}

export function SiteWorkbench({
  site,
  onImported,
  battleId,
  locked = false,
  restoring = false,
  overlay,
  onPreview,
  help,
}: SiteWorkbenchProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewController | null>(null);
  const onPreviewRef = useRef(onPreview);
  useEffect(() => {
    onPreviewRef.current = onPreview;
  }, [onPreview]);

  // The preview is attached once, before anything is imported.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = new PreviewController(host, previewConfig, {
      health: new PreviewHealth({ mode: 'live', battleId }),
    });
    // The controller is an external system with its own lifecycle, created per mount.
    setPreview(c);
    onPreviewRef.current?.(c);
    return () => {
      onPreviewRef.current?.(null);
      c.dispose();
      setPreview(null);
    };
    // The battle is fixed for the component's life (the BUILD stage remounts per battle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every new import (or the restored one) runs in the preview.
  useEffect(() => {
    if (preview && site && preview.current() !== site.pack) preview.load(site.pack);
  }, [preview, site]);

  const snapshot = useSyncExternalStore(
    preview?.subscribe ?? noopSubscribe,
    preview?.getSnapshot ?? initialSnapshot,
    initialSnapshot,
  );

  const importer = useSiteImport({ onImported, battleId, disabled: locked });
  const pickers = useFilePickers(importer.fromFiles, locked);
  const { dragging } = usePageDrop(importer.fromDrop, !locked);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="site-workbench">
      {pickers.inputs}
      {site && (
        <ImportBar
          site={site}
          state={importer.state}
          openFolder={pickers.openFolder}
          openZip={pickers.openZip}
          onDismissError={importer.clearError}
          disabled={locked}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <PreviewPane
          hostRef={hostRef}
          snapshot={snapshot}
          shellUrl={previewConfig.shellUrl}
          onRestart={() => preview?.restartPreview()}
          onDismissErrors={() => preview?.dismissErrors()}
          onClearConsole={() => preview?.clearConsole()}
          hidePanel={!site}
        >
          {!site && (
            <div className="absolute inset-0 z-10 bg-zinc-50 dark:bg-zinc-950">
              <DropZone
                state={importer.state}
                openFolder={pickers.openFolder}
                openZip={pickers.openZip}
                onDismissError={importer.clearError}
                dragging={dragging}
                disabled={locked}
                restoring={restoring}
                help={help}
              />
            </div>
          )}
        </PreviewPane>
        {overlay}
      </div>
      {dragging && (
        <div
          data-testid="drop-overlay"
          className="pointer-events-auto fixed inset-0 z-50 grid place-items-center bg-sky-500/20 p-6 backdrop-blur-[1px] dark:bg-sky-400/20"
        >
          <p className="pointer-events-none rounded-3xl border-4 border-dashed border-sky-500 bg-white/95 px-8 py-6 text-2xl font-black text-sky-900 shadow-2xl dark:border-sky-400 dark:bg-zinc-900/95 dark:text-sky-100">
            📦 {IMPORT_COPY.dropOverlay}
          </p>
        </div>
      )}
    </div>
  );
}
