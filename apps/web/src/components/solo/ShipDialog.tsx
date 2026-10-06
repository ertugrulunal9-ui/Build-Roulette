'use client';

import { useEffect, useRef, useState } from 'react';
import type { ShipState } from '../../lib/solo/controller';
import { describeError } from '../../lib/solo/errors';

const PROGRESS: Partial<Record<ShipState['status'], string>> = {
  thumbnail: 'Taking a snapshot…',
  building: 'Building for production…',
  uploading: 'Uploading your build…',
  shipping: 'Shipping…',
  done: 'Shipped!',
};

interface ShipDialogProps {
  open: boolean;
  defaultName: string;
  ship: ShipState;
  onShip: (name: string, opts: { useLastGood?: boolean }) => void;
  onClose: () => void;
}

/** "Ship it? You can't edit after." with the build name (docs/04 §4.4). */
export function ShipDialog({ open, defaultName, ship, onShip, onClose }: ShipDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(defaultName);
  const busy = ship.status !== 'idle' && ship.status !== 'error';
  const trimmed = name.trim();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      data-testid="ship-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/60 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && trimmed.length > 0) onShip(trimmed, {});
        }}
      >
        <h2 className="text-2xl font-black tracking-tight">Ship it?</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          You can&apos;t edit after. Your build is frozen, screenshotted and judged as it is now.
        </p>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Build name
          <input
            data-testid="build-name"
            value={name}
            maxLength={48}
            disabled={busy}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base font-normal dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>

        {busy && (
          <p role="status" className="text-sm font-semibold text-sky-700 dark:text-sky-300">
            {PROGRESS[ship.status]}
          </p>
        )}
        {ship.status === 'error' && ship.error && (
          <p
            role="alert"
            className="text-sm text-red-700 dark:text-red-300"
            data-testid="ship-error"
          >
            {describeError(ship.error)}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold disabled:opacity-50 dark:border-zinc-700"
          >
            Keep building
          </button>
          {ship.status === 'error' && ship.canShipLastGood && (
            <button
              type="button"
              disabled={trimmed.length === 0}
              onClick={() => {
                onShip(trimmed, { useLastGood: true });
              }}
              className="rounded-lg border border-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300"
            >
              Ship the last working preview
            </button>
          )}
          <button
            type="submit"
            data-testid="confirm-ship"
            disabled={busy || trimmed.length === 0}
            className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-black tracking-wide text-white disabled:opacity-50"
          >
            {ship.status === 'error' ? 'Try again' : 'Ship it 🚀'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
