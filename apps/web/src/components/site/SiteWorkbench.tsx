'use client';

/**
 * The main area of the BUILD stage and of `/try` (docs/09 §9.5): before the first import a
 * large drop zone, afterwards the live preview of the imported site under a bar that says
 * what was imported, with "Import again". Files dropped anywhere on the page are imported
 * too, with a full-screen overlay while they are dragged. With Supabase in the build, the
 * player can also paste the link of a published site (docs/10): the `import-url` function
 * copies it, and the copy takes the same path as a dropped folder (`onImported`).
 *
 * The site itself is the caller's (`site`, `onImported`): the battle's controller (autosave,
 * ship) on the BUILD stage, plain component state on `/try`. This component owns the preview
 * (PreviewController, attached at once so the sandbox is ready by the first import) and loads
 * every new `site` into it.
 */
import type { ImportedSite } from '@br/site';
import './site-workbench.css';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { previewConfig } from '../../lib/preview/config';
import { PreviewController } from '../../lib/preview/preview-controller';
import { useT } from '../../lib/i18n/context';
import { linkImportAvailable, linkTestOrigins } from '../../lib/site/link-config';
import { supabaseLinkCopier } from '../../lib/site/link-import';
import { useSiteImport, type ImportVia, type LinkImport } from '../../lib/site/use-site-import';
import { supabaseConfig } from '../../lib/supabase/config';
import { PreviewHealth } from '../../lib/telemetry/sandbox-health';
import { DropZone } from './DropZone';
import { ImportBar } from './ImportBar';
import { PreviewPane } from './PreviewPane';
import { useFilePickers } from './use-file-pickers';
import { usePageDrop } from './use-page-drop';

const noopSubscribe = () => () => undefined;
const initialSnapshot = () => PreviewController.initialSnapshot;

/**
 * The app's link import: the `import-url` function with the player's session (signed in
 * anonymously on first use: `/try` asks Supabase nothing until a link is imported). Null
 * when the build has no Supabase.
 */
export function defaultLinkImport(): LinkImport | null {
  if (!linkImportAvailable) return null;
  return { copy: supabaseLinkCopier(supabaseConfig.url), extraOrigins: linkTestOrigins };
}

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
  /** The link import (docs/10); default `defaultLinkImport()`, null hides the link field. */
  linkImport?: LinkImport | null;
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
  linkImport,
}: SiteWorkbenchProps) {
  const t = useT();
  const frameTitle = t.importUi.frameTitle;
  const frameTitleRef = useRef(frameTitle);
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
      frameTitle: frameTitleRef.current,
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

  // A language switch renames the iframe for screen readers; the preview keeps running.
  useEffect(() => {
    frameTitleRef.current = frameTitle;
    preview?.setFrameTitle(frameTitle);
  }, [preview, frameTitle]);

  const snapshot = useSyncExternalStore(
    preview?.subscribe ?? noopSubscribe,
    preview?.getSnapshot ?? initialSnapshot,
    initialSnapshot,
  );

  const link = useMemo(
    () => (linkImport === undefined ? defaultLinkImport() : linkImport),
    [linkImport],
  );
  const importer = useSiteImport({ onImported, battleId, disabled: locked, link });
  const linkControls = importer.linkEnabled
    ? { onSubmit: importer.fromLink, onCancel: importer.cancel, lastLink: importer.lastLink }
    : null;
  const pickers = useFilePickers(importer.fromFiles, locked);
  const { dragging } = usePageDrop(importer.fromDrop, !locked);

  return (
    <div className="br-site-workbench" data-testid="site-workbench">
      {pickers.inputs}
      {site && (
        <ImportBar
          site={site}
          state={importer.state}
          openFolder={pickers.openFolder}
          openZip={pickers.openZip}
          onDismissError={importer.clearError}
          disabled={locked}
          link={linkControls}
        />
      )}
      <div className="br-site-workbench__preview">
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
            <div className="br-site-workbench__drop-layer">
              <DropZone
                state={importer.state}
                openFolder={pickers.openFolder}
                openZip={pickers.openZip}
                onDismissError={importer.clearError}
                dragging={dragging}
                disabled={locked}
                restoring={restoring}
                help={help}
                link={linkControls}
              />
            </div>
          )}
        </PreviewPane>
        {overlay}
      </div>
      {dragging && (
        <div data-testid="drop-overlay" className="br-site-drop-overlay">
          <p className="br-site-drop-overlay__message">{t.importUi.dropOverlay}</p>
        </div>
      )}
    </div>
  );
}
