'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n/context';
import type { Messages } from '../../lib/i18n/messages/en';
import type { ShipState } from '../../lib/solo/controller';
import { describeError } from '../../lib/solo/errors';
import './solo-screens.css';

function progressText(status: ShipState['status'], m: Messages): string | null {
  if (status === 'thumbnail' || status === 'uploading' || status === 'shipping') {
    return m.ship[status];
  }
  return status === 'done' ? m.ship.done : null;
}

interface ShipDialogProps {
  open: boolean;
  defaultName: string;
  ship: ShipState;
  onShip: (name: string) => void;
  onClose: () => void;
}

/** "Ship it? You can't import again after." with the build name (docs/04 §4.4). */
export function ShipDialog({ open, defaultName, ship, onShip, onClose }: ShipDialogProps) {
  const t = useT();
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
      className="br-ship-dialog"
    >
      <form
        className="br-ship-dialog__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && trimmed.length > 0) onShip(trimmed);
        }}
      >
        <h2 className="text-2xl font-black tracking-tight">{t.ship.title}</h2>
        <p className="br-ship-dialog__description">{t.ship.text}</p>
        <label className="br-ship-dialog__label">
          {t.ship.buildName}
          <input
            data-testid="build-name"
            value={name}
            maxLength={48}
            disabled={busy}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="br-field"
          />
        </label>

        {busy && (
          <p role="status" className="br-import-reading">
            {progressText(ship.status, t)}
          </p>
        )}
        {ship.status === 'error' && ship.error && (
          <p role="alert" className="br-ship-dialog__error" data-testid="ship-error">
            {describeError(ship.error, t)}
          </p>
        )}

        <div className="br-ship-dialog__actions">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="br-btn br-btn--secondary"
          >
            {t.ship.keepBuilding}
          </button>
          <button
            type="submit"
            data-testid="confirm-ship"
            disabled={busy || trimmed.length === 0}
            className="br-btn br-btn--primary"
          >
            {ship.status === 'error' ? t.ship.tryAgain : t.ship.ship}
          </button>
        </div>
      </form>
    </dialog>
  );
}
