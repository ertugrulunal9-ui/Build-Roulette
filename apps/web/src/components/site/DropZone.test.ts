// @vitest-environment happy-dom
/**
 * The import UI's states (docs/09 §9.5): the drop zone before the first import (idle,
 * dragging, reading, an error with what to do, closed), the bar over the preview after one,
 * and `useSiteImport` (a good import, a refused one, a newer import winning, analytics
 * without names).
 */
import type { ImportResult } from '@br/site';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSite } from '../../lib/solo/test-support';
import { errorToken, useSiteImport, type ImportState } from '../../lib/site/use-site-import';
import { CodeText } from './CodeText';
import { DropZone } from './DropZone';
import { ImportBar } from './ImportBar';

afterEach(() => {
  cleanup();
});

function renderZone(state: ImportState, extra: Partial<Parameters<typeof DropZone>[0]> = {}) {
  const props = {
    state,
    openFolder: vi.fn(),
    openZip: vi.fn(),
    onDismissError: vi.fn(),
    ...extra,
  };
  render(createElement(DropZone, props));
  return props;
}

describe('DropZone', () => {
  it('idle: the title, the two pickers (buttons), the three steps', () => {
    const props = renderZone({ status: 'idle' });
    expect(screen.getByTestId('drop-title').textContent).toBe('Drop your built site here');
    expect(screen.getByTestId('drop-zone').dataset['state']).toBe('idle');
    // `dist` is code.
    expect(screen.getByTestId('drop-zone').querySelector('code')?.textContent).toBe('dist');
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }));
    fireEvent.click(screen.getByRole('button', { name: /Choose \.zip/ }));
    expect(props.openFolder).toHaveBeenCalledTimes(1);
    expect(props.openZip).toHaveBeenCalledTimes(1);
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual([
      '1Build it with your own AI tool on your computer.',
      '2Run its build (npm run build) — plain HTML needs none.',
      '3Drop the dist folder here.',
    ]);
    // No help yet: the slot only shows when the onboarding fills it.
    expect(screen.queryByTestId('import-help-slot')).toBeNull();
  });

  it('the "How do I import?" slot shows what it is given', () => {
    renderZone({ status: 'idle' }, { help: createElement('p', null, 'How do I import?') });
    expect(screen.getByTestId('import-help-slot').textContent).toBe('How do I import?');
  });

  it('dragging and reading show; the pickers wait while reading', () => {
    renderZone({ status: 'idle' }, { dragging: true });
    expect(screen.getByTestId('drop-zone').dataset['state']).toBe('dragging');
    cleanup();
    renderZone({ status: 'reading', via: 'drop' });
    expect(screen.getByTestId('drop-zone').dataset['state']).toBe('reading');
    expect(screen.getByTestId('import-reading').textContent).toBe('Reading files…');
    expect(screen.queryByRole('button', { name: /Choose folder/ })).toBeNull();
  });

  it('an error: its title and what to do, with code spans; the pickers stay', () => {
    const props = renderZone({ status: 'error', error: { code: 'not-built' } });
    expect(screen.getByTestId('import-error-title').textContent).toBe(
      'This is source code, not the built site',
    );
    const hint = screen.getByTestId('import-error-hint');
    expect([...hint.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'npm run build',
      'dist',
    ]);
    expect(hint.textContent).not.toContain('`');
    expect(screen.getByRole('button', { name: /Choose folder/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(props.onDismissError).toHaveBeenCalledTimes(1);
  });

  it('closed (time is up, shipped): says so, no pickers', () => {
    renderZone({ status: 'idle' }, { disabled: true });
    expect(screen.getByTestId('drop-zone').dataset['state']).toBe('disabled');
    expect(screen.getByTestId('import-locked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Choose/ })).toBeNull();
  });

  it('while an earlier import is brought back', () => {
    renderZone({ status: 'idle' }, { restoring: true });
    expect(screen.getByTestId('drop-title').textContent).toBe('Bringing back your last import…');
  });

  it('CodeText renders backticks as code and never as HTML', () => {
    render(createElement(CodeText, { text: 'run `<b>x</b>` then `y`' }));
    const codes = document.querySelectorAll('code');
    expect([...codes].map((c) => c.textContent)).toEqual(['<b>x</b>', 'y']);
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('ImportBar', () => {
  const props = (over: Partial<Parameters<typeof ImportBar>[0]> = {}) => ({
    site: { ...fakeSite('Bar', { 'a.js': 'x' }), bytes: 340 * 1024 },
    state: { status: 'idle' } as ImportState,
    openFolder: vi.fn(),
    openZip: vi.fn(),
    onDismissError: vi.fn(),
    ...over,
  });

  it('what was imported: the folder, files, size, skipped; Import again opens both choices', () => {
    const p = props();
    render(createElement(ImportBar, p));
    const summary = screen.getByTestId('import-summary');
    expect(summary.textContent).toBe('📦Importeddist· 2 files · 340 KB · 2 skipped');
    fireEvent.click(screen.getByTestId('import-again'));
    fireEvent.click(screen.getByTestId('import-again-zip'));
    expect(p.openZip).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('import-again'));
    fireEvent.click(screen.getByTestId('import-again-folder'));
    expect(p.openFolder).toHaveBeenCalledTimes(1);
  });

  it('a site from the dropped folder itself; a failed new import shows under the bar', () => {
    const p = props({
      site: { ...fakeSite('Root'), root: '', skipped: 0 },
      state: { status: 'error', error: { code: 'no-index' } },
    });
    render(createElement(ImportBar, p));
    expect(screen.getByTestId('import-summary').textContent).toContain('the folder you dropped');
    expect(screen.getByTestId('import-summary').textContent).not.toContain('skipped');
    expect(screen.getByTestId('import-error-title').textContent).toBe('No index.html found');
  });

  it('closed: no Import again', () => {
    render(createElement(ImportBar, props({ disabled: true })));
    expect(screen.queryByTestId('import-again')).toBeNull();
  });
});

describe('useSiteImport', () => {
  const ok = (label: string): ImportResult => ({ ok: true, site: fakeSite(label) });

  function hook(files: (f: readonly File[]) => Promise<ImportResult>, disabled = false) {
    const onImported = vi.fn();
    const track = vi.fn();
    const { result } = renderHook(() =>
      useSiteImport({
        onImported,
        battleId: '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a',
        disabled,
        readers: { drop: () => files([]), files },
        track,
      }),
    );
    return { result, onImported, track };
  }
  const file = new File(['x'], 'index.html');

  it('a good import: reading, then onImported; the event has the outcome only', async () => {
    const site = ok('Good');
    let answer: (r: ImportResult) => void = () => undefined;
    const { result, onImported, track } = hook(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    act(() => {
      result.current.fromFiles([file], 'folder');
    });
    expect(result.current.state).toEqual({ status: 'reading', via: 'folder' });
    expect(onImported).not.toHaveBeenCalled();
    await act(async () => {
      answer(site);
      await Promise.resolve();
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(onImported).toHaveBeenCalledWith(site.ok ? site.site : null, 'folder');
    expect(track).toHaveBeenCalledWith('site_import', {
      battle_id: '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a',
      via: 'folder',
      outcome: 'ok',
      error: null,
    });
  });

  it('a refused import: the error state and its code (no file names) in the event', async () => {
    const { result, onImported, track } = hook(() =>
      Promise.resolve({ ok: false, error: { code: 'not-built', detail: 'secret/path.tsx' } }),
    );
    await act(async () => {
      result.current.fromDrop({} as DataTransfer);
      await Promise.resolve();
    });
    expect(result.current.state).toEqual({
      status: 'error',
      error: { code: 'not-built', detail: 'secret/path.tsx' },
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(
      'site_import',
      expect.objectContaining({
        via: 'drop',
        outcome: 'error',
        error: 'not_built',
      }),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain('secret');
    act(() => {
      result.current.clearError();
    });
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('a newer import wins over one still being read; closed imports are ignored', async () => {
    const pending: ((r: ImportResult) => void)[] = [];
    const { result, onImported } = hook(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    act(() => {
      result.current.fromFiles([file], 'zip');
      result.current.fromFiles([file], 'folder');
    });
    await act(async () => {
      pending[1]?.(ok('Newer'));
      pending[0]?.(ok('Older'));
      await Promise.resolve();
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported.mock.calls[0]?.[1]).toBe('folder');

    const closed = hook(() => Promise.resolve(ok('Closed')), true);
    act(() => {
      closed.result.current.fromFiles([file], 'folder');
    });
    expect(closed.result.current.state).toEqual({ status: 'idle' });
    expect(errorToken('too-many-entries')).toBe('too_many_entries');
  });
});
