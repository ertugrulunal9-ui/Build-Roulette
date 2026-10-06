import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test';

/**
 * Clicks `target` once the browser really routes pointer input at its centre to it.
 *
 * Chromium decides which frame gets a mouse event from the compositor's hit-test data, not
 * from the DOM. Right after a modal dialog opens over the cross-site preview iframe, that
 * data can still show the iframe at the dialog's place (measured under CPU load: 16 of 25
 * first clicks on a freshly opened dialog went to the iframe; one second later, all reached
 * the dialog). A person cannot click a button before it is drawn, but Playwright clicks as
 * soon as the DOM is stable. So this helper hovers the target until the element itself
 * receives the pointer move (proof that routing is up to date), then clicks.
 */
export async function clickRouted(target: Locator): Promise<void> {
  const page = target.page();
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((el) => {
    const e = el as HTMLElement & { __routed?: boolean };
    e.__routed = false;
    el.addEventListener(
      'pointermove',
      () => {
        e.__routed = true;
      },
      { once: true },
    );
  });
  let nudge = 0;
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        if (!box) return false;
        // A slightly different point each time, so every poll is a real pointer move.
        nudge = (nudge + 1) % 3;
        await page.mouse.move(box.x + box.width / 2 + nudge - 1, box.y + box.height / 2);
        return target.evaluate((el) => (el as HTMLElement & { __routed?: boolean }).__routed);
      },
      { message: 'pointer input never reached the element', intervals: [50, 100, 200] },
    )
    .toBe(true);
  await target.click();
}

/** The user's document lives in the shell's child iframe: preview iframe -> build iframe. */
export function buildFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid=preview-frame]').frameLocator('iframe');
}

/** Opens /playground and waits for the first build to render. Collects page errors. */
export async function openPlayground(page: Page): Promise<{ pageErrors: string[] }> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => {
    void d.accept();
  });
  await page.goto('/playground');
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
    timeout: 20_000,
  });
  return { pageErrors };
}

export async function openFile(page: Page, path: string): Promise<void> {
  await page.locator(`[data-testid=file-item][data-path="${path}"] > button`).first().click();
  await expect(page.getByTestId('active-file')).toHaveText(path);
}

/** Replaces the active file's text through the CodeMirror UI (select all + insert). */
export async function replaceEditorText(page: Page, text: string): Promise<void> {
  const content = page.locator('[data-testid=code-editor] .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

export async function editorText(page: Page): Promise<string> {
  // CodeMirror renders one .cm-line per line (only visible ones, fine for short files).
  const lines = await page.locator('[data-testid=code-editor] .cm-line').allTextContents();
  return lines.join('\n');
}
