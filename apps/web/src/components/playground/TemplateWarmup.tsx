'use client';

/**
 * Warms the browser's HTTP cache with the template's packages before the battle starts
 * (T-032, docs/03 "Package cache and CDN outages"). A hidden preview runs an empty bundle
 * with the default template's import map; the shell then fetches every URL of that map with
 * `cache: 'force-cache'` (apps/sandbox-shell `packages.ts`). It uses the same shell URL as
 * the BUILD and REVEAL previews, so the same cache partition: React then loads from the
 * cache even when the package CDN goes down before SPIN, and a spectator (who never runs a
 * BUILD preview) can still watch the template's React in REVEAL. No build code runs here.
 * Desktop only (the callers skip touch devices, which start REVEAL builds as stills).
 */
import { PreviewHandle, buildImportMap } from '@br/runtime';
import { DEFAULT_TEMPLATE, TEMPLATES } from '@br/workspace';
import { useEffect, useRef } from 'react';
import { playgroundConfig } from '../../lib/playground/config';

/** The empty build whose only job is to hand the shell the template's import map. */
export function warmupBuild(cdnBaseUrl: string) {
  return {
    js: '',
    css: '',
    importMap: buildImportMap(TEMPLATES[DEFAULT_TEMPLATE].manifest.dependencies, cdnBaseUrl),
  };
}

export function TemplateWarmup() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const iframe = host.ownerDocument.createElement('iframe');
    iframe.title = 'Package warm-up (nothing to see)';
    iframe.tabIndex = -1;
    iframe.dataset['testid'] = 'template-warmup';
    iframe.style.cssText = 'width:1px;height:1px;border:0';
    host.replaceChildren(iframe);
    const preview = new PreviewHandle(iframe, {
      shellUrl: playgroundConfig.shellUrl,
      mode: 'reveal',
    });
    preview.load(warmupBuild(playgroundConfig.cdnBaseUrl), 'reveal');
    return () => {
      preview.dispose();
    };
  }, []);
  // Off screen rather than display:none, so the frame loads like any preview.
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 -left-[9999px] h-px w-px overflow-hidden"
    />
  );
}
