'use client';

/** Small pieces shared by the room screens. */
import { useEffect, useRef, type ReactNode } from 'react';
import type { Toast } from '../../lib/room/controller';

export function Centered({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <main
      className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 px-6 py-16 text-center"
      data-testid={testId}
    >
      {children}
    </main>
  );
}

const AVATAR_TONES = [
  'bg-sky-500',
  'bg-amber-500',
  'bg-fuchsia-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-lime-500',
  'bg-orange-500',
] as const;

/** A colored initial, stable per user. */
export function Avatar({
  userId,
  name,
  size = 'md',
}: {
  userId: string;
  name: string;
  size?: 'sm' | 'md';
}) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const tone = AVATAR_TONES[h % AVATAR_TONES.length] ?? AVATAR_TONES[0];
  const dims = size === 'sm' ? 'h-7 w-7 text-xs' : 'h-10 w-10 text-base';
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full font-black text-white ${dims} ${tone}`}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** Green when online (Presence), grey otherwise. */
export function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
        online ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.25)]' : 'bg-zinc-400'
      }`}
    />
  );
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <ol
      aria-live="polite"
      className="pointer-events-none fixed right-3 bottom-3 z-50 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <li
          key={t.id}
          data-testid="toast"
          data-kind={t.kind}
          className="pointer-events-auto flex items-start justify-between gap-3 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-semibold text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
        >
          <span>{t.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              onDismiss(t.id);
            }}
            className="opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </li>
      ))}
    </ol>
  );
}

export function ErrorBanner({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      data-testid="action-error"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-4 bg-red-700 px-4 py-2 text-sm text-white"
    >
      <span>{text}</span>
      <button type="button" onClick={onDismiss} className="font-semibold underline">
        Dismiss
      </button>
    </div>
  );
}

/** A modal "are you sure?" (kick a player). */
export function ConfirmDialog({
  open,
  title,
  body,
  confirm,
  busy,
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl bg-white p-6 text-zinc-900 shadow-2xl backdrop:bg-black/60 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <h2 className="text-xl font-black tracking-tight">{title}</h2>
      <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{body}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold dark:border-zinc-700"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="confirm"
          disabled={busy}
          onClick={onConfirm}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {confirm}
        </button>
      </div>
    </dialog>
  );
}

/** "12 s ago", "3 min ago", "2 h ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} min ago`;
  return `${String(Math.round(m / 60))} h ago`;
}
