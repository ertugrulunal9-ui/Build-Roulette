'use client';

/**
 * One import of a built site (docs/09 §9.2, §9.5) from a drop or one of the two pickers:
 * `@br/site` reads, checks and packs it, and this hook keeps the state the drop zone shows
 * (reading, or why it failed) and sends the `site_import` analytics event. What the caller
 * does with a good site (the live preview, the battle's autosave) is up to `onImported`.
 *
 * A drop must be read inside its `drop` handler (the browser only lends the files for the
 * event), so `fromDrop` starts reading synchronously. A newer import wins over one still
 * being read.
 */
import { importDrop, importFiles } from '@br/site/browser';
import type { ImportError, ImportResult, ImportedSite } from '@br/site';
import { useCallback, useEffect, useRef, useState } from 'react';
import { track as defaultTrack, type SiteImportProps, type Track } from '../telemetry/analytics';

export type ImportVia = SiteImportProps['via'];

export type ImportState =
  | { status: 'idle' }
  | { status: 'reading'; via: ImportVia }
  | { status: 'error'; error: ImportError };

export interface SiteImportOptions {
  /** A good import: show it, save it, count it. */
  onImported: (site: ImportedSite, via: ImportVia) => void;
  /** The battle being built (analytics); null on `/try`. */
  battleId: string | null;
  /** Locked (time is up, shipped): imports are refused quietly. */
  disabled?: boolean;
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
  fromFiles: (files: readonly File[], via: ImportVia) => void;
  /** Forget the last error (the drop zone's close button). */
  clearError: () => void;
}

/** `not-built` → `not_built`: analytics properties are lowercase tokens with underscores. */
export function errorToken(code: string): string {
  return code.replace(/-/g, '_');
}

export function useSiteImport(opts: SiteImportOptions): SiteImport {
  const [state, setState] = useState<ImportState>({ status: 'idle' });
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback((via: ImportVia, read: Promise<ImportResult>) => {
    const n = ++seq.current;
    setState({ status: 'reading', via });
    void read
      .catch((e: unknown): ImportResult => ({
        ok: false,
        error: { code: 'read-failed', detail: e instanceof Error ? e.message : String(e) },
      }))
      .then((result) => {
        if (!mounted.current || n !== seq.current) return;
        const o = optsRef.current;
        (o.track ?? defaultTrack)('site_import', {
          battle_id: o.battleId,
          via,
          outcome: result.ok ? 'ok' : 'error',
          error: result.ok ? null : errorToken(result.error.code),
        });
        if (!result.ok) {
          setState({ status: 'error', error: result.error });
          return;
        }
        setState({ status: 'idle' });
        o.onImported(result.site, via);
      });
  }, []);

  const fromDrop = useCallback(
    (dataTransfer: DataTransfer) => {
      if (optsRef.current.disabled) return;
      const readers = optsRef.current.readers;
      // Synchronously, before anything awaits: the drop's items are readable only now.
      const read = readers ? readers.drop(dataTransfer) : importDrop(dataTransfer);
      run('drop', read);
    },
    [run],
  );

  const fromFiles = useCallback(
    (files: readonly File[], via: ImportVia) => {
      if (optsRef.current.disabled || files.length === 0) return;
      const readers = optsRef.current.readers;
      run(via, readers ? readers.files(files) : importFiles(files));
    },
    [run],
  );

  const clearError = useCallback(() => {
    setState((s) => (s.status === 'error' ? { status: 'idle' } : s));
  }, []);

  return { state, fromDrop, fromFiles, clearError };
}
