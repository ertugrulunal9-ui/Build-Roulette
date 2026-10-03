import { expect, type FrameLocator, type Page } from '@playwright/test';

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
