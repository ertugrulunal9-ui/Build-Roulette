'use client';

/**
 * One import of a built site (docs/09 §9.2, §9.5) from a drop, one of the two pickers or the
 * link of a published site (docs/10): `@br/site` reads, checks and packs a folder or a .zip,
 * the `import-url` function copies a link (link-import.ts). This hook keeps the state the
 * drop zone shows (reading or copying, or why it failed) and sends the `site_import`
 * analytics event. What the caller does with a good site (the live preview, the battle's
 * autosave) is up to `onImported`, the same for every source.
 *
 * A drop must be read inside its `drop` handler (the browser only lends the files for the
 * event), so `fromDrop` starts reading synchronously. A newer import wins over one still
 * being read or copied (a copy is aborted). A link is checked in the page first
 * (`checkPublicUrl`): an obviously bad one fails at once, without a request.
 */
import { checkPublicUrl, type ImportError, type ImportResult, type ImportedSite } from '@br/site';
import { importDrop, importFiles } from '@br/site/browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { track as defaultTrack, type SiteImportProps, type Track } from '../telemetry/analytics';
import type { LinkCopier, LinkError, LinkResult } from './link-import';
import { linkScope, recallLink, rememberLink } from './link-memory';

export type ImportVia = SiteImportProps['source'];
/** The sources that read files (a drop or a picker). */
export type FileVia = Exclude<ImportVia, 'link'>;

export type ImportState =
  | { status: 'idle' }
  | { status: 'reading'; via: ImportVia }
  | { status: 'error'; error: ImportError; via?: FileVia }
  | { status: 'error'; error: LinkError; via: 'link' };

export type ImportErrorState = Extract<ImportState, { status: 'error' }>;

/** The link import of this page: how to copy, and which test origins the check accepts. */
export interface LinkImport {
  copy: LinkCopier;
  /** Exact origins accepted besides the public hosts (e2e builds only, link-config.ts). */
  extraOrigins?: readonly string[];
}

export interface SiteImportOptions {
  /** A good import: show it, save it, count it. */
  onImported: (site: ImportedSite, via: ImportVia) => void;
  /** The battle being built (analytics, the remembered link); null on `/try`. */
  battleId: string | null;
  /** Locked (time is up, shipped): imports are refused quietly. */
  disabled?: boolean;
  /** The link import; null or absent: no link field. */
  link?: LinkImport | null;
  /** Tests: the readers and the analytics. */
  readers?: {
    drop: (dt: DataTransfer) => Promise<ImportResult>;
    files: (files: readonly File[]) => Promise<ImportResult>;
  };
  track?: Track;
}

export interface SiteImport {
  state: ImportState;
  /** Call from the `drop` handler itself. */
  fromDrop: (dataTransfer: DataTransfer) => void;
  /** What a picker gave (a folder's files, or one .zip). */
  fromFiles: (files: readonly File[], via: FileVia) => void;
  /** A pasted link (checked here first). Ignored when the page has no link import. */
  fromLink: (link: string) => void;
  /** Stops a link's copy that is running (the page goes back to where it was). */
  cancel: () => void;
  /** Forget the last error (the drop zone's close button). */
  clearError: () => void;
  /** The last link imported here (this battle, or `/try` in this browser), or null. */
  lastLink: string | null;
  /** The page offers the link import. */
  linkEnabled: boolean;
}

/** `not-built` → `not_built`: analytics properties are lowercase tokens with underscores. */
export function errorToken(code: string): string {
  return code.replace(/-/g, '_');
}

type AnyResult = ImportResult | LinkResult;

export function useSiteImport(opts: SiteImportOptions): SiteImport {
  const [state, setState] = useState<ImportState>({ status: 'idle' });
  const scope = linkScope(opts.battleId);
  const [lastLink, setLastLink] = useState<string | null>(() => recallLink(scope));
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const seq = useRef(0);
  const copying = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copying.current?.abort();
    };
  }, []);

  const send = useCallback((props: Omit<SiteImportProps, 'battle_id'>) => {
    const o = optsRef.current;
    (o.track ?? defaultTrack)('site_import', { battle_id: o.battleId, ...props });
  }, []);

  /** A newer import starts: an older one's answer is ignored, a running copy stopped. */
  const next = useCallback(() => {
    copying.current?.abort();
    copying.current = null;
    return ++seq.current;
  }, []);

  const run = useCallback(
    (via: ImportVia, read: Promise<AnyResult>, n: number, link?: string) => {
      setState({ status: 'reading', via });
      void read
        .catch((e: unknown): AnyResult =>
          via === 'link'
            ? { ok: false, error: { code: 'network' } }
            : {
                ok: false,
                error: {
                  code: 'read-failed',
                  detail: e instanceof Error ? e.message : String(e),
                },
              },
        )
        .then((result) => {
          if (!mounted.current || n !== seq.current) return;
          if (via === 'link') copying.current = null;
          send({
            source: via,
            outcome: result.ok ? 'ok' : 'error',
            error: result.ok ? null : errorToken(result.error.code),
          });
          if (!result.ok) {
            setState(
              via === 'link'
                ? { status: 'error', error: result.error as LinkError, via }
                : { status: 'error', error: result.error as ImportError },
            );
            return;
          }
          if (link !== undefined) {
            rememberLink(linkScope(optsRef.current.battleId), link);
            setLastLink(link);
          }
          setState({ status: 'idle' });
          optsRef.current.onImported(result.site, via);
        });
    },
    [send],
  );

  const fromDrop = useCallback(
    (dataTransfer: DataTransfer) => {
      if (optsRef.current.disabled) return;
      const readers = optsRef.current.readers;
      // Synchronously, before anything awaits: the drop's items are readable only now.
      const read = readers ? readers.drop(dataTransfer) : importDrop(dataTransfer);
      run('drop', read, next());
    },
    [run, next],
  );

  const fromFiles = useCallback(
    (files: readonly File[], via: FileVia) => {
      if (optsRef.current.disabled || files.length === 0) return;
      const readers = optsRef.current.readers;
      run(via, readers ? readers.files(files) : importFiles(files), next());
    },
    [run, next],
  );

  const fromLink = useCallback(
    (text: string) => {
      const o = optsRef.current;
      if (o.disabled || !o.link) return;
      const n = next();
      const checked = checkPublicUrl(text, o.link.extraOrigins ?? []);
      if (!checked.ok) {
        // At once and without a request: the same rules as the function.
        send({ source: 'link', outcome: 'error', error: errorToken(checked.error.code) });
        setState({ status: 'error', error: checked.error, via: 'link' });
        return;
      }
      const controller = new AbortController();
      copying.current = controller;
      run('link', o.link.copy(checked.url, controller.signal), n, checked.url.href);
    },
    [run, next, send],
  );

  const cancel = useCallback(() => {
    if (!copying.current) return;
    next();
    send({ source: 'link', outcome: 'cancelled', error: null });
    setState({ status: 'idle' });
  }, [next, send]);

  const clearError = useCallback(() => {
    setState((s) => (s.status === 'error' ? { status: 'idle' } : s));
  }, []);

  return {
    state,
    fromDrop,
    fromFiles,
    fromLink,
    cancel,
    clearError,
    lastLink,
    linkEnabled: Boolean(opts.link),
  };
}
