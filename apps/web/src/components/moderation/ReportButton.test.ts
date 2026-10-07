// @vitest-environment happy-dom
/**
 * The report dialog (T-024): reasons, details, the thank-you state, the error texts, and
 * "hide it for me" linked to the REVEAL skip.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportInput } from '../../lib/moderation/report';
import { GameError } from '../../lib/solo/errors';
import { ReportButton } from './ReportButton';

afterEach(cleanup);

function open(submit: (input: ReportInput) => Promise<void>, onHide?: () => void) {
  render(
    createElement(ReportButton, {
      buildId: 'build-1',
      buildLabel: '“Snack Overflow” by Ana',
      submit,
      onHide,
    }),
  );
  fireEvent.click(screen.getByTestId('report-build'));
}

describe('ReportButton', () => {
  it('needs a reason, sends reason + details, then thanks', async () => {
    const submit = vi.fn((_input: ReportInput) => Promise.resolve());
    open(submit);
    expect(screen.getByTestId('report-dialog').textContent).toContain('“Snack Overflow” by Ana');
    expect(screen.getByTestId<HTMLButtonElement>('report-submit').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('report-reason-phishing'));
    fireEvent.change(screen.getByTestId('report-details'), {
      target: { value: 'Asks for a password' },
    });
    fireEvent.click(screen.getByTestId('report-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('report-thanks').textContent).toContain('Thanks for the report');
    });
    expect(submit).toHaveBeenCalledWith({
      buildId: 'build-1',
      reason: 'phishing',
      details: 'Asks for a password',
    });
    expect(screen.getByTestId('report-build').textContent).toContain('Reported');
    expect(screen.queryByTestId('report-details')).toBeNull();
  });

  it('already reported is a thank-you too', async () => {
    open(() => Promise.reject(new GameError('already_reported')));
    fireEvent.click(screen.getByTestId('report-reason-spam'));
    fireEvent.click(screen.getByTestId('report-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('report-thanks').textContent).toContain('already reported');
    });
  });

  it('errors are explained and the form stays', async () => {
    open(() => Promise.reject(new GameError('build_not_found')));
    fireEvent.click(screen.getByTestId('report-reason-other'));
    fireEvent.click(screen.getByTestId('report-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('report-error').textContent).toContain('no longer available');
    });
    cleanup();
    open(() =>
      Promise.reject(
        new GameError(
          'rate_limited',
          'You sent too many reports recently. Try again in 12 minutes.',
        ),
      ),
    );
    fireEvent.click(screen.getByTestId('report-reason-other'));
    fireEvent.click(screen.getByTestId('report-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('report-error').textContent).toBe(
        'You sent too many reports recently. Try again in 12 minutes.',
      );
    });
    expect(screen.getByTestId('report-submit')).toBeTruthy();
  });

  it('"hide it for me" calls onHide, before or after reporting', async () => {
    const onHide = vi.fn();
    open(() => Promise.resolve(), onHide);
    fireEvent.click(screen.getByTestId('report-hide'));
    expect(onHide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('report-build'));
    fireEvent.click(screen.getByTestId('report-reason-offensive'));
    fireEvent.click(screen.getByTestId('report-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('report-thanks')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('report-hide'));
    expect(onHide).toHaveBeenCalledTimes(2);
  });

  it('no onHide, no hide button', () => {
    open(() => Promise.resolve());
    expect(screen.queryByTestId('report-hide')).toBeNull();
  });
});
