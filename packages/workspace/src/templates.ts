/**
 * Starter templates (docs/03 §3.3). `react-ts` is the default.
 *
 * Both entry files call `window.buildRoulette?.ready()` after the first paint, so the
 * capture renderer can take the screenshot without waiting for network idle + 2 s
 * (apps/capture-worker README, "Readiness").
 *
 * React versions are pinned to what the package CDN serves. Until the self-hosted CDN
 * (T-006) lands, that is the local mock CDN in `@br/runtime`, which serves the React
 * installed in packages/runtime (a test in templates.test.ts guards against drift).
 */
import type { FileMap, Manifest, TemplateId, Workspace } from './types';

export const REACT_VERSION = '19.3.0';

export const DEFAULT_TEMPLATE: TemplateId = 'react-ts';

export interface Template {
  id: TemplateId;
  label: string;
  description: string;
  manifest: Manifest;
  files: FileMap;
}

const REACT_TS: Template = {
  id: 'react-ts',
  label: 'React + TypeScript',
  description: 'A React 19 app with TSX and plain CSS.',
  manifest: {
    template: 'react-ts',
    entry: 'src/main.tsx',
    dependencies: { react: REACT_VERSION, 'react-dom': REACT_VERSION },
    tailwind: false,
  },
  files: {
    'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

declare global {
  interface Window {
    buildRoulette?: { ready(): void };
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tells Build Roulette's screenshot renderer that the first frame is on screen.
// It does nothing in the live preview, and \`?.\` keeps it working outside the sandbox.
requestAnimationFrame(() => requestAnimationFrame(() => window.buildRoulette?.ready()));
`,
    'src/App.tsx': `import { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="app">
      <h1>Hello, Build Roulette!</h1>
      <p>Edit src/App.tsx and watch the preview update.</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} {count === 1 ? 'time' : 'times'}
      </button>
    </main>
  );
}
`,
    'src/styles.css': `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

body {
  margin: 0;
}

.app {
  display: grid;
  min-height: 100vh;
  place-content: center;
  gap: 12px;
  text-align: center;
}

button {
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
`,
  },
};

const VANILLA_TS: Template = {
  id: 'vanilla-ts',
  label: 'Vanilla TypeScript',
  description: 'Plain DOM and TypeScript, no framework.',
  manifest: {
    template: 'vanilla-ts',
    entry: 'src/main.ts',
    dependencies: {},
    tailwind: false,
  },
  files: {
    'src/main.ts': `import './styles.css';

const root = document.getElementById('root')!;
let count = 0;

const title = document.createElement('h1');
title.textContent = 'Hello, Build Roulette!';

const button = document.createElement('button');
button.type = 'button';
const render = () => {
  button.textContent = \`Clicked \${count} \${count === 1 ? 'time' : 'times'}\`;
};
button.addEventListener('click', () => {
  count += 1;
  render();
});
render();

const app = document.createElement('main');
app.className = 'app';
app.append(title, button);
root.append(app);

declare global {
  interface Window {
    buildRoulette?: { ready(): void };
  }
}

// Tells Build Roulette's screenshot renderer that the first frame is on screen.
// It does nothing in the live preview, and \`?.\` keeps it working outside the sandbox.
requestAnimationFrame(() => window.buildRoulette?.ready());
`,
    'src/styles.css': `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

body {
  margin: 0;
}

.app {
  display: grid;
  min-height: 100vh;
  place-content: center;
  gap: 12px;
  text-align: center;
}
`,
  },
};

export const TEMPLATES: Readonly<Record<TemplateId, Template>> = {
  'react-ts': REACT_TS,
  'vanilla-ts': VANILLA_TS,
};

export const TEMPLATE_IDS: readonly TemplateId[] = ['react-ts', 'vanilla-ts'];

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value);
}

/** A fresh, independent copy of a template's workspace. */
export function createWorkspace(template: TemplateId = DEFAULT_TEMPLATE): Workspace {
  const t = TEMPLATES[template];
  return { files: { ...t.files }, manifest: structuredClone(t.manifest) };
}
