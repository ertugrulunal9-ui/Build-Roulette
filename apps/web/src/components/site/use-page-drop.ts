'use client';

/**
 * Files dropped anywhere on the page (docs/09 §9.5: the whole stage takes a drop, not only
 * the drop zone). Listens on `window`:
 *
 * - while files are dragged over the page, `dragging` is true, and the caller shows a
 *   full-screen overlay. The overlay matters for the preview: a cross-site iframe swallows
 *   drag events, so once the overlay covers it the drop lands on the app instead of the site.
 *   (A drag that enters the window right over the preview, without crossing the app's own
 *   chrome first, is the iframe's until it reaches the app.)
 * - a drop never navigates the page to the dropped file (that would leave the battle), also
 *   while imports are closed (`enabled` false: no overlay, the drop is ignored).
 *
 * `onDrop` runs inside the `drop` event, so the files can be read (see `importDrop`).
 */
import { useEffect, useRef, useState } from 'react';

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function usePageDrop(onDrop: (dataTransfer: DataTransfer) => void, enabled: boolean) {
  const [dragging, setDragging] = useState(false);
  const onDropRef = useRef(onDrop);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    onDropRef.current = onDrop;
    enabledRef.current = enabled;
  }, [onDrop, enabled]);

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = enabledRef.current ? 'copy' : 'none';
      if (enabledRef.current) setDragging(true);
    };
    const leave = (e: DragEvent) => {
      // Out of the window (no element to go to), not from one element to another.
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) && (e.dataTransfer?.files.length ?? 0) === 0) return;
      e.preventDefault();
      setDragging(false);
      if (enabledRef.current && e.dataTransfer) onDropRef.current(e.dataTransfer);
    };
    const end = () => {
      setDragging(false);
    };
    window.addEventListener('dragenter', over);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragenter', over);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', end);
    };
  }, []);

  return { dragging: dragging && enabled };
}
