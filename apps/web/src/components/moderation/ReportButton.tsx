'use client';

/**
 * "Report" on a build (T-024, docs/02 R9): a small button that opens a dialog with the
 * reasons, optional details and a thank-you state. Used on the REVEAL spotlight chrome, on
 * the RESULTS cards of a room and on the public results page `/battles/[id]`.
 *
 * `onHide` links the report to the viewer's own "hide this build for me" (the REVEAL
 * "Skip this build"): the dialog offers it next to the report and after sending it, since
 * a report takes effect only once a moderator acts.
 *
 * A report that went through is the `report_filed` analytics event (reason and surface
 * only, T-030).
 */
import { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason } from '@br/game';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../lib/i18n/context';
import { submitReport, type SubmitReport } from '../../lib/moderation/report';
import { track as defaultTrack, type Track } from '../../lib/telemetry/analytics';
import { describeError, type GameError } from '../../lib/solo/errors';

type Stage =
  | { kind: 'form' }
  | { kind: 'sending' }
  | { kind: 'thanks'; already: boolean }
  | { kind: 'error'; error: GameError };

interface ReportButtonProps {
  buildId: string;
  /** For people: "“Snack Overflow” by Ana". */
  buildLabel: string;
  /** Dark chrome (REVEAL) or the default light/dark page style. */
  tone?: 'page' | 'dark';
  /** "Hide this build for me" (REVEAL Skip). */
  onHide?: (() => void) | undefined;
  /** Tests inject a fake; the default calls `report_build`. */
  submit?: SubmitReport;
  /** Product analytics (tests pass a spy). */
  track?: Track;
}

export function ReportButton({
  buildId,
  buildLabel,
  tone = 'page',
  onHide,
  submit = submitReport,
  track = defaultTrack,
}: ReportButtonProps) {
  const t = useT();
  const words = t.moderation;
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const close = () => {
    setOpen(false);
    // A finished report stays finished; a half-filled form starts over next time.
    if (stage.kind !== 'thanks') setStage({ kind: 'form' });
  };
  const hide = onHide
    ? () => {
        onHide();
        close();
      }
    : undefined;

  const send = async () => {
    if (reason === null || stage.kind === 'sending') return;
    setStage({ kind: 'sending' });
    try {
      await submit({ buildId, reason, details });
      track('report_filed', { reason, surface: tone === 'dark' ? 'reveal' : 'results' });
      setStage({ kind: 'thanks', already: false });
    } catch (e) {
      const error = e as GameError;
      if (error.code === 'already_reported') setStage({ kind: 'thanks', already: true });
      else setStage({ kind: 'error', error });
    }
  };

  const trigger =
    tone === 'dark'
      ? 'min-h-9 rounded-md border border-amber-300/60 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-400/20'
      : 'rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

  return (
    <>
      <button
        type="button"
        data-testid="report-build"
        data-build={buildId}
        onClick={() => {
          setOpen(true);
        }}
        title={words.reportTitle}
        className={trigger}
      >
        ⚑ {stage.kind === 'thanks' ? words.reported : words.report}
      </button>
      <dialog
        ref={dialogRef}
        data-testid="report-dialog"
        aria-labelledby={`${formId}-title`}
        onCancel={(e) => {
          e.preventDefault();
          if (stage.kind !== 'sending') close();
        }}
        className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/60 dark:bg-zinc-900 dark:text-zinc-100"
      >
        {stage.kind === 'thanks' ? (
          <div className="flex flex-col gap-4 p-6" data-testid="report-thanks">
            <h2 id={`${formId}-title`} className="text-2xl font-black tracking-tight">
              {stage.already ? words.alreadyTitle : words.thanksTitle}
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {stage.already ? words.alreadyText : words.thanksText}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              {hide && (
                <button
                  type="button"
                  data-testid="report-hide"
                  onClick={hide}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {words.hideNow}
                </button>
              )}
              <button
                type="button"
                data-testid="report-close"
                onClick={close}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                {t.common.close}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div>
              <h2 id={`${formId}-title`} className="text-2xl font-black tracking-tight">
                {words.dialogTitle}
              </h2>
              <p className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-400">{buildLabel}</p>
            </div>
            <fieldset className="flex flex-col gap-2" disabled={stage.kind === 'sending'}>
              <legend className="mb-1 text-sm font-semibold">{words.question}</legend>
              {REPORT_REASONS.map((r) => (
                <label
                  key={r}
                  className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2 ${
                    reason === r
                      ? 'border-red-500 bg-red-50 dark:border-red-400 dark:bg-red-950/40'
                      : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <input
                    type="radio"
                    name={`${formId}-reason`}
                    value={r}
                    data-testid={`report-reason-${r}`}
                    checked={reason === r}
                    onChange={() => {
                      setReason(r);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-semibold">{t.reportReasons[r].label}</span>
                    <span className="block text-xs text-zinc-500">{t.reportReasons[r].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-sm font-semibold">
              {words.details}
              <textarea
                data-testid="report-details"
                value={details}
                maxLength={REPORT_DETAILS_MAX}
                rows={3}
                disabled={stage.kind === 'sending'}
                onChange={(e) => {
                  setDetails(e.target.value);
                }}
                placeholder={words.placeholder}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal dark:border-zinc-700 dark:bg-zinc-950"
              />
              <span className="text-right text-xs font-normal text-zinc-500">
                {details.length}/{REPORT_DETAILS_MAX}
              </span>
            </label>
            {stage.kind === 'error' && (
              <p
                role="alert"
                data-testid="report-error"
                className="text-sm text-red-700 dark:text-red-300"
              >
                {stage.error.code === 'build_not_found'
                  ? words.buildGone
                  : describeError(stage.error, t)}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {hide && (
                <button
                  type="button"
                  data-testid="report-hide"
                  onClick={hide}
                  className="mr-auto text-sm font-semibold text-zinc-600 underline underline-offset-2 dark:text-zinc-300"
                >
                  {words.justHide}
                </button>
              )}
              <button
                type="button"
                onClick={close}
                disabled={stage.kind === 'sending'}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {t.common.cancel}
              </button>
              <button
                type="submit"
                data-testid="report-submit"
                disabled={reason === null || stage.kind === 'sending'}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {stage.kind === 'sending' ? words.sending : words.send}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
