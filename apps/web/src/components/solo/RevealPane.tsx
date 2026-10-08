'use client';

/**
 * The "last look": the shipped bundle running in a fresh preview iframe in **reveal** mode
 * (no popups, no modals, no clipboard; docs/03 §3.9) until DESTROY. The sandbox origin's
 * storage is wiped before the bundle loads (so nothing an earlier build stored there, e.g.
 * during the REVEAL, can reach it), and again when the build is destroyed (or the pane
 * unmounts), then the preview is disposed: nothing of the build stays in this tab.
 * A watchdog crash is a `preview_crash` analytics event (T-031, mode `reveal`; there is no
 * restart here), and the preview's watchdog stats count for the battle's preview health.
 * A build whose packages can't load (the package CDN is down, T-032) says so over the frame.
 */
import { isPackageStall } from '@br/protocol';
import { PreviewHandle, type CrashReason, type PreviewBuild } from '@br/runtime';
import { useEffect, useRef, useState } from 'react';
import { playgroundConfig } from '../../lib/playground/config';
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
  const hostRef = useRef<HTMLDivElement>(null);
  /** Why the watchdog stopped the preview (it froze, or it never started), if it did. */
  const [crashed, setCrashed] = useState<CrashReason | null>(null);
  /** Its code or packages could not load (T-032: the package CDN is unreachable). */
  const [noPackages, setNoPackages] = useState(false);
  const battleIdRef = useRef(battleId);
  useEffect(() => {
    battleIdRef.current = battleId;
  }, [battleId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!build || !host) return;
    const iframe = host.ownerDocument.createElement('iframe');
    iframe.title = 'Your shipped build (last look)';
    iframe.dataset['testid'] = 'reveal-frame';
    iframe.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    host.replaceChildren(iframe);
    const preview = new PreviewHandle(iframe, {
      shellUrl: playgroundConfig.shellUrl,
      mode: 'reveal',
    });
    const health = new PreviewHealth({ mode: 'reveal', battleId: battleIdRef.current });
    health.follow(preview);
    const offCrash = preview.on('crash', (crash) => {
      setCrashed(crash.reason);
      health.crashed(crash);
    });
    const offError = preview.on('error', (m) => {
      // A "still waiting" note is not a failure yet: the build may still start.
      if (m.kind === 'module-load' && !isPackageStall(m.message)) setNoPackages(true);
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
      setNoPackages(false);
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
            Loading your build…
          </p>
        )}
        {status === 'unavailable' && (
          <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-zinc-500">
            Nothing to show: no build was shipped.
          </p>
        )}
        {noPackages && !crashed && destroy === 'none' && (
          <p
            className="absolute inset-x-0 bottom-0 bg-zinc-100/95 p-4 text-center text-sm dark:bg-zinc-900/95"
            data-testid="reveal-no-packages"
          >
            Your build’s packages couldn’t load here: the package server isn’t answering. Its
            screenshot and results are safe.
          </p>
        )}
        {crashed && destroy === 'none' && (
          <p
            className="absolute inset-0 grid place-items-center bg-zinc-100 p-6 text-center text-sm dark:bg-zinc-900"
            data-testid="reveal-crashed"
            data-reason={crashed}
          >
            {crashed === 'handshake-timeout'
              ? 'Your build couldn’t start here: the preview sandbox never answered.'
              : 'Your build froze (it stopped responding), so it was stopped.'}
          </p>
        )}
        {destroy === 'animating' && (
          <div
            className="pointer-events-none absolute inset-0 grid place-items-center"
            data-testid="destroy-moment"
          >
            <p className="br-stamp rounded-lg border-8 border-red-600 bg-black/70 px-6 py-3 text-3xl font-black tracking-widest text-red-500 sm:text-5xl">
              DESTROYING
            </p>
          </div>
        )}
        {destroy === 'done' && (
          <div
            className="absolute inset-0 grid place-items-center bg-zinc-950 p-6 text-center text-white"
            data-testid="build-destroyed"
          >
            <div className="flex flex-col items-center gap-2">
              <p className="br-stamp rounded-lg border-8 border-red-600 px-6 py-3 text-3xl font-black tracking-widest text-red-500 sm:text-4xl">
                BUILD DESTROYED
              </p>
              <p className="max-w-sm text-sm text-zinc-400">
                The code and bundle are gone: from this browser now, and from the server in a
                moment. The results stay forever.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
