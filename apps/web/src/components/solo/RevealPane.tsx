'use client';

/**
 * The "last look": the shipped site running in a fresh preview iframe in **reveal** mode
 * (no popups, no modals, no clipboard; docs/03 §3.9) until DESTROY. The sandbox origin's
 * storage is wiped before the site loads (so nothing an earlier build stored there, e.g.
 * during the REVEAL, can reach it), and again when the build is destroyed (or the pane
 * unmounts), then the preview is disposed: nothing of the build stays in this tab.
 * A watchdog crash is a `preview_crash` analytics event (T-031, mode `reveal`; there is no
 * restart here), and the preview's watchdog stats count for the battle's preview health.
 * A site the sandbox cannot serve in this browser (site-errors.ts) says so over the frame.
 */
import { PreviewHandle, type CrashReason, type PreviewBuild } from '@br/runtime';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n/context';
import { previewConfig } from '../../lib/preview/config';
import { isSiteLoadFailure } from '../../lib/preview/site-errors';
import type { DestroyStage } from '../../lib/solo/controller';
import { PreviewHealth } from '../../lib/telemetry/sandbox-health';

interface RevealPaneProps {
  /** The battle (preview telemetry, T-031). */
  battleId: string;
  build: PreviewBuild | null;
  status: 'none' | 'loading' | 'ready' | 'unavailable' | 'destroyed';
  destroy: DestroyStage;
  /** Shown above the frame (the last-look countdown). */
  caption: string;
}

export function RevealPane({ battleId, build, status, destroy, caption }: RevealPaneProps) {
  const t = useT();
  const words = t.revealPane;
  const hostRef = useRef<HTMLDivElement>(null);
  const frameTitleRef = useRef(words.frameTitle);
  /** Why the watchdog stopped the preview (it froze, or it never started), if it did. */
  const [crashed, setCrashed] = useState<CrashReason | null>(null);
  /** The sandbox could not serve the site in this browser. */
  const [noLoad, setNoLoad] = useState(false);
  const battleIdRef = useRef(battleId);
  useEffect(() => {
    battleIdRef.current = battleId;
  }, [battleId]);

  // A language switch renames the frame; the build keeps running (T-050).
  useEffect(() => {
    frameTitleRef.current = words.frameTitle;
    const iframe = hostRef.current?.querySelector('iframe');
    if (iframe) iframe.title = words.frameTitle;
  }, [words.frameTitle]);

  useEffect(() => {
    const host = hostRef.current;
    if (!build || !host) return;
    const iframe = host.ownerDocument.createElement('iframe');
    iframe.title = frameTitleRef.current;
    iframe.dataset['testid'] = 'reveal-frame';
    iframe.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    host.replaceChildren(iframe);
    const preview = new PreviewHandle(iframe, {
      shellUrl: previewConfig.shellUrl,
      mode: 'reveal',
    });
    const health = new PreviewHealth({ mode: 'reveal', battleId: battleIdRef.current });
    health.follow(preview);
    const offCrash = preview.on('crash', (crash) => {
      setCrashed(crash.reason);
      health.crashed(crash);
    });
    const offError = preview.on('error', (m) => {
      if (isSiteLoadFailure(m)) setNoLoad(true);
    });
    // Wipe what an earlier build (another battle's, or a reveal in this tab) left on the
    // sandbox origin, in a fresh iframe, before this one loads: the load waits for the new
    // shell, which handles the wipe first (as in the REVEAL spotlight).
    void preview.resetStorage(10_000).catch(() => undefined);
    preview.load(build, 'reveal');
    return () => {
      offCrash();
      offError();
      health.close();
      setCrashed(null);
      setNoLoad(false);
      // Wipe what the build stored on the sandbox origin, in a new iframe, then let it go.
      let wiping: Promise<unknown>;
      try {
        wiping = preview.resetStorage(5000);
      } catch {
        wiping = Promise.resolve(); // already crashed or detached
      }
      void wiping
        .catch(() => undefined)
        .finally(() => {
          preview.dispose();
        });
    };
  }, [build]);

  return (
    <section className="flex min-h-[24rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p
        className="border-b border-zinc-200 px-4 py-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:border-zinc-800"
        data-testid="last-look"
      >
        {caption}
      </p>
      <div className="relative min-h-0 flex-1 bg-white">
        <div
          ref={hostRef}
          className={`absolute inset-0 ${destroy === 'animating' ? 'br-destroying' : ''}`}
          data-testid="reveal-host"
          hidden={destroy === 'done'}
        />
        {status === 'loading' && (
          <p className="absolute inset-0 grid place-items-center text-sm text-zinc-500">
            {words.loading}
          </p>
        )}
        {status === 'unavailable' && (
          <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-zinc-500">
            {words.unavailable}
          </p>
        )}
        {noLoad && !crashed && destroy === 'none' && (
          <p
            className="absolute inset-x-0 bottom-0 bg-zinc-100/95 p-4 text-center text-sm dark:bg-zinc-900/95"
            data-testid="reveal-no-load"
          >
            {words.noLoad}
          </p>
        )}
        {crashed && destroy === 'none' && (
          <p
            className="absolute inset-0 grid place-items-center bg-zinc-100 p-6 text-center text-sm dark:bg-zinc-900"
            data-testid="reveal-crashed"
            data-reason={crashed}
          >
            {crashed === 'handshake-timeout' ? words.noStart : words.froze}
          </p>
        )}
        {destroy === 'animating' && (
          <div
            className="pointer-events-none absolute inset-0 grid place-items-center"
            data-testid="destroy-moment"
          >
            <p className="br-stamp rounded-lg border-8 border-red-600 bg-black/70 px-6 py-3 text-3xl font-black tracking-widest text-red-500 sm:text-5xl">
              {words.destroying}
            </p>
          </div>
        )}
        {destroy === 'done' && (
          <div
            className="absolute inset-0 grid place-items-center bg-zinc-950 p-6 text-center text-white"
            data-testid="build-destroyed"
          >
            {/* The gap clears the stamp's corners: rotated -8deg, a ~450 px wide stamp reaches
                ~31 px below its box, onto the line under it. */}
            <div className="flex flex-col items-center gap-10">
              <p className="br-stamp rounded-lg border-8 border-red-600 px-6 py-3 text-3xl font-black tracking-widest text-red-500 sm:text-4xl">
                {words.destroyedStamp}
              </p>
              <p className="max-w-sm text-sm text-zinc-400">{words.destroyedText}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
