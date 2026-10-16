'use client';

/**
 * The two pickers of the import (docs/09 §9.5): a folder (`<input type="file"
 * webkitdirectory multiple>`: the browser lists every file with its `webkitRelativePath`) and
 * a .zip. The inputs are hidden; the visible buttons call `openFolder` / `openZip`. Each
 * input is emptied after a pick, so the same folder can be picked again after a rebuild.
 */
import { useCallback, useRef, type ReactNode } from 'react';
import type { ImportVia } from '../../lib/site/use-site-import';

export interface FilePickers {
  /** The hidden inputs: render once. */
  inputs: ReactNode;
  openFolder: () => void;
  openZip: () => void;
}

export function useFilePickers(
  onFiles: (files: File[], via: ImportVia) => void,
  disabled = false,
): FilePickers {
  const folderRef = useRef<HTMLInputElement | null>(null);
  const zipRef = useRef<HTMLInputElement | null>(null);

  const onChange = (via: ImportVia) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) onFiles(files, via);
  };

  const inputs = (
    <>
      <input
        ref={(el) => {
          folderRef.current = el;
          // Not in React's input attributes: set as plain DOM attributes.
          el?.setAttribute('webkitdirectory', '');
          el?.setAttribute('directory', '');
        }}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        data-testid="import-folder-input"
        onChange={onChange('folder')}
      />
      <input
        ref={zipRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        data-testid="import-zip-input"
        onChange={onChange('zip')}
      />
    </>
  );

  const openFolder = useCallback(() => {
    folderRef.current?.click();
  }, []);
  const openZip = useCallback(() => {
    zipRef.current?.click();
  }, []);

  return { inputs, openFolder, openZip };
}
