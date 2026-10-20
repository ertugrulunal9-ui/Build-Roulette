// @vitest-environment happy-dom
/**
 * The onboarding (T-049): when the welcome screen shows (first visit, seen, storage blocked,
 * only where it is mounted: the lobby, not the battle), its steps and keyboard (Esc, the
 * focus trap), "How it works", the lobby's hints, the guide's Copy button and tabs, and the
 * "How do I import?" help with the import errors' "How do I fix this?".
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOUCH_PRIMARY_QUERY } from '../../lib/device';
import { WELCOME_KEY, resetWelcomeForTests, welcomeStatus } from '../../lib/onboarding/welcome';
import { initialRoomState, type RoomController } from '../../lib/room/controller';
import { roomSnapshot } from '../../lib/room/test-support';
import { Lobby } from '../room/Lobby';
import { DropZone } from '../site/DropZone';
import { en } from '../../lib/i18n/messages/en';
import { GUIDE_PATH, STEP_IDS, TOOL_IDS, TRY_PATH } from './copy';

const GUIDE_COPY = en.guide;
const IMPORT_HELP_COPY = en.importHelp;
const STEPS = STEP_IDS.map((id) => en.steps[id]);
const TOOL_GUIDES = TOOL_IDS.map((id) => ({ id, ...en.guide.tools[id] }));
import { CopyPrompt } from './CopyPrompt';
import { ImportHelp } from './ImportHelp';
import { ToolTabs } from './ToolTabs';
import { HowItWorksButton, HowItWorksLink, Welcome } from './Welcome';

beforeEach(() => {
  window.localStorage.clear();
  resetWelcomeForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const welcome = () => screen.queryByTestId('welcome');
const stepTitle = () => screen.getByTestId('welcome-step-title').textContent;

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('missing element');
  return x;
}

/** Storage that throws on every access (a private window, blocked site data). */
function blockStorage(): void {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
}

describe('when the welcome shows', () => {
  it('a first visit: it opens by itself, as a labelled modal dialog on step 1', () => {
    render(createElement(Welcome));
    const dialog = must(welcome());
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('welcome-title welcome-step-title');
    expect(document.getElementById('welcome-title')?.textContent).toBe('Welcome to Build Roulette');
    expect(stepTitle()).toContain('Spin');
    expect(screen.getByTestId('welcome-step-count').textContent).toBe('Step 1 of 4');
    // Step 1 shows three example cards and the time.
    expect(dialog.querySelector('[data-art="spin"]')?.textContent).toContain('BUILD');
    expect(dialog.textContent).toContain('10 to 45 minutes');
  });

  it('seen before (to the end, or skipped): it stays closed', () => {
    window.localStorage.setItem(WELCOME_KEY, 'done');
    render(createElement(Welcome));
    expect(welcome()).toBeNull();
    cleanup();
    window.localStorage.setItem(WELCOME_KEY, 'skipped');
    render(createElement(Welcome));
    expect(welcome()).toBeNull();
  });

  it('Skip closes it and remembers it as skipped; a reload keeps it closed', () => {
    render(createElement(Welcome));
    fireEvent.click(screen.getByTestId('welcome-skip'));
    expect(welcome()).toBeNull();
    expect(window.localStorage.getItem(WELCOME_KEY)).toBe('skipped');
    cleanup();
    resetWelcomeForTests(); // a new page view: only storage is left
    render(createElement(Welcome));
    expect(welcome()).toBeNull();
  });

  it('storage blocked: it shows, and can still be closed for this page view', () => {
    blockStorage();
    render(createElement(Welcome));
    expect(welcome()).not.toBeNull();
    fireEvent.click(screen.getByTestId('welcome-skip'));
    expect(welcome()).toBeNull();
    // Another part of the page mounting it (a client-side navigation): still closed.
    cleanup();
    render(createElement(Welcome));
    expect(welcome()).toBeNull();
    expect(welcomeStatus()).toBe('skipped');
  });

  it('"How it works" opens it again from step 1', () => {
    window.localStorage.setItem(WELCOME_KEY, 'done');
    render(createElement('div', null, createElement(HowItWorksButton), createElement(Welcome)));
    expect(welcome()).toBeNull();
    fireEvent.click(screen.getByTestId('how-it-works'));
    expect(welcome()).not.toBeNull();
    expect(stepTitle()).toContain('Spin');
    fireEvent.click(screen.getByTestId('welcome-skip'));
    expect(welcome()).toBeNull();
    // Seen to the end before: skipping a second look does not make it "skipped".
    expect(window.localStorage.getItem(WELCOME_KEY)).toBe('done');
  });

  it('"How it works" without the welcome mounted (BUILD, /try) is a link to the guide', () => {
    render(createElement(HowItWorksLink, { newTab: true }));
    const link = screen.getByTestId('how-it-works');
    expect(link.getAttribute('href')).toBe(GUIDE_PATH);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.textContent).toContain('How it works');
    expect(welcome()).toBeNull();
  });
});

describe('steps', () => {
  it('Next ×3 reaches step 4 (Practice first, Let’s play, the guide); Back and the dots move', () => {
    render(createElement(Welcome));
    expect(screen.getByTestId<HTMLButtonElement>('welcome-back').disabled).toBe(true);
    const titles = [stepTitle()];
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByTestId('welcome-next'));
      titles.push(stepTitle());
    }
    expect(titles.map((t) => t.replace(/^\S+ /u, ''))).toEqual(STEPS.map((s) => s.title));
    expect(screen.queryByTestId('welcome-next')).toBeNull();
    expect(screen.getByTestId('welcome-practice').getAttribute('href')).toBe(TRY_PATH);
    expect(screen.getByTestId('welcome-guide').getAttribute('href')).toBe(GUIDE_PATH);
    expect(screen.getByTestId('welcome-play').textContent).toBe("Let's play");
    // Step 3 has the command as code.
    fireEvent.click(screen.getByTestId('welcome-back'));
    expect(stepTitle()).toContain('Build & drop');
    expect(
      [...must(welcome()).querySelectorAll('#welcome-step-text code')].map((c) => c.textContent),
    ).toEqual(['npm run build', 'dist']);
    // The dots: the current one is marked, any one can be picked.
    const dots = screen.getAllByTestId('welcome-dot');
    expect(dots.map((d) => d.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    fireEvent.click(must(dots[0]));
    expect(stepTitle()).toContain('Spin');
  });

  it('Let’s play on the last step closes it as done', () => {
    render(createElement(Welcome));
    fireEvent.click(must(screen.getAllByTestId('welcome-dot')[3]));
    fireEvent.click(screen.getByTestId('welcome-play'));
    expect(welcome()).toBeNull();
    expect(window.localStorage.getItem(WELCOME_KEY)).toBe('done');
  });

  it('Practice first closes it as done (and goes to /try)', () => {
    render(createElement(Welcome));
    fireEvent.click(must(screen.getAllByTestId('welcome-dot')[3]));
    fireEvent.click(screen.getByTestId('welcome-practice'));
    expect(welcome()).toBeNull();
    expect(welcomeStatus()).toBe('done');
  });
});

describe('keyboard', () => {
  it('focus starts on Next and follows the step; arrow keys move', () => {
    render(createElement(Welcome));
    expect(document.activeElement).toBe(screen.getByTestId('welcome-next'));
    fireEvent.keyDown(must(welcome()), { key: 'ArrowRight' });
    expect(stepTitle()).toContain('Build it your way');
    fireEvent.keyDown(must(welcome()), { key: 'ArrowLeft' });
    expect(stepTitle()).toContain('Spin');
    fireEvent.click(must(screen.getAllByTestId('welcome-dot')[3]));
    expect(document.activeElement).toBe(screen.getByTestId('welcome-play'));
  });

  it('Esc closes it (skipped)', () => {
    render(createElement(Welcome));
    fireEvent.keyDown(must(welcome()), { key: 'Escape' });
    expect(welcome()).toBeNull();
    expect(welcomeStatus()).toBe('skipped');
  });

  it('Tab wraps inside the dialog (the focus trap)', () => {
    render(createElement(Welcome));
    const dialog = must(welcome());
    const skip = screen.getByTestId('welcome-skip');
    const guide = screen.getByTestId('welcome-guide');
    guide.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(skip);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(guide);
    // Focus outside the dialog comes back in.
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(skip);
    outside.remove();
  });
});

describe('the room lobby', () => {
  const controller = {
    serverNow: () => Date.now(),
    setReady: vi.fn(),
  } as unknown as RoomController;

  function renderLobby() {
    const room = roomSnapshot();
    const state = initialRoomState('K7QXM');
    return render(createElement(Lobby, { controller, state, room, lastBattle: null }));
  }

  it('a first visit: the welcome (links in a new tab), "New here?" and the reminder', () => {
    renderLobby();
    expect(welcome()).not.toBeNull();
    fireEvent.click(must(screen.getAllByTestId('welcome-dot')[3]));
    expect(screen.getByTestId('welcome-practice').getAttribute('target')).toBe('_blank');
    expect(screen.getByTestId('welcome-guide').getAttribute('target')).toBe('_blank');
    expect(screen.getByTestId('new-here').textContent).toContain('New here?');
    expect(screen.getByTestId('build-reminder').textContent).toContain(
      'Have it open before the host spins',
    );
    // Seen to the end: the card goes; "Show me" is no longer needed.
    fireEvent.click(screen.getByTestId('welcome-play'));
    expect(welcome()).toBeNull();
    expect(screen.queryByTestId('new-here')).toBeNull();
  });

  it('skipped: "New here?" stays and opens the welcome again', () => {
    window.localStorage.setItem(WELCOME_KEY, 'skipped');
    renderLobby();
    expect(welcome()).toBeNull();
    fireEvent.click(screen.getByTestId('new-here-show'));
    expect(welcome()).not.toBeNull();
  });

  it('never outside the lobby: when the battle starts (the lobby goes), so does the welcome, and a pending request with it', () => {
    window.localStorage.setItem(WELCOME_KEY, 'skipped');
    const { unmount } = renderLobby();
    fireEvent.click(screen.getByTestId('new-here-show'));
    expect(welcome()).not.toBeNull();
    unmount(); // SPIN: RoomApp shows the battle instead of the lobby
    expect(welcome()).toBeNull();
    // Back in the lobby after the battle: it does not pop up again by itself.
    renderLobby();
    expect(welcome()).toBeNull();
  });

  it('a phone: no reminder to build (the phone note instead, with the guide)', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === TOUCH_PRIMARY_QUERY,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    window.localStorage.setItem(WELCOME_KEY, 'done');
    renderLobby();
    expect(screen.queryByTestId('build-reminder')).toBeNull();
    const note = screen.getByTestId('phone-lobby-note');
    expect(note.querySelector('a')?.getAttribute('href')).toBe(GUIDE_PATH);
  });
});

/** Replaces `navigator.clipboard` (undefined: no Clipboard API) until the returned restore. */
function stubClipboard(value: Partial<Clipboard> | undefined): () => void {
  const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  return () => {
    if (own) Object.defineProperty(navigator, 'clipboard', own);
    else Reflect.deleteProperty(navigator, 'clipboard');
  };
}

describe('the guide', () => {
  it('Copy writes the prompt line to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const restore = stubClipboard({ writeText });
    render(createElement(CopyPrompt));
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-prompt-button'));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(GUIDE_COPY.prompt);
    expect(screen.getByTestId('copy-prompt-button').textContent).toBe('Copied!');
    restore();
  });

  it('no Clipboard API, or a refusal: a message says to copy it by hand', async () => {
    let restore = stubClipboard(undefined);
    render(createElement(CopyPrompt));
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-prompt-button'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('copy-status').textContent).toBe(GUIDE_COPY.copyFailed);
    cleanup();
    restore();
    restore = stubClipboard({ writeText: () => Promise.reject(new Error('denied')) });
    render(createElement(CopyPrompt));
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-prompt-button'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('copy-status').textContent).toBe(GUIDE_COPY.copyFailed);
    expect(screen.getByTestId('copy-prompt-button').textContent).toBe('Copy');
    restore();
  });

  it('tool tabs: one panel at a time; click and arrow keys switch', () => {
    render(createElement(ToolTabs, { guides: TOOL_GUIDES, label: GUIDE_COPY.toolsLabel }));
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Editor agents',
      'Terminal agents',
      'Web builders',
      'No framework',
    ]);
    const visible = () =>
      screen
        .getAllByRole('tabpanel', { hidden: true })
        .filter((p) => !p.hidden)
        .map((p) => p.id);
    expect(visible()).toEqual(['tool-panel-editor']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    fireEvent.click(must(tabs[2]));
    expect(visible()).toEqual(['tool-panel-web']);
    expect(screen.getByTestId('tool-panel-web').textContent).toContain('Node.js');
    fireEvent.keyDown(must(tabs[2]), { key: 'ArrowRight' });
    expect(visible()).toEqual(['tool-panel-plain']);
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(must(tabs[3]), { key: 'ArrowRight' });
    expect(visible()).toEqual(['tool-panel-editor']);
    fireEvent.keyDown(must(tabs[0]), { key: 'End' });
    expect(tabs[3]?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('"How do I import?"', () => {
  it('closed by default: the steps, where the build is, web builders, the full guide (new tab)', () => {
    render(createElement(ImportHelp));
    const details = screen.getByTestId<HTMLDetailsElement>('import-help');
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('How do I import?');
    expect(screen.getByTestId('import-help-where').textContent).toContain('Vite');
    expect(details.textContent).toContain(IMPORT_HELP_COPY.webBuildersTitle);
    const guide = screen.getByTestId('import-help-guide');
    expect(guide.getAttribute('href')).toBe(GUIDE_PATH);
    expect(guide.getAttribute('target')).toBe('_blank');
  });

  it('an import error: "How do I fix this?" opens the help on the page', () => {
    render(
      createElement(DropZone, {
        state: { status: 'error', error: { code: 'not-built' } },
        openFolder: vi.fn(),
        openZip: vi.fn(),
        onDismissError: vi.fn(),
        help: createElement(ImportHelp),
      }),
    );
    const details = screen.getByTestId<HTMLDetailsElement>('import-help');
    expect(details.open).toBe(false);
    const fix = screen.getByTestId('import-error-fix');
    expect(fix.textContent).toBe('How do I fix this?');
    fireEvent.click(fix);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(details.querySelector('summary'));
  });

  it('no help on the page (the bar over a running preview): the guide’s troubleshooting, new tab', () => {
    render(
      createElement(DropZone, {
        state: { status: 'error', error: { code: 'too-large' } },
        openFolder: vi.fn(),
        openZip: vi.fn(),
        onDismissError: vi.fn(),
      }),
    );
    const fix = screen.getByTestId('import-error-fix');
    expect(fix.getAttribute('href')).toBe(`${GUIDE_PATH}#troubleshooting`);
    expect(fix.getAttribute('target')).toBe('_blank');
  });
});
