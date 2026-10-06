import { expect, test } from '@playwright/test';
import { buildFrame, editorText, openFile, openPlayground, replaceEditorText } from './helpers';

const F = '```';

test('the react-ts template renders in the cross-site preview', async ({ page }) => {
  const { pageErrors } = await openPlayground(page);
  const frame = buildFrame(page);
  await expect(frame.locator('h1')).toHaveText('Hello, Build Roulette!');
  await frame.getByRole('button').click();
  await expect(frame.getByRole('button')).toHaveText('Clicked 1 time');
  // The preview iframe is served by the shell on another site.
  const src = await page.getByTestId('preview-frame').getAttribute('src');
  expect(src).toBe('http://127.0.0.1:4321/v1/');
  await expect(page.getByTestId('active-file')).toHaveText('src/App.tsx');
  expect(pageErrors).toEqual([]);
});

test('editing App.tsx updates the preview and the console', async ({ page }) => {
  await openPlayground(page);
  await replaceEditorText(
    page,
    `export function App() {
  console.log('hello from the build', 42);
  return <h1 className="edited">Edited in CodeMirror</h1>;
}
`,
  );
  await expect(buildFrame(page).locator('h1.edited')).toHaveText('Edited in CodeMirror');
  await expect(page.getByTestId('console')).toContainText('hello from the build 42');
});

test('a build error shows in Problems and keeps the last good preview', async ({ page }) => {
  await openPlayground(page);
  await replaceEditorText(page, 'export function App() {\n  return <h1>unclosed;\n}\n');
  await expect(page.getByTestId('build-status')).toHaveText(/^Build failed/);
  await page.getByRole('tab', { name: /Problems/ }).click();
  await expect(page.getByTestId('problems')).toContainText('src/App.tsx:');
  await expect(buildFrame(page).locator('h1')).toHaveText('Hello, Build Roulette!');
});

test('paste-import of a 3-file chat answer builds and renders', async ({ page }) => {
  await openPlayground(page);
  const blob = `Here's a tiny dice roller split into three files.

**src/App.tsx**

${F}tsx
import { Dice } from './Dice';
import './theme.css';

export function App() {
  return (
    <main>
      <h1 className="title">Dice roller</h1>
      <Dice />
    </main>
  );
}
${F}

**src/Dice.tsx**

${F}tsx
import { useState } from 'react';

export function Dice() {
  const [value, setValue] = useState(4);
  return (
    <button data-testid="dice" onClick={() => setValue((v) => (v % 6) + 1)}>
      Rolled {value}
    </button>
  );
}
${F}

**src/theme.css**

${F}css
.title {
  color: rgb(255, 0, 128);
}
${F}

Have fun!`;
  await page.getByRole('button', { name: 'Paste import' }).click();
  await page.getByTestId('paste-input').fill(blob);
  const parsed = page.getByTestId('paste-parsed');
  await expect(parsed.locator('li')).toHaveCount(3);
  await expect(parsed).toContainText('src/App.tsx');
  await expect(parsed).toContainText('src/Dice.tsx');
  await expect(parsed).toContainText('src/theme.css');
  await page.getByRole('button', { name: 'Import 3 files' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  const frame = buildFrame(page);
  await expect(frame.locator('h1.title')).toHaveText('Dice roller');
  await expect(frame.locator('h1.title')).toHaveCSS('color', 'rgb(255, 0, 128)');
  await frame.getByTestId('dice').click();
  await expect(frame.getByTestId('dice')).toHaveText('Rolled 5');
  // The template's other files are kept (merge mode).
  await expect(page.locator('[data-testid=file-item]')).toHaveCount(5);
});

test('a reload restores edited files from IndexedDB', async ({ page }) => {
  await openPlayground(page);
  await openFile(page, 'src/styles.css');
  await replaceEditorText(page, 'h1 { color: rgb(0, 128, 0); }\n');
  await openFile(page, 'src/App.tsx');
  await replaceEditorText(page, 'export function App() {\n  return <h1>Persisted edit</h1>;\n}\n');
  const frame = buildFrame(page);
  await expect(frame.locator('h1')).toHaveText('Persisted edit');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.reload();
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in/, { timeout: 20_000 });
  await expect(buildFrame(page).locator('h1')).toHaveText('Persisted edit');
  await expect(buildFrame(page).locator('h1')).toHaveCSS('color', 'rgb(0, 128, 0)');
  expect(await editorText(page)).toContain('Persisted edit');
});

test('a bundler that failed to start is started again by the next edit', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  let failWasm = true;
  let wasmRequests = 0;
  // The bundler worker fetches esbuild.wasm; fail that request until the user edits a file.
  await page.context().route('**/*.wasm', (route) => {
    wasmRequests++;
    return failWasm ? route.abort() : route.continue();
  });
  await page.goto('/playground');
  await expect(page.getByTestId('build-status')).toHaveText('Bundler failed', { timeout: 20_000 });
  await expect(page.getByText('The bundler failed to start.')).toBeVisible();

  failWasm = false;
  await replaceEditorText(page, 'export function App() {\n  return <h1>Second try</h1>;\n}\n');
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/, {
    timeout: 20_000,
  });
  await expect(buildFrame(page).locator('h1')).toHaveText('Second try');
  await expect(page.getByText('The bundler failed to start.')).toHaveCount(0);
  expect(wasmRequests).toBeGreaterThanOrEqual(2);
  // No unhandled rejections from the failed start or the retried builds.
  expect(pageErrors).toEqual([]);
});

test('after a reload the template menu shows the stored workspace template', async ({ page }) => {
  await openPlayground(page);
  const picker = page.getByLabel('Template');
  await expect(picker).toHaveValue('react-ts');
  await picker.selectOption('vanilla-ts');
  await page.getByRole('button', { name: 'Reset to template' }).click(); // confirm() is accepted
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in/, { timeout: 20_000 });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.reload();
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in/, { timeout: 20_000 });
  await expect(page.getByLabel('Template')).toHaveValue('vanilla-ts');
});

test('a runtime error shows the error overlay, and fixing it clears it', async ({ page }) => {
  await openPlayground(page);
  await replaceEditorText(
    page,
    "export function App() {\n  throw new Error('boom from App');\n}\n",
  );
  const overlay = page.getByTestId('error-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId('error-message')).toContainText('boom from App');
  await expect(page.getByTestId('console')).toContainText('Uncaught');

  await replaceEditorText(page, 'export function App() {\n  return <h1>Fixed</h1>;\n}\n');
  await expect(buildFrame(page).locator('h1')).toHaveText('Fixed');
  await expect(overlay).toBeHidden();
});

test('an infinite loop shows the crashed state and restart recovers', async ({ page }) => {
  await openPlayground(page);
  await replaceEditorText(page, 'export function App() {\n  while (true) {}\n  return null;\n}\n');
  const crashed = page.getByTestId('preview-crashed');
  await expect(crashed).toBeVisible({ timeout: 20_000 });
  await expect(crashed).toContainText('The preview crashed');
  await expect(page.getByTestId('preview-frame')).toHaveCount(0);

  // The app itself stays responsive (the preview is site-isolated): keep editing.
  await replaceEditorText(page, 'export function App() {\n  return <h1>Recovered</h1>;\n}\n');
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in/);
  await expect(crashed).toBeVisible();

  await crashed.getByRole('button', { name: 'Restart preview' }).click();
  await expect(crashed).toBeHidden();
  await expect(buildFrame(page).locator('h1')).toHaveText('Recovered');
});

test('the editor theme follows prefers-color-scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPlayground(page);
  const editor = page.locator('[data-testid=code-editor] .cm-editor');
  await expect(editor).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.emulateMedia({ colorScheme: 'dark' });
  // oneDark's background (#282c34).
  await expect(editor).toHaveCSS('background-color', 'rgb(40, 44, 52)');
});

test('the file tree adds, renames and deletes files within the limits', async ({ page }) => {
  await openPlayground(page);

  await page.getByRole('button', { name: '+ New' }).click();
  await page.getByLabel('New file path').fill('src/greeting.ts');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('active-file')).toHaveText('src/greeting.ts');
  await replaceEditorText(page, "export const greeting = 'Hi from a new file';\n");

  await openFile(page, 'src/App.tsx');
  await replaceEditorText(
    page,
    "import { greeting } from './greeting';\nexport function App() {\n  return <h1>{greeting}</h1>;\n}\n",
  );
  await expect(buildFrame(page).locator('h1')).toHaveText('Hi from a new file');

  // Renaming to a path outside the workspace is refused.
  await page.getByRole('button', { name: 'Rename src/greeting.ts' }).click();
  await page.getByLabel('New path for src/greeting.ts').fill('../greeting.ts');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'cannot contain ".."' })).toBeVisible();
  await page.getByLabel('New path for src/greeting.ts').fill('src/lib/greeting.ts');
  await page.keyboard.press('Enter');
  await expect(
    page.locator('[data-testid=file-item][data-path="src/lib/greeting.ts"]'),
  ).toHaveCount(1);
  // App.tsx still imports './greeting', so the build now fails and says why.
  await expect(page.getByTestId('build-status')).toHaveText(/^Build failed/);

  await page.getByRole('button', { name: 'Delete src/lib/greeting.ts' }).click();
  await expect(
    page.locator('[data-testid=file-item][data-path="src/lib/greeting.ts"]'),
  ).toHaveCount(0);
  // The entry file cannot be deleted.
  await expect(page.getByRole('button', { name: 'Delete src/main.tsx' })).toBeDisabled();

  await page.getByRole('button', { name: 'Reset to template' }).click();
  await expect(buildFrame(page).locator('h1')).toHaveText('Hello, Build Roulette!');
  await expect(page.locator('[data-testid=file-item]')).toHaveCount(3);

  // Switching templates changes the entry and the dependencies too.
  await page.getByLabel('Template').selectOption('vanilla-ts');
  await page.getByRole('button', { name: 'Reset to template' }).click();
  await expect(page.locator('[data-testid=file-item]')).toHaveCount(2);
  await expect(page.locator('[data-testid=file-item][data-path="src/main.ts"]')).toHaveCount(1);
  await expect(buildFrame(page).getByRole('button')).toHaveText('Clicked 0 times');
  await buildFrame(page).getByRole('button').click();
  await expect(buildFrame(page).getByRole('button')).toHaveText('Clicked 1 time');
});

test('typing with pauses across rebuilds keeps the keyboard in the editor', async ({ page }) => {
  await openPlayground(page);
  await page.locator('[data-testid=code-editor] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  // Each pause is longer than the 150 ms rebuild debounce, so a new build frame loads
  // between keystrokes. None of them may take the focus (T-014).
  const text = '// typed slowly';
  await page.keyboard.type(text, { delay: 300 });
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in \d+ ms$/);
  expect(await editorText(page)).toContain(text);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(
    true,
  );
});

test('a click into the preview gives the keyboard to the build', async ({ page }) => {
  await openPlayground(page);
  await replaceEditorText(
    page,
    `import { useEffect, useState } from 'react';
export function App() {
  const [key, setKey] = useState('none');
  useEffect(() => {
    const on = (e: KeyboardEvent) => setKey(e.key);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return <h1 className="keys" style={{ minHeight: '100vh', margin: 0 }}>{key}</h1>;
}
`,
  );
  const h1 = buildFrame(page).locator('h1.keys');
  await expect(h1).toHaveText('none');
  await h1.click();
  await page.keyboard.press('x');
  await expect(h1).toHaveText('x');
});
